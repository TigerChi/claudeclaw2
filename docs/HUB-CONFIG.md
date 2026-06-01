# ClaudeClaw Hub — Configuration

Persistent settings for the hub process. CLI flags override per-invocation;
this file is the source of truth for everything else.

## File

| Path | `~/.claude/claudeclaw/hub/config.json` |
|---|---|
| Format | JSON |
| Permissions | `0600` (owner-only) |
| Created | First `claudeclaw hub start` writes a minimal file if absent |
| Reload | None. Edits take effect on next hub start |

Malformed JSON or unrecognised fields are ignored without error; the affected
field falls back to its default. Validate with `jq . config.json` after manual
edits.

## Schema

| Field | Type | Default | Purpose |
|---|---|---|---|
| `host` | `string` | `"127.0.0.1"` | Bind address |
| `port` | `number` | `4631` | TCP port |
| `autostartProxy` | `boolean` | `false` | Spawn LINE webhook proxy on hub start |
| `daemonAutostart` | `Record<string, boolean>` | `{}` | Per-agent opt-out for daemon autostart |

### Example

```json
{
  "host": "0.0.0.0",
  "port": 4631,
  "autostartProxy": true,
  "daemonAutostart": {
    "/Users/me/Workspace/Agent-Archive": false
  }
}
```

## Field reference

### `host` / `port`

The hub's bind address and TCP port.

- Loopback (`127.0.0.1`, `::1`, `localhost`) bypasses bearer-token auth for
  `/api/*`. The implicit security boundary is the OS user — anyone with shell
  access on the host can already control daemons directly.
- Non-loopback bind enforces bearer-token auth on every `/api/*` call. The
  token travels in plaintext unless you terminate TLS in front of the hub
  (caddy, nginx, traefik). See HUB-GUIDE.md → "Sharing access with teammates".
- `--host` and `--port` CLI flags on `claudeclaw hub start` override this
  file for the lifetime of the process. If supplied, they are also written
  back to `config.json`.

### `autostartProxy`

When `true`, the hub spawns the LINE webhook proxy after its own server is
listening. Behaviour:

- The proxy runs as a **detached subprocess** with its own PID file
  (`~/.claude/claudeclaw/proxy.pid`). It survives subsequent hub restarts.
- On every hub start, the hub probes `http://localhost:18789/status`. If a
  proxy already responds, the spawn is skipped — so toggling the flag never
  produces duplicate proxies.
- `claudeclaw proxy stop` still works independently and is the supported way
  to take the proxy down.

Default is `false` because the proxy is meaningless for installations not
using LINE. See LINE-GUIDE.md for the proxy's role and routing model.

### `daemonAutostart`

Controls which agent daemons the hub starts at its own start time. Map keys
are agent project paths (absolute, as recorded in the daemon registry):

| Value | Behaviour |
|---|---|
| Key absent | Autostart — **default for newly registered agents** |
| `true` | Autostart (explicit form of the default) |
| `false` | Skip; daemon must be started manually |

Notes:

- The hub iterates `listAgents()` from the daemon registry. An agent only
  appears in the registry **after its first run** (any method). A brand-new
  ClaudeClaw project must run `claudeclaw start` at least once before the
  hub can autostart it.
- Already-alive daemons are never re-spawned. Liveness is checked per entry
  via `process.kill(pid, 0)`.
- Spawn uses the same code path as `POST /api/agents/<id>/start`
  (`spawnDetachedDaemon`), so logs land in
  `<agent>/.claude/claudeclaw/logs/daemon.log` as normal.

## Related state

Not part of `config.json`, but commonly referenced together.

| Concern | Location | Managed by |
|---|---|---|
| Bearer token (hashed) | `~/.claude/claudeclaw/hub/auth.json` | `claudeclaw hub init` / `hub token --rotate` |
| Hub PID / port | `~/.claude/claudeclaw/hub/hub.{pid,port}` | Hub (auto, cleared on clean shutdown) |
| Hub log | `~/.claude/claudeclaw/hub/hub.log` | Hub (append-only) |
| Launch-on-login (macOS) | `~/Library/LaunchAgents/com.claudeclaw.hub.plist` | `claudeclaw hub autostart enable\|disable\|status` |
| Daemon registry | `~/.claude/claudeclaw/daemons/<hash>.json` | Daemons themselves (registers on start) |
| LINE proxy config | `~/.claude/claudeclaw/proxy-config.json` | Proxy itself |
| Per-agent settings | `<agent>/.claude/claudeclaw/settings.json` | Per-agent (LINE / Slack / Discord / Telegram) |

## Applying changes

The hub reads `config.json` once at process start. To pick up edits:

```bash
claudeclaw hub stop && claudeclaw hub start --detach
```

If the hub runs under launchctl, `hub stop` is sufficient — `KeepAlive` will
restart it. `claudeclaw hub stop` sends `SIGTERM` to the hub PID only, so any
daemons or proxy the hub previously spawned continue running across the
restart.

**Caveat — `launchctl kickstart -k`:** the `-k` flag kills the entire job's
process tree, which includes daemons and the proxy spawned through the hub.
Use plain `kickstart` (no `-k`) or the `hub stop` + `KeepAlive` pattern above
to avoid collateral damage. `daemonAutostart` and `autostartProxy` exist
partly to make recovery from `-k` painless when it is intentional.
