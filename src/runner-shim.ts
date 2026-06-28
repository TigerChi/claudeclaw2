/**
 * Runner shim — exposes v1's runner API surface (run / runUserMessage /
 * streamUserMessage / cancelThread / compactCurrentSession / bootstrap /
 * onCompactEvent / loadHeartbeatPromptTemplate / ensureProjectClaudeMd /
 * isInflight / runCompact) but delegates execution to hans's Channel
 * (tmux + JSONL) instead of v1's SDK runner.
 *
 * Why a shim: it lets v1's six platform handlers (slack/telegram/discord/
 * line/start/send) keep their existing structure — only the `import` line
 * changes. The shim handles the impedance match between v1's
 * request/response model and Channel's push-based callback model.
 *
 * v3 differences:
 *   - NO NO_REPLY suppression. The bot always tries to respond.
 *   - Tool-use events are not surfaced via the shim (v1 platforms didn't
 *     consume them either; for new platforms wire callbacks directly).
 *   - Compact event listener is stubbed (turn-count tracking lives in
 *     Channel; if Tiger needs warnings, hook into onTurnEnd there).
 */
import { readFile, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { Channel, type ChannelCallbacks, type ReplyTarget } from "./channel";
import { loadSessions, saveSessions, tmuxNameFor, touchActivity, type ChannelSession, type ChannelKind } from "./channel-sessions";
import type { Settings } from "./config";
import { hasSession } from "./tmux";
import { reportAndClearLeftoverInflight } from "./inflight-store";

// ---------- context (set once at daemon startup) ----------

interface ShimContext {
  settings: Settings;
  projectDir: string;
}

let context: ShimContext | null = null;

export function initRunnerShim(ctx: ShimContext): void {
  context = ctx;
  // Loss-detection for in-flight turns that didn't complete before last
  // shutdown. Async, fire-and-forget — daemon startup doesn't block on it.
  void reportAndClearLeftoverInflight().catch((err) =>
    console.error("[runner-shim] inflight startup check failed:", err)
  );
  startSessionCleanup();
}

// Re-export inflight helpers so platform handlers can wrap their
// runUserMessage / streamUserMessage calls without importing both modules.
export { trackInflight, untrackInflight } from "./inflight-store";

// ---------- session cleanup (idle channel teardown) ----------

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Periodically tear down tmux sessions whose channel has been idle past
 * `settings.sessionCleanup.idleTimeoutHours`. channel-sessions.json entry
 * STAYS — the next inbound message will spawn a fresh tmux and call
 * `claude --resume <sessionId>`, restoring full conversation context.
 *
 * Ported from hans's daemon.ts:298 (claudeclaw2 upstream). Config defaults
 * match hans's init: 168h timeout, 30min check interval. Set
 * `idleTimeoutHours: 0` in settings to disable.
 */
function startSessionCleanup(): void {
  if (!context) return;
  const cfg: any = (context.settings as any).sessionCleanup ?? {};
  const idleHours = typeof cfg.idleTimeoutHours === "number" ? cfg.idleTimeoutHours : 168;
  const checkMin = typeof cfg.checkIntervalMinutes === "number" ? cfg.checkIntervalMinutes : 30;
  const maxMemMb = typeof cfg.maxMemoryMb === "number" ? cfg.maxMemoryMb : 0;
  if ((idleHours <= 0 && maxMemMb <= 0) || checkMin <= 0) {
    console.log("[runner-shim] session cleanup disabled (no policy or checkInterval <= 0)");
    return;
  }
  if (cleanupTimer) clearInterval(cleanupTimer);
  void runCleanupTick(idleHours, maxMemMb);
  cleanupTimer = setInterval(() => void runCleanupTick(idleHours, maxMemMb), checkMin * 60_000);
  const policy = [
    idleHours > 0 ? `idleTimeout=${idleHours}h` : null,
    maxMemMb > 0 ? `maxMemoryMb=${maxMemMb}` : null,
  ].filter(Boolean).join(", ");
  console.log(`[runner-shim] session cleanup: ${policy}, check every ${checkMin}m`);
}

async function runCleanupTick(idleHours: number, maxMemMb: number): Promise<void> {
  if (idleHours > 0) await cleanupIdleSessions(idleHours);
  if (maxMemMb > 0) await cleanupOverMemory(maxMemMb);
}

async function cleanupIdleSessions(idleHours: number): Promise<void> {
  const timeoutMs = idleHours * 3_600_000;
  if (timeoutMs <= 0) return;
  const now = Date.now();
  const persisted = await loadSessions();
  const candidates: Array<{ key: string; ageH: number }> = [];
  for (const [key, entry] of channels.entries()) {
    if (entry.channel.currentState !== "idle") continue;
    const session = persisted[key];
    if (!session) continue;
    const lastTs = Date.parse(session.lastActivityAt);
    if (!Number.isFinite(lastTs)) continue;
    const age = now - lastTs;
    if (age >= timeoutMs) candidates.push({ key, ageH: Math.round(age / 3_600_000) });
  }
  if (candidates.length === 0) return;
  console.log(`[runner-shim] cleaning up ${candidates.length} idle channel(s)`);
  for (const { key, ageH } of candidates) {
    await evictChannel(key, `idle ${ageH}h`);
  }
}

/**
 * Memory-cap LRU eviction. When the TOTAL RSS of THIS agent's `claude`
 * processes exceeds maxMemMb, kill the oldest-idle channel's tmux and
 * retry. Repeats until under threshold or no more eligible candidates.
 *
 * "This agent's claudes" = `claude` processes whose --append-system-prompt
 * includes our projectDir. (Each claude is spawned with the agent's project
 * dir baked into the system prompt by compose.ts.)
 */
async function cleanupOverMemory(maxMemMb: number): Promise<void> {
  if (!context) return;
  const projectDir = context.projectDir;
  while (true) {
    const totalMb = await measureClaudeRssMb(projectDir);
    if (totalMb <= maxMemMb) {
      // Optional: log only on transitions to avoid noise. For now just log every check.
      return;
    }
    // Find oldest IDLE channel
    const persisted = await loadSessions();
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [key, entry] of channels.entries()) {
      if (entry.channel.currentState !== "idle") continue;
      const session = persisted[key];
      if (!session) continue;
      const lastTs = Date.parse(session.lastActivityAt);
      if (!Number.isFinite(lastTs)) continue;
      if (lastTs < oldestTs) {
        oldestTs = lastTs;
        oldestKey = key;
      }
    }
    if (!oldestKey) {
      console.warn(
        `[runner-shim] over memory budget (${totalMb.toFixed(0)}MB > ${maxMemMb}MB) but no idle channel to evict`,
      );
      return;
    }
    const ageMin = Math.round((Date.now() - oldestTs) / 60_000);
    console.log(
      `[runner-shim] memory ${totalMb.toFixed(0)}MB > ${maxMemMb}MB cap → evicting LRU channel ${oldestKey} (idle ${ageMin}m)`,
    );
    await evictChannel(oldestKey, `LRU memory cap`);
  }
}

async function measureClaudeRssMb(projectDir: string): Promise<number> {
  // ps RSS on all processes, filter `claude` whose cmdline references our projectDir
  // (every claude spawn includes "scoped to the project directory: <dir>" in
  // its --append-system-prompt). Cross-agent isolation.
  try {
    const proc = Bun.spawn(["ps", "-A", "-ww", "-o", "rss=,command="], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    let totalKb = 0;
    for (const line of out.split("\n")) {
      if (!line.includes(projectDir)) continue;
      const m = line.trim().match(/^(\d+)\s+(.+)/);
      if (!m) continue;
      const cmd = m[2];
      // Match the claude binary, not bun/node wrappers
      if (!/(^|\/|\s)claude(\s|$)/.test(cmd)) continue;
      totalKb += parseInt(m[1], 10);
    }
    return totalKb / 1024;
  } catch (err) {
    console.error("[runner-shim] measureClaudeRssMb failed:", err);
    return 0;
  }
}

async function evictChannel(key: string, reason: string): Promise<void> {
  const entry = channels.get(key);
  if (!entry) return;
  console.log(`[runner-shim]   evict ${key} (${reason}) — killing tmux, session entry preserved`);
  try {
    await entry.channel.shutdown();
  } catch (err) {
    console.error(`[runner-shim] evict ${key}:`, err);
  }
  channels.delete(key);
}

function getCtx(): ShimContext {
  if (!context) {
    throw new Error("runner-shim used before initRunnerShim() — call from daemon startup");
  }
  return context;
}

// ---------- channel cache + per-channel busy mutex ----------

interface ChannelEntry {
  channel: Channel;
  handler: RunHandler;
  starting: Promise<void>;
  busy: Promise<unknown>;
}

const channels = new Map<string, ChannelEntry>();

class RunHandler {
  resolve: ((s: string) => void) | null = null;
  reject: ((e: Error) => void) | null = null;
  buffer = "";
  abort: AbortController | null = null;
  onChunkCb: ((text: string) => void) | undefined;
  onUnblockCb: (() => void) | undefined;
  onResultCb: ((text: string) => void) | undefined;
  unblocked = false;
  /** Safety timer armed when onTurnEnd fires with empty buffer (extended-
   *  thinking case). Cleared when a content-bearing turn-end follows. */
  emptyTurnEndTimer: ReturnType<typeof setTimeout> | null = null;

  reset(): void {
    this.buffer = "";
    this.onChunkCb = undefined;
    this.onUnblockCb = undefined;
    this.onResultCb = undefined;
    this.unblocked = false;
    this.abort = null;
    if (this.emptyTurnEndTimer) {
      clearTimeout(this.emptyTurnEndTimer);
      this.emptyTurnEndTimer = null;
    }
  }
}

// ---------- threadId → channelKey mapping ----------

/**
 * v1 uses opaque thread ids (`slk:<channel>:<ts>`, `dsc:<channel>:<thread>`,
 * `tg:<chat>`, `agent-bus:<msg>`, or undefined). Channel keys are
 * `slack:<channel>(:<thread>)?`, `discord:<channel>`, `telegram:<chat>`, or
 * "global".
 */
function threadIdToChannelKey(threadId?: string): string {
  if (!threadId) return "global";
  if (threadId.startsWith("slk:")) return "slack:" + threadId.slice(4);
  if (threadId.startsWith("dsc:")) {
    // dsc:<channelId>:<threadId> → discord:<channelId> (hans collapses guild threads)
    const parts = threadId.slice(4).split(":");
    return "discord:" + parts[0];
  }
  if (threadId.startsWith("tg:")) return "telegram:" + threadId.slice(3);
  if (threadId.startsWith("agent-bus:")) return "global";
  return threadId;
}

function kindFromChannelKey(key: string): ChannelKind {
  if (key === "global") return "global";
  const prefix = key.split(":")[0];
  if (prefix === "slack" || prefix === "discord" || prefix === "telegram" || prefix === "line") {
    return prefix;
  }
  return "global";
}

// ---------- channel lifecycle ----------

async function ensureChannel(key: string): Promise<ChannelEntry> {
  let entry = channels.get(key);
  if (entry) {
    await entry.starting;
    return entry;
  }
  const ctx = getCtx();
  const persisted = await loadSessions();
  let session = persisted[key];
  let resume = !!session;
  if (!session) {
    session = {
      kind: kindFromChannelKey(key),
      channelKey: key,
      sessionId: randomUUID(),
      tmuxSession: tmuxNameFor(key, ctx.projectDir),
      multiparty: key !== "global",
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    persisted[key] = session;
    await saveSessions(persisted);
  } else {
    // Check tmux liveness — if the session was reaped but jsonl persisted,
    // do a fresh spawn with --resume so context is preserved.
    const alive = await hasSession(session.tmuxSession);
    resume = alive ? false : true;
  }

  const handler = new RunHandler();
  const callbacks: ChannelCallbacks = {
    onAssistantText: (text, _replyTo, _msgId, _stopReason) => {
      // Accumulate raw text for the final RunResult; also emit progressive
      // updates for streamUserMessage subscribers.
      if (text) handler.buffer += (handler.buffer ? "\n" : "") + text;
      if (handler.onChunkCb) {
        if (!handler.unblocked && handler.buffer.trim()) {
          handler.unblocked = true;
          try { handler.onUnblockCb?.(); } catch (err) {
            console.error("[runner-shim] onUnblock threw:", err);
          }
        }
        try { handler.onChunkCb(handler.buffer); } catch (err) {
          console.error("[runner-shim] onChunk threw:", err);
        }
      }
    },
    onTurnEnd: () => {
      const final = handler.buffer.trim();
      console.log(`[runner-shim] onTurnEnd key=${key} bufLen=${final.length} hasResolve=${!!handler.resolve}`);
      // Claude with extended thinking emits TWO end_turn chunks: one for the
      // thinking block, one for the actual text. Both fire onTurnEnd. We
      // must not resolve on the first (empty-buffer) one; wait for the
      // content-bearing one. Fallback: if no content ever comes, the
      // channel's stall watchdog (2 min) will give up; meanwhile arm a
      // local safety timer so we don't hang indefinitely.
      if (!final && handler.resolve) {
        if (handler.emptyTurnEndTimer) clearTimeout(handler.emptyTurnEndTimer);
        handler.emptyTurnEndTimer = setTimeout(() => {
          // Genuine empty reply (rare). Resolve with what we have so caller unblocks.
          console.log(`[runner-shim] onTurnEnd safety: resolving empty after 60s wait key=${key}`);
          const r = handler.resolve;
          handler.resolve = null;
          handler.reject = null;
          handler.emptyTurnEndTimer = null;
          r?.("");
        }, 60_000);
        return;
      }
      if (handler.emptyTurnEndTimer) {
        clearTimeout(handler.emptyTurnEndTimer);
        handler.emptyTurnEndTimer = null;
      }
      try { handler.onResultCb?.(final); } catch (err) {
        console.error("[runner-shim] onResult threw:", err);
      }
      const r = handler.resolve;
      handler.resolve = null;
      handler.reject = null;
      r?.(final);
    },
    onError: (err) => {
      const j = handler.reject;
      handler.resolve = null;
      handler.reject = null;
      j?.(err);
    },
    // Tool-use is not surfaced through the shim; if a platform handler
    // wants tool visibility, wire callbacks directly into a Channel.
    onToolUse: () => {},
    // Capture-pane periodic snapshots while claude is still generating.
    // Each call SUPERSEDES the previous snapshot (not additive). Feeds
    // straight into onChunk so streaming subscribers see live progress
    // even when JSONL writes the whole reply in one shot at end_turn.
    onStreamPartial: (text) => {
      if (!handler.onChunkCb) return;
      if (!text || !text.trim()) return;
      if (!handler.unblocked) {
        handler.unblocked = true;
        try { handler.onUnblockCb?.(); } catch (err) {
          console.error("[runner-shim] onUnblock threw:", err);
        }
      }
      try { handler.onChunkCb(text); } catch (err) {
        console.error("[runner-shim] onChunk(partial) threw:", err);
      }
    },
  };

  const cleanup = ctx.settings.sessionCleanup;
  const compactCooldownMs =
    typeof cleanup?.compactCooldownMinutes === "number"
      ? cleanup.compactCooldownMinutes * 60_000
      : undefined;
  const channel = new Channel({
    session,
    security: ctx.settings.security,
    projectDir: ctx.projectDir,
    callbacks,
    defaultModel: ctx.settings.model,
    agentic: ctx.settings.agentic,
    compactAtTokens: cleanup?.compactAtTokens,
    compactCooldownMs,
  });

  const starting = channel.start({ resume }).catch((err) => {
    console.error(`[runner-shim] channel ${key} failed to start:`, err);
  });
  entry = { channel, handler, starting, busy: Promise.resolve() };
  channels.set(key, entry);
  await starting;
  return entry;
}

// ---------- public API (mirrors v1 runner.ts exports) ----------

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CompactEvent =
  | { type: "warn"; turnCount: number }
  | { type: "auto-compact-start" }
  | { type: "auto-compact-done"; success: boolean }
  | { type: "auto-compact-retry"; success: boolean; stdout: string; stderr: string; exitCode: number };

/**
 * v3 stub. The Channel doesn't currently emit compaction warnings; if
 * Tiger needs them, hook the turn counter in channel.ts onTurnEnd.
 */
export function onCompactEvent(_listener: (e: CompactEvent) => void): void {
  // intentional no-op
}

async function withChannel<T>(threadId: string | undefined, fn: (entry: ChannelEntry) => Promise<T>): Promise<T> {
  const key = threadIdToChannelKey(threadId);
  console.log(`[runner-shim] withChannel threadId=${threadId} key=${key}`);
  const entry = await ensureChannel(key);
  // Refresh lastActivityAt so the cleanup scheduler doesn't treat a recently
  // used channel as idle. Fire-and-forget — write failure shouldn't block.
  void touchActivity(key).catch(() => {});
  const prev = entry.busy;
  const next = prev.catch(() => {}).then(() => {
    console.log(`[runner-shim] fn-start key=${key}`);
    return fn(entry).then(
      (v) => { console.log(`[runner-shim] fn-resolved key=${key}`); return v; },
      (e) => { console.log(`[runner-shim] fn-rejected key=${key}: ${e instanceof Error ? e.message : e}`); throw e; },
    );
  });
  entry.busy = next.catch(() => {});
  return next;
}

export async function run(
  name: string,
  prompt: string,
  threadId?: string,
  _replyToMsgId?: string,
): Promise<RunResult> {
  return withChannel(threadId, async (entry) => {
    entry.handler.reset();
    return new Promise<RunResult>((resolve, reject) => {
      entry.handler.resolve = (text) => resolve({ stdout: text, stderr: "", exitCode: 0 });
      entry.handler.reject = reject;
      void entry.channel.handleIncoming({
        text: prompt,
        fromLabel: name,
        replyTo: null,
      });
    });
  });
}

export async function runUserMessage(name: string, prompt: string, threadId?: string): Promise<RunResult> {
  return run(name, prompt, threadId);
}

export async function streamUserMessage(
  name: string,
  prompt: string,
  onChunk: (text: string) => void,
  onUnblock: () => void,
  threadId?: string,
  onResult?: (text: string) => void,
): Promise<void> {
  await withChannel(threadId, async (entry) => {
    entry.handler.reset();
    entry.handler.onChunkCb = onChunk;
    entry.handler.onUnblockCb = onUnblock;
    entry.handler.onResultCb = onResult;
    await new Promise<void>((resolve, reject) => {
      entry.handler.resolve = () => resolve();
      entry.handler.reject = reject;
      void entry.channel.handleIncoming({
        text: prompt,
        fromLabel: name,
        replyTo: null,
      });
    });
  });
}

export function cancelThread(threadId?: string): boolean {
  const key = threadIdToChannelKey(threadId);
  const entry = channels.get(key);
  if (!entry) return false;
  if (entry.channel.currentState !== "running") return false;
  void entry.channel.userStop();
  return true;
}

export function isInflight(threadId?: string): boolean {
  const key = threadIdToChannelKey(threadId);
  const entry = channels.get(key);
  return !!entry && entry.channel.currentState === "running";
}

export async function bootstrap(): Promise<void> {
  await ensureChannel("global");
}

export async function compactCurrentSession(): Promise<{ success: boolean; message: string }> {
  return withChannel(undefined, async (entry) => {
    return new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      entry.handler.reset();
      entry.handler.resolve = () => resolve({ success: true, message: "compact requested" });
      entry.handler.reject = (err) => reject(err);
      void entry.channel.handleIncoming({
        text: "/compact",
        fromLabel: "compact",
        replyTo: null,
      });
    });
  });
}

/**
 * v1 ran `/compact` and inspected output for success. v3 just pastes the
 * slash command and trusts the TUI. Kept for source compatibility.
 */
export async function runCompact(): Promise<{ success: boolean; message: string }> {
  return compactCurrentSession();
}

/**
 * v1 copied `prompts/CLAUDE.md` (plugin) → `<projectDir>/CLAUDE.md` on first
 * run if missing. v3 keeps the same behaviour: Claude Code expects a CLAUDE.md
 * for cwd auto-discovery; if absent, no-op (skip — agents that need one
 * already have it via their own `_claude/rules` symlinks).
 */
export async function ensureProjectClaudeMd(): Promise<void> {
  const ctx = getCtx();
  const target = join(ctx.projectDir, "CLAUDE.md");
  if (existsSync(target)) return;
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  const template = join(pluginDir, "..", "prompts", "CLAUDE.md");
  try {
    const content = await readFile(template, "utf8");
    await mkdir(ctx.projectDir, { recursive: true });
    await writeFile(target, content, "utf8");
  } catch {
    // template missing → silently skip
  }
}

/** v1 loaded `prompts/HEARTBEAT.md` from the plugin install dir. */
export async function loadHeartbeatPromptTemplate(): Promise<string> {
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  const path = join(pluginDir, "..", "prompts", "HEARTBEAT.md");
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

// ---------- shutdown ----------

/** Gracefully tear down all channels (tmux sessions stay alive). */
export async function shutdownRunnerShim(): Promise<void> {
  await Promise.all(
    Array.from(channels.values()).map(async (entry) => {
      try { await entry.channel.shutdown(); } catch {}
    }),
  );
  channels.clear();
}
