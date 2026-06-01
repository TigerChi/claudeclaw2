import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { getSession, createSession, incrementTurn, markCompactWarned } from "./sessions";
import {
  getThreadSession,
  createThreadSession,
  incrementThreadTurn,
  markThreadCompactWarned,
} from "./sessionManager";
import { getSettings, type ModelConfig, type SecurityConfig, type AgentBusConfig } from "./config";
import { buildClockPromptPrefix } from "./timezone";
import { selectModel } from "./model-router";
import { listAgents, extractAgentDirectives, sendToAgent } from "./agent-bus";
import { loadAgentEnv, withDaemonSafeEnv } from "./agent-env";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "child_process";
import { homedir } from "os";

/** Resolve the Claude Code CLI binary path. Checks env var, common locations, then falls back to `which`. */
function resolveClaudeCodePath(): string {
  if (process.env.CLAUDE_CODE_PATH) return process.env.CLAUDE_CODE_PATH;

  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    join(homedir(), ".claude", "bin", "claude"),
    "/usr/local/bin/claude",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // Fallback: ask the shell
  try {
    return execSync("which claude", { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Claude Code CLI not found. Install it or set CLAUDE_CODE_PATH.");
  }
}

const LOGS_DIR = join(process.cwd(), ".claude/claudeclaw/logs");
// Resolve prompts relative to the claudeclaw installation, not the project dir
const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const HEARTBEAT_PROMPT_FILE = join(PROMPTS_DIR, "heartbeat", "HEARTBEAT.md");
// Project-level prompt overrides live here (gitignored, user-owned)
const PROJECT_PROMPTS_DIR = join(process.cwd(), ".claude", "claudeclaw", "prompts");
const PROJECT_CLAUDE_MD = join(process.cwd(), "CLAUDE.md");
const LEGACY_PROJECT_CLAUDE_MD = join(process.cwd(), ".claude", "CLAUDE.md");
const CLAUDECLAW_BLOCK_START = "<!-- claudeclaw:managed:start -->";
const CLAUDECLAW_BLOCK_END = "<!-- claudeclaw:managed:end -->";

/**
 * Compact configuration.
 * COMPACT_WARN_THRESHOLD: notify user that context is getting large.
 * COMPACT_TIMEOUT_ENABLED: whether to auto-compact on timeout (exit 124).
 */
const COMPACT_WARN_THRESHOLD = 25;
const COMPACT_TIMEOUT_ENABLED = true;

export type CompactEvent =
  | { type: "warn"; turnCount: number }
  | { type: "auto-compact-start" }
  | { type: "auto-compact-done"; success: boolean }
  | { type: "auto-compact-retry"; success: boolean; stdout: string; stderr: string; exitCode: number };

type CompactEventListener = (event: CompactEvent) => void;
const compactListeners: CompactEventListener[] = [];

/** Register a listener for compact-related events (warnings, auto-compact notifications). */
export function onCompactEvent(listener: CompactEventListener): void {
  compactListeners.push(listener);
}

function emitCompactEvent(event: CompactEvent): void {
  for (const listener of compactListeners) {
    try { listener(event); } catch {}
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const RATE_LIMIT_PATTERN = /you.ve hit your limit|out of extra usage/i;

// Serial queue — prevents concurrent --resume on the same session
// Global queue for non-thread messages (backward compatible)
let globalQueue: Promise<unknown> = Promise.resolve();
// Per-thread queues — each thread runs independently in parallel
const threadQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(fn: () => Promise<T>, threadId?: string): Promise<T> {
  if (threadId) {
    const current = threadQueues.get(threadId) ?? Promise.resolve();
    const task = current.then(fn, fn);
    threadQueues.set(threadId, task.catch(() => {}));
    return task;
  }
  const task = globalQueue.then(fn, fn);
  globalQueue = task.catch(() => {});
  return task;
}

// --- Cancel registry: per-key in-flight AbortController ---
// Lets channel handlers cancel an in-flight Claude run via /cancel.
// Key: threadId for thread-bound runs, "global" for non-thread runs.
const inflightAborts = new Map<string, AbortController>();

function registerInflight(key: string, ac: AbortController) {
  inflightAborts.set(key, ac);
}

function clearInflight(key: string, ac: AbortController) {
  // Only clear if the registered controller is still ours (avoids races)
  if (inflightAborts.get(key) === ac) inflightAborts.delete(key);
}

/**
 * Cancel the in-flight Claude run for the given key (threadId or "global").
 * Returns true if a run was cancelled, false if nothing was in-flight.
 * Does NOT clear queued-but-not-yet-started runs after this one.
 */
export function cancelThread(threadId?: string): boolean {
  const key = threadId ?? "global";
  const ac = inflightAborts.get(key);
  if (!ac) return false;
  try { ac.abort(); } catch {}
  inflightAborts.delete(key);
  return true;
}

/** Whether a Claude run is currently in-flight for the given key. */
export function isInflight(threadId?: string): boolean {
  return inflightAborts.has(threadId ?? "global");
}

function extractRateLimitMessage(stdout: string, stderr: string): string | null {
  const candidates = [stdout, stderr];
  for (const text of candidates) {
    const trimmed = text.trim();
    if (trimmed && RATE_LIMIT_PATTERN.test(trimmed)) return trimmed;
  }
  return null;
}

function sameModelConfig(a: ModelConfig, b: ModelConfig): boolean {
  return a.model.trim().toLowerCase() === b.model.trim().toLowerCase() && a.api.trim() === b.api.trim();
}

function hasModelConfig(value: ModelConfig): boolean {
  return value.model.trim().length > 0 || value.api.trim().length > 0;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const message = String((error as { message?: unknown }).message ?? "");
  return /enoent|no such file or directory/i.test(message);
}

function buildChildEnv(baseEnv: Record<string, string>, model: string, api: string): Record<string, string> {
  const childEnv: Record<string, string> = { ...baseEnv };
  const normalizedModel = model.trim().toLowerCase();

  if (api.trim()) childEnv.ANTHROPIC_AUTH_TOKEN = api.trim();

  if (normalizedModel === "glm") {
    childEnv.ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
    childEnv.API_TIMEOUT_MS = "3000000";
  }

  return childEnv;
}

/** Default timeout for a single Claude Code invocation (15 minutes). */
const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000;

async function runClaudeOnce(
  baseArgs: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  timeoutMs: number = CLAUDE_TIMEOUT_MS,
  abortSignal?: AbortSignal
): Promise<{ rawStdout: string; stderr: string; exitCode: number }> {
  const args = [...baseArgs];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(baseEnv, model, api),
  });

  // External cancel via /cancel: kill the subprocess
  const onAbort = () => {
    try { proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 2000);
  };
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Claude session timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    if (!abortSignal) return;
    abortSignal.addEventListener("abort", () => reject(new Error("Cancelled by user")), { once: true });
  });

  try {
    const [rawStdout, stderr] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]),
      timeoutPromise,
      abortPromise,
    ]) as [string, string];
    await proc.exited;

    return {
      rawStdout,
      stderr,
      exitCode: proc.exitCode ?? 1,
    };
  } catch (err) {
    // Kill the hung process
    try { proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);

    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${new Date().toLocaleTimeString()}] ${message}`);

    return {
      rawStdout: "",
      stderr: message,
      exitCode: abortSignal?.aborted ? 130 : 124,  // 130 = cancelled, 124 = timeout
    };
  } finally {
    if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
  }
}

const PROJECT_DIR = process.cwd();

const DIR_SCOPE_PROMPT = [
  `CRITICAL SECURITY CONSTRAINT: You are scoped to the project directory: ${PROJECT_DIR}`,
  "You MUST NOT read, write, edit, or delete any file outside this directory.",
  "You MUST NOT run bash commands that modify anything outside this directory (no cd /, no /etc, no ~/, no ../.. escapes).",
  "If a request requires accessing files outside the project, refuse and explain why.",
].join("\n");

export async function ensureProjectClaudeMd(): Promise<void> {
  // Preflight-only initialization: never rewrite an existing project CLAUDE.md.
  if (existsSync(PROJECT_CLAUDE_MD)) return;

  const promptContent = (await loadPrompts()).trim();
  const managedBlock = [
    CLAUDECLAW_BLOCK_START,
    promptContent,
    CLAUDECLAW_BLOCK_END,
  ].join("\n");

  let content = "";

  if (existsSync(LEGACY_PROJECT_CLAUDE_MD)) {
    try {
      const legacy = await readFile(LEGACY_PROJECT_CLAUDE_MD, "utf8");
      content = legacy.trim();
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read legacy .claude/CLAUDE.md:`, e);
      return;
    }
  }

  const normalized = content.trim();
  const hasManagedBlock =
    normalized.includes(CLAUDECLAW_BLOCK_START) && normalized.includes(CLAUDECLAW_BLOCK_END);
  const managedPattern = new RegExp(
    `${CLAUDECLAW_BLOCK_START}[\\s\\S]*?${CLAUDECLAW_BLOCK_END}`,
    "m"
  );

  const merged = hasManagedBlock
    ? `${normalized.replace(managedPattern, managedBlock)}\n`
    : normalized
      ? `${normalized}\n\n${managedBlock}\n`
      : `${managedBlock}\n`;

  try {
    await writeFile(PROJECT_CLAUDE_MD, merged, "utf8");
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] Failed to write project CLAUDE.md:`, e);
  }
}

function buildSecurityArgs(security: SecurityConfig): string[] {
  const args: string[] = ["--dangerously-skip-permissions"];

  switch (security.level) {
    case "locked":
      args.push("--tools", "Read,Grep,Glob");
      break;
    case "strict":
      args.push("--disallowedTools", "Bash,WebSearch,WebFetch");
      break;
    case "moderate":
      // all tools available, scoped to project dir via system prompt
      break;
    case "unrestricted":
      // all tools, no directory restriction
      break;
  }

  if (security.allowedTools.length > 0) {
    args.push("--allowedTools", security.allowedTools.join(" "));
  }
  if (security.disallowedTools.length > 0) {
    args.push("--disallowedTools", security.disallowedTools.join(" "));
  }

  return args;
}

/** Load and concatenate all prompt files from the prompts/ directory. */
async function loadPrompts(): Promise<string> {
  const selectedPromptFiles = [
    join(PROMPTS_DIR, "IDENTITY.md"),
    join(PROMPTS_DIR, "USER.md"),
    join(PROMPTS_DIR, "SOUL.md"),
  ];
  const parts: string[] = [];

  for (const file of selectedPromptFiles) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) parts.push(content.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read prompt file ${file}:`, e);
    }
  }

  return parts.join("\n\n");
}

/**
 * Load the heartbeat prompt template.
 * Project-level override takes precedence: place a file at
 * .claude/claudeclaw/prompts/HEARTBEAT.md to fully replace the built-in template.
 */
export async function loadHeartbeatPromptTemplate(): Promise<string> {
  const projectOverride = join(PROJECT_PROMPTS_DIR, "HEARTBEAT.md");
  for (const file of [projectOverride, HEARTBEAT_PROMPT_FILE]) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) return content.trim();
    } catch (e) {
      if (!isNotFoundError(e)) {
        console.warn(`[${new Date().toLocaleTimeString()}] Failed to read heartbeat prompt file ${file}:`, e);
      }
    }
  }
  return "";
}

/** Run /compact on the current session to reduce context size. */
export async function runCompact(
  sessionId: string,
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  securityArgs: string[],
  timeoutMs: number
): Promise<boolean> {
  const compactArgs = [
    "claude", "-p", "/compact",
    "--output-format", "text",
    "--resume", sessionId,
    ...securityArgs,
  ];
  console.log(`[${new Date().toLocaleTimeString()}] Running /compact on session ${sessionId.slice(0, 8)}...`);
  const result = await runClaudeOnce(compactArgs, model, api, baseEnv, timeoutMs);
  const success = result.exitCode === 0;
  console.log(`[${new Date().toLocaleTimeString()}] Compact ${success ? "succeeded" : `failed (exit ${result.exitCode})`}`);
  return success;
}

/**
 * High-level compact: resolves session + settings internally.
 * Returns { success, message }.
 */
export async function compactCurrentSession(): Promise<{ success: boolean; message: string }> {
  const existing = await getSession();
  if (!existing) return { success: false, message: "No active session to compact." };

  const settings = getSettings();
  const securityArgs = buildSecurityArgs(settings.security);
  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const baseEnv = {
    ...withDaemonSafeEnv(cleanEnv as NodeJS.ProcessEnv),
    ...loadAgentEnv(process.cwd()),
  } as Record<string, string>;
  const timeoutMs = (settings as any).sessionTimeoutMs || CLAUDE_TIMEOUT_MS;

  const ok = await runCompact(
    existing.sessionId,
    settings.model,
    settings.api,
    baseEnv,
    securityArgs,
    timeoutMs
  );

  return ok
    ? { success: true, message: `✅ Session compact complete (${existing.sessionId.slice(0, 8)})` }
    : { success: false, message: `❌ Compact failed (${existing.sessionId.slice(0, 8)})` };
}

async function execClaude(name: string, prompt: string, threadId?: string): Promise<RunResult> {
  // Register abortController so /cancel can kill this run
  const cancelKey = threadId ?? "global";
  const abortController = new AbortController();
  registerInflight(cancelKey, abortController);

  try {
    return await execClaudeImpl(name, prompt, threadId, abortController);
  } finally {
    clearInflight(cancelKey, abortController);
  }
}

async function execClaudeImpl(name: string, prompt: string, threadId: string | undefined, abortController: AbortController): Promise<RunResult> {
  await mkdir(LOGS_DIR, { recursive: true });

  const existing = threadId
    ? await getThreadSession(threadId)
    : await getSession();
  const isNew = !existing;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `${name}-${timestamp}.log`);

  const settings = getSettings();
  const { security, model, api, fallback, agentic } = settings;

  // Determine which model to use based on agentic routing
  let primaryConfig: ModelConfig;
  let taskType = "unknown";
  let routingReasoning = "";

  if (agentic.enabled) {
    const routing = selectModel(prompt, agentic.modes, agentic.defaultMode);
    primaryConfig = { model: routing.model, api };
    taskType = routing.taskType;
    routingReasoning = routing.reasoning;
    console.log(
      `[${new Date().toLocaleTimeString()}] Agentic routing: ${routing.taskType} → ${routing.model} (${routing.reasoning})`
    );
  } else {
    primaryConfig = { model, api };
  }

  const fallbackConfig: ModelConfig = {
    model: fallback?.model ?? "",
    api: fallback?.api ?? "",
  };
  const securityArgs = buildSecurityArgs(security);
  const timeoutMs = (settings as any).sessionTimeoutMs || CLAUDE_TIMEOUT_MS;

  console.log(
    `[${new Date().toLocaleTimeString()}] Running: ${name} (${isNew ? "new session" : `resume ${existing.sessionId.slice(0, 8)}`}, security: ${security.level})`
  );

  // New session: use json output to capture Claude's session_id
  // Resumed session: use text output with --resume
  const outputFormat = isNew ? "json" : "text";
  const args = ["claude", "-p", prompt, "--output-format", outputFormat, ...securityArgs];

  if (!isNew) {
    args.push("--resume", existing.sessionId);
  }

  // Build the appended system prompt: prompt files + directory scoping
  // This is passed on EVERY invocation (not just new sessions) because
  // --append-system-prompt does not persist across --resume.
  const promptContent = await loadPrompts();
  const appendParts: string[] = [
    "You are running inside ClaudeClaw.",
  ];
  if (promptContent) appendParts.push(promptContent);

  // Load the project's CLAUDE.md if it exists
  if (existsSync(PROJECT_CLAUDE_MD)) {
    try {
      const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
      if (claudeMd.trim()) appendParts.push(claudeMd.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read project CLAUDE.md:`, e);
    }
  }

  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);

  // Agent Bus: inject inter-agent communication instructions when enabled
  const agentBus: AgentBusConfig = (settings as any).agentBus ?? { enabled: false, name: "" };
  if (agentBus.enabled && agentBus.name) {
    try {
      const registry = await listAgents();
      const others = Object.entries(registry)
        .filter(([name]) => name !== agentBus.name)
        .map(([name, entry]) => `  - ${name} (${entry.status}, project: ${entry.projectDir})`)
        .join("\n");

      const busPrompt = [
        "## Agent Bus — Inter-Agent Communication",
        "",
        `You are agent "${agentBus.name}". You can communicate with other agents using the Agent Bus.`,
        "",
        "### Available agents:",
        others || "  (no other agents registered yet)",
        "",
        "### How to send a message to another agent:",
        "Use the [send-agent:<name>] directive in your response:",
        "  [send-agent:alice] Please check the latest deployment status",
        "",
        "### How Agent Bus messages work:",
        "- When you receive an Agent Bus message, your plain text reply (anything NOT inside a [send-agent:] directive) will be automatically forwarded to the user on all active messaging channels (LINE, Telegram, Slack, Discord).",
        "- [send-agent:] directives in your reply are extracted and sent to that agent. They are NOT shown to the user.",
        "- So if you want to talk to the user: write plain text. If you want to talk to another agent: use [send-agent:].",
        "- You can do BOTH in the same reply — plain text goes to the user, directives go to agents.",
        "",
        "### Rules:",
        "- Only use [send-agent:] when the user explicitly asks you to contact another agent, or when the task clearly requires another agent's help.",
        "- Do NOT send messages to yourself.",
        "- Keep inter-agent messages concise and actionable.",
      ].join("\n");
      appendParts.push(busPrompt);
    } catch (err) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to build Agent Bus prompt:`, err);
    }
  }

  if (appendParts.length > 0) {
    args.push("--append-system-prompt", appendParts.join("\n\n"));
  }

  // Strip CLAUDECODE env var so child claude processes don't think they're nested,
  // strip leaky globals (e.g. global OP token), and layer per-agent env on top.
  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const baseEnv = {
    ...withDaemonSafeEnv(cleanEnv as NodeJS.ProcessEnv),
    ...loadAgentEnv(process.cwd()),
  } as Record<string, string>;

  let exec = await runClaudeOnce(args, primaryConfig.model, primaryConfig.api, baseEnv, timeoutMs, abortController.signal);
  const primaryRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
  let usedFallback = false;

  if (primaryRateLimit && hasModelConfig(fallbackConfig) && !sameModelConfig(primaryConfig, fallbackConfig) && !abortController.signal.aborted) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Claude limit reached; retrying with fallback${fallbackConfig.model ? ` (${fallbackConfig.model})` : ""}...`
    );
    exec = await runClaudeOnce(args, fallbackConfig.model, fallbackConfig.api, baseEnv, timeoutMs, abortController.signal);
    usedFallback = true;
  }

  const rawStdout = exec.rawStdout;
  const stderr = exec.stderr;
  const exitCode = exec.exitCode;
  let stdout = rawStdout;
  let sessionId = existing?.sessionId ?? "unknown";
  const rateLimitMessage = extractRateLimitMessage(rawStdout, stderr);

  if (rateLimitMessage) {
    stdout = rateLimitMessage;
  }

  // For new sessions, parse the JSON to extract session_id and result text
  if (!rateLimitMessage && isNew && exitCode === 0) {
    try {
      const json = JSON.parse(rawStdout);
      sessionId = json.session_id;
      stdout = json.result ?? "";
      // Save the real session ID from Claude Code
      if (threadId) {
        await createThreadSession(threadId, sessionId);
        console.log(`[${new Date().toLocaleTimeString()}] Thread session created: ${sessionId} (thread ${threadId.slice(0, 8)})`);
      } else {
        await createSession(sessionId);
        console.log(`[${new Date().toLocaleTimeString()}] Session created: ${sessionId}`);
      }
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to parse session from Claude output:`, e);
    }
  }

  const result: RunResult = {
    stdout,
    stderr,
    exitCode,
  };

  const output = [
    `# ${name}`,
    `Date: ${new Date().toISOString()}`,
    `Session: ${sessionId} (${isNew ? "new" : "resumed"})`,
    `Model config: ${usedFallback ? "fallback" : "primary"}`,
    ...(agentic.enabled ? [`Task type: ${taskType}`, `Routing: ${routingReasoning}`] : []),
    `Prompt: ${prompt}`,
    `Exit code: ${result.exitCode}`,
    "",
    "## Output",
    stdout,
    ...(stderr ? ["## Stderr", stderr] : []),
  ].join("\n");

  await Bun.write(logFile, output);
  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name} → ${logFile}`);

  // --- Auto-compact on timeout (exit 124) ---
  if (COMPACT_TIMEOUT_ENABLED && exitCode === 124 && !isNew && existing) {
    emitCompactEvent({ type: "auto-compact-start" });
    const compactOk = await runCompact(
      existing.sessionId,
      primaryConfig.model,
      primaryConfig.api,
      baseEnv,
      securityArgs,
      timeoutMs
    );
    emitCompactEvent({ type: "auto-compact-done", success: compactOk });

    if (compactOk) {
      console.log(`[${new Date().toLocaleTimeString()}] Retrying ${name} after compact...`);
      const retryExec = await runClaudeOnce(args, primaryConfig.model, primaryConfig.api, baseEnv, timeoutMs);
      const retryResult: RunResult = {
        stdout: retryExec.rawStdout,
        stderr: retryExec.stderr,
        exitCode: retryExec.exitCode,
      };
      emitCompactEvent({
        type: "auto-compact-retry",
        success: retryExec.exitCode === 0,
        stdout: retryResult.stdout,
        stderr: retryResult.stderr,
        exitCode: retryResult.exitCode,
      });

      if (retryExec.exitCode === 0) {
        const count = threadId ? await incrementThreadTurn(threadId) : await incrementTurn();
        console.log(`[${new Date().toLocaleTimeString()}] Turn count: ${count} (after compact + retry)`);
      }
      return retryResult;
    }
  }

  // --- Turn tracking & compact warning ---
  if (exitCode === 0 && !isNew) {
    const turnCount = threadId ? await incrementThreadTurn(threadId) : await incrementTurn();
    console.log(`[${new Date().toLocaleTimeString()}] Turn count: ${turnCount}${threadId ? ` (thread ${threadId.slice(0, 8)})` : ""}`);

    if (turnCount >= COMPACT_WARN_THRESHOLD && existing && !existing.compactWarned) {
      if (threadId) {
        await markThreadCompactWarned(threadId);
      } else {
        await markCompactWarned();
      }
      emitCompactEvent({ type: "warn", turnCount });
    }
  }

  return result;
}

export async function run(
  name: string,
  prompt: string,
  threadId?: string,
  replyToMsgId?: string,
): Promise<RunResult> {
  const result = await enqueue(() => execClaude(name, prompt, threadId), threadId);

  // Process [send-agent:] directives in output — works for all channels.
  // When this run is processing an incoming agent-bus message, `replyToMsgId`
  // is the origin message id; we attach it to outgoing directives so senders
  // that registered a pending listener can have their reply routed back.
  const agentBus: AgentBusConfig = (getSettings() as any).agentBus ?? { enabled: false, name: "" };
  if (agentBus.enabled && agentBus.name && result.stdout) {
    const { cleaned, directives } = extractAgentDirectives(result.stdout, agentBus.name);
    if (directives.length > 0) {
      for (const d of directives) {
        sendToAgent(d.to, d.payload, {
          from: agentBus.name,
          type: replyToMsgId ? "response" : "message",
          replyTo: replyToMsgId,
        }).catch((err) => {
          console.error(`[${new Date().toLocaleTimeString()}] Agent Bus: failed to send to "${d.to}":`, err);
        });
      }
      result.stdout = cleaned;
    }
  }

  return result;
}

async function streamClaude(
  name: string,
  prompt: string,
  onChunk: (text: string) => void,
  onUnblock: () => void,
  threadId?: string,
  onResult?: (text: string) => void,
): Promise<void> {
  // Register this run's abortController so /cancel can stop it
  const cancelKey = threadId ?? "global";
  await mkdir(LOGS_DIR, { recursive: true });

  const existing = threadId
    ? await getThreadSession(threadId)
    : await getSession();
  const { security, model, api } = getSettings();

  // Build system prompt (same components as execClaude)
  const promptContent = await loadPrompts();
  const appendParts: string[] = ["You are running inside ClaudeClaw."];
  if (promptContent) appendParts.push(promptContent);

  if (existsSync(PROJECT_CLAUDE_MD)) {
    try {
      const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
      if (claudeMd.trim()) appendParts.push(claudeMd.trim());
    } catch {}
  }

  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);

  // Build SDK options
  const sdkOptions: Record<string, unknown> = {
    cwd: process.cwd(),
    pathToClaudeCodeExecutable: resolveClaudeCodePath(),
    systemPrompt: { type: "preset", preset: "claude_code", append: appendParts.join("\n\n") },
    includePartialMessages: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  };

  // Model
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") {
    sdkOptions.model = model.trim();
  }

  // Session resume
  if (existing) {
    sdkOptions.resume = existing.sessionId;
  }

  // Security — tool restrictions
  if (security.level === "locked") {
    sdkOptions.allowedTools = ["Read", "Grep", "Glob"];
  } else if (security.level === "strict") {
    sdkOptions.disallowedTools = ["Bash", "WebSearch", "WebFetch"];
  }
  if (security.allowedTools.length > 0) {
    sdkOptions.allowedTools = security.allowedTools;
  }
  if (security.disallowedTools.length > 0) {
    sdkOptions.disallowedTools = security.disallowedTools;
  }

  // Environment for SDK-spawned claude child. The SDK replaces (does not
  // merge) process.env with whatever we set here, so we must build a full
  // env: daemon-safe baseline (with PATH backfill) + per-agent overrides
  // + API/model overrides.
  const envOverrides: Record<string, string> = {};
  if (api.trim()) envOverrides.ANTHROPIC_AUTH_TOKEN = api.trim();
  if (normalizedModel === "glm") {
    envOverrides.ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
    envOverrides.API_TIMEOUT_MS = "3000000";
  }
  const { CLAUDECODE: _sdkClaudecode, ...sdkCleanEnv } = process.env;
  sdkOptions.env = {
    ...withDaemonSafeEnv(sdkCleanEnv as NodeJS.ProcessEnv),
    ...loadAgentEnv(process.cwd()),
    ...envOverrides,
  };

  // Timeout via AbortController (also used for /cancel)
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), CLAUDE_TIMEOUT_MS);
  sdkOptions.abortController = abortController;
  registerInflight(cancelKey, abortController);

  console.log(`[${new Date().toLocaleTimeString()}] Running: ${name} (SDK stream, session: ${existing?.sessionId?.slice(0, 8) ?? "new"})`);

  let unblocked = false;
  let accumulatedText = "";
  let sessionCaptured = !!existing;

  const maybeUnblock = () => {
    if (!unblocked) {
      unblocked = true;
      onUnblock();
    }
  };

  try {
    const conversation = sdkQuery({ prompt, options: sdkOptions as any });

    for await (const message of conversation) {
      // Capture session ID from init event
      if (message.type === "system" && message.session_id && !sessionCaptured) {
        sessionCaptured = true;
        const sid = message.session_id;
        if (threadId) {
          await createThreadSession(threadId, sid);
          console.log(`[${new Date().toLocaleTimeString()}] Thread session created (SDK): ${sid} (thread ${threadId.slice(0, 8)})`);
        } else {
          await createSession(sid);
          console.log(`[${new Date().toLocaleTimeString()}] Session created (SDK): ${sid}`);
        }
      }

      // Streaming text deltas (incremental tokens)
      if (message.type === "stream_event") {
        const event = (message as any).event;
        if (
          event?.type === "content_block_delta" &&
          event?.delta?.type === "text_delta" &&
          event?.delta?.text
        ) {
          accumulatedText += event.delta.text;
          onChunk(accumulatedText);
          maybeUnblock();
        }
      }

      // Complete assistant message — sync accumulated text as checkpoint
      if (message.type === "assistant") {
        const msg = (message as any).message;
        if (msg?.content) {
          let fullText = "";
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              fullText += block.text;
            }
          }
          if (fullText) {
            // Reset accumulator to authoritative text from this turn
            accumulatedText = fullText;
            onChunk(accumulatedText);
            maybeUnblock();
          }
        }
      }

      // Final result — authoritative response text
      if (message.type === "result") {
        const resultMsg = message as any;
        if (resultMsg.subtype === "success" && resultMsg.result) {
          if (onResult) onResult(resultMsg.result);
        }
        maybeUnblock();
      }
    }
  } finally {
    clearTimeout(timeoutId);
    clearInflight(cancelKey, abortController);
  }

  maybeUnblock();
  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name}`);
}

export async function streamUserMessage(
  name: string,
  prompt: string,
  onChunk: (text: string) => void,
  onUnblock: () => void,
  threadId?: string,
  onResult?: (text: string) => void,
): Promise<void> {
  return enqueue(() => streamClaude(name, prefixUserMessageWithClock(prompt), onChunk, onUnblock, threadId, onResult), threadId);
}

function prefixUserMessageWithClock(prompt: string): string {
  try {
    const settings = getSettings();
    const prefix = buildClockPromptPrefix(new Date(), settings.timezoneOffsetMinutes);
    return `${prefix}\n${prompt}`;
  } catch {
    const prefix = buildClockPromptPrefix(new Date(), 0);
    return `${prefix}\n${prompt}`;
  }
}

export async function runUserMessage(name: string, prompt: string, threadId?: string): Promise<RunResult> {
  return run(name, prefixUserMessageWithClock(prompt), threadId);
}

/**
 * Bootstrap the session: fires Claude with the system prompt so the
 * session is created immediately. No-op if a session already exists.
 */
export async function bootstrap(): Promise<void> {
  const existing = await getSession();
  if (existing) return;

  console.log(`[${new Date().toLocaleTimeString()}] Bootstrapping new session...`);
  await execClaude("bootstrap", "Wakeup, my friend!");
  console.log(`[${new Date().toLocaleTimeString()}] Bootstrap complete — session is live.`);
}
