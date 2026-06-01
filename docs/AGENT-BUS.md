# Agent Bus

Inter-agent communication channel that lets ClaudeClaw daemons (and ad-hoc
local clients) send messages to each other without going through any external
service. Lives at `~/.claude/agent-bus/`.

## Transport

Two transports, automatic failover:

| Transport | When | Latency |
|---|---|---|
| **Unix domain socket** (`<agent>.sock`) | Receiver daemon is online | < 5 ms send |
| **File inbox** (`<agent>/inbox/<id>.json`) | Receiver offline / no socket | Polled every 30 s by the receiver's hot-reload loop |

`sendToAgent()` tries the socket first and falls back to file. Senders never
need to know which transport will be used.

## Message schema

```ts
interface AgentMessage {
  id: string;                 // "msg_<ts>_<from>_<rand4>"
  from: string;
  to: string;
  type: "message" | "request" | "response" | "system";
  payload: string;
  /** If this is a response, the id of the originating message. */
  replyTo?: string;
  mode: "followup" | "interrupt" | "collect";
  createdAt: string;
}
```

## In-claude directives

When a daemon-spawned claude session is processing an incoming bus message,
emitting `[send-agent:<name>]<payload>[/send-agent]` in the assistant output
queues an outgoing bus message. The runner automatically attaches
`replyTo = <incoming msg.id>` so the original sender's reply-routing
registration (if any) can match.

## Synchronous request/reply (pending-reply registry)

By default an incoming reply is dispatched to the daemon's global agent-bus
session. For ad-hoc callers (TUI sessions, one-off scripts) that want to
**block until a specific reply arrives**, the bus exposes a pending registry.

### Flow

1. Sender calls `sendToAgent(to, payload, { expectReply: { listenerPath, ttlMs } })`.
   This writes a registration to `~/.claude/agent-bus/<sender>/pending/<msgId>.json`
   pointing at `listenerPath`.
2. Receiver's claude session processes the message, emits
   `[send-agent:<sender>]<reply>[/send-agent]` — the runner tags it with
   `replyTo = <incoming msg.id>`.
3. Sender's daemon receives the reply, looks up the pending entry by
   `replyTo`, finds the listener path, and writes the reply JSON to that path
   (instead of dispatching to the global session). The pending entry is
   atomically consumed.
4. Sender polls `listenerPath`; when it appears, reads + deletes it.

If no pending entry matches (or the sender's daemon is offline), the reply
falls through to the global agent-bus session — fully backwards compatible.

Expired pending entries (past `ttlMs`) are GC'd by the daemon's 30 s
hot-reload loop and on lookup.

### CLI helper

`src/send-and-wait.ts` wraps the registration + polling for shell use:

```bash
bun run ~/.claude/plugins/cache/claudeclaw/claudeclaw/<version>/src/send-and-wait.ts \
  --to felix \
  --from dev \
  --payload "ping — please reply with 'pong from <your email>'." \
  --timeout 60
```

Stdout: pretty-printed reply JSON. Exit 0 = received, 1 = timeout, 2 = bad args.

**Caveat:** the routing path requires the local agent's daemon to be running so
it can consume the pending entry and write to the listener path. Without a
local daemon, the reply falls back to file-inbox and the listener never fires.

## Storage layout

```
~/.claude/agent-bus/
├── registry.json                    # name → pid + status + lastSeen
├── <agent>.sock                     # Unix socket (created when daemon listens)
├── <agent>/
│   ├── inbox/                       # offline messages waiting to be picked up
│   │   └── <ts>_from-<sender>.json
│   └── pending/                     # senders' active reply listeners
│       └── <msgId>.json             # PendingEntry { messageId, listenerPath, expiresAt }
```
