/**
 * Slack roundtrip test — verifies the daemon can actually post outbound
 * messages to a Slack channel via the real Slack Web API.
 *
 * Prereqs:
 *   - daemon is running for this project dir
 *   - .claude/claudeclaw/settings.json has valid slack.botToken
 *   - .claude/claudeclaw/auth.token exists (created on first daemon start)
 *   - SLACK_TEST_CHANNEL env var set to a channel id the bot can post to
 *     (defaults to first persisted slack channel session, if any)
 *
 * What it does:
 *   1. POST /api/trigger with a marker prompt directed at the slack target
 *   2. Poll slack conversations.history for a message containing the marker
 *   3. Pass if found within timeout
 *
 * SIDE EFFECT: posts a real test message to the configured Slack channel.
 * Run from a project directory:
 *   SLACK_TEST_CHANNEL=C0AP53KLHNK bun run \
 *     ~/.claude/plugins/marketplaces/claudeclaw2/scripts/slack-roundtrip-test.ts
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

const TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

async function main(): Promise<void> {
  const projectDir = process.cwd();
  const settingsPath = join(projectDir, ".claude/claudeclaw/settings.json");
  const authPath = join(projectDir, ".claude/claudeclaw/auth.token");
  const sessionsPath = join(projectDir, ".claude/claudeclaw/sessions.json");

  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  const authToken = (await readFile(authPath, "utf8")).trim();
  const botToken = settings?.slack?.botToken;
  const webHost = settings?.web?.host ?? "127.0.0.1";
  const webPort = settings?.web?.port ?? 4632;

  if (!botToken) throw new Error("slack.botToken missing in settings.json");

  let channelId = process.env.SLACK_TEST_CHANNEL;
  if (!channelId) {
    try {
      const sessions = JSON.parse(await readFile(sessionsPath, "utf8"));
      const slackEntry = Object.values(sessions ?? {}).find(
        (s: any) => s?.kind === "slack",
      ) as any;
      if (slackEntry?.channelKey?.startsWith("slack:")) {
        channelId = slackEntry.channelKey.replace(/^slack:/, "").split(":")[0];
      }
    } catch {
      // fall through
    }
  }
  if (!channelId) {
    throw new Error(
      "no SLACK_TEST_CHANNEL env var and no persisted slack session found",
    );
  }

  const marker = "slack-roundtrip-" + randomUUID().slice(0, 8);
  const target = `slack:${channelId}`;
  const prompt = `Reply with exactly: ${marker}`;

  console.log(`[test] target ${target}`);
  console.log(`[test] marker ${marker}`);
  console.log(`[test] POST /api/trigger ...`);

  const triggerRes = await fetch(`http://${webHost}:${webPort}/api/trigger`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ target, prompt, fromLabel: "roundtrip-test" }),
  });
  const triggerJson = await triggerRes.json();
  if (!triggerRes.ok || !(triggerJson as any).ok) {
    throw new Error(`/api/trigger failed: ${JSON.stringify(triggerJson)}`);
  }
  console.log(`[test] dispatched, polling slack history (${TIMEOUT_MS / 1000}s)...`);

  const sinceTs = (Date.now() / 1000).toString();
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const histRes = await fetch(
      `https://slack.com/api/conversations.history?channel=${channelId}&oldest=${sinceTs}&limit=20`,
      { headers: { authorization: `Bearer ${botToken}` } },
    );
    const hist = (await histRes.json()) as any;
    if (!hist.ok) {
      console.warn(`[test] slack history error: ${hist.error}`);
      continue;
    }
    const messages = Array.isArray(hist.messages) ? hist.messages : [];
    for (const m of messages) {
      const text: string = m.text ?? "";
      if (text.includes(marker)) {
        console.log(`[test] ✓ found marker in slack message ts=${m.ts}`);
        console.log(`[test] ✓ SLACK ROUNDTRIP PASSED`);
        process.exit(0);
      }
    }
    process.stdout.write(".");
  }
  console.log(`\n[test] ✗ marker never appeared in slack history`);
  process.exit(1);
}

main().catch((err) => {
  console.error("slack-roundtrip-test fatal:", err.message ?? err);
  process.exit(2);
});
