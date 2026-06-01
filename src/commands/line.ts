import { ensureProjectClaudeMd, runUserMessage, cancelThread } from "../runner";
import { isCancelCommand, CANCEL_CONFIRM_MESSAGE, CANCEL_NOTHING_MESSAGE } from "../cancel";
import { addLineAllowedUser, getSettings, loadSettings } from "../config";
import { peekThreadSession } from "../sessionManager";
import { transcribeAudioToText } from "../whisper";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { existsSync } from "node:fs";
import { createHmac } from "node:crypto";

// LINE-specific directives prompt (loaded once)
const LINE_DIRECTIVES_PATH = join(import.meta.dir, "..", "..", "prompts", "line", "DIRECTIVES.md");
let lineDirectivesPrompt: string | null = null;

async function loadLineDirectives(): Promise<string> {
  if (lineDirectivesPrompt !== null) return lineDirectivesPrompt;
  try {
    if (existsSync(LINE_DIRECTIVES_PATH)) {
      lineDirectivesPrompt = await Bun.file(LINE_DIRECTIVES_PATH).text();
    } else {
      lineDirectivesPrompt = "";
    }
  } catch {
    lineDirectivesPrompt = "";
  }
  return lineDirectivesPrompt;
}

// --- LINE API constants ---

const LINE_API = "https://api.line.me/v2";
const LINE_DATA_API = "https://api-data.line.me/v2";

// --- Type interfaces ---

interface LineMessageEvent {
  type: "message";
  replyToken: string;
  timestamp: number;
  source: {
    type: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message: {
    id: string;
    type: "text" | "image" | "video" | "audio" | "file" | "location" | "sticker";
    text?: string;
    // location
    title?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
    // sticker
    packageId?: string;
    stickerId?: string;
    keywords?: string[];
    // file
    fileName?: string;
    fileSize?: number;
    contentProvider?: { type: string };
  };
}

interface LineFollowEvent {
  type: "follow" | "unfollow" | "join" | "leave";
  replyToken?: string;
  timestamp: number;
  source: {
    type: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
}

interface LinePostbackEvent {
  type: "postback";
  replyToken: string;
  timestamp: number;
  source: {
    type: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  postback: {
    data: string;
  };
}

type LineEvent = LineMessageEvent | LineFollowEvent | LinePostbackEvent;

interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

interface LineProfile {
  displayName: string;
  userId: string;
  pictureUrl?: string;
  statusMessage?: string;
}

// --- State ---

let running = true;
let lineDebug = false;
let server: ReturnType<typeof Bun.serve> | null = null;

// Dedup recent events
const recentlyProcessed = new Map<string, number>();
const DEDUP_TTL_MS = 10_000;

// Bot identity
let botUserId: string | null = null;
let botDisplayName: string | null = null;

// User profile cache (5-minute TTL)
const profileCache = new Map<string, { profile: LineProfile; fetchedAt: number }>();
const PROFILE_TTL_MS = 5 * 60 * 1000;

// Loading animation interval handles per reply token
const loadingTimers = new Map<string, ReturnType<typeof setInterval>>();

// Known users — tracks DM users who have interacted with the bot.
// Used by forwardToLine when allowedUserIds is empty (allow-all mode).
const KNOWN_USERS_FILE = join(process.cwd(), ".claude", "claudeclaw", "line-known-users.json");

const knownUsers = new Set<string>();

async function loadKnownUsers(): Promise<void> {
  try {
    const raw = await Bun.file(KNOWN_USERS_FILE).text();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) arr.forEach((id: string) => knownUsers.add(id));
  } catch {
    // file doesn't exist yet — that's fine
  }
}

async function trackKnownUser(userId: string): Promise<void> {
  if (knownUsers.has(userId)) return;
  knownUsers.add(userId);
  try {
    await Bun.write(KNOWN_USERS_FILE, JSON.stringify([...knownUsers], null, 2) + "\n");
  } catch (err) {
    console.error(`[Line] Failed to persist known user: ${err}`);
  }
}

/** Get the list of users to forward messages to (push API). */
export function getLineForwardTargets(): string[] {
  const config = getSettings().line;
  if (config.allowedUserIds.length > 0) return config.allowedUserIds;
  return [...knownUsers];
}

// --- Debug ---

function debugLog(message: string): void {
  if (!lineDebug) return;
  console.log(`[Line][debug] ${message}`);
}

// --- Dedup ---

function isDuplicate(eventId: string): boolean {
  const now = Date.now();
  for (const [k, t] of recentlyProcessed) {
    if (now - t > DEDUP_TTL_MS) recentlyProcessed.delete(k);
  }
  if (recentlyProcessed.has(eventId)) return true;
  recentlyProcessed.set(eventId, now);
  return false;
}

// --- LINE API helpers ---

async function lineApi<T = Record<string, unknown>>(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const config = getSettings().line;
  const res = await fetch(`${LINE_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.channelAccessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LINE API ${endpoint}: HTTP ${res.status} ${text}`);
  }

  // Some endpoints return empty body (e.g. loading animation)
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {} as T;
  }

  return (await res.json()) as T;
}

// --- Webhook signature verification ---

function verifySignature(body: string, signature: string, channelSecret: string): boolean {
  const expected = createHmac("sha256", channelSecret)
    .update(body)
    .digest("base64");
  return signature === expected;
}

// --- Loading animation ---

async function showLoadingAnimation(chatId: string): Promise<void> {
  try {
    await lineApi("POST", "/bot/chat/loading", {
      chatId,
      loadingSeconds: 20,
    });
  } catch (err) {
    debugLog(`Loading animation failed: ${err instanceof Error ? err.message : err}`);
  }
}

function startLoadingAnimation(chatId: string): void {
  // Show immediately, then repeat every 18 seconds (LINE max is 20s per call)
  showLoadingAnimation(chatId);
  const timer = setInterval(() => {
    showLoadingAnimation(chatId);
  }, 18_000);
  loadingTimers.set(chatId, timer);
}

function stopLoadingAnimation(chatId: string): void {
  const timer = loadingTimers.get(chatId);
  if (timer) {
    clearInterval(timer);
    loadingTimers.delete(chatId);
  }
}

// --- User profile ---

async function getUserProfile(userId: string): Promise<LineProfile | null> {
  const cached = profileCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < PROFILE_TTL_MS) {
    return cached.profile;
  }

  try {
    const profile = await lineApi<LineProfile>("GET", `/bot/profile/${userId}`);
    profileCache.set(userId, { profile, fetchedAt: Date.now() });
    return profile;
  } catch (err) {
    debugLog(`Failed to get profile for ${userId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function getDisplayName(userId: string): Promise<string> {
  const profile = await getUserProfile(userId);
  return profile?.displayName ?? userId;
}

// --- Message sending ---

async function replyMessage(
  replyToken: string,
  messages: Array<Record<string, unknown>>,
): Promise<void> {
  await lineApi("POST", "/bot/message/reply", {
    replyToken,
    messages,
  });
}

async function pushMessage(
  to: string,
  messages: Array<Record<string, unknown>>,
): Promise<void> {
  await lineApi("POST", "/bot/message/push", {
    to,
    messages,
  });
}

async function sendText(
  to: string,
  text: string,
  replyToken?: string,
): Promise<void> {
  // Strip [react:...] directives (LINE doesn't support reactions)
  const normalized = text.replace(/\[react:[^\]\r\n]+\]/gi, "").trim();
  if (!normalized) return;

  // LINE max 5000 chars per message, max 5 messages per reply
  const MAX_LEN = 4500;
  const chunks: string[] = [];
  for (let i = 0; i < normalized.length; i += MAX_LEN) {
    chunks.push(normalized.slice(i, i + MAX_LEN));
  }

  // Try reply first (free, faster), fallback to push
  if (replyToken && chunks.length <= 5) {
    try {
      await replyMessage(
        replyToken,
        chunks.map((chunk) => ({ type: "text", text: chunk })),
      );
      return;
    } catch (err) {
      debugLog(`Reply failed, falling back to push: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Push in batches of 5
  for (let i = 0; i < chunks.length; i += 5) {
    const batch = chunks.slice(i, i + 5);
    await pushMessage(
      to,
      batch.map((chunk) => ({ type: "text", text: chunk })),
    );
  }
}

// --- Media download ---

async function downloadLineContent(
  messageId: string,
  type: "image" | "video" | "audio" | "file",
  fileName?: string,
): Promise<string | null> {
  const config = getSettings().line;
  const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "line");
  await mkdir(dir, { recursive: true });

  const res = await fetch(`${LINE_DATA_API}/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${config.channelAccessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Content download failed: HTTP ${res.status}`);
  }

  // Determine extension from content-type or filename
  const contentType = res.headers.get("content-type") ?? "";
  let ext = "";
  if (fileName) {
    ext = extname(fileName);
  } else if (contentType.includes("jpeg") || contentType.includes("jpg")) {
    ext = ".jpg";
  } else if (contentType.includes("png")) {
    ext = ".png";
  } else if (contentType.includes("gif")) {
    ext = ".gif";
  } else if (contentType.includes("mp4")) {
    ext = type === "audio" ? ".m4a" : ".mp4";
  } else if (contentType.includes("audio")) {
    ext = ".m4a";
  }

  const localPath = join(dir, `${messageId}${ext}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await Bun.write(localPath, bytes);
  debugLog(`Downloaded ${type}: ${localPath} (${bytes.length} bytes)`);
  return localPath;
}

// --- Input sanitization ---

function sanitizeUserInput(text: string): string {
  return text
    .replace(/\[react:[^\]]*\]/gi, "[react removed]")
    .replace(/\[\[line_quick_reply:[^\]]*\]\]/gi, "[quick_reply removed]");
}

// --- Thread/session ID helpers ---

function lineSessionId(source: LineMessageEvent["source"]): string | undefined {
  // Group and room chats get their own session; DMs go to global session
  if (source.groupId) return `line:group:${source.groupId}`;
  if (source.roomId) return `line:room:${source.roomId}`;
  return undefined; // DM uses global session
}

function getChatId(source: LineMessageEvent["source"]): string {
  return source.groupId ?? source.roomId ?? source.userId ?? "unknown";
}

// --- Mention detection for groups ---

function isBotMentioned(text: string): boolean {
  if (!botDisplayName) return false;
  // LINE doesn't have a standardized @mention format like Slack.
  // Check if the message contains the bot's display name.
  return text.includes(`@${botDisplayName}`);
}

// --- Message handler ---

async function handleMessageEvent(event: LineMessageEvent): Promise<void> {
  const config = getSettings().line;
  const userId = event.source.userId;
  if (!userId) return;

  // Dedup by message ID
  if (isDuplicate(event.message.id)) {
    debugLog(`Skipping duplicate message: ${event.message.id}`);
    return;
  }

  const isGroup = event.source.type === "group" || event.source.type === "room";

  // Track DM users for forwarding (push API)
  if (!isGroup) trackKnownUser(userId);

  // Authorization check.
  //
  // Pairing flow triggers when there's a pairing code set and the user isn't
  // already on the allowlist — this is the primary way to add users. It works
  // even with an empty `allowedUserIds`, supporting "pairing-only" setups
  // where the operator never has to look up LINE User IDs by hand.
  //
  // If pairing isn't configured, fall back to the classic allowlist behavior:
  // empty list = allow all, non-empty = strict allowlist.
  const hasPairing = config.pairing.enabled && Boolean(config.pairing.code);
  const onAllowlist = config.allowedUserIds.includes(userId);

  if (hasPairing && !onAllowlist) {
    if (!isGroup && event.message.type === "text") {
      const text = (event.message.text ?? "").trim();
      if (text === config.pairing.code) {
        try {
          await addLineAllowedUser(userId);
          console.log(`[${new Date().toLocaleTimeString()}] LINE pairing success: ${userId}`);
          await sendText(userId, config.pairing.successMessage, event.replyToken);
        } catch (err) {
          console.error(`[Line] Pairing persist failed for ${userId}: ${err instanceof Error ? err.message : err}`);
          await sendText(userId, "配對流程發生錯誤，請稍後再試。", event.replyToken);
        }
      } else {
        debugLog(`Pairing prompt sent to ${userId} (input did not match code)`);
        await sendText(userId, config.pairing.welcomeMessage, event.replyToken);
      }
      return;
    }
    debugLog(`Unauthorized user (no pairing channel for groups/non-text): ${userId}`);
    return;
  }

  if (config.allowedUserIds.length > 0 && !onAllowlist) {
    debugLog(`Unauthorized user: ${userId}`);
    return;
  }


  const chatId = getChatId(event.source);
  const sessionThreadId = lineSessionId(event.source);

  // In groups, check requireMention policy (per-group override falls back to global default)
  if (isGroup && event.message.type === "text") {
    const groupOverride = config.groups[chatId]?.requireMention;
    const requireMention = groupOverride !== undefined ? groupOverride : config.requireMention;
    if (requireMention && !isBotMentioned(event.message.text ?? "")) {
      debugLog(`Skip group message (mention required): ${chatId}`);
      return;
    }
  }

  const displayName = await getDisplayName(userId);
  const channelType = isGroup ? (event.source.groupId ? "group" : "room") : "DM";

  let messageText = "";
  let imagePath: string | null = null;
  let voicePath: string | null = null;
  let voiceTranscript: string | null = null;
  let voiceVocabHint = "";
  let filePath: string | null = null;

  switch (event.message.type) {
    case "text": {
      messageText = event.message.text ?? "";
      // Strip bot name from mention
      if (botDisplayName) {
        messageText = messageText.replace(new RegExp(`@${botDisplayName}`, "g"), "").trim();
      }
      break;
    }

    case "image": {
      try {
        imagePath = await downloadLineContent(event.message.id, "image");
      } catch (err) {
        console.error(`[Line] Failed to download image: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }

    case "video": {
      try {
        filePath = await downloadLineContent(event.message.id, "video");
        messageText = "(user sent a video)";
      } catch (err) {
        console.error(`[Line] Failed to download video: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }

    case "audio": {
      try {
        voicePath = await downloadLineContent(event.message.id, "audio");
      } catch (err) {
        console.error(`[Line] Failed to download audio: ${err instanceof Error ? err.message : err}`);
      }

      if (voicePath) {
        try {
          {
            const result = await transcribeAudioToText(voicePath, {
              debug: lineDebug,
              log: (msg) => debugLog(msg),
            });
            voiceTranscript = result.text || null;
            voiceVocabHint = result.vocabHint;
          }
        } catch (err) {
          console.error(`[Line] Failed to transcribe audio: ${err instanceof Error ? err.message : err}`);
        }
      }
      break;
    }

    case "file": {
      try {
        filePath = await downloadLineContent(
          event.message.id,
          "file",
          event.message.fileName,
        );
        messageText = `(user sent a file: ${event.message.fileName ?? "unknown"})`;
      } catch (err) {
        console.error(`[Line] Failed to download file: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }

    case "location": {
      const loc = event.message;
      messageText = `(user shared location: ${loc.title ?? ""} ${loc.address ?? ""} [${loc.latitude}, ${loc.longitude}])`;
      break;
    }

    case "sticker": {
      const keywords = event.message.keywords ?? [];
      const desc = keywords.length > 0 ? keywords.join(", ") : `sticker ${event.message.stickerId}`;
      messageText = `(user sent a sticker: ${desc})`;
      break;
    }
  }

  // Skip if nothing to process
  if (!messageText && !imagePath && !voicePath && !filePath) return;

  const mediaParts = [
    imagePath ? "image" : "",
    voicePath ? "voice" : "",
    filePath ? "file" : "",
  ].filter(Boolean);
  const mediaSuffix = mediaParts.length > 0 ? ` [${mediaParts.join("+")}]` : "";
  console.log(
    `[${new Date().toLocaleTimeString()}] Line ${displayName}(${userId})${mediaSuffix} in ${channelType}: "${(messageText || "(media)").slice(0, 60)}"`,
  );

  // /cancel — abort the in-flight Claude run for this LINE source
  if (isCancelCommand(messageText)) {
    const cancelled = cancelThread(sessionThreadId);
    await sendText(chatId, cancelled ? CANCEL_CONFIRM_MESSAGE : CANCEL_NOTHING_MESSAGE, event.replyToken).catch(() => {});
    return;
  }

  try {
    // Start loading animation
    startLoadingAnimation(chatId);

    // Build prompt
    const lineDirectives = await loadLineDirectives();
    const promptParts = [`[LINE from ${displayName}(${userId}) in ${channelType} ${chatId}]`];
    if (lineDirectives) promptParts.push(lineDirectives);

    if (messageText) {
      promptParts.push(`Message: ${sanitizeUserInput(messageText)}`);
    }
    if (imagePath) {
      promptParts.push(`Image path: ${imagePath}`);
      promptParts.push("The user attached an image. Inspect this image file directly before answering.");
    }
    if (voiceTranscript) {
      promptParts.push(`Voice transcript: ${voiceTranscript}`);
      if (voiceVocabHint) promptParts.push(voiceVocabHint);
      promptParts.push("The user sent a voice message. Use the transcript as their spoken message.");
    } else if (voicePath) {
      promptParts.push("The user sent a voice message, but it could not be transcribed. Ask them to resend.");
    }
    if (filePath && event.message.type !== "audio" && event.message.type !== "image") {
      promptParts.push(`Attached file: ${filePath}`);
      promptParts.push("The user attached a file. Read and analyze it as needed.");
    }

    const prefixedPrompt = promptParts.join("\n");

    // Run agent
    const result = await runUserMessage("line", prefixedPrompt, sessionThreadId);

    // Stop loading animation
    stopLoadingAnimation(chatId);

    if (result.exitCode !== 0) {
      await sendText(
        chatId,
        `Error (exit ${result.exitCode}): ${result.stderr || result.stdout || "Unknown error"}`,
        event.replyToken,
      );
    } else if (result.stdout) {
      await sendText(chatId, result.stdout, event.replyToken);
    }
  } catch (err) {
    stopLoadingAnimation(chatId);
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Line] Error for ${displayName}: ${errMsg}`);
    await sendText(chatId, `Error: ${errMsg}`).catch(() => {});
  }
}

// --- Postback handler ---

async function handlePostbackEvent(event: LinePostbackEvent): Promise<void> {
  const config = getSettings().line;
  const userId = event.source.userId;
  if (!userId) return;

  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) return;

  const chatId = getChatId(event.source);
  const sessionThreadId = lineSessionId(event.source);
  const displayName = await getDisplayName(userId);

  console.log(
    `[${new Date().toLocaleTimeString()}] Line ${displayName} [postback]: "${event.postback.data}"`,
  );

  startLoadingAnimation(chatId);

  const prompt = `[LINE postback from ${displayName}(${userId})]\nUser action data: ${event.postback.data}`;
  const result = await runUserMessage("line", prompt, sessionThreadId);

  stopLoadingAnimation(chatId);

  if (result.exitCode === 0 && result.stdout) {
    await sendText(chatId, result.stdout, event.replyToken);
  } else if (result.exitCode !== 0) {
    await sendText(chatId, `Error: ${result.stderr || "Unknown"}`, event.replyToken);
  }
}

// --- Webhook handler ---

async function handleWebhook(body: string, signature: string): Promise<void> {
  const config = getSettings().line;

  if (!verifySignature(body, signature, config.channelSecret)) {
    console.error("[Line] Invalid webhook signature");
    return;
  }

  let payload: LineWebhookBody;
  try {
    payload = JSON.parse(body) as LineWebhookBody;
  } catch {
    console.error("[Line] Failed to parse webhook body");
    return;
  }

  // Save destination as bot user ID
  if (payload.destination && !botUserId) {
    botUserId = payload.destination;
    debugLog(`Bot user ID: ${botUserId}`);
  }

  for (const event of payload.events) {
    if (event.type === "message") {
      handleMessageEvent(event as LineMessageEvent).catch((err) => {
        console.error(`[Line] handleMessageEvent error: ${err instanceof Error ? err.message : err}`);
      });
    } else if (event.type === "postback") {
      handlePostbackEvent(event as LinePostbackEvent).catch((err) => {
        console.error(`[Line] handlePostbackEvent error: ${err instanceof Error ? err.message : err}`);
      });
    } else if (event.type === "follow") {
      const userId = event.source.userId;
      debugLog(`New follower: ${userId}`);
    } else if (event.type === "join") {
      const groupId = event.source.groupId ?? event.source.roomId;
      debugLog(`Joined group/room: ${groupId}`);
    }
  }
}

// --- Webhook server ---

function startWebhookServer(port: number): void {
  server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (req.method === "GET" && url.pathname === "/health") {
        return new Response("OK", { status: 200 });
      }

      // LINE webhook
      const config = getSettings().line;
      if (req.method === "POST" && url.pathname === config.webhookPath) {
        const signature = req.headers.get("x-line-signature") ?? "";
        const body = await req.text();

        // Always respond 200 immediately (LINE expects it within 1s)
        handleWebhook(body, signature).catch((err) => {
          console.error(`[Line] Webhook error: ${err instanceof Error ? err.message : err}`);
        });

        return new Response("OK", { status: 200 });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const config = getSettings().line;
  console.log(`  Webhook listening on http://localhost:${port}${config.webhookPath}`);
}

// --- Bot info ---

async function fetchBotInfo(): Promise<void> {
  try {
    const info = await lineApi<{ userId: string; displayName: string; pictureUrl?: string }>(
      "GET",
      "/bot/info",
    );
    botUserId = info.userId;
    botDisplayName = info.displayName;
    console.log(`  Bot: ${botDisplayName} (${botUserId})`);
  } catch (err) {
    console.error(`[Line] Failed to fetch bot info: ${err instanceof Error ? err.message : err}`);
  }
}

// --- Exports ---

export { sendText as sendMessage };

export async function sendMessageToUser(
  userId: string,
  text: string,
): Promise<void> {
  await sendText(userId, text);
}

export function stopLine(): void {
  running = false;
  // Stop all loading timers
  for (const timer of loadingTimers.values()) {
    clearInterval(timer);
  }
  loadingTimers.clear();
  if (server) {
    server.stop();
    server = null;
  }
}

export function startLine(debug = false): void {
  lineDebug = debug;
  const config = getSettings().line;

  if (server) stopLine();
  running = true;

  if (!config.channelAccessToken || !config.channelSecret) {
    console.log("  LINE: not configured");
    return;
  }

  // Load known users for forwarding
  loadKnownUsers().catch(() => {});

  console.log("LINE bot started (Webhook)");
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
  if (lineDebug) console.log("  Debug: enabled");

  (async () => {
    await ensureProjectClaudeMd();
    await fetchBotInfo();
    try {
      startWebhookServer(config.webhookPort);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EADDRINUSE") || msg.includes("Failed to start") || msg.includes("port")) {
        console.error(`[Line] Port ${config.webhookPort} is already in use.`);
        console.error(`[Line] If running multiple LINE agents, start the proxy first:`);
        console.error(`[Line]   bun run <claudeclaw>/src/index.ts proxy start`);
        console.error(`[Line] Then set a unique webhookPort in this agent's settings.json.`);
      } else {
        console.error(`[Line] Fatal: ${msg}`);
      }
    }
  })().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EADDRINUSE") || msg.includes("Failed to start") || msg.includes("port")) {
      console.error(`[Line] Port ${config.webhookPort} is already in use.`);
      console.error(`[Line] If running multiple LINE agents, use /claudeclaw:proxy start first.`);
    } else {
      console.error(`[Line] Fatal: ${msg}`);
    }
  });
}

process.on("SIGTERM", () => stopLine());
process.on("SIGINT", () => stopLine());

/** Standalone entry point (bun run src/index.ts line) */
export async function line(): Promise<void> {
  lineDebug = true;
  await loadSettings();
  await ensureProjectClaudeMd();
  const config = getSettings().line;

  if (!config.channelAccessToken) {
    console.error("LINE channel access token not configured. Set line.channelAccessToken in .claude/claudeclaw/settings.json");
    process.exit(1);
  }
  if (!config.channelSecret) {
    console.error("LINE channel secret not configured. Set line.channelSecret in .claude/claudeclaw/settings.json");
    process.exit(1);
  }

  console.log("LINE bot started (Webhook, standalone)");

  await fetchBotInfo();
  startWebhookServer(config.webhookPort);

  // Keep process alive
  await new Promise(() => {});
}
