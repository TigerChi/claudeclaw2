# Multi-Session Channels

ClaudeClaw v2 runs one `claude` TUI per active channel inside its own tmux
session. Different channels run concurrently; messages within a single
channel are serialised through a per-channel mutex.

For per-platform channel semantics see [Channel_Guide.md](Channel_Guide.md).
For runtime mechanics (tmux paste, JSONL tail, capture-pane polling) read
the inline comments in `src/channel.ts` and `src/runner-shim.ts`.

## Channel keys

A channel key identifies one isolated session and one tmux window. The
platform handler passes a `threadId` to `runner-shim`, which maps it via
`threadIdToChannelKey()` (in `src/runner-shim.ts`):

| Source | `threadId` → channel key | Notes |
|---|---|---|
| Slack thread/channel | `slk:<channelId>:<threadAnchor>` → `slack:<channelId>:<threadAnchor>` | `threadAnchor` is `thread_ts` if present, else the top-level `ts`. Slack DMs pass no `threadId` → `global`. |
| LINE group | `line:group:<groupId>` (returned as-is) | LINE rooms use `line:room:<roomId>`. LINE DMs pass no `threadId` → `global`. |
| Discord thread | `<threadChannelId>` (raw snowflake, returned as-is) | Main-channel and DM messages pass no `threadId` → `global`. |
| Telegram | (no `threadId`) → `global` | All Telegram messages currently share `global`. |
| Heartbeat / cron / agent-bus / unspecified | `global` | |

`global` is just a channel; it has no privileged status, but multiple
inbound sources do share it.

## Architecture

```
inbound message
   │
   ▼
platform handler       (slack.ts / line.ts / telegram.ts / discord.ts)
   │  resolves threadId (or none), calls runner-shim
   ▼
runner-shim            (src/runner-shim.ts)
   │  threadIdToChannelKey(threadId) → channelKey
   │  ensureChannel(key) → cache hit OR new Channel
   │  withChannel(key, fn) — per-channel busy mutex
   ▼
Channel                (src/channel.ts)
   │  owns one tmux session running `claude --session-id <uuid>`
   │  writes via `tmux paste-buffer` + Enter
   │  tails ~/.claude/projects/<encodedProjectDir>/<sessionId>.jsonl
   ▼
JSONL events          → onAssistantText / onToolUse / onTurnEnd / onStreamPartial
   ▼
platform handler emits reply via platform API
```

## Lifecycle

### Create

1. Inbound message arrives. Platform handler resolves a `threadId` (or none).
2. `runner-shim.ensureChannel(key)`: cache miss + no entry in
   `channel-sessions.json` → instantiate `Channel`, `start({ resume: false })`.
3. Channel spawns tmux, runs `claude --session-id <uuid>` (no `--resume`).
4. The first `paste(prompt)` lazily attaches the JSONL tail. The JSONL file
   does not exist until claude writes to it.
5. On the first `end_turn`, `channel-sessions.json` is updated with the
   `sessionId` and `lastActivityAt`.

### Use

1. The per-channel mutex serialises turns. `withChannel(key, fn)` awaits
   any in-flight turn before calling `fn`.
2. `paste(prompt)` → bracketed-paste → Enter.
3. The JSONL tail emits assistant/tool events. An optional capture-pane
   poller emits incremental `onStreamPartial` updates between JSONL
   flushes (Slack uses this for streamed message edits).
4. `onTurnEnd` resolves the turn promise; the mutex releases.

### Resume

1. Inbound message in a known channel, but no live cache entry (e.g. after
   eviction or daemon restart).
2. `ensureChannel(key)`: cache miss + `channel-sessions.json` entry exists →
   `Channel.start({ resume: true })`.
3. Channel spawns tmux, runs `claude --resume <sessionId>`. Claude reads
   the existing JSONL and reconstructs the conversation.
4. First message after resume takes ~5–10s extra (tmux startup + JSONL
   replay). Subsequent turns run at normal speed.

### Cleanup

Idle-timeout and memory-cap LRU eviction. See
[AGENT-CONFIG.md § sessionCleanup](AGENT-CONFIG.md#sessioncleanup).
Eviction kills the tmux process only; the `channel-sessions.json` entry
survives so the next inbound message can resume.

## Concurrency

```
slack:C1:t1   ──▶ ┐
slack:C1:t2   ──▶ ├──── distinct channels run in parallel
line:group:X  ──▶ │
global        ──▶ ┘

within one channel:  turn1 → turn2 → turn3   (serial via per-channel mutex)
```

Different channels do not block each other. A second message arriving in
the same channel while a turn is in flight queues behind it.

## Storage

### `channel-sessions.json` (v2, authoritative)

Per-agent file under `<projectDir>/.claude/claudeclaw/`. Schema (simplified):

```json
{
  "channels": {
    "slack:<channelId>:<threadAnchor>": {
      "sessionId": "<uuid>",
      "createdAt": "<ISO8601>",
      "lastActivityAt": "<ISO8601>",
      "turnCount": <int>
    },
    "line:group:<groupId>": { },
    "global": { }
  }
}
```

### `sessions.json` (v1, legacy)

v1's per-thread schema (Discord threads). A small set of v1-era commands
(`peekThreadSession`, `listThreadSessions`) still read it, but the v2
engine never writes to it. New deployments do not need this file.

### JSONL transcripts

Actual conversation history lives in
`~/.claude/projects/<encodedProjectDir>/<sessionId>.jsonl`, written by the
`claude` process. `channel-sessions.json` only stores the metadata needed
to locate and resume the right JSONL.

`encodedProjectDir` is `projectDir` with both `/` and whitespace replaced
by `-` (matches Claude Code's own encoding).

## Files

| File | Role |
|---|---|
| `src/channel.ts` | tmux session lifecycle, JSONL tail, capture-pane polling, paste+Enter sequencing |
| `src/runner-shim.ts` | v1-compatible runner API (`run` / `runUserMessage` / `streamUserMessage`); per-channel cache; per-channel busy mutex; cleanup scheduler; `threadIdToChannelKey()` |
| `src/channel-sessions.ts` | Read/write `channel-sessions.json`; `touchActivity` to update `lastActivityAt` |
| `src/inflight-store.ts` | Active-reply tracking in `inflight.json` (Slack) |
| `src/commands/<platform>.ts` | Per-platform `threadId` resolution and reply emission |

## Limitations

- One in-flight turn per channel. Subsequent messages queue serially.
- Resume cost scales with JSONL size. Multi-MB transcripts are slower to
  resume than a fresh start.
- Cleanup eviction is best-effort. A channel busy at tick time is skipped.
- Telegram currently has no per-chat session — all Telegram messages
  share `global`. Per-chat keys are a future addition.
- Discord channel keys are raw snowflakes (no `discord:` prefix). Slack
  and LINE use prefixed keys. Inconsistency from the v2 bring-up; may be
  normalised later.
