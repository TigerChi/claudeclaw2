import { writeFile, unlink, readFile } from "fs/promises";
import { join } from "path";

const PID_FILE = join(process.cwd(), ".claude", "claudeclaw", "daemon.pid");

export function getPidPath(): string {
  return PID_FILE;
}

/**
 * Check if a daemon is already running in this directory.
 * If a stale PID file exists (process dead), it gets cleaned up.
 * Returns the running PID if alive, or null.
 */
export async function checkExistingDaemon(): Promise<number | null> {
  let raw: string;
  try {
    raw = (await readFile(PID_FILE, "utf-8")).trim();
  } catch {
    return null; // no pid file
  }

  const pid = Number(raw);
  if (!pid || isNaN(pid)) {
    await cleanupPidFile();
    return null;
  }

  try {
    process.kill(pid, 0); // signal 0 = just check if alive
    return pid;
  } catch {
    // process is dead, clean up stale pid file
    await cleanupPidFile();
    return null;
  }
}

export async function writePidFile(): Promise<void> {
  await writeFile(PID_FILE, String(process.pid) + "\n");
}

export async function cleanupPidFile(): Promise<void> {
  try {
    await unlink(PID_FILE);
  } catch {
    // already gone
  }
}

/**
 * Read a PID file at `pidFile` and return the live PID, or null if the file
 * is missing/unreadable or the process is dead. Cleans up stale files.
 * Hub and registry use this to probe arbitrary project daemons.
 */
export async function checkPidAt(pidFile: string): Promise<number | null> {
  let raw: string;
  try {
    raw = (await readFile(pidFile, "utf-8")).trim();
  } catch {
    return null;
  }
  const pid = Number(raw);
  if (!pid || isNaN(pid)) {
    try { await unlink(pidFile); } catch {}
    return null;
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    try { await unlink(pidFile); } catch {}
    return null;
  }
}
