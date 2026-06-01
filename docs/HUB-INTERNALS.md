# ClaudeClaw Hub — Internals

How the hub finds daemons, proxies traffic, and stays in sync. Counterpart to
[HUB-GUIDE.md](HUB-GUIDE.md), which covers usage.

## Component map

```
┌────────────────────── Browser ──────────────────────┐
│  Hub SPA (single page)                              │
│   • lists agents       /api/agents                  │
│   • detail panel       /api/agents/<id>/proxy/api/* │
│   • lifecycle actions  POST /api/agents/<id>/<action>│
│   • per-daemon UI      new tab into proxy URL       │
└───────────────┬─────────────────────────────────────┘
                │  Bearer token (header) or cookie
                ▼
┌──────────── Hub server (Bun.serve) ─────────────────┐
│  /api/health                  no auth               │
│  /api/agents                  list registered       │
│  /api/agents/start            spawn at given path   │
│  /api/agents/restart-all      stop+spawn each       │
│  /api/agents/<id>/<action>    start/stop/restart    │
│  /api/agents/<id>/proxy/<…>   reverse proxy         │
└───────┬──────────────────────────────────┬──────────┘
        │ reads                            │ stop/spawn
        ▼                                  ▼
~/.claude/claudeclaw/daemons/        Daemon processes
  <hash>.json (one per daemon)         (one per project)
        ▲
        │ register on start, leave on stop
        │ (entry only removed by `hub forget`*; otherwise overwritten on restart)
ClaudeClaw daemon
  process.cwd()
```

\* `hub forget` is not yet implemented; stale entries get overwritten the
next time a daemon starts in the same `cwd`.

## Why a global daemon registry?

The original implementation tried to discover daemons by reading
`~/.claude/projects/<encoded-name>` and reversing the encoded directory name
back into a real path with `replace(/-/g, "/")`. That encoding is **lossy** —
`/`, space, and literal `-` in the original `cwd` all collapse to `-`, so the
reverse cannot distinguish them. Any daemon whose path contained a space or
hyphen (e.g. `/Users/x/Claude Workspace/Agent-CooBot`) was invisible to the
hub.

Each daemon now records its own real `process.cwd()` at start in
`~/.claude/claudeclaw/daemons/<sha1(path)[:12]>.json`:

```json
{
  "path": "/Users/x/Claude Workspace/Agent-CooBot",
  "pid": 45924,
  "startedAt": 1777105635065
}
```

Hub and `stopAll` read this directory directly — no decoding needed, no path
ambiguity. Same hash function (`agentIdForPath`) is the agent ID exposed to
the SPA, so `<id>` in URLs is stable as long as the path is.

### Lifecycle

| Event | Effect on registry |
|---|---|
| Daemon `start` (post `writePidFile`) | `registerDaemon()` writes `<hash>.json` with current `cwd`/`pid` |
| Daemon `start` again at the same path | Overwrites the same `<hash>.json` (no accumulation) |
| Daemon `stop` / `restart` / SIGTERM shutdown | Entry **left in place** so the dashboard can still show "stopped" |
| Daemon process dies without cleanup | Entry stays; `listAgents()` marks `alive: false` via `process.kill(pid, 0)` |
| Same `cwd` deleted forever | Entry remains until manually removed (or overwritten by a future daemon at that path) |

This trade-off keeps the dashboard "remembering" agents you've used, at the
cost of orphan entries when a project directory is permanently removed. A
`hub forget <id>` command is the planned cleanup hook.

## Reverse proxy

The hub forwards requests under `/api/agents/<id>/proxy/<rest>` to
`http://<daemon.web.host>:<daemon.web.port>/<rest>` (per-daemon `web.host`/
`web.port` come from each daemon's `state.json`).

Notable behavior:

- `Authorization` and hop-by-hop headers (`Connection`, `Host`,
  `Transfer-Encoding`, `Content-Encoding`) are stripped before forwarding.
- Streaming bodies are passed through with `duplex: "half"` (Bun/undici
  requirement).
- Daemon SPA fetches use a runtime-detected `API_BASE` so the same code path
  works whether served directly (`/`) or through the proxy
  (`/api/agents/<id>/proxy/`).

## Authentication

| Element | Choice |
|---|---|
| Token shape | 32 random bytes, base64url-encoded |
| Storage | `~/.claude/claudeclaw/hub/auth.json` mode `0600`, format `{primary: {hash: "sha256:<hex>", createdAt}}` |
| Comparison | `crypto.timingSafeEqual` against the SHA-256 of the presented token |
| Constant-time floor | If no auth is configured but a token is presented, a fake-hash compare runs anyway to avoid leaking config state via timing |
| Token sources accepted | `Authorization: Bearer …` (preferred) → `Cookie: claudeclaw_hub_token=…` (fallback for new-tab navigations that can't set headers) |

Non-loopback bind refuses to start without auth configured. Loopback bind
doesn't enforce auth at the host level (anyone with shell access could read
`auth.json` anyway), but auth is still recommended.

## HTTP API reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | no | Dashboard SPA |
| GET | `/api/health` | no | Liveness + auth-configured probe |
| GET | `/api/agents` | yes | Registered daemons w/ alive status |
| POST | `/api/agents/start` body `{path}` | yes | Spawn detached daemon at path |
| POST | `/api/agents/restart-all` | yes | Stop+spawn every listed agent in sequence |
| POST | `/api/agents/<id>/start` | yes | Spawn detached daemon for an existing entry |
| POST | `/api/agents/<id>/stop` | yes | SIGTERM and wait |
| POST | `/api/agents/<id>/restart` | yes | Stop (if alive) + spawn |
| ANY | `/api/agents/<id>/proxy/<rest>` | yes | Reverse proxy to that daemon |

Action handlers wait ~1.5 s after spawn before re-reading registry, so the
response carries the post-restart `agent` snapshot.

## Source layout

```
src/
  daemon-registry.ts           Global registry (register / unregister / list)
  pid.ts                       Per-cwd PID file (still needed for daemon's own
                                start/stop check; the global registry is for
                                cross-process discovery)
  commands/
    start.ts                   Calls registerDaemon() after writePidFile()
    stop.ts                    Reads registry for stopAll(); does NOT
                                unregister on stop (entries persist)
    hub.ts                     CLI surface for the hub subcommand
  hub/
    server.ts                  Bun.serve, routing, auth, proxy
    page.ts                    Dashboard SPA (single inline HTML/JS)
    registry.ts                listAgents(): wraps daemon-registry +
                                process.kill(pid,0) for liveness
    auth.ts                    Token gen/hash/verify
    paths.ts                   Constants + config.json read/write
    spawn.ts                   spawnDetachedDaemon() — used by start/restart
                                endpoints
```

## Adding a new endpoint

A new HTTP endpoint typically needs three things:

1. A route entry in `server.ts`'s `fetch` handler.
2. A backing function (in `hub/registry.ts`, `commands/stop.ts`, etc.) that
   doesn't `process.exit()`.
3. SPA wiring in `page.ts` if it should appear in the dashboard.

Anything affecting per-daemon state (e.g. a new lifecycle action) goes
through `stopByPath` / `spawnDetachedDaemon` so behavior stays consistent
between CLI (`claudeclaw hub restart`) and dashboard (`POST /api/agents/<id>/restart`).
