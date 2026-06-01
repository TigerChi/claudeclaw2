import { homedir } from "os";
import { join } from "path";
import { mkdir, readdir, readFile, writeFile, unlink } from "fs/promises";
import { createHash } from "crypto";

export const DAEMON_REGISTRY_DIR = join(homedir(), ".claude", "claudeclaw", "daemons");

export interface DaemonRegistryEntry {
  path: string;
  pid: number;
  startedAt: number;
}

export function agentIdForPath(path: string): string {
  return createHash("sha1").update(path).digest("hex").slice(0, 12);
}

function entryFile(path: string): string {
  return join(DAEMON_REGISTRY_DIR, `${agentIdForPath(path)}.json`);
}

/**
 * Record this daemon's real cwd in the global registry. Hub and stopAll read
 * the registry instead of trying to reverse-engineer ~/.claude/projects/ dir
 * names, which is lossy when paths contain spaces or hyphens.
 */
export async function registerDaemon(): Promise<void> {
  await mkdir(DAEMON_REGISTRY_DIR, { recursive: true });
  const entry: DaemonRegistryEntry = {
    path: process.cwd(),
    pid: process.pid,
    startedAt: Date.now(),
  };
  await writeFile(entryFile(entry.path), JSON.stringify(entry, null, 2) + "\n", { mode: 0o600 });
}

export async function unregisterDaemon(path: string = process.cwd()): Promise<void> {
  try { await unlink(entryFile(path)); } catch {}
}

/**
 * Read all registry entries. No alive check — callers decide whether to filter
 * by liveness. Malformed JSON files are silently dropped from disk.
 */
export async function listRegisteredDaemons(): Promise<DaemonRegistryEntry[]> {
  let files: string[];
  try {
    files = await readdir(DAEMON_REGISTRY_DIR);
  } catch {
    return [];
  }

  const entries: DaemonRegistryEntry[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const filePath = join(DAEMON_REGISTRY_DIR, f);
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf-8"));
      if (typeof parsed.path !== "string" || typeof parsed.pid !== "number") {
        try { await unlink(filePath); } catch {}
        continue;
      }
      entries.push({
        path: parsed.path,
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      });
    } catch {
      try { await unlink(filePath); } catch {}
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}
