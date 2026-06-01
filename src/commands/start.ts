import { writeFile, unlink, mkdir } from "fs/promises";
import { openSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { run, runUserMessage, streamUserMessage, bootstrap, ensureProjectClaudeMd, loadHeartbeatPromptTemplate } from "../runner";
import { writeState, type StateData } from "../statusline";
import { cronMatches, nextCronMatch } from "../cron";
import { clearJobSchedule, loadJobs } from "../jobs";
import { writePidFile, cleanupPidFile, checkExistingDaemon } from "../pid";
import { registerDaemon } from "../daemon-registry";
import { initConfig, loadSettings, reloadSettings, resolvePrompt, type HeartbeatConfig, type Settings } from "../config";
import { getDayAndMinuteAtOffset } from "../timezone";
import { startWebUi, type WebServerHandle } from "../web";
import type { Job } from "../jobs";
import {
  registerAgent,
  unregisterAgent,
  startSocketServer as startBusSocket,
  stopSocketServer as stopBusSocket,
  checkInbox,
  sendToAgent,
  buildAgentMessagePrompt,
  updateHeartbeat,
  consumePending,
  gcPending,
  type AgentMessage,
} from "../agent-bus";

const CLAUDE_DIR = join(process.cwd(), ".claude");
const HEARTBEAT_DIR = join(CLAUDE_DIR, "claudeclaw");
const STATUSLINE_FILE = join(CLAUDE_DIR, "statusline.cjs");
const CLAUDE_SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");
const PREFLIGHT_SCRIPT = fileURLToPath(new URL("../preflight.ts", import.meta.url));

// --- Statusline setup/teardown ---

const STATUSLINE_SCRIPT = `#!/usr/bin/env node
const { readFileSync } = require("fs");
const { join, basename } = require("path");

const DIR = join(__dirname, "claudeclaw");
const STATE_FILE = join(DIR, "state.json");
const PID_FILE = join(DIR, "daemon.pid");

// Project folder name — shown in the box header so multi-window users can tell
// which Claude Code session belongs to which agent without scrolling up.
var AGENT = basename(process.cwd());
if (AGENT.length > 18) AGENT = AGENT.slice(0, 17) + "…";

const R = "\\x1b[0m";
const DIM = "\\x1b[2m";
const RED = "\\x1b[31m";
const GREEN = "\\x1b[32m";

function fmt(ms) {
  if (ms <= 0) return GREEN + "now!" + R;
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m";
  return (s % 60) + "s";
}

function alive() {
  try {
    var pid = readFileSync(PID_FILE, "utf-8").trim();
    process.kill(Number(pid), 0);
    return true;
  } catch { return false; }
}

var B = DIM + "\\u2502" + R;
var TL = DIM + "\\u256d" + R;
var TR = DIM + "\\u256e" + R;
var BL = DIM + "\\u2570" + R;
var BR = DIM + "\\u256f" + R;
var H = DIM + "\\u2500" + R;
// Visual width budget for the box: 30 H-equivalents. Each emoji ≈ 2 wide.
// Inner content " 🦞 NAME 🦞 " visual width = 8 + AGENT.length.
var TARGET = 30;
var INNER = 8 + AGENT.length;
var FILL = Math.max(2, TARGET - INNER);
var FILL_L = Math.floor(FILL / 2);
var FILL_R = FILL - FILL_L;
var HEADER = TL + H.repeat(FILL_L) + " \\ud83e\\udd9e " + AGENT + " \\ud83e\\udd9e " + H.repeat(FILL_R) + TR;
var FOOTER = BL + H.repeat(TARGET) + BR;

if (!alive()) {
  process.stdout.write(
    HEADER + "\\n" +
    B + "        " + RED + "\\u25cb offline" + R + "              " + B + "\\n" +
    FOOTER
  );
  process.exit(0);
}

try {
  var state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  var now = Date.now();
  var info = [];

  if (state.heartbeat) {
    info.push("\\ud83d\\udc93 " + fmt(state.heartbeat.nextAt - now));
  }

  var jc = (state.jobs || []).length;
  info.push("\\ud83d\\udccb " + jc + " job" + (jc !== 1 ? "s" : ""));
  info.push(GREEN + "\\u25cf live" + R);

  if (state.telegram) {
    info.push(GREEN + "\\ud83d\\udce1" + R);
  }

  if (state.discord) {
    info.push(GREEN + "\\ud83c\\udfae" + R);
  }

  if (state.slack) {
    info.push(GREEN + "\\u{1F4AC}" + R);
  }

  if (state.line) {
    info.push(GREEN + "\\ud83d\\udfe2" + R);
  }

  var mid = " " + info.join(" " + B + " ") + " ";

  process.stdout.write(HEADER + "\\n" + B + mid + B + "\\n" + FOOTER);
} catch {
  process.stdout.write(
    HEADER + "\\n" +
    B + DIM + "         waiting...         " + R + B + "\\n" +
    FOOTER
  );
}
`;

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function parseClockMinutes(value: string): number | null {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isHeartbeatExcludedNow(config: HeartbeatConfig, timezoneOffsetMinutes: number): boolean {
  return isHeartbeatExcludedAt(config, timezoneOffsetMinutes, new Date());
}

function isHeartbeatExcludedAt(config: HeartbeatConfig, timezoneOffsetMinutes: number, at: Date): boolean {
  if (!Array.isArray(config.excludeWindows) || config.excludeWindows.length === 0) return false;
  const local = getDayAndMinuteAtOffset(at, timezoneOffsetMinutes);

  for (const window of config.excludeWindows) {
    const start = parseClockMinutes(window.start);
    const end = parseClockMinutes(window.end);
    if (start == null || end == null) continue;
    const days = Array.isArray(window.days) && window.days.length > 0 ? window.days : ALL_DAYS;
    const sameDay = start < end;

    if (sameDay) {
      if (days.includes(local.day) && local.minute >= start && local.minute < end) return true;
      continue;
    }

    if (start === end) {
      if (days.includes(local.day)) return true;
      continue;
    }

    if (local.minute >= start && days.includes(local.day)) return true;
    const previousDay = (local.day + 6) % 7;
    if (local.minute < end && days.includes(previousDay)) return true;
  }

  return false;
}

function nextAllowedHeartbeatAt(
  config: HeartbeatConfig,
  timezoneOffsetMinutes: number,
  intervalMs: number,
  fromMs: number
): number {
  const interval = Math.max(60_000, Math.round(intervalMs));
  let candidate = fromMs + interval;
  let guard = 0;

  while (isHeartbeatExcludedAt(config, timezoneOffsetMinutes, new Date(candidate)) && guard < 20_000) {
    candidate += interval;
    guard++;
  }

  return candidate;
}

async function setupStatusline() {
  await mkdir(CLAUDE_DIR, { recursive: true });
  await writeFile(STATUSLINE_FILE, STATUSLINE_SCRIPT);

  let settings: Record<string, unknown> = {};
  try {
    settings = await Bun.file(CLAUDE_SETTINGS_FILE).json();
  } catch {
    // file doesn't exist or isn't valid JSON
  }
  settings.statusLine = {
    type: "command",
    command: "node .claude/statusline.cjs",
  };
  await writeFile(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
}

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

// --- Main ---

export async function start(args: string[] = []) {
  let hasPromptFlag = false;
  let hasTriggerFlag = false;
  let telegramFlag = false;
  let discordFlag = false;
  let slackFlag = false;
  let lineFlag = false;
  let debugFlag = false;
  let webFlag = false;
  let replaceExistingFlag = false;
  let detachFlag = false;
  let webPortFlag: number | null = null;
  const payloadParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--prompt") {
      hasPromptFlag = true;
    } else if (arg === "--trigger") {
      hasTriggerFlag = true;
    } else if (arg === "--telegram") {
      telegramFlag = true;
    } else if (arg === "--discord") {
      discordFlag = true;
    } else if (arg === "--slack") {
      slackFlag = true;
    } else if (arg === "--line") {
      lineFlag = true;
    } else if (arg === "--debug") {
      debugFlag = true;
    } else if (arg === "--web") {
      webFlag = true;
    } else if (arg === "--replace-existing") {
      replaceExistingFlag = true;
    } else if (arg === "--detach") {
      detachFlag = true;
    } else if (arg === "--web-port") {
      const raw = args[i + 1];
      if (!raw) {
        console.error("`--web-port` requires a numeric value.");
        process.exit(1);
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
        console.error("`--web-port` must be a valid TCP port (1-65535).");
        process.exit(1);
      }
      webPortFlag = parsed;
      i++;
    } else {
      payloadParts.push(arg);
    }
  }
  const payload = payloadParts.join(" ").trim();
  if (hasPromptFlag && !payload) {
    console.error("Usage: claudeclaw start --prompt <prompt> [--trigger] [--telegram] [--discord] [--debug] [--web] [--web-port <port>] [--detach] [--replace-existing]");
    process.exit(1);
  }
  if (!hasPromptFlag && payload) {
    console.error("Prompt text requires `--prompt`.");
    process.exit(1);
  }
  if (telegramFlag && !hasTriggerFlag) {
    console.error("`--telegram` with `start` requires `--trigger`.");
    process.exit(1);
  }
  if (discordFlag && !hasTriggerFlag) {
    console.error("`--discord` with `start` requires `--trigger`.");
    process.exit(1);
  }
  if (hasPromptFlag && !hasTriggerFlag && (webFlag || webPortFlag !== null)) {
    console.error("`--web` is daemon-only. Remove `--prompt`, or add `--trigger`.");
    process.exit(1);
  }
  if (hasPromptFlag && !hasTriggerFlag && detachFlag) {
    console.error("`--detach` is daemon-only. Remove `--prompt`, or add `--trigger`.");
    process.exit(1);
  }

  // One-shot mode: explicit prompt without trigger.
  if (hasPromptFlag && !hasTriggerFlag) {
    const existingPid = await checkExistingDaemon();
    if (existingPid) {
      console.error(`\x1b[31mAborted: daemon already running in this directory (PID ${existingPid})\x1b[0m`);
      console.error("Use `claudeclaw send <message> [--telegram] [--discord]` while daemon is running.");
      process.exit(1);
    }

    await initConfig();
    await loadSettings();
    await ensureProjectClaudeMd();
    const result = await runUserMessage("prompt", payload);
    console.log(result.stdout);
    if (result.exitCode !== 0) process.exit(result.exitCode);
    return;
  }

  const existingPid = await checkExistingDaemon();
  if (existingPid) {
    if (!replaceExistingFlag) {
      console.error(`\x1b[31mAborted: daemon already running in this directory (PID ${existingPid})\x1b[0m`);
      console.error(`Use --stop first, or kill PID ${existingPid} manually.`);
      process.exit(1);
    }

    console.log(`Replacing existing daemon (PID ${existingPid})...`);
    try {
      process.kill(existingPid, "SIGTERM");
    } catch {
      // ignore if process is already dead
    }

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try {
        process.kill(existingPid, 0);
        await Bun.sleep(100);
      } catch {
        break;
      }
    }

    await cleanupPidFile();
  }

  if (detachFlag && process.env.CLAUDECLAW_DETACHED !== "1") {
    await mkdir(join(HEARTBEAT_DIR, "logs"), { recursive: true });
    const logPath = join(HEARTBEAT_DIR, "logs", "daemon.log");
    const logFd = openSync(logPath, "a");
    const childArgs = process.argv.slice(1).filter((a) => a !== "--detach");
    const proc = Bun.spawn([process.execPath, ...childArgs], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      env: { ...process.env, CLAUDECLAW_DETACHED: "1" },
    });
    proc.unref();
    console.log(`ClaudeClaw daemon started in background (PID ${proc.pid})`);
    console.log(`  Logs: ${logPath}`);
    process.exit(0);
  }

  await initConfig();
  const settings = await loadSettings();
  await ensureProjectClaudeMd();
  const jobs = await loadJobs();
  const webEnabled = webFlag || webPortFlag !== null || settings.web.enabled;
  const webPort = webPortFlag ?? settings.web.port;

  await setupStatusline();
  await writePidFile();
  await registerDaemon();
  let web: WebServerHandle | null = null;
  let discordStopGateway: (() => void) | null = null;
  let slackStop: (() => void | Promise<void>) | null = null;
  let lineStop: (() => void) | null = null;

  async function shutdown() {
    if (discordStopGateway) discordStopGateway();
    if (slackStop) await slackStop();
    if (lineStop) lineStop();
    if (web) web.stop();
    // Agent Bus cleanup
    stopBusSocket();
    if (settings.agentBus.enabled && settings.agentBus.name) {
      await unregisterAgent(settings.agentBus.name).catch(() => {});
    }
    await teardownStatusline();
    await cleanupPidFile();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log("ClaudeClaw daemon started");
  console.log(`  PID: ${process.pid}`);
  console.log(`  Security: ${settings.security.level}`);
  if (settings.security.allowedTools.length > 0)
    console.log(`    + allowed: ${settings.security.allowedTools.join(", ")}`);
  if (settings.security.disallowedTools.length > 0)
    console.log(`    - blocked: ${settings.security.disallowedTools.join(", ")}`);
  console.log(`  Heartbeat: ${settings.heartbeat.enabled ? `every ${settings.heartbeat.interval}m` : "disabled"}`);
  console.log(`  Web UI: ${webEnabled ? `http://${settings.web.host}:${webPort}` : "disabled"}`);
  console.log(`  Agent Bus: ${settings.agentBus.enabled ? `"${settings.agentBus.name}"` : "disabled"}`);
  if (debugFlag) console.log("  Debug: enabled");
  console.log(`  Jobs loaded: ${jobs.length}`);
  jobs.forEach((j) => console.log(`    - ${j.name} [${j.schedule}]`));

  // --- Mutable state ---
  let currentSettings: Settings = settings;
  let currentJobs: Job[] = jobs;
  let nextHeartbeatAt = 0;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  const daemonStartedAt = Date.now();

  // --- Telegram ---
  let telegramSend: ((chatId: number, text: string) => Promise<void>) | null = null;
  let telegramToken = "";

  async function initTelegram(token: string) {
    if (token && token !== telegramToken) {
      const { startPolling, sendMessage } = await import("./telegram");
      startPolling(debugFlag);
      telegramSend = (chatId, text) => sendMessage(token, chatId, text);
      telegramToken = token;
      console.log(`[${ts()}] Telegram: enabled`);
    } else if (!token && telegramToken) {
      telegramSend = null;
      telegramToken = "";
      console.log(`[${ts()}] Telegram: disabled`);
    }
  }

  await initTelegram(currentSettings.telegram.token);
  if (!telegramToken) console.log("  Telegram: not configured");

  // --- Discord ---
  let discordSendToUser: ((userId: string, text: string) => Promise<void>) | null = null;
  let discordToken = "";

  async function initDiscord(token: string) {
    if (token && token !== discordToken) {
      const { startGateway, sendMessageToUser, stopGateway } = await import("./discord");
      if (discordToken) stopGateway();
      startGateway(debugFlag);
      discordStopGateway = stopGateway;
      discordSendToUser = (userId, text) => sendMessageToUser(token, userId, text);
      discordToken = token;
      console.log(`[${ts()}] Discord: enabled`);
    } else if (!token && discordToken) {
      if (discordStopGateway) discordStopGateway();
      discordStopGateway = null;
      discordSendToUser = null;
      discordToken = "";
      console.log(`[${ts()}] Discord: disabled`);
    }
  }

  await initDiscord(currentSettings.discord.token);
  if (!discordToken) console.log("  Discord: not configured");

  // --- Slack ---
  let slackSendToUser: ((userId: string, text: string) => Promise<void>) | null = null;
  let slackBotToken = "";

  async function initSlack(botToken: string) {
    if (botToken && botToken !== slackBotToken) {
      const { startSlack, sendMessageToUser: slackSend, stopSlack, stopSlackGraceful } = await import("./slack");
      if (slackBotToken) stopSlack();
      startSlack(debugFlag);
      slackStop = stopSlackGraceful;
      slackSendToUser = (userId, text) => slackSend(botToken, userId, text);
      slackBotToken = botToken;
      console.log(`[${ts()}] Slack: enabled`);
    } else if (!botToken && slackBotToken) {
      if (slackStop) await slackStop();
      slackStop = null;
      slackSendToUser = null;
      slackBotToken = "";
      console.log(`[${ts()}] Slack: disabled`);
    }
  }

  await initSlack(currentSettings.slack.botToken);
  if (!slackBotToken) console.log("  Slack: not configured");

  // --- LINE ---
  let lineSendToUser: ((userId: string, text: string) => Promise<void>) | null = null;
  let lineForwardTargets: () => string[] = () => [];
  let lineAccessToken = "";

  async function initLine(accessToken: string) {
    if (accessToken && accessToken !== lineAccessToken) {
      const { startLine, sendMessageToUser: lineSend, stopLine, getLineForwardTargets } = await import("./line");
      if (lineAccessToken) stopLine();

      // Check if LINE proxy is running — if so, daemon connects via proxy (no port conflict)
      const { isProxyRunning } = await import("./proxy");
      const proxyActive = await isProxyRunning();
      if (proxyActive) {
        console.log(`  LINE: proxy detected, using internal :${currentSettings.line.webhookPort}`);
      }

      startLine(debugFlag);
      lineStop = stopLine;
      lineSendToUser = (userId, text) => lineSend(userId, text);
      lineForwardTargets = getLineForwardTargets;
      lineAccessToken = accessToken;
      console.log(`[${ts()}] LINE: enabled${proxyActive ? " (via proxy)" : ""}`);
    } else if (!accessToken && lineAccessToken) {
      if (lineStop) lineStop();
      lineStop = null;
      lineSendToUser = null;
      lineForwardTargets = () => [];
      lineAccessToken = "";
      console.log(`[${ts()}] LINE: disabled`);
    }
  }

  await initLine(currentSettings.line.channelAccessToken);
  if (!lineAccessToken) console.log("  LINE: not configured");

  function isAddrInUse(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const code = "code" in err ? String((err as { code?: unknown }).code) : "";
    const message = "message" in err ? String((err as { message?: unknown }).message) : "";
    return code === "EADDRINUSE" || message.includes("EADDRINUSE");
  }

  function startWebWithFallback(host: string, preferredPort: number): WebServerHandle {
    const maxAttempts = 10;
    let lastError: unknown;
    for (let i = 0; i < maxAttempts; i++) {
      const candidatePort = preferredPort + i;
      try {
        return startWebUi({
          host,
          port: candidatePort,
          getSnapshot: () => ({
            pid: process.pid,
            startedAt: daemonStartedAt,
            heartbeatNextAt: nextHeartbeatAt,
            settings: currentSettings,
            jobs: currentJobs,
          }),
          onHeartbeatEnabledChanged: (enabled) => {
            if (currentSettings.heartbeat.enabled === enabled) return;
            currentSettings.heartbeat.enabled = enabled;
            scheduleHeartbeat();
            updateState();
            console.log(`[${ts()}] Heartbeat ${enabled ? "enabled" : "disabled"} from Web UI`);
          },
          onHeartbeatSettingsChanged: (patch) => {
            let changed = false;
            if (typeof patch.enabled === "boolean" && currentSettings.heartbeat.enabled !== patch.enabled) {
              currentSettings.heartbeat.enabled = patch.enabled;
              changed = true;
            }
            if (typeof patch.interval === "number" && Number.isFinite(patch.interval)) {
              const interval = Math.max(1, Math.min(1440, Math.round(patch.interval)));
              if (currentSettings.heartbeat.interval !== interval) {
                currentSettings.heartbeat.interval = interval;
                changed = true;
              }
            }
          if (typeof patch.prompt === "string" && currentSettings.heartbeat.prompt !== patch.prompt) {
            currentSettings.heartbeat.prompt = patch.prompt;
            changed = true;
          }
          if (Array.isArray(patch.excludeWindows)) {
            const prev = JSON.stringify(currentSettings.heartbeat.excludeWindows);
            const next = JSON.stringify(patch.excludeWindows);
            if (prev !== next) {
              currentSettings.heartbeat.excludeWindows = patch.excludeWindows;
              changed = true;
            }
          }
          if (!changed) return;
          scheduleHeartbeat();
          updateState();
            console.log(`[${ts()}] Heartbeat settings updated from Web UI`);
          },
          onJobsChanged: async () => {
            currentJobs = await loadJobs();
            scheduleHeartbeat();
            updateState();
            console.log(`[${ts()}] Jobs reloaded from Web UI`);
          },
          onChat: async (message, onChunk, onUnblock) => {
            await streamUserMessage("chat", message, onChunk, onUnblock);
          },
        });
      } catch (err) {
        lastError = err;
        if (!isAddrInUse(err) || i === maxAttempts - 1) throw err;
      }
    }

    throw lastError;
  }

  if (webEnabled) {
    currentSettings.web.enabled = true;
    web = startWebWithFallback(currentSettings.web.host, webPort);
    currentSettings.web.port = web.port;
    console.log(`[${new Date().toLocaleTimeString()}] Web UI listening on http://${web.host}:${web.port}`);
  }

  // --- Helpers ---
  function ts() { return new Date().toLocaleTimeString(); }

  function startPreflightInBackground(projectPath: string): void {
    try {
      const proc = Bun.spawn([process.execPath, "run", PREFLIGHT_SCRIPT, projectPath], {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      proc.unref();
      console.log(`[${ts()}] Plugin preflight started in background`);
    } catch (err) {
      console.error(`[${ts()}] Failed to start plugin preflight:`, err);
    }
  }

  function forwardToTelegram(label: string, result: { exitCode: number; stdout: string; stderr: string }) {
    if (!telegramSend || currentSettings.telegram.allowedUserIds.length === 0) return;
    const text = result.exitCode === 0
      ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
      : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;
    for (const userId of currentSettings.telegram.allowedUserIds) {
      telegramSend(userId, text).catch((err) =>
        console.error(`[Telegram] Failed to forward to ${userId}: ${err}`)
      );
    }
  }

  function forwardToDiscord(label: string, result: { exitCode: number; stdout: string; stderr: string }) {
    if (!discordSendToUser || currentSettings.discord.allowedUserIds.length === 0) return;
    const text = result.exitCode === 0
      ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
      : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;
    for (const userId of currentSettings.discord.allowedUserIds) {
      discordSendToUser(userId, text).catch((err) =>
        console.error(`[Discord] Failed to forward to ${userId}: ${err}`)
      );
    }
  }

  function forwardToSlack(label: string, result: { exitCode: number; stdout: string; stderr: string }) {
    if (!slackSendToUser || currentSettings.slack.allowedUserIds.length === 0) return;
    const text = result.exitCode === 0
      ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
      : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;
    for (const userId of currentSettings.slack.allowedUserIds) {
      slackSendToUser(userId, text).catch((err) =>
        console.error(`[Slack] Failed to forward to ${userId}: ${err}`)
      );
    }
  }

  function forwardToLine(label: string, result: { exitCode: number; stdout: string; stderr: string }) {
    if (!lineSendToUser) return;
    const targets = lineForwardTargets();
    if (targets.length === 0) return;
    const text = result.exitCode === 0
      ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
      : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;
    for (const userId of targets) {
      lineSendToUser(userId, text).catch((err) =>
        console.error(`[LINE] Failed to forward to ${userId}: ${err}`)
      );
    }
  }

  // --- Heartbeat scheduling ---
  function scheduleHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;

    if (!currentSettings.heartbeat.enabled) {
      nextHeartbeatAt = 0;
      return;
    }

    const ms = currentSettings.heartbeat.interval * 60_000;
    nextHeartbeatAt = nextAllowedHeartbeatAt(
      currentSettings.heartbeat,
      currentSettings.timezoneOffsetMinutes,
      ms,
      Date.now()
    );

    function tick() {
      if (isHeartbeatExcludedNow(currentSettings.heartbeat, currentSettings.timezoneOffsetMinutes)) {
        console.log(`[${ts()}] Heartbeat skipped (excluded window)`);
        nextHeartbeatAt = nextAllowedHeartbeatAt(
          currentSettings.heartbeat,
          currentSettings.timezoneOffsetMinutes,
          ms,
          Date.now()
        );
        return;
      }
      Promise.all([
        resolvePrompt(currentSettings.heartbeat.prompt),
        loadHeartbeatPromptTemplate(),
      ])
        .then(([prompt, template]) => {
          const userPromptSection = prompt.trim()
            ? `User custom heartbeat prompt:\n${prompt.trim()}`
            : "";
          const mergedPrompt = [template.trim(), userPromptSection]
            .filter((part) => part.length > 0)
            .join("\n\n");
          if (!mergedPrompt) return null;
          return run("heartbeat", mergedPrompt);
        })
        .then((r) => {
          if (!r) return;
          const shouldForward = currentSettings.heartbeat.forwardToTelegram || !r.stdout.trim().startsWith("HEARTBEAT_OK");
          if (shouldForward) {
            forwardToTelegram("", r);
            forwardToDiscord("", r);
            forwardToSlack("", r);
            forwardToLine("", r);
          }
        });
      nextHeartbeatAt = nextAllowedHeartbeatAt(
        currentSettings.heartbeat,
        currentSettings.timezoneOffsetMinutes,
        ms,
        Date.now()
      );
    }

    heartbeatTimer = setTimeout(function runAndReschedule() {
      tick();
      heartbeatTimer = setTimeout(runAndReschedule, ms);
    }, ms);
  }

  // Startup init:
  // - trigger mode: run exactly one trigger prompt (no separate bootstrap)
  // - normal mode: bootstrap to initialize session context
  if (hasTriggerFlag) {
    const triggerPrompt = hasPromptFlag ? payload : "Wake up, my friend!";
    const triggerResult = await run("trigger", triggerPrompt);
    console.log(triggerResult.stdout);
    if (telegramFlag) forwardToTelegram("", triggerResult);
    if (discordFlag) forwardToDiscord("", triggerResult);
    if (slackFlag) forwardToSlack("", triggerResult);
    if (lineFlag) forwardToLine("", triggerResult);
    if (triggerResult.exitCode !== 0) {
      console.error(`[${ts()}] Startup trigger failed (exit ${triggerResult.exitCode}). Daemon will continue running.`);
    }
  } else {
    // Bootstrap the session first so system prompt is initial context
    // and session.json is created immediately.
    await bootstrap();
  }

  // Install plugins without blocking daemon startup.
  startPreflightInBackground(process.cwd());

  if (currentSettings.heartbeat.enabled) scheduleHeartbeat();

  // --- Agent Bus init ---
  /**
   * If `msg` carries a `replyTo` matching a pending-reply registration the
   * local agent made earlier, route the reply directly to the registered
   * listener and skip global-session dispatch. Returns true if routed.
   */
  async function tryRouteAsPendingReply(busName: string, msg: AgentMessage): Promise<boolean> {
    if (!msg.replyTo) return false;
    const pending = await consumePending(busName, msg.replyTo);
    if (!pending) return false;
    try {
      await writeFile(pending.listenerPath, JSON.stringify(msg, null, 2));
      console.log(`[${ts()}] Agent Bus: routed reply ${msg.id} → listener for ${msg.replyTo}`);
    } catch (err) {
      console.error(`[${ts()}] Agent Bus: failed to write listener file:`, err);
    }
    return true;
  }

  if (currentSettings.agentBus.enabled && currentSettings.agentBus.name) {
    const busName = currentSettings.agentBus.name;
    await registerAgent(busName, process.cwd(), process.pid, "online");

    startBusSocket(busName, async (msg) => {
      // Handle incoming agent messages via socket (real-time)
      if (msg.type === "system") {
        await handleSystemMessage(msg);
        return;
      }
      // Pending-reply routing — short-circuits global session if matched.
      if (await tryRouteAsPendingReply(busName, msg)) return;

      const prompt = buildAgentMessagePrompt([msg]);
      const r = await run("agent-bus", prompt, undefined, msg.id);
      // Forward non-empty results to messaging channels
      if (r.exitCode === 0 && r.stdout?.trim()) {
        forwardToTelegram("agent-bus", r);
        forwardToDiscord("agent-bus", r);
        forwardToSlack("agent-bus", r);
        forwardToLine("agent-bus", r);
      }
    });

    console.log(`[${ts()}] Agent Bus: enabled as "${busName}"`);
  }

  async function handleSystemMessage(msg: AgentMessage & { action?: string; reason?: string }) {
    const busName = currentSettings.agentBus.name;
    console.log(`[${ts()}] Agent Bus: system action "${msg.action}" from "${msg.from}"`);
    switch (msg.action) {
      case "status":
        await sendToAgent(msg.from, JSON.stringify({
          agent: busName,
          pid: process.pid,
          uptime: Date.now() - daemonStartedAt,
          heartbeat: currentSettings.heartbeat.enabled,
          security: currentSettings.security.level,
        }), { from: busName, type: "response", replyTo: msg.id });
        break;
      case "reload-settings":
        currentSettings = await reloadSettings();
        await sendToAgent(msg.from, `Settings reloaded.`, { from: busName, type: "response", replyTo: msg.id });
        break;
      case "reload-jobs":
        currentJobs = await loadJobs();
        await sendToAgent(msg.from, `Jobs reloaded: ${currentJobs.length} job(s).`, { from: busName, type: "response", replyTo: msg.id });
        break;
      default:
        console.log(`[${ts()}] Agent Bus: unknown system action "${msg.action}"`);
    }
  }

  // --- Hot-reload loop (every 30s) ---
  setInterval(async () => {
    try {
      const newSettings = await reloadSettings();
      const newJobs = await loadJobs();

      // Detect heartbeat config changes
      const hbChanged =
        newSettings.heartbeat.enabled !== currentSettings.heartbeat.enabled ||
        newSettings.heartbeat.interval !== currentSettings.heartbeat.interval ||
        newSettings.heartbeat.prompt !== currentSettings.heartbeat.prompt ||
        newSettings.timezoneOffsetMinutes !== currentSettings.timezoneOffsetMinutes ||
        newSettings.timezone !== currentSettings.timezone ||
        JSON.stringify(newSettings.heartbeat.excludeWindows) !== JSON.stringify(currentSettings.heartbeat.excludeWindows);

      // Detect security config changes
      const secChanged =
        newSettings.security.level !== currentSettings.security.level ||
        newSettings.security.allowedTools.join(",") !== currentSettings.security.allowedTools.join(",") ||
        newSettings.security.disallowedTools.join(",") !== currentSettings.security.disallowedTools.join(",");

      if (secChanged) {
        console.log(`[${ts()}] Security level changed → ${newSettings.security.level}`);
      }

      if (hbChanged) {
        console.log(`[${ts()}] Config change detected — heartbeat: ${newSettings.heartbeat.enabled ? `every ${newSettings.heartbeat.interval}m` : "disabled"}`);
        currentSettings = newSettings;
        scheduleHeartbeat();
      } else {
        currentSettings = newSettings;
      }
      if (web) {
        currentSettings.web.enabled = true;
        currentSettings.web.port = web.port;
      }

      // Detect job changes
      const jobNames = newJobs.map((j) => `${j.name}:${j.schedule}:${j.prompt}`).sort().join("|");
      const oldJobNames = currentJobs.map((j) => `${j.name}:${j.schedule}:${j.prompt}`).sort().join("|");
      if (jobNames !== oldJobNames) {
        console.log(`[${ts()}] Jobs reloaded: ${newJobs.length} job(s)`);
        newJobs.forEach((j) => console.log(`    - ${j.name} [${j.schedule}]`));
      }
      currentJobs = newJobs;

      // Telegram changes
      await initTelegram(newSettings.telegram.token);

      // Discord changes
      await initDiscord(newSettings.discord.token);

      // Slack changes
      await initSlack(newSettings.slack.botToken);

      // LINE changes
      await initLine(newSettings.line.channelAccessToken);

      // Agent Bus: check file inbox for offline messages
      if (currentSettings.agentBus.enabled && currentSettings.agentBus.name) {
        const busName = currentSettings.agentBus.name;
        await updateHeartbeat(busName);
        await gcPending(busName).catch(() => {});
        const inboxMessages = await checkInbox(busName);
        for (const msg of inboxMessages) {
          if (msg.type === "system") {
            await handleSystemMessage(msg as any);
            continue;
          }
          // Pending-reply routing — short-circuits global session if matched.
          if (await tryRouteAsPendingReply(busName, msg)) continue;

          const prompt = buildAgentMessagePrompt([msg]);
          const r = await run("agent-bus", prompt, undefined, msg.id);
          if (r.exitCode === 0 && r.stdout?.trim()) {
            forwardToTelegram("agent-bus", r);
            forwardToDiscord("agent-bus", r);
            forwardToSlack("agent-bus", r);
            forwardToLine("agent-bus", r);
          }
        }
      }
    } catch (err) {
      console.error(`[${ts()}] Hot-reload error:`, err);
    }
  }, 30_000);

  // --- Cron tick (every 60s) ---
  function updateState() {
    const now = new Date();
    const state: StateData = {
      heartbeat: currentSettings.heartbeat.enabled
        ? { nextAt: nextHeartbeatAt }
        : undefined,
      jobs: currentJobs.map((job) => ({
        name: job.name,
        nextAt: nextCronMatch(job.schedule, now, currentSettings.timezoneOffsetMinutes).getTime(),
      })),
      security: currentSettings.security.level,
      telegram: !!currentSettings.telegram.token,
      discord: !!currentSettings.discord.token,
      slack: !!currentSettings.slack.botToken,
      line: !!currentSettings.line.channelAccessToken,
      startedAt: daemonStartedAt,
      web: {
        enabled: !!web,
        host: currentSettings.web.host,
        port: currentSettings.web.port,
      },
    };
    writeState(state);
  }

  updateState();

  setInterval(() => {
    const now = new Date();
    for (const job of currentJobs) {
      if (cronMatches(job.schedule, now, currentSettings.timezoneOffsetMinutes)) {
        resolvePrompt(job.prompt)
          .then((prompt) => run(job.name, prompt))
          .then((r) => {
              if (job.notify === false) return;
            if (job.notify === "error" && r.exitCode === 0) return;
            const wantAll = job.channels.length === 0;
            const want = (c: string) => wantAll || job.channels.includes(c as never);
            if (want("telegram")) forwardToTelegram(job.name, r);
            if (want("discord")) forwardToDiscord(job.name, r);
            if (want("slack")) forwardToSlack(job.name, r);
            if (want("line")) forwardToLine(job.name, r);
          })
          .finally(async () => {
            if (job.recurring) return;
            try {
              await clearJobSchedule(job.name);
              console.log(`[${ts()}] Cleared schedule for one-time job: ${job.name}`);
            } catch (err) {
              console.error(`[${ts()}] Failed to clear schedule for ${job.name}:`, err);
            }
          });
      }
    }
    updateState();
  }, 60_000);
}
