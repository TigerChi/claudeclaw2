/**
 * LINE Webhook Proxy — Auto-Discovery
 *
 * Shared proxy server that auto-discovers all Claude Code agents,
 * reads their LINE settings, and routes webhooks by path to each agent's internal port.
 *
 * Discovery: reads ~/.claude/projects/ session data to find agent working directories.
 * No manual agent registration needed.
 */

import { join, basename } from "node:path";
import { readFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";

// --- Types ---

interface DiscoveredAgent {
  name: string;
  directory: string;
  webhookPath: string;
  internalPort: number;
  channelSecret: string;
  hasLineToken: boolean;
}

interface AgentHealth {
  agent: DiscoveredAgent;
  reachable: boolean;
  lastChecked: number;
}

// --- Constants ---

const HOME = process.env.HOME ?? "/tmp";
const DEFAULT_EXTERNAL_PORT = 18789;
const DEFAULT_BIND = "0.0.0.0";
const RELOAD_INTERVAL_MS = 15_000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const CLAUDECLAW_DIR = join(HOME, ".claude", "claudeclaw");
const PID_PATH = join(CLAUDECLAW_DIR, "proxy.pid");
const LOG_PATH = join(CLAUDECLAW_DIR, "proxy.log");
const CONFIG_PATH = join(CLAUDECLAW_DIR, "proxy-config.json");

// --- Proxy config file ---

interface ProxyFileConfig {
  port?: number;
  bind?: string;
}

function loadProxyConfig(): { port: number; bind: string } {
  let fileConfig: ProxyFileConfig = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch {}
  }
  return {
    port: typeof fileConfig.port === "number" ? fileConfig.port : DEFAULT_EXTERNAL_PORT,
    bind: typeof fileConfig.bind === "string" ? fileConfig.bind : DEFAULT_BIND,
  };
}

// --- State ---

let agents: DiscoveredAgent[] = [];
let agentHealth: Map<string, AgentHealth> = new Map();
let server: ReturnType<typeof Bun.serve> | null = null;
let reloadTimer: ReturnType<typeof setInterval> | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;

// --- Auto-discovery ---

/**
 * Discover all Claude Code agent directories by reading session data
 * from ~/.claude/projects/. Each project's jsonl files contain "cwd" fields
 * with the real working directory path.
 */
function discoverAgentDirectories(): string[] {
  const projectsRoot = join(HOME, ".claude", "projects");
  if (!existsSync(projectsRoot)) return [];

  const found = new Set<string>();

  try {
    const projectDirs = readdirSync(projectsRoot, { withFileTypes: true });

    for (const projEntry of projectDirs) {
      if (!projEntry.isDirectory()) continue;
      const projPath = join(projectsRoot, projEntry.name);

      try {
        const files = readdirSync(projPath)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => ({
            name: f,
            mtime: statSync(join(projPath, f)).mtimeMs,
          }))
          .sort((a, b) => b.mtime - a.mtime);

        if (files.length === 0) continue;

        const content = readFileSync(join(projPath, files[0].name), "utf8");
        const cwds = new Set<string>();

        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          const match = line.match(/"cwd":"([^"]+)"/);
          if (match) cwds.add(match[1]);
        }

        for (const cwd of cwds) {
          if (
            cwd.includes("plugins/cache") ||
            cwd.includes("plugins/marketplaces") ||
            cwd.includes(".claude/")
          ) continue;

          const settingsPath = join(cwd, ".claude", "claudeclaw", "settings.json");
          if (existsSync(settingsPath)) {
            found.add(cwd);
          }
        }
      } catch {
        // skip unreadable project directories
      }
    }
  } catch {
    // projects root unreadable
  }

  return [...found];
}

function readAgentLineConfig(agentDir: string) {
  const settingsPath = join(agentDir, ".claude", "claudeclaw", "settings.json");
  if (!existsSync(settingsPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (!raw.line) return null;
    return {
      channelAccessToken: (raw.line.channelAccessToken ?? "") as string,
      channelSecret: (raw.line.channelSecret ?? "") as string,
      webhookPort: (raw.line.webhookPort ?? 18789) as number,
      webhookPath: (raw.line.webhookPath ?? "/webhook") as string,
    };
  } catch {
    return null;
  }
}

function discoverAgents(): DiscoveredAgent[] {
  const dirs = discoverAgentDirectories();
  const result: DiscoveredAgent[] = [];

  for (const dir of dirs) {
    const name = basename(dir);
    const lineConfig = readAgentLineConfig(dir);

    if (!lineConfig) {
      result.push({ name, directory: dir, webhookPath: "", internalPort: 0, channelSecret: "", hasLineToken: false });
      continue;
    }

    result.push({
      name,
      directory: dir,
      webhookPath: lineConfig.webhookPath,
      internalPort: lineConfig.webhookPort,
      channelSecret: lineConfig.channelSecret,
      hasLineToken: lineConfig.channelAccessToken.length > 0,
    });
  }

  return result;
}

// --- Conflict detection ---

function detectConflicts(agents: DiscoveredAgent[], externalPort: number): string[] {
  const warnings: string[] = [];
  const lineAgents = agents.filter((a) => a.hasLineToken);

  const pathMap = new Map<string, string[]>();
  for (const a of lineAgents) {
    if (!pathMap.has(a.webhookPath)) pathMap.set(a.webhookPath, []);
    pathMap.get(a.webhookPath)!.push(a.name);
  }
  for (const [path, names] of pathMap) {
    if (names.length > 1) {
      warnings.push(`PATH CONFLICT: ${path} used by [${names.join(", ")}]. Each agent needs a unique webhookPath.`);
    }
  }

  for (const a of lineAgents) {
    if (a.internalPort === externalPort) {
      warnings.push(
        `PORT CONFLICT: [${a.name}] webhookPort ${a.internalPort} = proxy external port.\n` +
        `  → Fix: Change webhookPort in ${a.directory}/.claude/claudeclaw/settings.json\n` +
        `  → Suggested: ${externalPort + 1 + lineAgents.indexOf(a)}`
      );
    }
  }

  const portMap = new Map<number, string[]>();
  for (const a of lineAgents) {
    if (a.internalPort === externalPort) continue;
    if (!portMap.has(a.internalPort)) portMap.set(a.internalPort, []);
    portMap.get(a.internalPort)!.push(a.name);
  }
  for (const [port, names] of portMap) {
    if (names.length > 1) {
      warnings.push(
        `PORT CONFLICT: [${names.join(", ")}] share internal port ${port}.\n` +
        `  → Fix: Each agent needs a unique webhookPort.\n` +
        `  → Suggested: ${names.map((n, i) => `${n} → ${externalPort + 1 + i}`).join(", ")}`
      );
    }
  }

  return warnings;
}

// --- Health check ---

async function checkHealth(agent: DiscoveredAgent): Promise<boolean> {
  if (!agent.hasLineToken || agent.internalPort === 0) return false;
  try {
    const res = await fetch(`http://localhost:${agent.internalPort}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function updateAllHealth(): Promise<void> {
  for (const agent of agents) {
    if (!agent.hasLineToken) continue;
    const reachable = await checkHealth(agent);
    agentHealth.set(agent.name, { agent, reachable, lastChecked: Date.now() });
  }
}

// --- Status ---

function getIcon(agent: DiscoveredAgent): string {
  if (!agent.hasLineToken) return "⚪";
  const h = agentHealth.get(agent.name);
  if (!h) return "❓";
  return h.reachable ? "🟢" : "🔴";
}

function printStatus(port: number, bind: string): void {
  const lineAgents = agents.filter((a) => a.hasLineToken);
  const noLineAgents = agents.filter((a) => !a.hasLineToken);

  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  LINE Webhook Proxy (Auto-Discovery)");
  console.log("═══════════════════════════════════════════════════════");
  console.log("");
  console.log(`  External: http://${bind}:${port}`);
  console.log(`  Agents discovered: ${agents.length} total, ${lineAgents.length} LINE-enabled`);
  console.log(`  Auto-reload: every ${RELOAD_INTERVAL_MS / 1000}s`);
  console.log("");
  console.log("  Routes:");
  console.log("  ───────────────────────────────────────────────────");

  if (lineAgents.length === 0) {
    console.log("  (no LINE-enabled agents found)");
  }

  for (const a of lineAgents) {
    const icon = getIcon(a);
    const h = agentHealth.get(a.name);
    const status = !h ? "checking..." : h.reachable ? "connected" : "agent not running";
    console.log(`  ${icon} ${a.webhookPath.padEnd(20)} → :${String(a.internalPort).padEnd(5)}  [${a.name}]  ${status}`);
  }

  if (noLineAgents.length > 0) {
    console.log("");
    for (const a of noLineAgents) {
      console.log(`  ⚪ ${"—".padEnd(20)}            [${a.name}]  LINE not configured`);
    }
  }

  console.log("");
  console.log(`  Total: ${agents.length} agents, ${lineAgents.length} LINE-enabled`);
  console.log("═══════════════════════════════════════════════════════");
  console.log("");
}

// --- Proxy server ---

function startProxyServer(port: number, bind: string): void {
  server = Bun.serve({
    port,
    hostname: bind,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return new Response("OK");
      }

      if (req.method === "GET" && url.pathname === "/status") {
        const data = {
          proxy: { port, bind, pid: process.pid },
          agents: agents.map((a) => ({
            name: a.name,
            directory: a.directory,
            lineEnabled: a.hasLineToken,
            webhookPath: a.webhookPath || null,
            internalPort: a.internalPort || null,
            reachable: agentHealth.get(a.name)?.reachable ?? null,
            lastChecked: agentHealth.get(a.name)?.lastChecked ?? null,
          })),
        };
        return new Response(JSON.stringify(data, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const matched = agents.find((a) => a.hasLineToken && a.webhookPath === url.pathname);
      if (!matched) {
        if (req.method === "POST") {
          console.log(`[${ts()}] 404 POST ${url.pathname} — no matching agent`);
        }
        return new Response("Not Found", { status: 404 });
      }

      const target = `http://localhost:${matched.internalPort}${url.pathname}`;
      try {
        const res = await fetch(target, {
          method: req.method,
          headers: req.headers,
          body: req.method === "POST" ? req.body : undefined,
          signal: AbortSignal.timeout(5000),
        });
        return new Response(await res.text(), { status: res.status, headers: res.headers });
      } catch (err) {
        console.error(`[${ts()}] FORWARD FAILED: ${url.pathname} → :${matched.internalPort} [${matched.name}]: ${err instanceof Error ? err.message : err}`);
        return new Response("OK", { status: 200 });
      }
    },
  });
}

// --- Reload ---

function reload(externalPort: number): void {
  const prev = new Set(agents.filter((a) => a.hasLineToken).map((a) => `${a.webhookPath}→${a.internalPort}`));
  agents = discoverAgents();
  const curr = new Set(agents.filter((a) => a.hasLineToken).map((a) => `${a.webhookPath}→${a.internalPort}`));

  const added = [...curr].filter((p) => !prev.has(p));
  const removed = [...prev].filter((p) => !curr.has(p));

  if (added.length > 0) console.log(`[${ts()}] New routes: ${added.join(", ")}`);
  if (removed.length > 0) console.log(`[${ts()}] Removed routes: ${removed.join(", ")}`);

  const warnings = detectConflicts(agents, externalPort);
  for (const w of warnings) console.warn(`[${ts()}] ⚠️  ${w}`);
}

// --- PID management ---

function writePid(): void {
  try { Bun.write(PID_PATH, String(process.pid)); } catch {}
}

function removePid(): void {
  try { unlinkSync(PID_PATH); } catch {}
}

export function readProxyPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
    if (isNaN(pid)) return null;
    try { process.kill(pid, 0); return pid; } catch { return null; }
  } catch {
    return null;
  }
}

/** Check if a LINE proxy is currently running and responding on the given port.
 *  If no port is specified, reads from proxy-config.json or uses default 18789. */
export async function isProxyRunning(port?: number): Promise<boolean> {
  if (port === undefined) port = loadProxyConfig().port;
  try {
    const res = await fetch(`http://localhost:${port}/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json() as { proxy?: { pid?: number } };
    return typeof data?.proxy?.pid === "number";
  } catch {
    return false;
  }
}

// --- Utility ---

function ts(): string {
  return new Date().toLocaleTimeString();
}

// --- Exported functions for other commands ---

export async function proxyStatus(): Promise<void> {
  const pid = readProxyPid();
  const config = loadProxyConfig();
  if (pid) {
    console.log(`LINE Proxy is running (PID ${pid})`);
  } else {
    console.log("LINE Proxy is NOT running");
  }
  agents = discoverAgents();
  await updateAllHealth();
  printStatus(config.port, config.bind);
  console.log(`  Config: ${existsSync(CONFIG_PATH) ? CONFIG_PATH : "(using defaults, create proxy-config.json to customize)"}`);
  console.log("");
}

export async function proxyStop(): Promise<void> {
  const pid = readProxyPid();
  if (!pid) {
    console.log("LINE Proxy is not running.");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`LINE Proxy stopped (PID ${pid}).`);
  } catch (err) {
    console.error(`Failed to stop proxy: ${err instanceof Error ? err.message : err}`);
  }
}

export async function proxyStart(args: string[] = []): Promise<void> {
  // Priority: CLI args > config file > defaults
  const config = loadProxyConfig();
  let port = config.port;
  let bind = config.bind;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) port = parseInt(args[++i], 10);
    if (args[i] === "--bind" && args[i + 1]) bind = args[++i];
  }

  const existingPid = readProxyPid();
  if (existingPid) {
    console.error(`LINE Proxy already running (PID ${existingPid}). Use 'proxy stop' first.`);
    return;
  }

  agents = discoverAgents();

  const warnings = detectConflicts(agents, port);
  if (warnings.length > 0) {
    console.log("\n⚠️  Configuration warnings:");
    for (const w of warnings) console.warn(`  ${w}`);
    console.log("");
    if (warnings.some((w) => w.includes("= proxy external port"))) {
      console.error("CRITICAL: Some agents use the same port as the proxy. Fix their webhookPort first.");
      return;
    }
  }

  startProxyServer(port, bind);
  writePid();

  await updateAllHealth();
  printStatus(port, bind);

  reloadTimer = setInterval(() => reload(port), RELOAD_INTERVAL_MS);
  healthTimer = setInterval(() => updateAllHealth(), HEALTH_CHECK_INTERVAL_MS);

  const shutdown = () => {
    console.log(`\n[${ts()}] LINE Proxy shutting down...`);
    if (reloadTimer) clearInterval(reloadTimer);
    if (healthTimer) clearInterval(healthTimer);
    if (server) server.stop();
    removePid();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`[${ts()}] LINE Proxy ready. Auto-discovery scanning every ${RELOAD_INTERVAL_MS / 1000}s`);
  console.log(`[${ts()}] Status: http://localhost:${port}/status`);
}

/** CLI entry point: `bun run src/index.ts proxy [start|stop|status]` */
export async function proxy(args: string[] = []): Promise<void> {
  const subcommand = args[0] ?? "status";

  if (subcommand === "start") {
    await proxyStart(args.slice(1));
  } else if (subcommand === "stop") {
    await proxyStop();
  } else {
    await proxyStatus();
  }
}
