import { homedir } from "os";
import { join } from "path";
import { mkdir, chmod, readFile, writeFile, unlink } from "fs/promises";

export const HUB_DIR = join(homedir(), ".claude", "claudeclaw", "hub");
export const HUB_PID_FILE = join(HUB_DIR, "hub.pid");
export const HUB_PORT_FILE = join(HUB_DIR, "hub.port");
export const HUB_AUTH_FILE = join(HUB_DIR, "auth.json");
export const HUB_CONFIG_FILE = join(HUB_DIR, "config.json");
export const HUB_LOG_FILE = join(HUB_DIR, "hub.log");

export interface HubConfig {
  host: string;
  port: number;
  autostartProxy: boolean;
  /**
   * Per-agent opt-out for daemon autostart on hub start. Missing key (or
   * missing field entirely) means "yes, autostart" — newly registered agents
   * are picked up automatically. Set a path to `false` to skip it.
   */
  daemonAutostart: Record<string, boolean>;
}

export const DEFAULT_HUB_CONFIG: HubConfig = {
  host: "127.0.0.1",
  port: 4631,
  autostartProxy: false,
  daemonAutostart: {},
};

export async function ensureHubDir(): Promise<void> {
  await mkdir(HUB_DIR, { recursive: true });
  try { await chmod(HUB_DIR, 0o700); } catch {}
}

export async function readHubConfig(): Promise<HubConfig> {
  try {
    const raw = await readFile(HUB_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const daemonAutostart: Record<string, boolean> = {};
    if (parsed.daemonAutostart && typeof parsed.daemonAutostart === "object" && !Array.isArray(parsed.daemonAutostart)) {
      for (const [k, v] of Object.entries(parsed.daemonAutostart)) {
        if (typeof v === "boolean") daemonAutostart[k] = v;
      }
    }
    return {
      host: typeof parsed.host === "string" && parsed.host.trim() ? parsed.host.trim() : DEFAULT_HUB_CONFIG.host,
      port: Number.isFinite(parsed.port) ? Number(parsed.port) : DEFAULT_HUB_CONFIG.port,
      autostartProxy: typeof parsed.autostartProxy === "boolean" ? parsed.autostartProxy : DEFAULT_HUB_CONFIG.autostartProxy,
      daemonAutostart,
    };
  } catch {
    return { ...DEFAULT_HUB_CONFIG };
  }
}

export async function writeHubConfig(cfg: HubConfig): Promise<void> {
  await ensureHubDir();
  await writeFile(HUB_CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

export async function writeHubPid(pid: number, port: number): Promise<void> {
  await ensureHubDir();
  await writeFile(HUB_PID_FILE, String(pid) + "\n");
  await writeFile(HUB_PORT_FILE, String(port) + "\n");
}

export async function cleanupHubPid(): Promise<void> {
  try { await unlink(HUB_PID_FILE); } catch {}
  try { await unlink(HUB_PORT_FILE); } catch {}
}

export async function readHubPid(): Promise<number | null> {
  try {
    const raw = (await readFile(HUB_PID_FILE, "utf-8")).trim();
    const pid = Number(raw);
    if (!pid || isNaN(pid)) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export async function readHubPort(): Promise<number | null> {
  try {
    const raw = (await readFile(HUB_PORT_FILE, "utf-8")).trim();
    const port = Number(raw);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}
