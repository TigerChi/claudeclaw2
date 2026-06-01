/**
 * Build the `--append-system-prompt` value and CLI argument list for a
 * `claude` spawn. Called once per session spawn (new or resume).
 *
 * What goes in the append:
 *   1. "You are running inside ClaudeClaw." brand line
 *   2. prompts/IDENTITY.md + USER.md + SOUL.md (skipped if absent)
 *   3. DIR_SCOPE_PROMPT (unless security.level == "unrestricted")
 *
 * Notably absent: the project's CLAUDE.md. Claude Code auto-discovers it
 * from cwd, so duplicating it here would only break hot-reload semantics.
 *
 * v3 difference vs hans's v2:
 *   - SILENT_REPLY_PROMPT removed entirely (no NO_REPLY suppression).
 *   - PROMPTS_DIR resolves to the PLUGIN install dir, not cwd. v1 inherited
 *     `prompts/` from the plugin install (per-Agent persona files live in
 *     `_claude/rules/` and CLAUDE.md auto-discovery handles per-project).
 */
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export type SecurityLevel = "locked" | "strict" | "moderate" | "unrestricted";

export interface SecurityConfig {
  level: SecurityLevel;
  allowedTools: string[];
  disallowedTools: string[];
}

// Resolve prompts/ relative to this source file (works for both bun src run
// and bundled output as long as the dir layout is preserved).
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
const PROMPT_FILES = ["IDENTITY.md", "USER.md", "SOUL.md"];

const BRAND_LINE = "You are running inside ClaudeClaw.";

function dirScopePrompt(projectDir: string): string {
  return [
    `CRITICAL SECURITY CONSTRAINT: You are scoped to the project directory: ${projectDir}`,
    "You MUST NOT read, write, edit, or delete any file outside this directory.",
    "You MUST NOT run bash commands that modify anything outside this directory (no cd /, no /etc, no ~/, no ../.. escapes).",
    "If a request requires accessing files outside the project, refuse and explain why.",
  ].join("\n");
}

/**
 * Cron-job schema hint. The agent has Write/Read/Bash natively, so it can
 * manage scheduled jobs by editing markdown files itself — this just tells
 * it the expected file format and conventions. Always appended.
 */
const CRON_JOBS_HINT = [
  "## Scheduled jobs",
  "",
  "You can schedule recurring or one-shot self-prompts by writing markdown files at `.claude/claudeclaw/jobs/<name>.md`:",
  "",
  "```markdown",
  "---",
  'schedule: "0 23 * * *"        # 5-field POSIX cron, required',
  "recurring: true               # default true; false = delete file after firing",
  'target: "global"              # default "global"; or "discord:<channelId>" / "slack:<channelId>" / "slack:<channelId>:<threadTs>"',
  'replyTo: "telegram:<chatId>"  # optional outbound sink; without it output is log-only',
  'timezone: "+08:00"            # optional, default UTC',
  "---",
  "<prompt body — what you want yourself to do when fired>",
  "```",
  "",
  "Use Write to create or update, Glob/Read to inspect, Bash `rm` to delete. The cron tick runs every minute; existing jobs are picked up immediately without restart.",
].join("\n");

async function loadPrompts(): Promise<string> {
  const parts: string[] = [];
  for (const file of PROMPT_FILES) {
    try {
      const content = await readFile(join(PROMPTS_DIR, file), "utf8");
      const trimmed = content.trim();
      if (trimmed) parts.push(trimmed);
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.error(`[compose] failed to read ${file}:`, err);
      }
    }
  }
  return parts.join("\n\n");
}

/**
 * ClaudeClaw capabilities/usage guide. Ships with the plugin in prompts/USAGE.md
 * and is appended to every session's system prompt so any agent running as a
 * daemon knows the in-conversation directives ([react:], [send-agent:], etc.),
 * scheduling, session model, and platform limits without having to go read docs.
 */
async function loadUsage(): Promise<string> {
  try {
    const content = await readFile(join(PROMPTS_DIR, "USAGE.md"), "utf8");
    return content.trim();
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.error("[compose] failed to read USAGE.md:", err);
    }
    return "";
  }
}

export interface ComposeOptions {
  multiparty: boolean;
  security: SecurityConfig;
  /** Absolute path of the project dir. Defaults to process.cwd(). */
  projectDir?: string;
}

export async function composeAppendSystemPrompt(opts: ComposeOptions): Promise<string> {
  const parts: string[] = [BRAND_LINE];
  const userPrompts = await loadPrompts();
  if (userPrompts) parts.push(userPrompts);
  if (opts.security.level !== "unrestricted") {
    parts.push(dirScopePrompt(opts.projectDir ?? process.cwd()));
  }
  parts.push(CRON_JOBS_HINT);
  const usage = await loadUsage();
  if (usage) parts.push(usage);
  // v3: NO SILENT_REPLY_PROMPT — bot must always try to respond. Channel
  // filtering happens at the platform layer (e.g. slack requireMention).
  return parts.join("\n\n");
}

/**
 * Build the security-related CLI args for `claude`. Mirrors v1 buildSecurityArgs
 * so behaviour is unchanged from v1.
 */
export function buildSecurityArgs(security: SecurityConfig): string[] {
  const args: string[] = ["--dangerously-skip-permissions"];

  switch (security.level) {
    case "locked":
      args.push("--tools", "Read,Grep,Glob");
      break;
    case "strict":
      args.push("--disallowedTools", "Bash,WebSearch,WebFetch");
      break;
    case "moderate":
    case "unrestricted":
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

export interface SpawnArgsOptions extends ComposeOptions {
  sessionId: string;
  /** If true, resume an existing session instead of starting a new one. */
  resume?: boolean;
  /** Initial model alias or full id. Pass-through to `--model`. */
  model?: string;
  /** Extra args to append (e.g. --name). */
  extra?: string[];
}

/** Compose the full `claude` argv for a session spawn. */
export async function buildClaudeArgs(opts: SpawnArgsOptions): Promise<string[]> {
  const args = ["claude"];
  if (opts.resume) {
    args.push("--resume", opts.sessionId);
  } else {
    args.push("--session-id", opts.sessionId);
  }
  if (opts.model && opts.model.trim()) {
    args.push("--model", opts.model.trim());
  }
  args.push(...buildSecurityArgs(opts.security));
  const append = await composeAppendSystemPrompt(opts);
  if (append) args.push("--append-system-prompt", append);
  if (opts.extra) args.push(...opts.extra);
  return args;
}
