import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawnSync } from "bun";

const ENV_FILENAMES = ["_claude/agent.env"];

const LEAKY_GLOBAL_KEYS = ["OP_SERVICE_ACCOUNT_TOKEN"];

/**
 * Directories that should always be on PATH for daemon-spawned children.
 * The hub may be started by launchd with a minimal PATH (`/usr/bin:/bin:...`),
 * which means `claude`, `bun`, and Homebrew binaries cannot be resolved by
 * children. We backfill these regardless of inherited PATH.
 */
const ENSURED_PATH_ENTRIES = [
  `${homedir()}/.local/bin`,
  `${homedir()}/.bun/bin`,
  `${homedir()}/.claude/bin`,
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
];

export function ensurePathEntries(pathValue: string | undefined): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const append = (p: string) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    parts.push(p);
  };
  for (const entry of ENSURED_PATH_ENTRIES) append(entry);
  if (pathValue) for (const entry of pathValue.split(":")) append(entry);
  return parts.join(":");
}

function findEnvFile(projectPath: string): string | null {
  for (const rel of ENV_FILENAMES) {
    const p = join(projectPath, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Load per-agent env from `<projectPath>/_claude/agent.env`.
 *
 * The file is a shell script (typically containing `export FOO=$(...)` lines
 * that pull secrets from macOS Keychain). We evaluate it via `bash` so
 * dynamic command substitutions work.
 *
 * Returns an empty object if no file exists or evaluation fails — callers
 * should treat absence as "no per-agent overrides".
 */
export function loadAgentEnv(projectPath: string): Record<string, string> {
  const envFile = findEnvFile(projectPath);
  if (!envFile) return {};

  try {
    const result = spawnSync(
      ["bash", "-c", `set -a; source "${envFile}" 2>/dev/null; env -0`],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (result.exitCode !== 0) return {};
    const raw = result.stdout.toString();

    const fileEntries: Record<string, string> = {};
    for (const entry of raw.split("\0")) {
      if (!entry) continue;
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      fileEntries[entry.slice(0, eq)] = entry.slice(eq + 1);
    }

    const baseline = new Set(Object.keys(process.env));
    const overrides: Record<string, string> = {};
    for (const [k, v] of Object.entries(fileEntries)) {
      if (!baseline.has(k) || process.env[k] !== v) overrides[k] = v;
    }
    return overrides;
  } catch {
    return {};
  }
}

/**
 * Strip global env keys that should not leak from one agent's daemon to
 * another agent's spawned daemon. Per-agent `agent.env` should fill these
 * back in via Keychain.
 */
export function withoutLeakyGlobals(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (LEAKY_GLOBAL_KEYS.includes(k)) continue;
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Same as `withoutLeakyGlobals` but also guarantees PATH contains the
 * standard binary locations (`~/.local/bin`, `~/.bun/bin`, Homebrew, etc.).
 * Use this for any env passed to a child process that needs to find
 * `claude`, `bun`, or other tools.
 */
export function withDaemonSafeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out = withoutLeakyGlobals(env);
  out.PATH = ensurePathEntries(out.PATH);
  return out;
}

/**
 * Build the env for a child process spawned for a specific agent project:
 *   - Strip leaky global secrets from the parent env
 *   - Layer the agent's own `_claude/agent.env` on top
 */
export function buildAgentSpawnEnv(
  projectPath: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
  extras: Record<string, string> = {}
): Record<string, string> {
  const merged: Record<string, string> = {
    ...withoutLeakyGlobals(parentEnv),
    ...loadAgentEnv(projectPath),
    ...extras,
  };
  merged.PATH = ensurePathEntries(merged.PATH);
  return merged;
}
