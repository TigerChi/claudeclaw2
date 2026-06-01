import { homedir, platform } from "os";
import { join } from "path";
import { writeFile, unlink, access, mkdir } from "fs/promises";
import { spawn } from "child_process";
import { HUB_LOG_FILE } from "./paths";

export const LAUNCH_AGENT_LABEL = "com.claudeclaw.hub";
export const LAUNCH_AGENT_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCH_AGENT_LABEL}.plist`,
);

export function isMacOS(): boolean {
  return platform() === "darwin";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runCmd(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }));
    p.on("error", (e) => resolve({ code: 1, stdout: "", stderr: String(e) }));
  });
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildPlist(bunPath: string, indexPath: string): string {
  const args = [bunPath, "run", indexPath, "hub", "start"]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(HUB_LOG_FILE)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(HUB_LOG_FILE)}</string>
</dict>
</plist>
`;
}

export async function isAutostartEnabled(): Promise<boolean> {
  if (!isMacOS()) return false;
  return fileExists(LAUNCH_AGENT_PATH);
}

export async function enableAutostart(): Promise<{ ok: boolean; reason?: string }> {
  if (!isMacOS()) {
    return { ok: false, reason: "Autostart is only supported on macOS (LaunchAgents)." };
  }

  const bunPath = process.execPath;
  // This file lives at .../src/hub/autostart.ts → index.ts is two levels up.
  const indexPath = join(import.meta.dir, "..", "index.ts");

  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await writeFile(LAUNCH_AGENT_PATH, buildPlist(bunPath, indexPath));

  // Replace any existing registration. unload may fail if not loaded — ignore.
  await runCmd("launchctl", ["unload", LAUNCH_AGENT_PATH]);
  const r = await runCmd("launchctl", ["load", LAUNCH_AGENT_PATH]);
  if (r.code !== 0) {
    return { ok: false, reason: `launchctl load failed: ${r.stderr.trim() || "unknown error"}` };
  }
  return { ok: true };
}

export async function disableAutostart(): Promise<{ ok: boolean; reason?: string }> {
  if (!isMacOS()) {
    return { ok: false, reason: "Autostart is only supported on macOS." };
  }
  if (!(await fileExists(LAUNCH_AGENT_PATH))) {
    return { ok: true };
  }
  await runCmd("launchctl", ["unload", LAUNCH_AGENT_PATH]);
  await unlink(LAUNCH_AGENT_PATH);
  return { ok: true };
}
