import { openSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { startHubServer } from "../hub/server";
import { isProxyRunning, readProxyPid } from "./proxy";
import {
  HUB_LOG_FILE,
  cleanupHubPid,
  ensureHubDir,
  readHubConfig,
  readHubPid,
  readHubPort,
  writeHubPid,
  writeHubConfig,
} from "../hub/paths";
import { hasAuth, initAuth, rotateAuth } from "../hub/auth";
import { listAgents, findAgentById, findAgentByPath } from "../hub/registry";
import type { HubConfig } from "../hub/paths";
import { spawnDetachedDaemon } from "../hub/spawn";
import { stopByPath } from "./stop";
import {
  enableAutostart,
  disableAutostart,
  isAutostartEnabled,
  isMacOS,
} from "../hub/autostart";

function printUsage() {
  const COL_L = 35;
  const COL_R = 55;
  const dash = (n: number) => "─".repeat(n);
  const top = "┌" + dash(COL_L + 2) + "┬" + dash(COL_R + 2) + "┐";
  const sep = "├" + dash(COL_L + 2) + "┼" + dash(COL_R + 2) + "┤";
  const bot = "└" + dash(COL_L + 2) + "┴" + dash(COL_R + 2) + "┘";
  const row = (l: string, r: string) => `│ ${l.padEnd(COL_L)} │ ${r.padEnd(COL_R)} │`;

  const rows: Array<[string, string]> = [
    ["Subcommand", "What it does"],
    ["(no args)", "Detect: print status if running, start --detach if not"],
    ["status", "Show hub PID, URL, auth, autostart, agents"],
    ["start [--detach --host --port]", "Start the hub (auto-inits token on first run)"],
    ["stop", "Stop the hub"],
    ["init [--force]", "Manually generate bearer token (rarely needed)"],
    ["token --rotate", "Replace the current token (revokes old)"],
    ["restart <agent-id|path>", "Restart a registered daemon"],
    ["autostart <enable|disable|status>", "Manage launch-on-login (macOS only)"],
  ];

  console.log(top);
  rows.forEach(([l, r], i) => {
    console.log(row(l, r));
    if (i < rows.length - 1) console.log(sep);
  });
  console.log(bot);
  console.log("");
  console.log("Typical first-time flow:");
  console.log("  /claudeclaw:hub             → auto-inits token, asks about autostart, starts hub");
  console.log("  open http://127.0.0.1:4631  → paste the bearer token");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const PROXY_LOG_FILE = join(homedir(), ".claude", "claudeclaw", "proxy.log");
const ENTRY_SCRIPT = fileURLToPath(new URL("../index.ts", import.meta.url));

async function maybeAutostartDaemons(cfg: HubConfig): Promise<void> {
  const agents = await listAgents();
  const opts = cfg.daemonAutostart;
  let started = 0;
  let skipped = 0;
  for (const agent of agents) {
    if (agent.alive) continue;
    if (opts[agent.path] === false) {
      skipped++;
      continue;
    }
    try {
      const spawned = await spawnDetachedDaemon(agent.path);
      console.log(`  Daemon autostart: ${agent.path} (PID ${spawned.pid})`);
      started++;
    } catch (err) {
      console.error(`  Daemon autostart FAILED: ${agent.path} — ${err instanceof Error ? err.message : err}`);
    }
  }
  if (started === 0 && skipped === 0) {
    console.log("  Daemon autostart: nothing to start (all alive or none registered)");
  } else if (started === 0) {
    console.log(`  Daemon autostart: ${skipped} skipped via config`);
  }
}

async function maybeAutostartProxy(): Promise<void> {
  // Survives hub restart on purpose — proxy lives independently with its own
  // pid file at ~/.claude/claudeclaw/proxy.pid. We only spawn when nothing is
  // already listening.
  if (await isProxyRunning()) {
    const pid = readProxyPid();
    console.log(`  LINE Proxy: already running${pid ? ` (PID ${pid})` : ""}`);
    return;
  }
  const logFd = openSync(PROXY_LOG_FILE, "a");
  const proc = Bun.spawn([process.execPath, "run", ENTRY_SCRIPT, "proxy", "start"], {
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
    env: process.env,
  });
  proc.unref();
  console.log(`  LINE Proxy: autostart spawned (PID ${proc.pid}, logs: ${PROXY_LOG_FILE})`);
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

async function maybePromptAutostart() {
  if (!isMacOS()) return;
  if (await isAutostartEnabled()) return;
  if (process.stdin.isTTY) {
    const yes = await promptYesNo("\n要把 hub 設定為開機自動啟動嗎? (autostart) [y/N]: ");
    if (yes) {
      const r = await enableAutostart();
      if (r.ok) console.log("✓ Autostart enabled. Hub will launch on login.\n");
      else console.error(`✗ Autostart enable failed: ${r.reason}\n`);
    }
  } else {
    // Non-TTY (e.g. via slash command). Slash command (.md) instructs Claude
    // to ask the user separately and then run `hub autostart enable` on yes.
    console.log("To enable launch-on-login later: claudeclaw hub autostart enable\n");
  }
}

async function cmdInit(args: string[]) {
  const force = args.includes("--force");
  if (!force && (await hasAuth())) {
    console.error("Auth already initialized. Use `claudeclaw hub token --rotate` to replace.");
    process.exit(1);
  }
  const token = force ? await rotateAuth() : await initAuth();
  console.log("ClaudeClaw Hub auth initialized.");
  console.log("");
  console.log("  Bearer token (copy now — you won't see this again):");
  console.log("");
  console.log("    " + token);
  console.log("");
  console.log("  Use header `Authorization: Bearer <token>` for /api/* requests.");
  await maybePromptAutostart();
}

async function cmdToken(args: string[]) {
  if (!args.includes("--rotate")) {
    console.error("Usage: claudeclaw hub token --rotate");
    process.exit(1);
  }
  const token = await rotateAuth();
  console.log("Token rotated. New token (copy now):");
  console.log("");
  console.log("  " + token);
}

async function cmdStart(args: string[]) {
  let detachFlag = false;
  let host: string | null = null;
  let port: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--detach") detachFlag = true;
    else if (a === "--host") {
      host = String(args[++i] ?? "");
    } else if (a === "--port") {
      const p = Number(args[++i]);
      if (!Number.isFinite(p) || p <= 0 || p > 65535) {
        console.error("`--port` must be a valid TCP port (1-65535).");
        process.exit(1);
      }
      port = p;
    }
  }

  await ensureHubDir();

  // Already running → degrade to status + usage. Lets `claudeclaw hub` (or
  // `/claudeclaw:hub`) be a single ergonomic entry point: start when stopped,
  // status (with help) when already up.
  // Verify the PID is actually alive — stale pid files (after crash, kill -9,
  // or reboot) would otherwise misreport "running" forever.
  const existing = await readHubPid();
  if (existing) {
    if (isProcessAlive(existing)) {
      await cmdStatus();
      return;
    }
    // Stale pid file. Clean up and continue with normal start.
    await cleanupHubPid();
  }

  const cfg = await readHubConfig();
  const finalHost = host ?? cfg.host;
  const finalPort = port ?? cfg.port;

  if (host !== null || port !== null) {
    await writeHubConfig({ ...cfg, host: finalHost, port: finalPort });
  }

  // Auto-init bearer token on first ever run.
  if (!(await hasAuth())) {
    const token = await initAuth();
    console.log("ClaudeClaw Hub auth initialized.");
    console.log("");
    console.log("  Bearer token (copy now — you won't see this again):");
    console.log("");
    console.log("    " + token);
    console.log("");
    console.log("  Use header `Authorization: Bearer <token>` for /api/* requests.");
    console.log("");
    await maybePromptAutostart();
  }

  if (finalHost !== "127.0.0.1" && finalHost !== "::1" && finalHost !== "localhost") {
    console.warn(
      `Warning: hub is binding ${finalHost}. Bearer token alone is NOT confidential over plain HTTP.\n` +
        `         Front the hub with TLS (caddy, nginx, traefik) before exposing it remotely.`
    );
  }

  if (detachFlag && process.env.CLAUDECLAW_HUB_DETACHED !== "1") {
    const logFd = openSync(HUB_LOG_FILE, "a");
    const childArgs = process.argv.slice(1).filter((a) => a !== "--detach");
    const proc = Bun.spawn([process.execPath, ...childArgs], {
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      env: { ...process.env, CLAUDECLAW_HUB_DETACHED: "1" },
    });
    proc.unref();
    console.log(`ClaudeClaw Hub started in background (PID ${proc.pid})`);
    console.log(`  Logs: ${HUB_LOG_FILE}`);
    console.log(`  URL:  http://${finalHost}:${finalPort}`);
    process.exit(0);
  }

  const handle = startHubServer({ host: finalHost, port: finalPort });
  await writeHubPid(process.pid, handle.port);

  const shutdown = async () => {
    handle.stop();
    await cleanupHubPid();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`ClaudeClaw Hub listening on http://${handle.host}:${handle.port}`);
  console.log(`  PID: ${process.pid}`);

  if (cfg.autostartProxy) {
    await maybeAutostartProxy();
  }

  await maybeAutostartDaemons(cfg);
}

async function cmdStop() {
  const pid = await readHubPid();
  if (!pid) {
    console.log("Hub is not running.");
    await cleanupHubPid();
    return;
  }
  if (!isProcessAlive(pid)) {
    console.log(`Hub process ${pid} already dead. Cleaning up pid file.`);
    await cleanupHubPid();
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped hub (PID ${pid}).`);
  } catch {
    console.log(`Hub process ${pid} already dead.`);
  }
  await cleanupHubPid();
}

async function cmdStatus() {
  const pid = await readHubPid();
  const port = await readHubPort();
  const cfg = await readHubConfig();
  if (pid) {
    console.log(`\x1b[32m● Hub running\x1b[0m (PID ${pid}) on http://${cfg.host}:${port ?? cfg.port}`);
  } else {
    console.log("\x1b[31m○ Hub is not running\x1b[0m");
  }
  console.log(`  Auth: ${(await hasAuth()) ? "configured" : "not configured"}`);
  if (isMacOS()) {
    console.log(`  Autostart: ${(await isAutostartEnabled()) ? "enabled" : "disabled"}`);
  }
  console.log("");
  const agents = await listAgents();
  console.log(`Discovered agents (${agents.length}):`);
  for (const a of agents) {
    const dot = a.alive ? "\x1b[32m●\x1b[0m" : "\x1b[31m○\x1b[0m";
    const sub = a.alive ? `PID ${a.pid}` + (a.web ? ` :${a.web.port}` : "") : "stopped";
    console.log(`  ${dot} ${a.path} — ${sub}`);
  }
  console.log("");
  printUsage();
}

async function cmdAutostart(args: string[]) {
  const sub = args[0] ?? "status";
  if (sub === "enable") {
    const r = await enableAutostart();
    if (!r.ok) {
      console.error(r.reason);
      process.exit(1);
    }
    console.log("Autostart enabled. Hub will launch on login.");
    return;
  }
  if (sub === "disable") {
    const r = await disableAutostart();
    if (!r.ok) {
      console.error(r.reason);
      process.exit(1);
    }
    console.log("Autostart disabled.");
    return;
  }
  if (sub === "status") {
    if (!isMacOS()) {
      console.log("Autostart: not supported on this platform (macOS only).");
      return;
    }
    console.log(`Autostart: ${(await isAutostartEnabled()) ? "enabled" : "disabled"}`);
    return;
  }
  console.error("Usage: claudeclaw hub autostart <enable|disable|status>");
  process.exit(1);
}

async function cmdRestart(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: claudeclaw hub restart <agent-id|path>");
    process.exit(1);
  }
  const target = args[0];
  let agent = await findAgentById(target);
  if (!agent) agent = await findAgentByPath(target);
  if (!agent) {
    console.error(`Agent not found: ${target}`);
    process.exit(1);
  }
  if (agent.alive) {
    console.log(`Stopping PID ${agent.pid}...`);
    const r = await stopByPath(agent.path, 4000);
    if (!r.ok && r.reason !== "already-dead") {
      console.error(`Stop failed: ${r.reason ?? "unknown"}`);
      process.exit(1);
    }
  }
  const spawned = await spawnDetachedDaemon(agent.path);
  console.log(`Spawned detached daemon (PID ${spawned.pid})`);
  console.log(`  Logs: ${spawned.logPath}`);
}

export async function hub(args: string[]) {
  const sub = args[0];
  // No subcommand → default to `start`. cmdStart auto-handles already-running
  // (prints status + usage) and missing auth (auto-init).
  if (!sub) {
    return cmdStart([]);
  }
  const rest = args.slice(1);
  switch (sub) {
    case "init":
      return cmdInit(rest);
    case "start":
      return cmdStart(rest);
    case "stop":
      return cmdStop();
    case "status":
      return cmdStatus();
    case "token":
      return cmdToken(rest);
    case "restart":
      return cmdRestart(rest);
    case "autostart":
      return cmdAutostart(rest);
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printUsage();
      process.exit(1);
  }
}

