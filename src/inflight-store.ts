/**
 * Inflight turn tracking — durable record of "turn started but no reply
 * posted yet" so a daemon restart mid-turn doesn't lose the reply target.
 *
 * Lifecycle:
 *   1. Platform handler receives message, derives channelKey + replyTo
 *   2. `trackInflight(channelKey, replyTo, promptPreview)` writes entry to
 *      `.claude/claudeclaw/inflight.json` BEFORE awaiting runUserMessage
 *   3. On `runUserMessage` resolve (successful response posted),
 *      `untrackInflight(channelKey)` deletes the entry
 *   4. If daemon is killed between #2 and #3, the entry persists
 *   5. Next daemon startup: `loadInflight()` reveals what was lost.
 *      Phase 1 (this version): log a warning so the operator knows.
 *      Phase 2 (future): actually recover by reading new JSONL events
 *      since `submittedAt` and posting them to the saved `replyTo`.
 */
import { mkdir, readFile, writeFile, rename, unlink } from "fs/promises";
import { dirname, join } from "path";

const FILE_PATH = join(".claude", "claudeclaw", "inflight.json");

export interface InflightEntry {
  channelKey: string;
  /** Opaque replyTo carried by the platform handler. Shape varies per
   *  platform (slack: {channelId, threadTs, ...}; telegram: {chatId, ...}).
   *  Stored verbatim so the same platform handler can route it back. */
  replyTo: unknown;
  /** Platform tag — slack / telegram / line / discord */
  platform: string;
  /** ISO timestamp when the turn was submitted to claude. */
  submittedAt: string;
  /** First ~100 chars of the prompt, for diagnostics. */
  promptPreview: string;
}

export type InflightStore = Record<string, InflightEntry>;

export async function loadInflight(): Promise<InflightStore> {
  try {
    const raw = await readFile(FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as InflightStore;
    }
    return {};
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

async function saveInflight(store: InflightStore): Promise<void> {
  await mkdir(dirname(FILE_PATH), { recursive: true });
  const tmp = `${FILE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, FILE_PATH);
}

export async function trackInflight(
  channelKey: string,
  platform: string,
  replyTo: unknown,
  promptPreview: string,
): Promise<void> {
  const store = await loadInflight();
  store[channelKey] = {
    channelKey,
    platform,
    replyTo,
    submittedAt: new Date().toISOString(),
    promptPreview: promptPreview.slice(0, 100),
  };
  await saveInflight(store);
}

export async function untrackInflight(channelKey: string): Promise<void> {
  const store = await loadInflight();
  if (!(channelKey in store)) return;
  delete store[channelKey];
  if (Object.keys(store).length === 0) {
    // Empty store — delete the file entirely for cleanliness.
    await unlink(FILE_PATH).catch(() => {});
    return;
  }
  await saveInflight(store);
}

/**
 * Called once at daemon startup. Logs each leftover inflight entry as a
 * warning, then clears the file so we don't re-warn next restart.
 *
 * NOTE: this is loss-detection only — actual auto-recovery (post the
 * eventual reply to the saved replyTo) is not yet implemented. See
 * issue #4 phase 2.
 */
export async function reportAndClearLeftoverInflight(): Promise<InflightEntry[]> {
  const store = await loadInflight();
  const entries = Object.values(store);
  if (entries.length === 0) return [];
  for (const e of entries) {
    console.warn(
      `[inflight] LOST REPLY: channelKey=${e.channelKey} platform=${e.platform} submittedAt=${e.submittedAt} preview="${e.promptPreview}"`,
    );
  }
  console.warn(
    `[inflight] ${entries.length} unfinished turn(s) at last shutdown — their replies may not have been delivered. Clearing record.`,
  );
  try { await unlink(FILE_PATH); } catch {}
  return entries;
}
