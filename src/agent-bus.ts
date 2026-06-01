/**
 * Agent Bus — inter-agent communication for ClaudeClaw.
 *
 * Two transport layers:
 *   1. Unix Domain Socket — real-time, millisecond delivery
 *   2. File-based inbox    — offline fallback, picked up by 30s reload loop
 *
 * Shared directory: ~/.claude/agent-bus/
 */

import { mkdir, readdir, readFile, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";

// ── Constants ──────────────────────────────────────────────────────────────

const BUS_DIR = join(homedir(), ".claude", "agent-bus");
const REGISTRY_FILE = join(BUS_DIR, "registry.json");

// ── Types ──────────────────────────────────────────────────────────────────

export interface AgentRegistryEntry {
  projectDir: string;
  pid: number | null;
  lastSeen: string;
  status: "online" | "offline" | "interactive";
}

export type AgentRegistry = Record<string, AgentRegistryEntry>;

export type MessageMode = "followup" | "interrupt" | "collect";

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  type: "message" | "request" | "response" | "system";
  payload: string;
  /** If this is a response, which message ID it replies to */
  replyTo?: string;
  mode: MessageMode;
  createdAt: string;
}

export type SystemAction = "restart" | "stop" | "status" | "reload-settings" | "reload-jobs";

export interface SystemMessage extends AgentMessage {
  type: "system";
  action: SystemAction;
  reason?: string;
}

/**
 * Pending-reply registration. Sender writes one of these before sending a
 * message when it wants the reply routed back to a specific listener instead
 * of being dispatched to the global agent-bus session.
 */
export interface PendingEntry {
  messageId: string;
  listenerPath: string;
  expiresAt: string;
}

type MessageHandler = (msg: AgentMessage) => void | Promise<void>;

// ── State ──────────────────────────────────────────────────────────────────

let socketServer: ReturnType<typeof Bun.listen> | null = null;
let localAgentName: string | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toLocaleTimeString();
}

function inboxDir(agentName: string): string {
  return join(BUS_DIR, agentName, "inbox");
}

function socketPath(agentName: string): string {
  return join(BUS_DIR, `${agentName}.sock`);
}

function pendingDir(senderName: string): string {
  return join(BUS_DIR, senderName, "pending");
}

function generateMessageId(from: string): string {
  return `msg_${Date.now()}_${from}_${Math.random().toString(36).slice(2, 6)}`;
}

async function ensureBusDir(): Promise<void> {
  await mkdir(BUS_DIR, { recursive: true });
}

// ── Registry ───────────────────────────────────────────────────────────────

async function readRegistry(): Promise<AgentRegistry> {
  try {
    const raw = await readFile(REGISTRY_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeRegistry(registry: AgentRegistry): Promise<void> {
  await ensureBusDir();
  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2) + "\n");
}

export async function registerAgent(
  name: string,
  projectDir: string,
  pid: number | null = process.pid,
  status: AgentRegistryEntry["status"] = "online",
): Promise<void> {
  await ensureBusDir();
  await mkdir(inboxDir(name), { recursive: true });

  const registry = await readRegistry();
  registry[name] = {
    projectDir,
    pid,
    lastSeen: new Date().toISOString(),
    status,
  };
  await writeRegistry(registry);
  localAgentName = name;
  console.log(`[${ts()}] Agent Bus: registered as "${name}"`);
}

export async function unregisterAgent(name: string): Promise<void> {
  const registry = await readRegistry();
  if (registry[name]) {
    registry[name].status = "offline";
    registry[name].lastSeen = new Date().toISOString();
    registry[name].pid = null;
    await writeRegistry(registry);
  }

  // Clean up socket file
  const sock = socketPath(name);
  try { await unlink(sock); } catch {}

  localAgentName = null;
  console.log(`[${ts()}] Agent Bus: unregistered "${name}"`);
}

export async function updateHeartbeat(name: string): Promise<void> {
  const registry = await readRegistry();
  if (registry[name]) {
    registry[name].lastSeen = new Date().toISOString();
    registry[name].pid = process.pid;
    await writeRegistry(registry);
  }
}

export async function listAgents(): Promise<AgentRegistry> {
  return readRegistry();
}

// ── Unix Domain Socket Server ──────────────────────────────────────────────

export function startSocketServer(
  agentName: string,
  onMessage: MessageHandler,
): void {
  const sock = socketPath(agentName);

  // Clean up stale socket
  try {
    if (existsSync(sock)) {
      const { unlinkSync } = require("fs");
      unlinkSync(sock);
    }
  } catch {}

  socketServer = Bun.listen({
    unix: sock,
    socket: {
      data(_socket, data) {
        try {
          const text = Buffer.from(data).toString("utf8");
          // Support multiple JSON messages in one chunk (newline-delimited)
          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const msg: AgentMessage = JSON.parse(trimmed);
            console.log(`[${ts()}] Agent Bus: received from "${msg.from}" via socket`);
            Promise.resolve(onMessage(msg)).catch((err) => {
              console.error(`[${ts()}] Agent Bus: handler error:`, err);
            });
          }
        } catch (err) {
          console.error(`[${ts()}] Agent Bus: failed to parse socket message:`, err);
        }
      },
      open(_socket) {
        // Connection opened — nothing to do
      },
      close(_socket) {
        // Connection closed — nothing to do
      },
      error(_socket, err) {
        console.error(`[${ts()}] Agent Bus: socket error:`, err);
      },
    },
  });

  console.log(`[${ts()}] Agent Bus: socket server listening on ${sock}`);
}

export function stopSocketServer(): void {
  if (socketServer) {
    socketServer.stop(true);
    socketServer = null;
  }
  if (localAgentName) {
    const sock = socketPath(localAgentName);
    try {
      const { unlinkSync } = require("fs");
      unlinkSync(sock);
    } catch {}
  }
}

// ── Send Message ───────────────────────────────────────────────────────────

/**
 * Send a message to another agent.
 * Tries Unix socket first (real-time); falls back to file inbox (offline).
 */
export async function sendToAgent(
  to: string,
  payload: string,
  options: {
    from?: string;
    type?: AgentMessage["type"];
    mode?: MessageMode;
    replyTo?: string;
    action?: SystemAction;
    reason?: string;
    /**
     * Register a pending-reply listener so the daemon will route the matching
     * reply to `listenerPath` instead of dispatching to the global session.
     */
    expectReply?: { listenerPath: string; ttlMs?: number };
  } = {},
): Promise<{ delivered: "socket" | "file"; messageId: string }> {
  const from = options.from ?? localAgentName ?? "unknown";
  const messageId = generateMessageId(from);

  const msg: AgentMessage & { action?: string; reason?: string } = {
    id: messageId,
    from,
    to,
    type: options.type ?? "message",
    payload,
    mode: options.mode ?? "followup",
    replyTo: options.replyTo,
    createdAt: new Date().toISOString(),
  };

  if (options.action) msg.action = options.action;
  if (options.reason) msg.reason = options.reason;

  // Register pending entry before sending so the reply can never race ahead.
  if (options.expectReply) {
    const ttlMs = options.expectReply.ttlMs ?? 60_000;
    await writePending(from, {
      messageId,
      listenerPath: options.expectReply.listenerPath,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    });
  }

  const json = JSON.stringify(msg);

  // Try socket first
  const sock = socketPath(to);
  if (existsSync(sock)) {
    try {
      const connected = await new Promise<boolean>((resolve) => {
        const conn = Bun.connect({
          unix: sock,
          socket: {
            open(socket) {
              socket.write(json + "\n");
              socket.end();
              resolve(true);
            },
            data() {},
            error() { resolve(false); },
            close() {},
            connectError() { resolve(false); },
          },
        });
        // Timeout after 1s
        setTimeout(() => resolve(false), 1000);
      });

      if (connected) {
        console.log(`[${ts()}] Agent Bus: sent to "${to}" via socket`);
        return { delivered: "socket", messageId };
      }
    } catch {
      // Fall through to file
    }
  }

  // Fallback: write to inbox
  await ensureBusDir();
  await mkdir(inboxDir(to), { recursive: true });

  const filename = `${Date.now()}_from-${from}.json`;
  await writeFile(join(inboxDir(to), filename), json + "\n");
  console.log(`[${ts()}] Agent Bus: sent to "${to}" via file inbox`);
  return { delivered: "file", messageId };
}

// ── Pending-reply registry ─────────────────────────────────────────────────

async function writePending(sender: string, entry: PendingEntry): Promise<void> {
  await mkdir(pendingDir(sender), { recursive: true });
  await writeFile(
    join(pendingDir(sender), `${entry.messageId}.json`),
    JSON.stringify(entry, null, 2),
  );
}

/**
 * Look up a pending entry without removing it. Returns null if missing or expired
 * (expired entries are removed as a side effect).
 */
export async function lookupPending(sender: string, msgId: string): Promise<PendingEntry | null> {
  const p = join(pendingDir(sender), `${msgId}.json`);
  if (!existsSync(p)) return null;
  try {
    const entry: PendingEntry = JSON.parse(await readFile(p, "utf8"));
    if (new Date(entry.expiresAt).getTime() < Date.now()) {
      await unlink(p).catch(() => {});
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

/** Look up and atomically remove a pending entry. */
export async function consumePending(sender: string, msgId: string): Promise<PendingEntry | null> {
  const entry = await lookupPending(sender, msgId);
  if (!entry) return null;
  await unlink(join(pendingDir(sender), `${msgId}.json`)).catch(() => {});
  return entry;
}

/** Remove all expired pending entries for one agent. Best-effort. */
export async function gcPending(sender: string): Promise<number> {
  const dir = pendingDir(sender);
  if (!existsSync(dir)) return 0;
  let removed = 0;
  const now = Date.now();
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const entry: PendingEntry = JSON.parse(await readFile(join(dir, f), "utf8"));
      if (new Date(entry.expiresAt).getTime() < now) {
        await unlink(join(dir, f));
        removed++;
      }
    } catch {
      // malformed → drop
      await unlink(join(dir, f)).catch(() => {});
    }
  }
  return removed;
}

/**
 * Poll a listener path until a reply file appears or the timeout elapses.
 * On hit, reads, deletes, and returns the parsed message.
 */
export async function waitForReply(
  listenerPath: string,
  timeoutMs: number = 60_000,
  pollIntervalMs: number = 200,
): Promise<AgentMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(listenerPath)) {
      try {
        const raw = await readFile(listenerPath, "utf8");
        await unlink(listenerPath).catch(() => {});
        return JSON.parse(raw) as AgentMessage;
      } catch {
        return null;
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return null;
}

// ── Check Inbox (file-based) ───────────────────────────────────────────────

/**
 * Read and remove all pending messages from the agent's file inbox.
 * Called from the 30s hot-reload loop.
 */
export async function checkInbox(agentName: string): Promise<AgentMessage[]> {
  const dir = inboxDir(agentName);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  // Sort by filename (timestamp prefix ensures chronological order)
  files.sort();

  const messages: AgentMessage[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = join(dir, file);
    try {
      const raw = await readFile(filePath, "utf8");
      const msg: AgentMessage = JSON.parse(raw.trim());
      messages.push(msg);
      // Remove after reading
      await unlink(filePath);
    } catch (err) {
      console.error(`[${ts()}] Agent Bus: failed to read inbox message ${file}:`, err);
      // Remove corrupted files
      try { await unlink(filePath); } catch {}
    }
  }

  if (messages.length > 0) {
    console.log(`[${ts()}] Agent Bus: picked up ${messages.length} message(s) from inbox`);
  }

  return messages;
}

// ── Directive Parsing ──────────────────────────────────────────────────────

/**
 * Extract [send-agent:name] directives from Claude's output.
 * Returns the cleaned text and extracted messages.
 *
 * Format: [send-agent:targetName] message content here
 * The message content extends to the next directive or end of text.
 */
export function extractAgentDirectives(
  text: string,
  fromAgent: string,
): { cleaned: string; directives: Array<{ to: string; payload: string }> } {
  const directives: Array<{ to: string; payload: string }> = [];
  const pattern = /\[send-agent:([^\]\r\n]+)\]\s*/gi;

  let cleaned = text;
  let match: RegExpExecArray | null;
  const matches: Array<{ to: string; start: number; end: number }> = [];

  while ((match = pattern.exec(text)) !== null) {
    matches.push({
      to: match[1].trim(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  // Extract payload for each directive
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const payloadEnd = i + 1 < matches.length ? matches[i + 1].start : text.length;
    const payload = text.slice(m.end, payloadEnd).trim();
    if (payload) {
      directives.push({ to: m.to, payload });
    }
  }

  // Remove directives from output
  if (directives.length > 0) {
    cleaned = text.replace(/\[send-agent:[^\]\r\n]+\][^\[]*/gi, "").trim();
  }

  return { cleaned, directives };
}

// ── Build prompt context for incoming messages ─────────────────────────────

/**
 * Build a prompt prefix that injects pending agent messages into the Claude session.
 */
export function buildAgentMessagePrompt(messages: AgentMessage[]): string {
  if (messages.length === 0) return "";

  const lines = [
    "[Agent Bus] Incoming messages from other agents:",
    "",
  ];

  for (const msg of messages) {
    const time = new Date(msg.createdAt).toLocaleTimeString();
    const header = msg.type === "system"
      ? `[SYSTEM from ${msg.from} at ${time}] action=${(msg as any).action}`
      : `[${msg.type.toUpperCase()} from ${msg.from} at ${time}]`;

    lines.push(header);
    lines.push(msg.payload);
    if (msg.replyTo) lines.push(`(reply to: ${msg.replyTo})`);
    lines.push("");
  }

  lines.push(
    "Reply using [send-agent:<name>] directive if you need to respond to another agent.",
  );

  return lines.join("\n");
}
