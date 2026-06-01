# Per-Agent Settings

Per-agent configuration lives in `<projectDir>/.claude/claudeclaw/settings.json`.
Each agent's daemon reads this file. The hub config
(`~/.claude/claudeclaw/hub/config.json`, see [HUB-CONFIG.md](HUB-CONFIG.md))
is a separate file governing the hub itself, not individual agents.

## File

| | |
|---|---|
| Path | `<projectDir>/.claude/claudeclaw/settings.json` |
| Format | JSON |
| Permissions | `0600` |
| Created by | `claudeclaw init` |
| Validation | `jq . settings.json` |
| Reload | Most fields require daemon restart. `agentic` and `timezone` hot-reload via the `watching settings.json` mechanism (visible in `daemon` log). |

Unknown top-level fields are ignored. Recognised fields with malformed
shape fall back to defaults; no hard error.

## Sibling state files

The v2 daemon reads and writes additional state in the same directory:

| File | Engine | Role |
|---|---|---|
| `channel-sessions.json` | v2 | Per-channel session metadata. Authoritative; written on every turn. |
| `sessions.json` | v1 | Legacy schema. Read by a small set of v1-era commands but **not** written by the v2 engine. |
| `inflight.json` | v2 | Active reply markers (currently Slack). Cleared on turn completion. Leftover entries are logged at daemon startup. |

## Top-level fields

| Field | Type | Purpose |
|---|---|---|
| `model` | string | Default `--model` for `claude` spawn. Empty = Claude Code default. |
| `agentic` | object | Per-turn model routing (hot-reload). |
| `timezone` | string | e.g. `"+08:00"`. Used in prompt prefix timestamp (hot-reload). |
| `heartbeat` | object | Periodic self-prompt scheduler. |
| `telegram` / `discord` / `slack` / `line` | object | Platform connectors. |
| `security` | object | Tool allow/disallow + scope level. |
| `web` | object | Per-agent web UI host/port. |
| `approval` | object | TUI permission dialog routing. |
| `sessionCleanup` | object | Channel garbage collection (see below). |

Platform/feature blocks are documented elsewhere:

- `telegram` / `discord` / `slack` / `line` — [Channel_Guide.md](Channel_Guide.md); platform directives under `prompts/<platform>/DIRECTIVES.md`
- `line` setup — [LINE-GUIDE.md](LINE-GUIDE.md)
- `whisper` — [WHISPER-GUIDE.md](WHISPER-GUIDE.md)
- `agentBus` — [AGENT-BUS.md](AGENT-BUS.md)
- Multi-channel session model — [MULTI_SESSION.md](MULTI_SESSION.md)
- `agentic` / `security` / `approval` — inline `"//"` comments in the JSON template (`src/init.ts`)

## `sessionCleanup`

```json
"sessionCleanup": {
  "idleTimeoutHours": 168,
  "checkIntervalMinutes": 30,
  "maxMemoryMb": 0
}
```

| Field | Default | Behaviour |
|---|---|---|
| `idleTimeoutHours` | `168` | Channels idle past this → tmux killed. `0` disables. |
| `checkIntervalMinutes` | `30` | Cleaner tick cadence. `0` disables the scheduler. |
| `maxMemoryMb` | `0` | RSS cap. `0` disables memory-cap eviction. |

Eviction kills the tmux process only. The `channel-sessions.json` entry
stays intact. The next inbound message to that channel respawns tmux with
`claude --resume <sessionId>` — JSONL replay restores conversation state.
First message after eviction takes ~5–10s extra (tmux startup + replay).

### Policies

Both policies run on each cleaner tick, independently.

```
# 1. Idle timeout
for each channel:
  if (now - lastActivityAt) >= idleTimeoutHours:
    shutdown(channel)
```

```
# 2. Memory-cap LRU
total = sum(RSS) of claude processes whose
        --append-system-prompt contains projectDir
while total > maxMemoryMb:
  oldest = idle channel with smallest lastActivityAt
  if !oldest: break    // everything busy
  shutdown(oldest)
  total = recompute()
```

Memory measurement filters `ps` output by `projectDir` (baked into each
spawn's `--append-system-prompt`), so an agent sees only its own `claude`
processes.

### Log lines

Startup:
```
[runner-shim] session cleanup: idleTimeout=<h>h, maxMemoryMb=<MB>, check every <m>m
```

Idle eviction:
```
[runner-shim] cleaning up <n> idle channel(s)
[runner-shim]   evict <channelKey> (idle <h>h) — killing tmux, session entry preserved
```

Memory-cap eviction:
```
[runner-shim] memory <usedMB>MB > <capMB>MB cap → evicting LRU channel <channelKey>
[runner-shim]   evict <channelKey> (LRU memory cap) — killing tmux, session entry preserved
```
