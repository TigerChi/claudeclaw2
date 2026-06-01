# Per-Agent Settings — `<projectDir>/.claude/claudeclaw/settings.json`

Each agent (eleven, dev, felix, …) owns a `settings.json` that drives **its**
daemon's behaviour. The hub config (`~/.claude/claudeclaw/hub/config.json`,
see [HUB-CONFIG.md](HUB-CONFIG.md)) is separate — it governs the multi-agent
hub itself, not individual agents.

## File

| Path | `<projectDir>/.claude/claudeclaw/settings.json` |
|---|---|
| Format | JSON |
| Permissions | `0600` (owner-only) |
| Created by | `claudeclaw init` |
| Reload | Most fields require daemon restart. `agentic` + `timezone` are hot-reloaded via the `watching settings.json` mechanism (see `daemon` log) |
| Validate | `jq . settings.json` after edits |

Unrecognised top-level fields are silently ignored. Recognised fields with
malformed shape fall back to their default (no hard error).

## Top-level Schema

| Field | Type | Purpose |
|---|---|---|
| `model` | `string` | Default `--model` for `claude` spawn (empty = Claude Code default) |
| `agentic` | object | Per-turn agentic model routing (hot-reload) |
| `timezone` | `string` | e.g. `"+08:00"` — used for prompt prefix timestamp (hot-reload) |
| `heartbeat` | object | Periodic self-prompt scheduler |
| `telegram` / `discord` / `slack` / `line` | object | Platform connectors |
| `security` | object | Tool allowlist / disallowlist + scope level |
| `web` | object | Per-agent web UI host/port |
| `approval` | object | TUI permission-dialog routing |
| `sessionCleanup` | object | Idle-channel teardown (see below) ⭐ |

---

## `sessionCleanup` — channel garbage collection

```json
"sessionCleanup": {
  "idleTimeoutHours": 168,
  "checkIntervalMinutes": 30,
  "maxMemoryMb": 3000
}
```

**Why this exists.** Every Slack thread / Telegram chat / LINE group becomes
its own `claude` TUI inside its own tmux session. Without cleanup these
accumulate — a single `claude` is ~200-500 MB RSS, so 30 active channels
≈ 6-15 GB resident. The cleaner periodically tears down idle channels.

**The `channel-sessions.json` entry survives the cleanup.** Next inbound
message to that channel respawns tmux and runs `claude --resume <sessionId>`
— full conversation history reconstructed from the JSONL file. So eviction
is **not** data loss; it's just a tmux+claude RAM reclaim.

### Fields

| Field | Default | Meaning |
|---|---|---|
| `idleTimeoutHours` | `168` (1 week) | Channels idle past this → tmux killed |
| `checkIntervalMinutes` | `30` | Cleaner tick cadence |
| `maxMemoryMb` | `0` (disabled) | RSS cap; when total `claude` RSS for this agent exceeds → evict oldest idle channel(s) until under cap |

### Two cleanup policies — independent, both run each tick

**1. Idle-timeout** (steady state)
```
For each idle channel:
  if (now − lastActivityAt) ≥ idleTimeoutHours:
    shutdown channel  (kill tmux; channel-sessions entry stays)
```
Good for low-frequency steady-state use — old conversations naturally
clear out after a week.

**2. Memory-cap LRU** (burst protection)
```
total = sum(RSS) of `claude` processes whose --append-system-prompt
        contains this agent's projectDir
while total > maxMemoryMb:
  oldest = idle channel with smallest lastActivityAt
  if !oldest: break (everything busy — can't evict)
  shutdown oldest
  total = recompute
```
Solves the burst-load failure mode: if you spawn 50 threads in one day,
they all stay alive for 168h with idle policy alone. Memory cap evicts
oldest idle as soon as total RSS crosses the threshold.

**Cross-agent isolation**: Memory measurement filters `ps` output by
`projectDir` (each `claude` has the dir baked into its `--append-system-prompt`),
so one agent doesn't measure another's processes.

### Disabling

- `idleTimeoutHours: 0` — disable timeout-based eviction
- `maxMemoryMb: 0` (default) — disable memory-cap eviction
- Both 0 — cleanup scheduler doesn't even start (log line: `session cleanup disabled`)
- `checkIntervalMinutes: 0` — also disables (regardless of the others)

### Recommended values

| Agent profile | `maxMemoryMb` | Reason |
|---|---|---|
| Heavy user (dev, felix) | `3000` | Plenty of headroom, evicts ~7-15 channels worth before kicking in |
| Light user (chifa, beo) | `1500` | Modest RSS, frees memory for the rest of the box |
| Voice/family (eleven) | `2000` | Whisper backend keeps an extra process per turn |
| Single-channel only | leave at `0` | Cleanup not really needed; idle timeout handles it |

### Log lines to confirm it's wired

On daemon start:
```
[runner-shim] session cleanup: idleTimeout=168h, maxMemoryMb=3000, check every 30m
```

On eviction:
```
[runner-shim] cleaning up N idle channel(s)
[runner-shim]   evict slack:C…:1780… (idle 192h) — killing tmux, session entry preserved
```

Or for memory-driven:
```
[runner-shim] memory 3120MB > 3000MB cap → evicting LRU channel slack:C…:… (idle 47m)
[runner-shim]   evict slack:C…:… (LRU memory cap) — killing tmux, session entry preserved
```

### Resume after eviction

Once cleanup has killed the tmux:

```
[Slack] message arrives in evicted channel
  ↓
runner-shim.ensureChannel(key)
  ↓ tmux dead (hasSession=false) + channel-sessions entry exists
  ↓ resume = true
  ↓ channel.start({ resume: true })
  ↓ new tmux + `claude --resume <sessionId>`
  ↓ claude reads JSONL, restores conversation
  ↓ user's message processed in restored context
```

User-visible difference: **first message after eviction is slightly slower**
(claude TUI startup + jsonl replay), about 5–10 seconds. Subsequent messages
behave normally.

---

## Other sections (briefly)

The remaining top-level fields are platform/feature scoped — they each have
their own guide:

- **telegram / discord / slack / line** — see [Channel_Guide.md](Channel_Guide.md) for shared concepts and platform-specific quirks
- **slack** — full directive vocabulary in `prompts/slack/DIRECTIVES.md`
- **line** — see [LINE-GUIDE.md](LINE-GUIDE.md)
- **whisper** (voice transcription) — see [WHISPER-GUIDE.md](WHISPER-GUIDE.md)
- **agentic** (per-turn model routing) — comments in `settings.json` cover the hysteresis gates inline
- **agentBus** — cross-agent comms — see [AGENT-BUS.md](AGENT-BUS.md)
- **approval** — TUI permission dialog routing to Telegram inline buttons
- **security** — tool allowlist/disallowlist + `--dangerously-skip-permissions` gating

If a field is missing from this doc, it's either (a) self-documenting via
inline `"//"` comments in the JSON, or (b) inherited from upstream
`claudeclaw2/src/init.ts` template defaults — read that file for canonical
shape.
