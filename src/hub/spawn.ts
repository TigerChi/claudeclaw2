import { mkdir } from "fs/promises";
import { openSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { buildAgentSpawnEnv } from "../agent-env";

const ENTRY_SCRIPT = fileURLToPath(new URL("../index.ts", import.meta.url));

export interface SpawnOptions {
  /** Extra args to forward to `claudeclaw start`. `--web` is always added. */
  extraArgs?: string[];
}

export interface SpawnResult {
  pid: number;
  logPath: string;
}

/**
 * Spawn `claudeclaw start --web` detached in `projectPath`. The new process
 * survives the parent and writes stdout/stderr to its project log file.
 *
 * Used by the hub's restart and start endpoints.
 */
export async function spawnDetachedDaemon(
  projectPath: string,
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  const logsDir = join(projectPath, ".claude", "claudeclaw", "logs");
  await mkdir(logsDir, { recursive: true });
  const logPath = join(logsDir, "daemon.log");
  const logFd = openSync(logPath, "a");

  const args = ["run", ENTRY_SCRIPT, "start", "--web", ...(opts.extraArgs ?? [])];
  const proc = Bun.spawn([process.execPath, ...args], {
    cwd: projectPath,
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
    env: buildAgentSpawnEnv(projectPath, process.env, { CLAUDECLAW_DETACHED: "1" }),
  });
  proc.unref();
  return { pid: proc.pid, logPath };
}

/**
 * Wait until a PID stops responding to signal 0, up to `timeoutMs`.
 * Returns true if the process died within the timeout.
 */
export async function waitForExit(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(100);
    } catch {
      return true;
    }
  }
  return false;
}
