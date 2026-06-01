# ClaudeClaw Hub — Usage Guide

A host-global control plane for managing many ClaudeClaw daemons from one
dashboard, without keeping a terminal open per agent.

## What it does

- **One dashboard, many daemons.** Lists every ClaudeClaw daemon registered on
  this host, alive or stopped. Click an agent to see its heartbeat / jobs /
  config; the panel reuses each daemon's existing `/api/*` endpoints via a
  reverse proxy, so you don't need to remember per-daemon ports.
- **Lifecycle controls.** Start, Stop, Restart any agent — single button or
  "Restart all" for the whole host. Stopped agents stay in the list so you can
  start them again later.
- **Open per-daemon UI.** One click opens the daemon's own full web UI in a new
  tab, proxied through the hub (no need to expose each daemon's port).
- **Bearer-token auth.** A 32-byte token, hashed at rest, gates every `/api/*`
  call. Loopback bind doesn't strictly need it; non-loopback bind requires it.
- **Mobile-friendly dashboard.** Sidebar collapses above the detail panel on
  narrow screens.

## Quick start

```bash
# 1. Generate a Bearer token (printed once — copy now)
claudeclaw hub init

# 2. Start the hub daemon in the background
claudeclaw hub start --detach
# → http://127.0.0.1:4631
```

Open `http://127.0.0.1:4631/`, paste the token, you're in.

### Auto-login via URL token

Skip the paste step by appending the token as a query parameter:

```
http://127.0.0.1:4631/?token=<your-token>
```

The SPA reads the `token` query on load, stores it in `localStorage`, then
`history.replaceState`s the URL down to `/` so the token doesn't linger in
browser history or referer headers. Subsequent visits to `/` use the saved
token automatically. Bookmarkable, shareable to a private clipboard, and
works across reverse-proxied hostnames (Tailscale IP, custom domain, etc.).

If the URL is opened in private/incognito mode, the token does not persist
beyond that session — paste-style login still works the same way.

## Commands

The same actions are available two ways — pick whichever suits the moment.

### From inside Claude Code (slash command)

```
/claudeclaw:hub status
/claudeclaw:hub init
/claudeclaw:hub start [--detach] [--host <ip>] [--port <n>]
/claudeclaw:hub stop
/claudeclaw:hub token --rotate
/claudeclaw:hub restart <id|path>
```

> Slash commands load when Claude Code starts. After installing or upgrading
> this plugin, restart Claude Code (or reload the plugin) before
> `/claudeclaw:hub` appears.

### From a terminal

```bash
# Direct invocation (substitute the actual version in your cache path)
bun run ~/.claude/plugins/cache/claudeclaw/claudeclaw/1.0.0/src/index.ts hub status

# Or set up a shell alias once
alias claudeclaw='bun run ~/.claude/plugins/cache/claudeclaw/claudeclaw/1.0.0/src/index.ts'
claudeclaw hub status
```

### Subcommands

| Subcommand | Effect |
|---|---|
| `init` | Generate the Bearer token (printed once — copy it now). |
| `start [--detach] [--host <ip>] [--port <n>]` | Start the hub daemon. `--detach` logs to `~/.claude/claudeclaw/hub/hub.log`. Default port `4631`. Non-loopback `--host` requires auth. |
| `stop` | Stop the hub daemon. |
| `status` | Show running state, listening URL, auth status, and registered agent list. |
| `token --rotate` | Replace the token (revokes the old one). Anyone using the old token must update. |
| `restart <id\|path>` | Stop + re-spawn one agent daemon. `<id>` is the 12-char ID from `status`; `<path>` is the absolute project path. |

`--host` and `--port` from `start` are persisted to
`~/.claude/claudeclaw/hub/config.json`, so subsequent `start` calls reuse them
automatically.

## Dashboard features

| Element | Action |
|---|---|
| Sidebar | Click an agent name to view its detail panel. Green dot = alive, red dot = stopped. |
| **Restart / Stop / Start** | Per-agent lifecycle. Buttons show "Stopping…" while in flight, then a green inline confirmation with the new PID. |
| **Open per-daemon UI** | New tab into that daemon's full web UI, served via the hub proxy. |
| **↻ Restart all** | Stops + re-spawns every listed agent in sequence. Useful after a code update. Confirms before running. |
| **🔑 Token** | Copies the current Bearer token to your clipboard (for sharing with teammates). |
| **Refresh** | Force a re-fetch of the agent list. The dashboard also auto-refreshes every 5 seconds. |
| **Sign out** | Clears the token from `localStorage`. |

## Sharing access with teammates

The token is stable — `hub init` writes it once, `hub token --rotate`
explicitly replaces it. Anyone holding the token can use the hub. To share:

1. Click **🔑 Token** in the dashboard, paste the token to your teammate.
2. They open the hub URL and paste the token in the auth screen.

For remote access without exposing the hub publicly, run it on a
[Tailscale](https://tailscale.com) node and bind the tailnet IP:

```bash
claudeclaw hub stop
claudeclaw hub start --host 100.x.y.z --detach
```

Teammates joined to your tailnet can then visit `http://100.x.y.z:4631/`.
Tailscale provides the encryption layer; the token gates access.

If you need true public access, front the hub with a TLS reverse proxy
(caddy, nginx, traefik) — never expose plain HTTP + Bearer token to the
public internet.

## File layout

```
~/.claude/claudeclaw/hub/
  auth.json     SHA-256 hash of the token (mode 0600)
  config.json   Persisted host/port/autostart settings — see HUB-CONFIG.md
  hub.pid       Running hub PID (cleared on stop)
  hub.port      Bound port (cleared on stop)
  hub.log       Detached-mode stdout/stderr

~/.claude/claudeclaw/daemons/
  <hash>.json   One file per registered daemon (path/pid/startedAt)
```

The `daemons/` directory is the source of truth for what the hub lists; see
[HUB-INTERNALS.md](HUB-INTERNALS.md) for why this exists and how registration
works. For every settable field in `config.json` (host, port, proxy autostart,
per-agent daemon autostart) see [HUB-CONFIG.md](HUB-CONFIG.md).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Discovered agents (0)` | No daemon has registered yet. Start one with `claudeclaw start --detach` in any project. Existing daemons need to be restarted once on a version that includes the registry feature. |
| `unauthorized` after pasting token | Token mismatch (rotated since you copied? typo?). `hub init --force` or `hub token --rotate` to reset. |
| "Open per-daemon UI" returns 401 | The dashboard plants a cookie on click — make sure JavaScript is enabled and you didn't open the link from outside the dashboard. |
| Hub `--host` refused | Non-loopback bind requires `hub init` to have been run. |
| `claudeclaw hub start` says "already running" | Stop it first with `hub stop`, or kill the PID listed in `hub.pid` if stale. |
