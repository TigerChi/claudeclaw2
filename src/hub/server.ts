import { json } from "../ui/http";
import { stopByPath } from "../commands/stop";
import {
  listAgents,
  findAgentById,
  findAgentByPath,
  type AgentRecord,
} from "./registry";
import { spawnDetachedDaemon, waitForExit } from "./spawn";
import { hubPage } from "./page";
import { extractBearer, hasAuth, verifyBearerToken } from "./auth";

export interface HubServerOptions {
  host: string;
  port: number;
}

export interface HubServerHandle {
  stop: () => void;
  host: string;
  port: number;
}

const PROXY_PREFIX = "/api/agents/";
const PROXY_INFIX = "/proxy/";

type BunServerHandle = ReturnType<typeof Bun.serve>;

function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

async function authorize(req: Request, server: BunServerHandle): Promise<{ ok: boolean; readOnly: boolean }> {
  // Loopback bypass: requests from 127.0.0.1 / ::1 skip token auth so that
  // local automation (scripts, agents on the same host) can call the Hub API
  // without juggling a bearer token. The security boundary for loopback is
  // the OS user — anyone with shell access can already kill/spawn daemons
  // directly, so token auth on loopback only inconveniences automation.
  const peer = server.requestIP(req);
  if (isLoopbackAddress(peer?.address)) {
    return { ok: true, readOnly: false };
  }

  let token = extractBearer(req.headers.get("authorization"));
  if (!token) {
    // Fallback: cookie. The SPA writes this cookie before opening the
    // per-daemon UI in a new tab, since browser navigation can't carry
    // the Authorization header that fetch() uses.
    const cookie = req.headers.get("cookie") || "";
    const match = cookie.match(/(?:^|; )claudeclaw_hub_token=([^;]+)/);
    if (match) token = decodeURIComponent(match[1]);
  }
  const ok = await verifyBearerToken(token);
  return { ok, readOnly: false };
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "WWW-Authenticate": 'Bearer realm="claudeclaw-hub"',
    },
  });
}

function notFound(msg = "not found"): Response {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: 404,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function badRequest(msg: string): Response {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: 400,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function serverError(msg: string): Response {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: 500,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function proxyToAgent(
  agent: AgentRecord,
  req: Request,
  remainder: string,
): Promise<Response> {
  if (!agent.alive || !agent.web) {
    return notFound("agent daemon not running");
  }
  const targetUrl = `http://${agent.web.host}:${agent.web.port}${remainder}`;

  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const lk = k.toLowerCase();
    if (lk === "authorization" || lk === "host" || lk === "connection") continue;
    headers.set(k, v);
  }

  const init: RequestInit = {
    method: req.method,
    headers,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body as any;
    // @ts-expect-error duplex is required by undici/Bun for streaming bodies
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, init);
  } catch (err) {
    return serverError(`proxy failed: ${String(err)}`);
  }

  const responseHeaders = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    const lk = k.toLowerCase();
    if (lk === "transfer-encoding" || lk === "connection" || lk === "content-encoding") continue;
    responseHeaders.set(k, v);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

async function handleAgentAction(id: string, action: string): Promise<Response> {
  const agent = await findAgentById(id);
  if (!agent) return notFound("agent not found");

  if (action === "stop") {
    if (!agent.alive) return json({ ok: true, alreadyStopped: true });
    const result = await stopByPath(agent.path, 4000);
    return json(result);
  }

  if (action === "restart") {
    if (agent.alive) {
      const stopped = await stopByPath(agent.path, 4000);
      if (!stopped.ok && stopped.reason !== "already-dead") {
        return serverError(`stop failed: ${stopped.reason ?? "unknown"}`);
      }
    }
    const spawned = await spawnDetachedDaemon(agent.path);
    await Bun.sleep(1500);
    const next = await findAgentByPath(agent.path);
    return json({ ok: true, pid: spawned.pid, logPath: spawned.logPath, agent: next });
  }

  if (action === "start") {
    if (agent.alive) return json({ ok: true, alreadyRunning: true, pid: agent.pid });
    const spawned = await spawnDetachedDaemon(agent.path);
    await Bun.sleep(1500);
    const next = await findAgentByPath(agent.path);
    return json({ ok: true, pid: spawned.pid, logPath: spawned.logPath, agent: next });
  }

  return notFound(`unknown action: ${action}`);
}

export function startHubServer(opts: HubServerOptions): HubServerHandle {
  const handleRequest = async (req: Request, server: BunServerHandle): Promise<Response> => {
      const url = new URL(req.url);

      if (url.pathname === "/api/health") {
        return json({ ok: true, now: Date.now(), authConfigured: await hasAuth() });
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        // URL token bootstrap is handled client-side in page.ts so the SPA
        // can promote ?token=<plaintext> into localStorage and strip the
        // query before continuing. Server stays out of it.
        return new Response(hubPage(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // All /api/* below this point require auth (loopback bypasses inside authorize()).
      if (url.pathname.startsWith("/api/")) {
        const auth = await authorize(req, server);
        if (!auth.ok) return unauthorized();
      }

      if (url.pathname === "/api/agents" && req.method === "GET") {
        const agents = await listAgents();
        return json({ agents });
      }

      // /api/agents/:id/(restart|stop|start)
      if (url.pathname.startsWith(PROXY_PREFIX)) {
        const tail = url.pathname.slice(PROXY_PREFIX.length);
        const proxyIdx = tail.indexOf(PROXY_INFIX);
        if (proxyIdx >= 0) {
          const id = tail.slice(0, proxyIdx);
          const remainder = tail.slice(proxyIdx + PROXY_INFIX.length - 1); // keep leading "/"
          const agent = await findAgentById(id);
          if (!agent) return notFound("agent not found");
          // Forward path begins with "/" plus remainder. We strip our /api/agents/:id/proxy
          // prefix and forward to http://agent.web.host:port<remainder>.
          const search = url.search ? url.search : "";
          return proxyToAgent(agent, req, remainder + search);
        }

        // action endpoints
        const segments = tail.split("/").filter(Boolean);
        if (segments.length === 2 && req.method === "POST") {
          const [id, action] = segments;
          return handleAgentAction(id, action);
        }
        if (segments.length === 1 && segments[0] === "start" && req.method === "POST") {
          // POST /api/agents/start { path }
          try {
            const body = await req.json();
            const path = typeof body?.path === "string" ? body.path.trim() : "";
            if (!path) return badRequest("path required");
            const spawned = await spawnDetachedDaemon(path);
            await Bun.sleep(1500);
            const next = await findAgentByPath(path);
            return json({ ok: true, pid: spawned.pid, logPath: spawned.logPath, agent: next });
          } catch (err) {
            return badRequest(String(err));
          }
        }

        if (segments.length === 1 && segments[0] === "restart-all" && req.method === "POST") {
          // POST /api/agents/restart-all
          // Restarts every agent in the registry (alive ones get stopped first,
          // then spawned again; dead ones get spawned).
          const all = await listAgents();
          const results: Array<{ id: string; path: string; ok: boolean; pid?: number; error?: string }> = [];
          for (const agent of all) {
            try {
              if (agent.alive) {
                const stopped = await stopByPath(agent.path, 4000);
                if (!stopped.ok && stopped.reason !== "already-dead") {
                  results.push({ id: agent.id, path: agent.path, ok: false, error: stopped.reason ?? "stop-failed" });
                  continue;
                }
              }
              const spawned = await spawnDetachedDaemon(agent.path);
              results.push({ id: agent.id, path: agent.path, ok: true, pid: spawned.pid });
            } catch (err) {
              results.push({ id: agent.id, path: agent.path, ok: false, error: String(err) });
            }
          }
          return json({ ok: true, results });
        }
      }

      return notFound();
  };

  const mainServer = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0,
    fetch: handleRequest,
  });

  // Secondary listener bound to 127.0.0.1 so local automation can hit the Hub
  // API even when the main listener is bound to a non-loopback interface
  // (e.g. tailnet IP). authorize() bypasses tokens for any source IP that
  // arrives via loopback, regardless of which listener accepted it.
  // Skipped when the main listener already covers loopback (wildcard or
  // explicit 127.0.0.1 / ::1) — the second bind would just fail with EADDRINUSE.
  const mainCoversLoopback =
    opts.host === "127.0.0.1" ||
    opts.host === "::1" ||
    opts.host === "0.0.0.0" ||
    opts.host === "::" ||
    opts.host === "localhost";
  let loopbackServer: BunServerHandle | null = null;
  if (!mainCoversLoopback) {
    try {
      loopbackServer = Bun.serve({
        hostname: "127.0.0.1",
        port: opts.port,
        idleTimeout: 0,
        fetch: handleRequest,
      });
    } catch (err) {
      console.warn(
        `[Hub] could not bind loopback listener on 127.0.0.1:${opts.port} (continuing with main listener only): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return {
    stop: () => {
      mainServer.stop();
      loopbackServer?.stop();
    },
    host: opts.host,
    port: mainServer.port ?? opts.port,
  };
}
