import { ensureProjectClaudeMd, runUserMessage, streamUserMessage, compactCurrentSession, cancelThread } from "../runner";
import { isCancelCommand, CANCEL_CONFIRM_MESSAGE, CANCEL_NOTHING_MESSAGE } from "../cancel";
import { getSettings, loadSettings } from "../config";
import { resetSession, peekSession } from "../sessions";
import { listThreadSessions, peekThreadSession } from "../sessionManager";
import { transcribeAudioToText } from "../whisper";
import { resolveSkillPrompt } from "../skills";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { existsSync } from "node:fs";

// Slack-specific directives prompt (loaded once)
const SLACK_DIRECTIVES_PATH = join(import.meta.dir, "..", "..", "prompts", "slack", "DIRECTIVES.md");
let slackDirectivesPrompt: string | null = null;

async function loadSlackDirectives(): Promise<string> {
  if (slackDirectivesPrompt !== null) return slackDirectivesPrompt;
  try {
    if (existsSync(SLACK_DIRECTIVES_PATH)) {
      slackDirectivesPrompt = await Bun.file(SLACK_DIRECTIVES_PATH).text();
    } else {
      slackDirectivesPrompt = "";
    }
  } catch {
    slackDirectivesPrompt = "";
  }
  return slackDirectivesPrompt;
}

// --- Slack API constants ---

const SLACK_API = "https://slack.com/api";

// --- Type interfaces ---

interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
  filetype?: string;
}

interface SlackMessage {
  type: string;
  subtype?: string;
  text: string;
  user?: string;
  bot_id?: string;
  channel: string;
  ts: string;
  thread_ts?: string;     // set on thread replies; equals ts for the first reply
  files?: SlackFile[];
  channel_type?: string;  // "im" | "mpim" | "channel" | "group"
}

interface SlackSocketPayload {
  envelope_id: string;
  type: string;           // "events_api" | "slash_commands" | "interactive" | "disconnect"
  accepts_response_payload?: boolean;
  payload?: {
    // events_api
    type?: string;
    event?: SlackMessage;
    // slash_commands
    command?: string;
    text?: string;
    user_id?: string;
    channel_id?: string;
    // disconnect
    reason?: string;
  };
  // disconnect event fields
  reason?: string;
}

// --- Backoff policy (modeled after OpenClaw) ---

const SLACK_AUTH_ERROR_RE =
  /account_inactive|invalid_auth|token_revoked|token_expired|not_authed|org_login_required|team_access_not_granted|missing_scope|cannot_find_service|invalid_token/i;

interface BackoffPolicy {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
  maxAttempts: number;
}

const RECONNECT_POLICY: BackoffPolicy = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
  maxAttempts: 12,
};

function computeBackoff(policy: BackoffPolicy, attempt: number): number {
  const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
  const jitter = base * policy.jitter * Math.random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

/**
 * Wait until the current ws is fully CLOSED (or null).
 * Prevents stale-socket race when reopening — Slack server needs the previous
 * socket truly torn down before it'll accept a new one without too_many_websockets.
 */
function waitForWsClosed(timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    const target = ws;
    const timer = setTimeout(() => {
      target.removeEventListener("close", onClose);
      resolve();
    }, timeoutMs);
    function onClose() { clearTimeout(timer); resolve(); }
    target.addEventListener("close", onClose, { once: true });
    // Best-effort nudge if it's lingering open
    if (target.readyState === WebSocket.OPEN || target.readyState === WebSocket.CONNECTING) {
      try { target.close(1000, "Cleanup before reconnect"); } catch { /* best-effort */ }
    }
  });
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(new Error("aborted")); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isNonRecoverableAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return SLACK_AUTH_ERROR_RE.test(msg);
}

// --- Socket state ---

let ws: WebSocket | null = null;
let abortController: AbortController | null = null;
let slackDebug = false;
let proactiveTimer: ReturnType<typeof setTimeout> | null = null;

// Health tracking
let lastEventAt = 0;
let connectionCount = 0;

// Dedup: track recently processed message timestamps to avoid handling both message + app_mention
const recentlyProcessed = new Map<string, number>();
const DEDUP_TTL_MS = 10_000;

// #4: Track the bot's last message ts per channel+thread for edit/delete directives
const lastBotMessageTs = new Map<string, string>();

function botMessageKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}:${threadTs}` : channelId;
}

// #5: Track threads where history has already been loaded
const threadHistoryLoaded = new Set<string>();

function isDuplicate(channelId: string, ts: string): boolean {
  const key = `${channelId}:${ts}`;
  const now = Date.now();
  // Clean old entries
  for (const [k, t] of recentlyProcessed) {
    if (now - t > DEDUP_TTL_MS) recentlyProcessed.delete(k);
  }
  if (recentlyProcessed.has(key)) return true;
  recentlyProcessed.set(key, now);
  return false;
}

// Bot identity (populated from auth.test)
let botUserId: string | null = null;
let botUsername: string | null = null;

// --- Debug ---

function debugLog(message: string): void {
  if (!slackDebug) return;
  console.log(`[Slack][debug] ${message}`);
}

// --- Slack Web API helper ---

async function slackApi<T = Record<string, unknown>>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Slack API ${method}: HTTP ${res.status} ${text}`);
  }

  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) {
    throw new Error(`Slack API ${method} error: ${data.error ?? "unknown"}`);
  }
  return data;
}

// --- Assistant API helpers ---

async function setAssistantStatus(
  token: string,
  channelId: string,
  threadTs: string,
  status: string,
): Promise<void> {
  await slackApi(token, "assistant.threads.setStatus", {
    channel_id: channelId,
    thread_ts: threadTs,
    status,
  }).catch((err) => {
    debugLog(`assistant.threads.setStatus failed: ${err instanceof Error ? err.message : err}`);
  });
}

async function clearAssistantStatus(
  token: string,
  channelId: string,
  threadTs: string,
): Promise<void> {
  await slackApi(token, "assistant.threads.setStatus", {
    channel_id: channelId,
    thread_ts: threadTs,
    status: "",
  }).catch((err) => {
    debugLog(`assistant.threads.clearStatus failed: ${err instanceof Error ? err.message : err}`);
  });
}

async function setAssistantSuggestedPrompts(
  token: string,
  channelId: string,
  threadTs: string,
  prompts: { title: string; message: string }[],
): Promise<void> {
  await slackApi(token, "assistant.threads.setSuggestedPrompts", {
    channel_id: channelId,
    thread_ts: threadTs,
    prompts,
  }).catch((err) => {
    debugLog(`assistant.threads.setSuggestedPrompts failed: ${err instanceof Error ? err.message : err}`);
  });
}

// Track channels that are assistant threads (no @mention needed)
const assistantThreadChannels = new Set<string>();

// --- Message sending ---

async function sendMessage(
  token: string,
  channelId: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  // Strip [react:...] directives before sending
  const normalized = text.replace(/\[react:[^\]\r\n]+\]/gi, "").trim();
  if (!normalized) return;

  // Slack max message length is 40000 chars, chunk at 3800 for mrkdwn block limits
  const MAX_LEN = 3800;
  for (let i = 0; i < normalized.length; i += MAX_LEN) {
    const chunk = normalized.slice(i, i + MAX_LEN);
    const params: Record<string, unknown> = {
      channel: channelId,
      text: chunk,
    };
    if (threadTs) params.thread_ts = threadTs;
    await slackApi(token, "chat.postMessage", params);
  }
}

async function sendReaction(
  token: string,
  channelId: string,
  ts: string,
  emoji: string,
): Promise<void> {
  // Slack emoji names don't have colons and must be lowercase
  const name = emoji.replace(/:/g, "").toLowerCase();
  await slackApi(token, "reactions.add", {
    channel: channelId,
    timestamp: ts,
    name,
  }).catch((err) => {
    debugLog(`Reaction failed (${name}): ${err instanceof Error ? err.message : err}`);
  });
}

async function removeReaction(
  token: string,
  channelId: string,
  ts: string,
  emoji: string,
): Promise<void> {
  const name = emoji.replace(/:/g, "").toLowerCase();
  await slackApi(token, "reactions.remove", {
    channel: channelId,
    timestamp: ts,
    name,
  }).catch((err) => {
    debugLog(`Remove reaction failed (${name}): ${err instanceof Error ? err.message : err}`);
  });
}

// --- Message update (for streaming) ---

async function updateMessage(
  token: string,
  channelId: string,
  messageTs: string,
  text: string,
): Promise<void> {
  await slackApi(token, "chat.update", {
    channel: channelId,
    ts: messageTs,
    text,
  }).catch((err) => {
    debugLog(`chat.update failed: ${err instanceof Error ? err.message : err}`);
  });
}

async function deleteMessage(
  token: string,
  channelId: string,
  messageTs: string,
): Promise<void> {
  await slackApi(token, "chat.delete", {
    channel: channelId,
    ts: messageTs,
  }).catch((err) => {
    debugLog(`chat.delete failed: ${err instanceof Error ? err.message : err}`);
  });
}

async function postMessage(
  token: string,
  channelId: string,
  text: string,
  threadTs?: string,
): Promise<string | null> {
  const params: Record<string, unknown> = {
    channel: channelId,
    text,
  };
  if (threadTs) params.thread_ts = threadTs;
  const data = await slackApi<{ ts: string }>(token, "chat.postMessage", params).catch((err) => {
    debugLog(`chat.postMessage failed: ${err instanceof Error ? err.message : err}`);
    return null;
  });
  return data?.ts ?? null;
}

// Streaming: send initial message then update it as chunks arrive
const STREAM_UPDATE_INTERVAL_MS = 1200; // throttle updates to ~1/sec

// --- Reaction directive extraction ---

function extractReactionDirective(text: string): { cleanedText: string; reactionEmoji: string | null } {
  let reactionEmoji: string | null = null;
  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, reactionEmoji };
}

// --- #3: Block Kit directive extraction ---

interface BlockKitButton {
  label: string;
  value: string;
  style?: "primary" | "danger";
}

interface BlockKitSelect {
  placeholder: string;
  options: { label: string; value: string }[];
}

function extractBlockKitDirectives(text: string): {
  cleanedText: string;
  buttons: BlockKitButton[] | null;
  select: BlockKitSelect | null;
} {
  let buttons: BlockKitButton[] | null = null;
  let select: BlockKitSelect | null = null;

  let cleaned = text
    // Parse [[slack_buttons: Label1:value1, Label2:value2]]
    .replace(/\[\[slack_buttons:\s*(.+?)\]\]/gi, (_match, raw) => {
      buttons = String(raw).split(",").map((pair) => {
        const trimmed = pair.trim();
        const colonIdx = trimmed.lastIndexOf(":");
        if (colonIdx === -1) return { label: trimmed, value: trimmed.toLowerCase().replace(/\s+/g, "_") };
        const label = trimmed.slice(0, colonIdx).trim();
        const value = trimmed.slice(colonIdx + 1).trim();
        return { label, value };
      }).filter((b) => b.label);
      return "";
    })
    // Parse [[slack_select: Placeholder | Option1:opt1, Option2:opt2]]
    .replace(/\[\[slack_select:\s*(.+?)\]\]/gi, (_match, raw) => {
      const parts = String(raw).split("|");
      const placeholder = parts.length > 1 ? parts[0].trim() : "Select...";
      const optionsStr = parts.length > 1 ? parts.slice(1).join("|").trim() : parts[0].trim();
      const options = optionsStr.split(",").map((pair) => {
        const trimmed = pair.trim();
        const colonIdx = trimmed.lastIndexOf(":");
        if (colonIdx === -1) return { label: trimmed, value: trimmed.toLowerCase().replace(/\s+/g, "_") };
        return { label: trimmed.slice(0, colonIdx).trim(), value: trimmed.slice(colonIdx + 1).trim() };
      }).filter((o) => o.label);
      if (options.length > 0) select = { placeholder, options };
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { cleanedText: cleaned, buttons: buttons && buttons.length > 0 ? buttons : null, select };
}

async function sendBlockKitMessage(
  token: string,
  channelId: string,
  text: string,
  buttons: BlockKitButton[] | null,
  select: BlockKitSelect | null,
  threadTs?: string,
): Promise<string | null> {
  const blocks: Record<string, unknown>[] = [];

  if (text) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text },
    });
  }

  const actionElements: Record<string, unknown>[] = [];

  if (buttons) {
    for (const btn of buttons) {
      const element: Record<string, unknown> = {
        type: "button",
        text: { type: "plain_text", text: btn.label },
        action_id: `btn_${btn.value}`,
        value: btn.value,
      };
      if (btn.style) element.style = btn.style;
      actionElements.push(element);
    }
  }

  if (select) {
    actionElements.push({
      type: "static_select",
      placeholder: { type: "plain_text", text: select.placeholder },
      action_id: "select_action",
      options: select.options.map((o) => ({
        text: { type: "plain_text", text: o.label },
        value: o.value,
      })),
    });
  }

  if (actionElements.length > 0) {
    blocks.push({
      type: "actions",
      elements: actionElements,
    });
  }

  const params: Record<string, unknown> = {
    channel: channelId,
    text: text || "Interactive message",
    blocks,
  };
  if (threadTs) params.thread_ts = threadTs;

  const data = await slackApi<{ ts: string }>(token, "chat.postMessage", params).catch((err) => {
    debugLog(`sendBlockKitMessage failed: ${err instanceof Error ? err.message : err}`);
    return null;
  });
  return data?.ts ?? null;
}

/**
 * Replace the actions block on an existing Block Kit message with a
 * context block recording who clicked which button. This is what makes
 * past button choices visible when scrolling back through a thread.
 */
async function freezeMessageWithChoice(
  token: string,
  channelId: string,
  messageTs: string,
  originalBlocks: any[] | undefined,
  fallbackText: string,
  userId: string,
  choiceLabel: string,
): Promise<void> {
  const blocks = Array.isArray(originalBlocks) ? originalBlocks : [];
  // Drop interactive blocks; keep section/context/header/divider/etc.
  const kept = blocks.filter((b) => b?.type !== "actions");
  kept.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `✅ <@${userId}> 已選擇：*${choiceLabel}*`,
      },
    ],
  });
  await slackApi(token, "chat.update", {
    channel: channelId,
    ts: messageTs,
    text: fallbackText || "(updated)",
    blocks: kept,
  }).catch((err) => {
    debugLog(`freezeMessageWithChoice failed: ${err instanceof Error ? err.message : err}`);
  });
}

// --- #4: Edit/Delete directive extraction ---

function extractEditDirective(text: string): {
  cleanedText: string;
  editContent: string | null;
  deleteCount: number; // 0 = no delete, -1 = delete all, N = delete last N
  deleteMatches: string[]; // content patterns to match for targeted deletion
} {
  let editContent: string | null = null;
  let deleteCount = 0;
  const deleteMatches: string[] = [];

  const cleaned = text
    .replace(/\[edit_last\]([\s\S]*?)\[\/edit_last\]/gi, (_match, content) => {
      editContent = String(content).trim();
      return "";
    })
    .replace(/\[delete_all\]/gi, () => {
      deleteCount = -1;
      return "";
    })
    .replace(/\[delete_last(?::(\d+))?\]/gi, (_match, n) => {
      deleteCount = n ? parseInt(n, 10) : 1;
      return "";
    })
    .replace(/\[delete_match:([^\]]+)\]/gi, (_match, pattern) => {
      deleteMatches.push(String(pattern).trim());
      return "";
    })
    .trim();

  return { cleanedText: cleaned, editContent, deleteCount, deleteMatches };
}

// Fetch bot's own messages from channel/thread history for edit/delete
async function fetchBotMessages(
  token: string,
  channelId: string,
  threadTs?: string,
  limit: number = 50,
): Promise<{ ts: string; text: string }[]> {
  if (threadTs) {
    // Thread: use conversations.replies
    const params = new URLSearchParams({
      channel: channelId,
      ts: threadTs,
      limit: String(limit),
      inclusive: "true",
    });
    const res = await fetch(`${SLACK_API}/conversations.replies?${params}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as { ok: boolean; messages?: Array<{ ts: string; text: string; bot_id?: string; user?: string }> };
    if (!data.ok || !data.messages) return [];
    return data.messages
      .filter((m) => m.user === botUserId || m.bot_id)
      .map((m) => ({ ts: m.ts, text: m.text }));
  } else {
    // DM/channel: use conversations.history
    const data = await slackApi<{ messages: Array<{ ts: string; text: string; bot_id?: string; user?: string }> }>(
      token, "conversations.history", { channel: channelId, limit },
    );
    return (data.messages ?? [])
      .filter((m) => m.user === botUserId || m.bot_id)
      .map((m) => ({ ts: m.ts, text: m.text }));
  }
}

// --- #5: Thread history loading ---

async function fetchThreadHistory(
  token: string,
  channelId: string,
  threadTs: string,
  limit: number = 20,
): Promise<{ role: string; text: string; user?: string; ts: string }[]> {
  // conversations.replies uses GET-style params — pass as query string via fetch
  const params = new URLSearchParams({
    channel: channelId,
    ts: threadTs,
    limit: String(limit),
    inclusive: "true",
  });
  const res = await fetch(`${SLACK_API}/conversations.replies?${params}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json() as {
    ok: boolean;
    error?: string;
    messages?: Array<{
      text: string;
      user?: string;
      bot_id?: string;
      ts: string;
    }>;
  };
  if (!data.ok) {
    throw new Error(`conversations.replies error: ${data.error ?? "unknown"}`);
  }

  return (data.messages ?? []).map((msg) => ({
    role: msg.bot_id ? "assistant" : "user",
    text: msg.text,
    user: msg.user,
    ts: msg.ts,
  }));
}

function formatThreadHistoryAsContext(
  messages: { role: string; text: string; user?: string; ts: string }[],
): string {
  if (messages.length === 0) return "";

  const lines = ["--- Thread History (previous messages) ---"];
  for (const msg of messages) {
    const sender = msg.role === "assistant" ? "Bot" : `User ${msg.user ?? "unknown"}`;
    lines.push(`[${sender}]: ${msg.text}`);
  }
  lines.push("--- End of Thread History ---");
  lines.push("");
  return lines.join("\n");
}

// --- Thread session key ---
// Slack threads are (channel + thread_ts) rather than a distinct channel ID.
// We prefix with "slk:" to avoid collisions with Discord thread IDs in sessions.json.

function slackThreadId(channelId: string, threadTs: string): string {
  return `slk:${channelId}:${threadTs}`;
}

// --- #6: File download (all types) ---

async function downloadSlackFile(
  token: string,
  file: SlackFile,
  type: "image" | "voice" | "document",
): Promise<string | null> {
  const url = file.url_private_download ?? file.url_private;
  if (!url) return null;

  const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "slack");
  await mkdir(dir, { recursive: true });

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Slack file download failed: ${res.status}`);
  }

  const defaultExt = type === "voice" ? ".webm" : type === "image" ? ".jpg" : "";
  const ext = extname(file.name ?? "") || defaultExt;
  const filename = `${file.id}-${Date.now()}${ext}`;
  const localPath = join(dir, filename);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await Bun.write(localPath, bytes);
  debugLog(`File downloaded: ${localPath} (${bytes.length} bytes)`);
  return localPath;
}

// --- #6: File upload ---

async function uploadFile(
  token: string,
  channelId: string,
  filePath: string,
  threadTs?: string,
  title?: string,
): Promise<void> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    debugLog(`Upload failed: file not found: ${filePath}`);
    return;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const filename = filePath.split("/").pop() ?? "file";

  // Step 1: Get upload URL (uses GET-style params)
  const params = new URLSearchParams({
    filename,
    length: String(bytes.byteLength),
  });
  const step1Res = await fetch(`${SLACK_API}/files.getUploadURLExternal?${params}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const step1Data = await step1Res.json() as { ok: boolean; error?: string; upload_url?: string; file_id?: string };
  if (!step1Data.ok || !step1Data.upload_url || !step1Data.file_id) {
    throw new Error(`files.getUploadURLExternal error: ${step1Data.error ?? "missing upload_url"}`);
  }

  // Step 2: Upload file content to the URL
  const uploadRes = await fetch(step1Data.upload_url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  if (!uploadRes.ok) {
    throw new Error(`File upload failed: ${uploadRes.status}`);
  }

  // Step 3: Complete upload and share to channel
  const fileObj: Record<string, unknown> = { id: step1Data.file_id };
  if (title) fileObj.title = title;
  await slackApi(token, "files.completeUploadExternal", {
    files: [fileObj],
    channel_id: channelId,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });

  console.log(`[Slack] File uploaded: ${filename} to ${channelId}`);
}

// --- #6: Upload directive extraction ---

function extractUploadDirectives(text: string): {
  cleanedText: string;
  uploads: { path: string; title?: string }[];
} {
  const uploads: { path: string; title?: string }[] = [];
  const cleaned = text
    .replace(/\[upload_file:([^\]]+)\]/gi, (_match, raw) => {
      const parts = String(raw).split("|");
      const path = parts[0].trim();
      const title = parts.length > 1 ? parts[1].trim() : undefined;
      if (path) uploads.push({ path, title });
      return "";
    })
    .trim();
  return { cleanedText: cleaned, uploads };
}

// --- #12: Read channel history directive ---

function extractChannelReadDirectives(text: string): {
  cleanedText: string;
  channelReads: { channelId: string; limit: number }[];
} {
  const channelReads: { channelId: string; limit: number }[] = [];
  const cleaned = text
    .replace(/\[read_channel:([A-Z0-9]+)(?::(\d+))?\]/gi, (_match, chId, lim) => {
      channelReads.push({ channelId: chId, limit: lim ? parseInt(lim, 10) : 20 });
      return "";
    })
    .trim();
  return { cleanedText: cleaned, channelReads };
}

async function fetchChannelHistory(
  token: string,
  channelId: string,
  limit: number = 20,
): Promise<string> {
  const params = new URLSearchParams({
    channel: channelId,
    limit: String(limit),
  });
  const res = await fetch(`${SLACK_API}/conversations.history?${params}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json() as {
    ok: boolean;
    error?: string;
    messages?: Array<{ text: string; user?: string; bot_id?: string; ts: string }>;
  };
  if (!data.ok) {
    return `Error reading channel ${channelId}: ${data.error ?? "unknown"}`;
  }
  const msgs = (data.messages ?? []).reverse();
  const lines = [`--- Channel ${channelId} History (${msgs.length} messages) ---`];
  for (const msg of msgs) {
    const sender = msg.bot_id ? "Bot" : `User ${msg.user ?? "unknown"}`;
    lines.push(`[${sender}]: ${msg.text}`);
  }
  lines.push("--- End ---");
  return lines.join("\n");
}

// --- #11: Message content sanitization ---

function sanitizeUserInput(text: string): string {
  // Strip any directive-like patterns from user input to prevent injection
  return text
    .replace(/\[react:[^\]]*\]/gi, "[react removed]")
    .replace(/\[edit_last\][\s\S]*?\[\/edit_last\]/gi, "[edit removed]")
    .replace(/\[delete_last(?::\d+)?\]/gi, "[delete removed]")
    .replace(/\[delete_all\]/gi, "[delete removed]")
    .replace(/\[delete_match:[^\]]*\]/gi, "[delete removed]")
    .replace(/\[upload_file:[^\]]*\]/gi, "[upload removed]")
    .replace(/\[read_channel:[^\]]*\]/gi, "[read removed]")
    .replace(/\[\[slack_buttons:[^\]]*\]\]/gi, "[buttons removed]")
    .replace(/\[\[slack_select:[^\]]*\]\]/gi, "[select removed]");
}

// --- Trigger check ---

function isImageFile(f: SlackFile): boolean {
  return Boolean(f.mimetype?.startsWith("image/"));
}

function isVoiceFile(f: SlackFile): boolean {
  return Boolean(
    f.mimetype?.startsWith("audio/") ||
    f.filetype === "webm" ||
    f.filetype === "mp4",
  );
}

function isDocumentFile(f: SlackFile): boolean {
  return !isImageFile(f) && !isVoiceFile(f) && Boolean(f.url_private);
}

function isBotMentioned(text: string): boolean {
  if (!botUserId) return false;
  return text.includes(`<@${botUserId}>`);
}

function isDM(event: SlackMessage): boolean {
  return event.channel_type === "im";
}

// --- Message handler ---

async function handleMessage(event: SlackMessage): Promise<void> {
  const config = getSettings().slack;

  // Ignore bot's own messages and other bot messages
  if (event.bot_id || !event.user) return;
  // Skip subtype messages (edits, joins, etc.) unless they are file_share
  if (event.subtype && event.subtype !== "file_share") return;

  // Deduplicate: Slack sends both message + app_mention for @mentions
  if (isDuplicate(event.channel, event.ts)) {
    debugLog(`Skipping duplicate: channel=${event.channel} ts=${event.ts}`);
    return;
  }

  const userId = event.user;
  const channelId = event.channel;
  const isDirectMessage = isDM(event);
  const isListenChannel = config.listenChannels.includes(channelId);
  const mentioned = isBotMentioned(event.text);

  // Determine if we should respond
  const isAssistantThread = assistantThreadChannels.has(channelId);
  if (!isDirectMessage && !mentioned && !isListenChannel && !isAssistantThread) {
    debugLog(`Skip channel=${channelId} user=${userId} text="${event.text.slice(0, 40)}"`);
    return;
  }

  // Authorization check
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    if (isDirectMessage) {
      await sendMessage(config.botToken, channelId, "Unauthorized.");
    }
    return;
  }

  // Strip mention from text
  let cleanText = event.text;
  if (botUserId) {
    cleanText = cleanText.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
  }

  const files = event.files ?? [];
  const imageFiles = files.filter(isImageFile);
  const voiceFiles = files.filter(isVoiceFile);
  const docFiles = files.filter(isDocumentFile);
  const hasImage = imageFiles.length > 0;
  const hasVoice = voiceFiles.length > 0;
  const hasDoc = docFiles.length > 0;

  if (!cleanText.trim() && !hasImage && !hasVoice && !hasDoc) return;

  const label = userId;
  const mediaParts = [hasImage ? "image" : "", hasVoice ? "voice" : ""].filter(Boolean);
  const mediaSuffix = mediaParts.length > 0 ? ` [${mediaParts.join("+")}]` : "";
  console.log(
    `[${new Date().toLocaleTimeString()}] Slack ${label}${mediaSuffix}: "${cleanText.slice(0, 60)}${cleanText.length > 60 ? "..." : ""}"`,
  );

  try {
    // Determine thread context for multi-session support.
    // event.thread_ts is set when the message is inside a thread.
    // For the root message of a thread it equals event.ts.
    // We use it to key per-thread sessions; non-thread messages go to global session.
    const inThread = !!event.thread_ts;
    const replyThreadTs = event.thread_ts ?? event.ts; // reply in same thread
    const sessionThreadId = inThread ? slackThreadId(channelId, event.thread_ts!) : undefined;

    // Handle /cancel — abort the in-flight Claude run for this thread/global key
    if (isCancelCommand(cleanText)) {
      const cancelled = cancelThread(sessionThreadId);
      const reply = cancelled ? CANCEL_CONFIRM_MESSAGE : CANCEL_NOTHING_MESSAGE;
      await sendMessage(config.botToken, channelId, reply, replyThreadTs);
      // React on the user's /cancel message itself for visual feedback
      if (cancelled) {
        await sendReaction(config.botToken, channelId, event.ts, "octagonal_sign").catch(() => {});
      }
      return;
    }

    // Recover lost thread from sessions.json if needed
    if (inThread && sessionThreadId) {
      const persisted = await peekThreadSession(sessionThreadId);
      if (persisted) {
        debugLog(`Thread session recovered: ${sessionThreadId}`);
      }
    }

    // #5: Load thread history for new thread sessions
    let threadHistoryContext = "";
    if (inThread && sessionThreadId && !threadHistoryLoaded.has(sessionThreadId)) {
      const existingSession = await peekThreadSession(sessionThreadId);
      if (!existingSession) {
        try {
          const history = await fetchThreadHistory(config.botToken, channelId, event.thread_ts!, 20);
          const pastMessages = history.filter((m) => m.ts !== event.ts);
          if (pastMessages.length > 0) {
            threadHistoryContext = formatThreadHistoryAsContext(pastMessages);
            debugLog(`Loaded ${pastMessages.length} thread history messages for ${sessionThreadId}`);
          }
        } catch (err) {
          debugLog(`Failed to load thread history: ${err instanceof Error ? err.message : err}`);
        }
      }
      threadHistoryLoaded.add(sessionThreadId);
    }

    const imagePaths: string[] = [];
    const voiceTranscripts: string[] = [];
    let voiceVocabHint = "";
    const docPaths: { path: string; name: string }[] = [];

    if (hasImage) {
      for (const imgFile of imageFiles) {
        try {
          const p = await downloadSlackFile(config.botToken, imgFile, "image");
          if (p) imagePaths.push(p);
        } catch (err) {
          console.error(`[Slack] Failed to download image: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    if (hasVoice) {
      for (const voiceFile of voiceFiles) {
        let voicePath: string | null = null;
        try {
          voicePath = await downloadSlackFile(config.botToken, voiceFile, "voice");
        } catch (err) {
          console.error(`[Slack] Failed to download voice: ${err instanceof Error ? err.message : err}`);
        }
        if (voicePath) {
          try {
            const result = await transcribeAudioToText(voicePath, {
              debug: slackDebug,
              log: (msg) => debugLog(msg),
            });
            if (result.text) voiceTranscripts.push(result.text);
            if (result.vocabHint) voiceVocabHint = result.vocabHint;
          } catch (err) {
            console.error(`[Slack] Failed to transcribe voice: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }

    // #6: Download document files
    if (hasDoc) {
      for (const docFile of docFiles) {
        try {
          const docPath = await downloadSlackFile(config.botToken, docFile, "document");
          if (docPath) {
            docPaths.push({ path: docPath, name: docFile.name ?? "unknown" });
          }
        } catch (err) {
          console.error(`[Slack] Failed to download doc: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Skill routing
    const command = cleanText.startsWith("/") ? cleanText.trim().split(/\s+/, 1)[0].toLowerCase() : null;
    let skillContext: string | null = null;
    if (command) {
      try {
        skillContext = await resolveSkillPrompt(command);
      } catch (err) {
        debugLog(`Skill resolution failed for ${command}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Build prompt
    const slackDirectives = await loadSlackDirectives();
    const channelType = isDirectMessage ? "DM" : inThread ? "thread" : "channel";
    const promptParts = [`[Slack from ${label} in ${channelType} ${channelId}${inThread ? ` thread ${event.thread_ts}` : ""}]`];
    if (slackDirectives) {
      promptParts.push(slackDirectives);
    }
    // #5: Prepend thread history context
    if (threadHistoryContext) {
      promptParts.push(threadHistoryContext);
    }
    if (skillContext) {
      const args = cleanText.trim().slice(command!.length).trim();
      promptParts.push(`<command-name>${command}</command-name>`);
      promptParts.push(skillContext);
      if (args) promptParts.push(`User arguments: ${args}`);
    } else if (cleanText.trim()) {
      promptParts.push(`Message: ${cleanText}`);
    }
    if (imagePaths.length > 0) {
      for (const p of imagePaths) {
        promptParts.push(`Image path: ${p}`);
      }
      const noun = imagePaths.length === 1 ? "an image" : `${imagePaths.length} images`;
      const target = imagePaths.length === 1 ? "this image file" : "each of these image files";
      promptParts.push(`The user attached ${noun}. Inspect ${target} directly before answering.`);
    } else if (hasImage) {
      promptParts.push("The user attached image(s), but downloading failed. Respond and ask them to resend.");
    }
    if (voiceTranscripts.length === 1) {
      promptParts.push(`Voice transcript: ${voiceTranscripts[0]}`);
      promptParts.push("The user attached voice audio. Use the transcript as their spoken message.");
      if (voiceVocabHint) promptParts.push(voiceVocabHint);
    } else if (voiceTranscripts.length > 1) {
      voiceTranscripts.forEach((t, i) => {
        promptParts.push(`Voice transcript ${i + 1}: ${t}`);
      });
      promptParts.push("The user attached multiple voice clips. Treat the transcripts in order as their spoken messages.");
      if (voiceVocabHint) promptParts.push(voiceVocabHint);
    } else if (hasVoice) {
      promptParts.push("The user attached voice audio, but it could not be transcribed. Ask them to resend a clearer clip.");
    }
    // #6: Document files
    if (docPaths.length > 0) {
      for (const doc of docPaths) {
        promptParts.push(`Attached file "${doc.name}": ${doc.path}`);
      }
      promptParts.push("The user attached file(s). Read and analyze them as needed.");
    } else if (hasDoc) {
      promptParts.push("The user attached file(s), but downloading failed. Ask them to resend.");
    }

    const prefixedPrompt = promptParts.join("\n");

    // Show "thinking" status via Assistant API
    await setAssistantStatus(config.botToken, channelId, replyThreadTs, "Thinking...");

    // Add thinking reaction
    await sendReaction(config.botToken, channelId, event.ts, "hourglass_flowing_sand");

    // Periodically refresh assistant status to prevent Slack auto-expiry
    const statusRefreshInterval = setInterval(async () => {
      await setAssistantStatus(config.botToken, channelId, replyThreadTs, "Thinking...").catch(() => {});
    }, 20_000);

    // --- Streaming reply (#1) ---
    // Defer posting until first text chunk arrives, then throttle updates.
    let streamMsgTs: string | null = null;
    let streamMsgPromise: Promise<string | null> | null = null;
    let streamText = "";
    let lastStreamUpdate = 0;
    let finalResultText: string | null = null;

    try {
      await streamUserMessage(
        "slack",
        prefixedPrompt,
        (text: string) => {
          streamText = text;
          const now = Date.now();

          if (!streamMsgPromise) {
            // First chunk — post the message with real text (no placeholder)
            streamMsgPromise = postMessage(config.botToken, channelId, streamText, replyThreadTs);
            streamMsgPromise.then(ts => { streamMsgTs = ts; }).catch(() => {});
            lastStreamUpdate = now;
          } else if (streamMsgTs && now - lastStreamUpdate >= STREAM_UPDATE_INTERVAL_MS) {
            lastStreamUpdate = now;
            updateMessage(config.botToken, channelId, streamMsgTs, streamText).catch(() => {});
          }
        },
        () => { /* onUnblock */ },
        sessionThreadId,
        (text: string) => { finalResultText = text; },
      );
    } catch (err) {
      clearInterval(statusRefreshInterval);
      await removeReaction(config.botToken, channelId, event.ts, "hourglass_flowing_sand");
      await clearAssistantStatus(config.botToken, channelId, replyThreadTs);
      const errMsg = err instanceof Error ? err.message : String(err);
      // Ensure deferred post resolved before updating
      if (streamMsgPromise) streamMsgTs = await streamMsgPromise;
      if (streamMsgTs) {
        await updateMessage(config.botToken, channelId, streamMsgTs, `Error: ${errMsg}`);
      } else {
        await sendMessage(config.botToken, channelId, `Error: ${errMsg}`, replyThreadTs);
      }
      throw err;
    }

    // Ensure deferred post resolved
    if (streamMsgPromise) streamMsgTs = await streamMsgPromise;

    // Stop refreshing status
    clearInterval(statusRefreshInterval);

    const responseText = finalResultText ?? streamText;

    if (!responseText) {
      // Empty response
      await removeReaction(config.botToken, channelId, event.ts, "hourglass_flowing_sand");
      await clearAssistantStatus(config.botToken, channelId, replyThreadTs);
      if (streamMsgTs) {
        await updateMessage(config.botToken, channelId, streamMsgTs, "(empty response)");
        lastBotMessageTs.set(botMessageKey(channelId, replyThreadTs), streamMsgTs);
      } else {
        const sentTs = await postMessage(config.botToken, channelId, "(empty response)", replyThreadTs);
        if (sentTs) lastBotMessageTs.set(botMessageKey(channelId, replyThreadTs), sentTs);
      }
    } else {
      // Extract all directives
      const { cleanedText: afterReact, reactionEmoji } = extractReactionDirective(responseText);
      const { cleanedText: afterEdit, editContent, deleteCount, deleteMatches } = extractEditDirective(afterReact);
      const { cleanedText: afterUpload, uploads } = extractUploadDirectives(afterEdit);
      const { cleanedText: afterChannelRead, channelReads } = extractChannelReadDirectives(afterUpload);
      const { cleanedText: finalText, buttons, select } = extractBlockKitDirectives(afterChannelRead);

      if (reactionEmoji) {
        await sendReaction(config.botToken, channelId, event.ts, reactionEmoji);
      }

      // #4: Handle edit/delete of bot messages via API history lookup
      const msgKey = botMessageKey(channelId, replyThreadTs);

      if (deleteCount !== 0 || deleteMatches.length > 0) {
        try {
          const botMessages = await fetchBotMessages(config.botToken, channelId, replyThreadTs);
          let toDelete: { ts: string; text: string }[] = [];

          if (deleteCount === -1) {
            toDelete = botMessages;
          } else if (deleteCount > 0) {
            toDelete = botMessages.slice(0, deleteCount);
          }

          // Match specific messages by content
          if (deleteMatches.length > 0) {
            for (const pattern of deleteMatches) {
              const lowerPattern = pattern.toLowerCase();
              const matched = botMessages.filter((m) =>
                m.text.toLowerCase().includes(lowerPattern) && !toDelete.some((d) => d.ts === m.ts)
              );
              toDelete.push(...matched);
            }
          }

          for (const msg of toDelete) {
            await deleteMessage(config.botToken, channelId, msg.ts);
          }
          debugLog(`Deleted ${toDelete.length} bot messages`);
          lastBotMessageTs.delete(msgKey);
        } catch (err) {
          debugLog(`Failed to delete bot messages: ${err instanceof Error ? err.message : err}`);
        }
      }

      if (editContent) {
        try {
          const lastTs = lastBotMessageTs.get(msgKey);
          if (lastTs) {
            await updateMessage(config.botToken, channelId, lastTs, editContent);
            debugLog(`Edited last bot message: ${lastTs}`);
          } else {
            // Fallback: fetch from API
            const botMessages = await fetchBotMessages(config.botToken, channelId, replyThreadTs);
            if (botMessages.length > 0) {
              await updateMessage(config.botToken, channelId, botMessages[0].ts, editContent);
              debugLog(`Edited bot message (from history): ${botMessages[0].ts}`);
            }
          }
        } catch (err) {
          debugLog(`Failed to edit bot message: ${err instanceof Error ? err.message : err}`);
        }
      }

      // #6: Handle file uploads
      for (const upload of uploads) {
        try {
          console.log(`[Slack] Uploading file: ${upload.path}`);
          await uploadFile(config.botToken, channelId, upload.path, replyThreadTs, upload.title);
          console.log(`[Slack] File uploaded: ${upload.path}`);
        } catch (err) {
          console.error(`[Slack] Failed to upload file: ${err instanceof Error ? err.message : err}`);
        }
      }

      // #12: Handle channel read directives — fetch and send as follow-up message to agent
      for (const read of channelReads) {
        try {
          const history = await fetchChannelHistory(config.botToken, read.channelId, read.limit);
          const historyPath = join(process.cwd(), ".claude", "claudeclaw", "inbox", "slack", `channel-${read.channelId}-${Date.now()}.txt`);
          await mkdir(join(process.cwd(), ".claude", "claudeclaw", "inbox", "slack"), { recursive: true });
          await Bun.write(historyPath, history);
          // Send follow-up to agent with channel history (non-streaming, secondary operation)
          const followUp = `[System] Channel history for ${read.channelId} saved to: ${historyPath}\nPlease read this file and summarize or respond based on the user's request.`;
          await runUserMessage("slack", followUp, sessionThreadId);
          debugLog(`Channel history fetched: ${read.channelId} → ${historyPath}`);
        } catch (err) {
          debugLog(`Failed to fetch channel history: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Finalize response — update streaming message or replace with Block Kit
      if (finalText) {
        if (buttons || select) {
          // Block Kit needs a fresh message; remove streaming message
          if (streamMsgTs) await deleteMessage(config.botToken, channelId, streamMsgTs);
          const sentTs = await sendBlockKitMessage(config.botToken, channelId, finalText, buttons, select, replyThreadTs);
          if (sentTs) lastBotMessageTs.set(msgKey, sentTs);
        } else if (finalText.length > 3800) {
          // Update streaming message with first chunk, post remaining chunks
          if (streamMsgTs) {
            await updateMessage(config.botToken, channelId, streamMsgTs, finalText.slice(0, 3800));
            lastBotMessageTs.set(msgKey, streamMsgTs);
          }
          for (let i = 3800; i < finalText.length; i += 3800) {
            const chunkTs = await postMessage(config.botToken, channelId, finalText.slice(i, i + 3800), replyThreadTs);
            if (chunkTs) lastBotMessageTs.set(msgKey, chunkTs);
          }
        } else {
          // Simple case — update streaming message with final cleaned text
          if (streamMsgTs) {
            await updateMessage(config.botToken, channelId, streamMsgTs, finalText);
            lastBotMessageTs.set(msgKey, streamMsgTs);
          }
        }
      } else if (streamMsgTs && !editContent && deleteCount === 0 && uploads.length === 0 && channelReads.length === 0) {
        // No text, no directives — show empty
        await updateMessage(config.botToken, channelId, streamMsgTs, "(empty response)");
        lastBotMessageTs.set(msgKey, streamMsgTs);
      } else if (streamMsgTs) {
        // Directives handled but no visible text — remove streaming message
        await deleteMessage(config.botToken, channelId, streamMsgTs);
      }

      // Remove thinking reaction and status AFTER reply is sent
      await removeReaction(config.botToken, channelId, event.ts, "hourglass_flowing_sand");
      await clearAssistantStatus(config.botToken, channelId, replyThreadTs);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Slack] Error for ${label}: ${errMsg}`);
    // Clear thinking reaction and status on error
    await removeReaction(config.botToken, channelId, event.ts, "hourglass_flowing_sand");
    await clearAssistantStatus(config.botToken, event.channel, event.thread_ts ?? event.ts);
    await sendMessage(
      config.botToken,
      event.channel,
      `Error: ${errMsg}`,
      event.thread_ts ?? event.ts,
    );
  }
}

// --- #3: Block action handler ---

async function handleBlockAction(payload: any): Promise<void> {
  const config = getSettings().slack;
  const actions = payload.actions as Array<{
    action_id: string;
    value?: string;
    type: string;
    selected_option?: { value: string; text: { text: string } };
  }>;
  const user = payload.user as { id: string; username?: string };
  const channelId = (payload.channel as { id: string })?.id;
  const message = payload.message as { ts: string; thread_ts?: string } | undefined;
  const container = payload.container as { thread_ts?: string } | undefined;

  if (!actions?.length || !channelId || !user?.id) return;

  // Authorization check
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(user.id)) {
    return;
  }

  const action = actions[0];
  const actionId = action.action_id;
  const value = action.type === "static_select"
    ? action.selected_option?.value ?? ""
    : action.value ?? actionId;
  const label = action.type === "static_select"
    ? action.selected_option?.text?.text ?? value
    : value;

  // Freeze the original button message so anyone scrolling back through the
  // thread can see which option was picked and by whom. We do this before
  // kicking off the Claude turn so the visual state is consistent even if
  // the streaming reply takes a while to arrive.
  const clickedMessageTs = (payload.message as { ts?: string } | undefined)?.ts;
  const messageBlocks = (payload.message as any)?.blocks as any[] | undefined;
  const messageFallbackText = (payload.message as { text?: string } | undefined)?.text ?? "";
  if (clickedMessageTs) {
    await freezeMessageWithChoice(
      config.botToken,
      channelId,
      clickedMessageTs,
      messageBlocks,
      messageFallbackText,
      user.id,
      label,
    );
  }

  // Resolve thread context for session continuity.
  // message.thread_ts is the thread root (only present when the button message is inside a thread).
  // container.thread_ts is a fallback source for the same value.
  // IMPORTANT: Do NOT fall back to message.ts — that's the button message's own ts,
  // which would create a brand-new session instead of continuing the existing conversation.
  const threadTs = message?.thread_ts ?? container?.thread_ts;
  const inThread = !!threadTs;
  const replyThreadTs = threadTs ?? message?.ts; // still reply in the button's thread or as a new thread
  let sessionThreadId = inThread ? slackThreadId(channelId, threadTs!) : undefined;

  // Fall back to global session when no thread session exists for this threadId.
  // This handles the case where a top-level message used the global session and
  // replied in a thread — the button click sees a thread but should continue
  // in the global session, not create a new one.
  if (sessionThreadId) {
    const existingThread = await peekThreadSession(sessionThreadId);
    if (!existingThread) {
      sessionThreadId = undefined;
    }
  }

  console.log(
    `[${new Date().toLocaleTimeString()}] Slack ${user.id} [interactive]: "${actionId}" = "${value}"`,
  );

  // Show thinking status and reaction
  const messageTs = message?.ts;
  if (replyThreadTs) {
    await setAssistantStatus(config.botToken, channelId, replyThreadTs, "Processing...");
  }
  if (messageTs) {
    await sendReaction(config.botToken, channelId, messageTs, "hourglass_flowing_sand");
  }

  // Periodically refresh assistant status to prevent Slack auto-expiry
  const statusRefreshInterval = replyThreadTs
    ? setInterval(async () => {
        await setAssistantStatus(config.botToken, channelId, replyThreadTs, "正在處理中...").catch(() => {});
      }, 20_000)
    : null;

  const prompt = `[Slack interactive from ${user.id}]\nUser clicked: "${label}" (action: ${actionId}, value: ${value})`;

  // --- Streaming reply for interactive actions (deferred post) ---
  let streamMsgTs: string | null = null;
  let streamMsgPromise: Promise<string | null> | null = null;
  let streamText = "";
  let lastStreamUpdate = 0;
  let finalResultText: string | null = null;

  try {
    await streamUserMessage(
      "slack",
      prompt,
      (text: string) => {
        streamText = text;
        const now = Date.now();
        if (!streamMsgPromise) {
          streamMsgPromise = postMessage(config.botToken, channelId, streamText, replyThreadTs);
          streamMsgPromise.then(ts => { streamMsgTs = ts; }).catch(() => {});
          lastStreamUpdate = now;
        } else if (streamMsgTs && now - lastStreamUpdate >= STREAM_UPDATE_INTERVAL_MS) {
          lastStreamUpdate = now;
          updateMessage(config.botToken, channelId, streamMsgTs, streamText).catch(() => {});
        }
      },
      () => {},
      sessionThreadId,
      (text: string) => { finalResultText = text; },
    );
  } catch (err) {
    if (statusRefreshInterval) clearInterval(statusRefreshInterval);
    if (messageTs) await removeReaction(config.botToken, channelId, messageTs, "hourglass_flowing_sand");
    if (replyThreadTs) await clearAssistantStatus(config.botToken, channelId, replyThreadTs);
    if (streamMsgPromise) streamMsgTs = await streamMsgPromise;
    const errMsg = err instanceof Error ? err.message : String(err);
    if (streamMsgTs) {
      await updateMessage(config.botToken, channelId, streamMsgTs, `Error: ${errMsg}`);
    } else {
      await sendMessage(config.botToken, channelId, `Error: ${errMsg}`, replyThreadTs);
    }
    return;
  }

  if (streamMsgPromise) streamMsgTs = await streamMsgPromise;
  if (statusRefreshInterval) clearInterval(statusRefreshInterval);

  const responseText = finalResultText ?? streamText;
  if (responseText) {
    const { cleanedText } = extractReactionDirective(responseText);
    const { cleanedText: finalText, buttons, select } = extractBlockKitDirectives(cleanedText);

    if (finalText) {
      const msgKey = botMessageKey(channelId, replyThreadTs);
      if (buttons || select) {
        if (streamMsgTs) await deleteMessage(config.botToken, channelId, streamMsgTs);
        const sentTs = await sendBlockKitMessage(config.botToken, channelId, finalText, buttons, select, replyThreadTs);
        if (sentTs) lastBotMessageTs.set(msgKey, sentTs);
      } else {
        if (streamMsgTs) {
          await updateMessage(config.botToken, channelId, streamMsgTs, finalText);
          lastBotMessageTs.set(msgKey, streamMsgTs);
        }
      }
    } else if (streamMsgTs) {
      await deleteMessage(config.botToken, channelId, streamMsgTs);
    }
  } else if (streamMsgTs) {
    await updateMessage(config.botToken, channelId, streamMsgTs, "(empty response)");
  } else {
    const sentTs = await postMessage(config.botToken, channelId, "(empty response)", replyThreadTs);
    if (sentTs) lastBotMessageTs.set(botMessageKey(channelId, replyThreadTs), sentTs);
  }

  // Remove thinking reaction and status AFTER reply is sent
  if (messageTs) {
    await removeReaction(config.botToken, channelId, messageTs, "hourglass_flowing_sand");
  }
  if (replyThreadTs) {
    await clearAssistantStatus(config.botToken, channelId, replyThreadTs);
  }
}

// --- Slash command handler ---

async function handleSlashCommand(
  _token: string,
  command: string,
  _channelId: string,
  userId: string,
): Promise<string> {
  const config = getSettings().slack;

  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    return "Unauthorized.";
  }

  switch (command) {
    case "/reset": {
      await resetSession();
      return "Session reset. Fresh start!";
    }

    case "/compact": {
      const result = await compactCurrentSession();
      if (!result.success) {
        return `Compact failed: ${result.message}`;
      }
      return result.message || "Session compacted.";
    }

    case "/status": {
      const session = await peekSession();
      const threadSessions = await listThreadSessions();
      const lines: string[] = [];

      if (session) {
        lines.push(`*Global session*`);
        lines.push(`  ID: \`${session.sessionId.slice(0, 8)}...\``);
        lines.push(`  Turns: ${session.turnCount}`);
        lines.push(`  Last used: ${new Date(session.lastUsedAt).toLocaleString()}`);
      } else {
        lines.push("No active global session.");
      }

      const slackThreads = threadSessions.filter((ts) => ts.threadId.startsWith("slk:"));
      if (slackThreads.length > 0) {
        lines.push("");
        lines.push(`*Thread sessions* (${slackThreads.length})`);
        const shown = slackThreads.slice(0, 5);
        for (const ts of shown) {
          const parts = ts.threadId.split(":");
          const label = parts.length === 3 ? `#${parts[1]}:${parts[2]}` : ts.threadId;
          lines.push(`  ${label} — ${ts.turnCount} turns`);
        }
        if (slackThreads.length > 5) {
          lines.push(`  ... and ${slackThreads.length - 5} more`);
        }
      }

      lines.push("");
      lines.push(`Security: \`${config.allowedUserIds.length === 0 ? "open" : "restricted"}\``);

      return lines.join("\n");
    }

    default:
      return `Unknown command: ${command}`;
  }
}

// --- Socket payload handler ---

async function handleSocketPayload(
  raw: string,
  sendAck: (envelopeId: string, responsePayload?: unknown) => void,
): Promise<void> {
  let data: SlackSocketPayload;
  try {
    data = JSON.parse(raw) as SlackSocketPayload;
  } catch (err) {
    debugLog(`Failed to parse socket payload: ${err}`);
    return;
  }

  // Slack always expects an ACK within 3 seconds to prevent retry
  if (data.envelope_id) {
    // ACK immediately (before async processing) unless we return a response
    if (!data.accepts_response_payload) {
      sendAck(data.envelope_id);
    }
  }

  const type = data.type;

  if (type === "hello") {
    console.log("[Slack] Socket connected");
    return;
  }

  if (type === "disconnect") {
    const reason = data.reason ?? data.payload?.reason ?? "unknown";
    console.log(`[Slack] Server disconnect: ${reason}`);
    if (reason === "link_disabled") {
      ws?.close(4100, `disconnect:${reason}`);
    } else if (reason === "too_many_websockets") {
      ws?.close(4200, `disconnect:${reason}`);
    } else {
      ws?.close(4000, `disconnect:${reason}`);
    }
    return;
  }

  if (type === "events_api" && data.payload?.event) {
    const event = data.payload.event;

    // Handle Assistant thread started — user opened the assistant panel
    if (event.type === "assistant_thread_started") {
      const threadChannel = (event as any).assistant_thread?.channel_id;
      const threadTs = (event as any).assistant_thread?.thread_ts;
      if (threadChannel) {
        assistantThreadChannels.add(threadChannel);
        debugLog(`Assistant thread started: channel=${threadChannel} ts=${threadTs}`);
        const config = getSettings().slack;
        // Set suggested prompts for the new thread
        if (threadChannel && threadTs) {
          await setAssistantSuggestedPrompts(config.botToken, threadChannel, threadTs, [
            { title: "Project status", message: "What is the current status of the project?" },
            { title: "Analyze", message: "Please help me analyze..." },
          ]);
        }
      }
      return;
    }

    // Handle Assistant thread context changed
    if (event.type === "assistant_thread_context_changed") {
      const threadChannel = (event as any).assistant_thread?.channel_id;
      if (threadChannel) {
        assistantThreadChannels.add(threadChannel);
        debugLog(`Assistant thread context changed: channel=${threadChannel}`);
      }
      return;
    }

    if (event.type === "message" || event.type === "app_mention") {
      await handleMessage(event).catch((err) => {
        console.error(`[Slack] handleMessage error: ${err instanceof Error ? err.message : err}`);
      });
    }
    return;
  }

  if (type === "slash_commands" && data.payload) {
    const p = data.payload;
    const command = p.command ?? "";
    const channelId = p.channel_id ?? "";
    const userId = p.user_id ?? "";
    const config = getSettings().slack;

    const responseText = await handleSlashCommand(config.botToken, command, channelId, userId).catch(
      (err) => `Error: ${err instanceof Error ? err.message : String(err)}`,
    );

    // For slash commands, Slack expects the response in the ACK itself
    if (data.accepts_response_payload) {
      sendAck(data.envelope_id!, { text: responseText });
    } else {
      sendAck(data.envelope_id!);
      // Fallback: post as message
      await sendMessage(config.botToken, channelId, responseText).catch(() => {});
    }
    return;
  }

  // #3: Handle interactive events (button clicks, select menus)
  if (type === "interactive" && data.payload) {
    const interactivePayload = data.payload as any;
    if (data.accepts_response_payload) {
      sendAck(data.envelope_id!);
    }
    if (interactivePayload.type === "block_actions") {
      await handleBlockAction(interactivePayload).catch((err) => {
        console.error(`[Slack] handleBlockAction error: ${err instanceof Error ? err.message : err}`);
      });
    }
    return;
  }

  debugLog(`Unhandled socket event type: ${type}`);
}

// --- Socket connection (OpenClaw-style while-loop + AbortSignal) ---

const PROACTIVE_RECONNECT_MS = 29 * 60 * 1000; // 29 min — before Slack's 30-min forced rotation

/** Fetch a fresh Socket Mode WebSocket URL from Slack. */
async function fetchSocketUrl(appToken: string): Promise<string> {
  const res = await fetch(`${SLACK_API}/apps.connections.open`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const data: any = await res.json();
  if (!data.ok || !data.url) {
    throw new Error(`apps.connections.open failed: ${data.error ?? "no URL returned"}`);
  }
  return data.url as string;
}

/**
 * Open a WebSocket and return a promise that resolves when it closes.
 * The proactive 29-min rotation timer is tracked and cleaned up properly.
 */
function openSocket(url: string, appToken: string, signal: AbortSignal): Promise<{
  event: "close" | "error";
  code?: number;
  reason?: string;
  error?: unknown;
  openedAt?: number;
}> {
  return new Promise((resolve) => {
    debugLog(`Opening WebSocket: ${url.slice(0, 60)}...`);
    const openedAt = Date.now();

    // Clean up previous socket if somehow still open
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.onclose = null;
      ws.onerror = null;
      try { ws.close(1000, "Replaced"); } catch { /* best-effort */ }
    }

    ws = new WebSocket(url);
    let resolved = false;

    const resolveOnce = (value: { event: "close" | "error"; code?: number; reason?: string; error?: unknown; openedAt?: number }) => {
      if (resolved) return;
      resolved = true;
      // Clean up proactive timer
      if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };

    ws.onopen = () => {
      connectionCount++;
      lastEventAt = Date.now();
      debugLog(`WebSocket opened (connection #${connectionCount})`);
    };

    ws.onmessage = (event) => {
      lastEventAt = Date.now();
      const raw = String(event.data);
      const currentWs = ws;
      const sendAck = (envelopeId: string, payload?: unknown) => {
        if (currentWs?.readyState === WebSocket.OPEN) {
          const msg: Record<string, unknown> = { envelope_id: envelopeId };
          if (payload !== undefined) msg.payload = payload;
          currentWs.send(JSON.stringify(msg));
        }
      };
      handleSocketPayload(raw, sendAck).catch((err) => {
        console.error(`[Slack] Socket payload error: ${err instanceof Error ? err.message : err}`);
      });
    };

    ws.onclose = (event) => {
      debugLog(`WebSocket closed: code=${event.code} reason=${event.reason}`);
      ws = null;
      resolveOnce({ event: "close", code: event.code, reason: event.reason, openedAt });
    };

    ws.onerror = (event) => {
      // onclose normally fires after onerror — but if it doesn't, resolve here
      const err = (event as ErrorEvent).error ?? (event as ErrorEvent).message ?? "unknown";
      resolveOnce({ event: "error", error: err, openedAt });
    };

    // Proactive reconnect: close gracefully at 29 min (tracked, single timer)
    if (proactiveTimer) clearTimeout(proactiveTimer);
    proactiveTimer = setTimeout(() => {
      proactiveTimer = null;
      if (signal.aborted) return;
      debugLog("Proactive reconnect (29-min rotation)");
      ws?.close(1000, "Proactive reconnect");
    }, PROACTIVE_RECONNECT_MS);

    // Abort handler — external stop request
    function onAbort() {
      if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
      if (ws) {
        try { ws.close(1000, "Stop requested"); } catch { /* best-effort */ }
      }
      resolveOnce({ event: "close", code: 1000, reason: "Stop requested", openedAt });
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Main connection loop — keeps reconnecting until aborted.
 * Modeled after OpenClaw's monitorSlackProvider pattern:
 * while-loop + exponential backoff + auth error detection.
 */
async function socketLoop(appToken: string, signal: AbortSignal): Promise<void> {
  let reconnectAttempts = 0;

  while (!signal.aborted) {
    // Phase 1: get a WebSocket URL
    let url: string;
    try {
      debugLog("Fetching Socket Mode URL...");
      url = await fetchSocketUrl(appToken);
    } catch (err) {
      if (signal.aborted) break;

      if (isNonRecoverableAuthError(err)) {
        console.error(`[Slack] Non-recoverable auth error — stopping: ${err instanceof Error ? err.message : err}`);
        break;
      }

      reconnectAttempts++;
      if (RECONNECT_POLICY.maxAttempts > 0 && reconnectAttempts >= RECONNECT_POLICY.maxAttempts) {
        console.error(`[Slack] Max reconnect attempts (${RECONNECT_POLICY.maxAttempts}) reached, giving up`);
        break;
      }

      const delayMs = computeBackoff(RECONNECT_POLICY, reconnectAttempts);
      console.error(`[Slack] Failed to fetch socket URL, retry ${reconnectAttempts}/${RECONNECT_POLICY.maxAttempts} in ${Math.round(delayMs / 1000)}s: ${err instanceof Error ? err.message : err}`);

      try { await sleepWithAbort(delayMs, signal); } catch { break; }
      continue;
    }

    // Phase 2: connect and wait for disconnect
    try {
      const disconnect = await openSocket(url, appToken, signal);

      if (signal.aborted) break;

      if (disconnect.error && isNonRecoverableAuthError(disconnect.error)) {
        console.error(`[Slack] Non-recoverable auth error during connection — stopping`);
        break;
      }

      // link_disabled — Socket Mode turned off, no point retrying
      if (disconnect.code === 4100) {
        console.error(`[Slack] Socket Mode disabled (link_disabled) — stopping`);
        break;
      }

      // Only reset attempts if the connection was stable (>30s alive)
      const connectionDuration = disconnect.openedAt ? Date.now() - disconnect.openedAt : 0;
      const wasStable = connectionDuration > 30_000;

      if (disconnect.code === 1000 && wasStable) {
        reconnectAttempts = 0;
      }

      // too_many_websockets: Slack server still tracks a stale socket from us.
      // No amount of fast retrying will help — wait for server-side GC, don't
      // burn the retry budget. (See issue #1.)
      const isTooManyWs = disconnect.code === 4200
        || (disconnect.reason ?? "").includes("too_many_websockets");

      if (isTooManyWs) {
        const delayMs = 5 * 60_000 + Math.round(Math.random() * 60_000); // 5–6 min
        console.log(`[Slack] too_many_websockets — Slack server still has a stale slot, waiting ${Math.round(delayMs / 1000)}s before retry (no attempt counter)`);
        // Wait for previous ws to fully close before next attempt
        await waitForWsClosed();
        try { await sleepWithAbort(delayMs, signal); } catch { break; }
        continue;
      }

      reconnectAttempts++;
      if (RECONNECT_POLICY.maxAttempts > 0 && reconnectAttempts >= RECONNECT_POLICY.maxAttempts) {
        console.error(`[Slack] Max reconnect attempts (${RECONNECT_POLICY.maxAttempts}) reached, giving up`);
        break;
      }

      // Quick reconnect only for proactive rotation (code 1000 + stable)
      // Everything else uses exponential backoff
      const delayMs = (disconnect.code === 1000 && wasStable)
        ? Math.round(1000 + Math.random() * 2000)
        : computeBackoff(RECONNECT_POLICY, reconnectAttempts);

      const reason = disconnect.reason || disconnect.event;
      console.log(`[Slack] Disconnected (${reason}), reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${reconnectAttempts}/${RECONNECT_POLICY.maxAttempts}, alive ${Math.round(connectionDuration / 1000)}s)`);

      // Ensure previous ws is fully closed before opening a new one
      await waitForWsClosed();
      try { await sleepWithAbort(delayMs, signal); } catch { break; }
    } catch (err) {
      if (signal.aborted) break;
      console.error(`[Slack] Unexpected error in socket loop: ${err instanceof Error ? err.message : err}`);
      reconnectAttempts++;
      const delayMs = computeBackoff(RECONNECT_POLICY, reconnectAttempts);
      try { await sleepWithAbort(delayMs, signal); } catch { break; }
    }
  }

  // Cleanup
  if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
  if (ws) {
    try { ws.close(1000, "Loop ended"); } catch { /* best-effort */ }
    ws = null;
  }
  debugLog("Socket loop ended");
}

// --- Exports ---

export { sendMessage };

export async function sendMessageToUser(
  token: string,
  userId: string,
  text: string,
): Promise<void> {
  const data = await slackApi<{ channel: { id: string } }>(token, "conversations.open", {
    users: userId,
  });
  await sendMessage(token, data.channel.id, text);
}

export function stopSlack(): void {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  // Belt-and-suspenders: clean up anything the abort handler might miss
  if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
  if (ws) {
    try { ws.close(1000, "Stop requested"); } catch { /* best-effort */ }
    ws = null;
  }
}

/**
 * Async stop: close ws gracefully and wait for the close frame to be flushed
 * before resolving. Prevents Slack server from holding a stale slot, which
 * would cause too_many_websockets on the next startup. (See issue #1.)
 */
export async function stopSlackGraceful(timeoutMs = 2_000): Promise<void> {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
  await waitForWsClosed(timeoutMs);
  ws = null;
}

export function startSlack(debug = false): void {
  slackDebug = debug;
  const config = getSettings().slack;

  // Stop previous instance cleanly
  if (abortController) stopSlack();

  // Fresh AbortController for this session
  abortController = new AbortController();
  const signal = abortController.signal;
  connectionCount = 0;
  lastEventAt = 0;

  console.log("Slack bot started (Socket Mode)");
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
  if (config.listenChannels.length > 0) {
    console.log(`  Listen channels: ${config.listenChannels.join(", ")}`);
  }
  if (slackDebug) console.log("  Debug: enabled");

  (async () => {
    await ensureProjectClaudeMd();

    // Resolve bot identity
    try {
      const authData = await slackApi<{ user_id: string; user: string }>(
        config.botToken,
        "auth.test",
        {},
      );
      botUserId = authData.user_id;
      botUsername = authData.user;
      console.log(`  Bot: @${botUsername} (${botUserId})`);
    } catch (err) {
      console.error(`[Slack] auth.test failed: ${err instanceof Error ? err.message : err}`);
    }

    // Enter the main socket loop (blocks until aborted or max attempts)
    await socketLoop(config.appToken, signal);
  })().catch((err) => {
    if (!signal.aborted) {
      console.error(`[Slack] Fatal: ${err}`);
    }
  });
}

// Standalone-mode shutdown: graceful close so Slack server releases the slot
// immediately, preventing too_many_websockets on next start. (See issue #1.)
// Daemon mode has its own shutdown handler in start.ts that does the same.
process.on("SIGTERM", () => { void stopSlackGraceful(); });
process.on("SIGINT", () => { void stopSlackGraceful(); });

/** Standalone entry point (bun run src/index.ts slack) */
export async function slack(): Promise<void> {
  slackDebug = true; // Enable debug for standalone mode
  await loadSettings();
  await ensureProjectClaudeMd();
  const config = getSettings().slack;

  if (!config.botToken) {
    console.error("Slack bot token not configured. Set slack.botToken in .claude/claudeclaw/settings.json");
    process.exit(1);
  }
  if (!config.appToken) {
    console.error("Slack app token not configured. Set slack.appToken in .claude/claudeclaw/settings.json");
    process.exit(1);
  }

  console.log("Slack bot started (Socket Mode, standalone)");

  try {
    const authData = await slackApi<{ user_id: string; user: string }>(config.botToken, "auth.test", {});
    botUserId = authData.user_id;
    botUsername = authData.user;
    console.log(`  Bot: @${botUsername} (${botUserId})`);
  } catch (err) {
    console.error(`[Slack] auth.test failed: ${err instanceof Error ? err.message : err}`);
  }

  abortController = new AbortController();
  connectionCount = 0;
  lastEventAt = 0;
  await socketLoop(config.appToken, abortController.signal);
}
