/**
 * Scenario test suite for claudeclaw2 — exercises the core engine across
 * multiple realistic patterns:
 *
 *   1. Tool-use flow — verify onToolUse fires and final text contains output
 *   2. NO_REPLY suppression — verify silent reply is detected and not posted
 *   3. Multi-turn — verify two sequential prompts both complete cleanly
 *
 * Run from a project directory (e.g. Agent-Eleven):
 *   bun run ~/.claude/plugins/marketplaces/claudeclaw2/scripts/scenarios-test.ts
 *
 * Each scenario spins up a fresh channel + claude session, so this test
 * coexists safely with a running daemon (different channelKey, different
 * sessionId, different tmux session).
 */
import { randomUUID } from "crypto";
import { Channel, type ChannelCallbacks, type ReplyTarget } from "../src/channel";
import { tmuxNameFor, type ChannelSession } from "../src/channel-sessions";
// v3 removed silent.ts entirely (no NO_REPLY); scenario test below is updated.

const TIMEOUT_MS = 120_000;

type Outbound =
  | { kind: "text"; text: string; stopReason?: string }
  | { kind: "tool"; toolName: string; input: unknown }
  | { kind: "turn-end" }
  | { kind: "error"; message: string };

interface ScenarioResult {
  name: string;
  ok: boolean;
  reason?: string;
  events: Outbound[];
  elapsedMs: number;
}

function makeChannel(channelKey: string): { channel: Channel; getEvents(): Outbound[]; waitForTurnEnd(): Promise<void> } {
  const events: Outbound[] = [];
  let turnEndResolve: (() => void) | null = null;
  const turnEndPromise = () =>
    new Promise<void>((resolve) => {
      turnEndResolve = resolve;
    });
  let currentPromise = turnEndPromise();

  const callbacks: ChannelCallbacks = {
    onAssistantText: (text, _replyTo, _msgId, stopReason) => {
      events.push({ kind: "text", text, stopReason });
    },
    onToolUse: (toolName, input) => {
      events.push({ kind: "tool", toolName, input });
    },
    onTurnEnd: () => {
      events.push({ kind: "turn-end" });
      if (turnEndResolve) {
        const r = turnEndResolve;
        turnEndResolve = null;
        currentPromise = turnEndPromise();
        r();
      }
    },
    onError: (err) => {
      events.push({ kind: "error", message: err.message });
    },
  };

  const session: ChannelSession = {
    kind: "global",
    channelKey,
    sessionId: randomUUID(),
    tmuxSession: tmuxNameFor(channelKey, process.cwd()),
    multiparty: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };

  const channel = new Channel({
    session,
    security: { level: "moderate", allowedTools: [], disallowedTools: [] },
    projectDir: process.cwd(),
    callbacks,
  });

  return {
    channel,
    getEvents: () => events.slice(),
    waitForTurnEnd: () => currentPromise,
  };
}

async function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms / 1000}s waiting for ${label}`)), ms),
    ),
  ]);
}

async function runScenario(
  name: string,
  fn: () => Promise<{ ok: boolean; reason?: string; events: Outbound[] }>,
): Promise<ScenarioResult> {
  const start = Date.now();
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`▶ ${name}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  try {
    const { ok, reason, events } = await fn();
    const elapsedMs = Date.now() - start;
    console.log(`${ok ? "✓" : "✗"} ${name} (${(elapsedMs / 1000).toFixed(1)}s)${reason ? ` — ${reason}` : ""}`);
    return { name, ok, reason, events, elapsedMs };
  } catch (err: any) {
    const elapsedMs = Date.now() - start;
    console.log(`✗ ${name} (${(elapsedMs / 1000).toFixed(1)}s) — error: ${err.message}`);
    return { name, ok: false, reason: `error: ${err.message}`, events: [], elapsedMs };
  }
}

async function scenarioToolUse(): Promise<{ ok: boolean; reason?: string; events: Outbound[] }> {
  const marker = "tool-" + randomUUID().slice(0, 8);
  const { channel, getEvents, waitForTurnEnd } = makeChannel(`scenario-tool-${marker}`);
  try {
    await channel.start({ resume: false });
    if (channel.currentState !== "idle") {
      return { ok: false, reason: `not idle after start (${channel.currentState})`, events: getEvents() };
    }
    const prompt = `Run \`echo ${marker}\` via the Bash tool and tell me what it printed. Reply with the marker string exactly.`;
    await channel.handleIncoming({ text: prompt, fromLabel: "tester", replyTo: null });
    await raceTimeout(waitForTurnEnd(), TIMEOUT_MS, "turn-end");
    const events = getEvents();
    const sawTool = events.some((e) => e.kind === "tool");
    const text = events
      .filter((e): e is Extract<Outbound, { kind: "text" }> => e.kind === "text")
      .map((e) => e.text)
      .join("\n");
    if (!sawTool) {
      return { ok: false, reason: `no tool event observed`, events };
    }
    if (!text.includes(marker)) {
      return { ok: false, reason: `marker missing from text: ${text.slice(0, 200)}`, events };
    }
    return { ok: true, events };
  } finally {
    await channel.shutdown();
  }
}

// v3: NO_REPLY scenario removed. The bot must always respond — no silent
// reply suppression in compose.ts or daemon dispatch. Instead we verify
// that even an "ambiguous chitchat" prompt produces SOME text response.
async function scenarioAmbiguousChitchat(): Promise<{ ok: boolean; reason?: string; events: Outbound[] }> {
  const { channel, getEvents, waitForTurnEnd } = makeChannel(`scenario-chitchat-${randomUUID().slice(0, 6)}`);
  try {
    await channel.start({ resume: false });
    if (channel.currentState !== "idle") {
      return { ok: false, reason: `not idle after start (${channel.currentState})`, events: getEvents() };
    }
    const prompt = `Briefly acknowledge in one sentence.`;
    await channel.handleIncoming({ text: prompt, fromLabel: "tester", replyTo: null });
    await raceTimeout(waitForTurnEnd(), TIMEOUT_MS, "turn-end");
    const events = getEvents();
    const texts = events.filter((e): e is Extract<Outbound, { kind: "text" }> => e.kind === "text");
    if (texts.length === 0 || !texts.some((t) => t.text.trim().length > 0)) {
      return { ok: false, reason: `bot stayed silent — v3 should always respond`, events };
    }
    return { ok: true, events };
  } finally {
    await channel.shutdown();
  }
}

async function scenarioMultiTurn(): Promise<{ ok: boolean; reason?: string; events: Outbound[] }> {
  const m1 = "first-" + randomUUID().slice(0, 6);
  const m2 = "second-" + randomUUID().slice(0, 6);
  const { channel, getEvents, waitForTurnEnd } = makeChannel(`scenario-multi-${randomUUID().slice(0, 6)}`);
  try {
    await channel.start({ resume: false });
    if (channel.currentState !== "idle") {
      return { ok: false, reason: `not idle after start (${channel.currentState})`, events: getEvents() };
    }
    await channel.handleIncoming({
      text: `Reply with exactly the word "${m1}" and nothing else.`,
      fromLabel: "tester",
      replyTo: null,
    });
    await raceTimeout(waitForTurnEnd(), TIMEOUT_MS, "turn-1 end");

    await channel.handleIncoming({
      text: `Now reply with exactly the word "${m2}" and nothing else.`,
      fromLabel: "tester",
      replyTo: null,
    });
    await raceTimeout(waitForTurnEnd(), TIMEOUT_MS, "turn-2 end");

    const events = getEvents();
    const allText = events
      .filter((e): e is Extract<Outbound, { kind: "text" }> => e.kind === "text")
      .map((e) => e.text)
      .join("\n");
    if (!allText.includes(m1)) return { ok: false, reason: `m1 missing`, events };
    if (!allText.includes(m2)) return { ok: false, reason: `m2 missing`, events };
    const turnEnds = events.filter((e) => e.kind === "turn-end").length;
    if (turnEnds < 2) return { ok: false, reason: `expected 2 turn-end, got ${turnEnds}`, events };
    return { ok: true, events };
  } finally {
    await channel.shutdown();
  }
}

async function main(): Promise<void> {
  console.log(`scenarios-test starting; projectDir=${process.cwd()}`);

  const results: ScenarioResult[] = [];
  results.push(await runScenario("tool-use flow", scenarioToolUse));
  results.push(await runScenario("always-respond (no NO_REPLY)", scenarioAmbiguousChitchat));
  results.push(await runScenario("multi-turn conversation", scenarioMultiTurn));

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`SUMMARY`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.name} (${(r.elapsedMs / 1000).toFixed(1)}s)${r.reason ? ` — ${r.reason}` : ""}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("scenarios-test fatal:", err);
  process.exit(2);
});
