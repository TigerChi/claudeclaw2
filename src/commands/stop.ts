import { writeFile, unlink, readFile } from "fs/promises";
import { join } from "path";
import { getPidPath, cleanupPidFile } from "../pid";
import { listRegisteredDaemons } from "../daemon-registry";

const CLAUDE_DIR = join(process.cwd(), ".claude");
const HEARTBEAT_DIR = join(CLAUDE_DIR, "claudeclaw");
const STATUSLINE_FILE = join(CLAUDE_DIR, "statusline.cjs");
const CLAUDE_SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");

async function teardownStatusline() {
  try {
    const settings = await Bun.file(CLAUDE_SETTINGS_FILE).json();
    delete settings.statusLine;
    await writeFile(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // file doesn't exist, nothing to clean up
  }

  try {
    await unlink(STATUSLINE_FILE);
  } catch {
    // already gone
  }
}

export async function stop() {
  const pidFile = getPidPath();
  let pid: string;
  try {
    pid = (await Bun.file(pidFile).text()).trim();
  } catch {
    console.log("No daemon is running (PID file not found).");
    process.exit(0);
  }

  try {
    process.kill(Number(pid), "SIGTERM");
    console.log(`Stopped daemon (PID ${pid}).`);
  } catch {
    console.log(`Daemon process ${pid} already dead.`);
  }

  await cleanupPidFile();
  await teardownStatusline();

  try {
    await unlink(join(HEARTBEAT_DIR, "state.json"));
  } catch {
    // already gone
  }

  process.exit(0);
}

export async function restart() {
  const pidFile = getPidPath();
  let pid: string;
  try {
    pid = (await Bun.file(pidFile).text()).trim();
  } catch {
    console.log("No daemon is running. Starting fresh...");
    return; // caller will proceed to start
  }

  try {
    process.kill(Number(pid), "SIGTERM");
    console.log(`Stopped daemon (PID ${pid}).`);
  } catch {
    console.log(`Daemon process ${pid} already dead.`);
  }

  await cleanupPidFile();
  await teardownStatusline();

  try {
    await unlink(join(HEARTBEAT_DIR, "state.json"));
  } catch {}

  // Brief pause to let port/socket release
  await new Promise((r) => setTimeout(r, 500));
  console.log("Restarting...");
}

export interface StopByPathResult {
  ok: boolean;
  pid?: number;
  reason?: "no-pid-file" | "already-dead" | "kill-failed";
}

/**
 * Stop a daemon running in `projectPath`. Returns ok:true if a SIGTERM was
 * delivered (or pid file removed). Used by `stopAll` and the hub control plane.
 * Does NOT exit the process. Waits up to `waitMs` for the process to actually die.
 */
export async function stopByPath(projectPath: string, waitMs = 4000): Promise<StopByPathResult> {
  const pidFile = join(projectPath, ".claude", "claudeclaw", "daemon.pid");

  let pidStr: string;
  try {
    pidStr = (await readFile(pidFile, "utf-8")).trim();
  } catch {
    return { ok: false, reason: "no-pid-file" };
  }
  const pid = Number(pidStr);
  if (!pid || isNaN(pid)) {
    try { await unlink(pidFile); } catch {}
    return { ok: false, reason: "no-pid-file" };
  }

  // Verify alive before SIGTERM
  try {
    process.kill(pid, 0);
  } catch {
    try { await unlink(pidFile); } catch {}
    return { ok: false, pid, reason: "already-dead" };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { ok: false, pid, reason: "kill-failed" };
  }

  // Wait for actual exit
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(100);
    } catch {
      break;
    }
  }
  try { await unlink(pidFile); } catch {}
  return { ok: true, pid };
}

export async function stopAll() {
  const daemons = await listRegisteredDaemons();
  if (daemons.length === 0) {
    console.log("No running daemons found.");
    process.exit(0);
  }

  let stopped = 0;
  for (const d of daemons) {
    const result = await stopByPath(d.path, 0);
    if (result.ok) {
      stopped++;
      console.log(`\x1b[33m■ Stopped\x1b[0m PID ${result.pid} — ${d.path}`);
    } else if (result.reason === "kill-failed") {
      console.log(`\x1b[31m✗ Failed to stop\x1b[0m PID ${result.pid} — ${d.path}`);
    }
  }

  if (stopped === 0) {
    console.log("No running daemons found.");
  }

  process.exit(0);
}
