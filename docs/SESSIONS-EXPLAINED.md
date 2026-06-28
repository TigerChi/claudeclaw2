# Sessions, in plain language

> A non-technical companion to [MULTI_SESSION.md](MULTI_SESSION.md). If you
> just want to understand how your agent keeps conversations separate — and
> how to tune it — start here.

## What is a "session"?

Each ongoing conversation your agent has runs as its own separate "mind" —
its own running copy of Claude with its own short-term memory of that
conversation. We call each one a **session**.

Two sessions don't share short-term memory. What you say in one chat is not
visible to another chat, unless it was written to the agent's long-term
memory files (those are shared).

> Long-term memory (the agent's notes/`CLAUDE.md`) is shared across every
> session. Only the live back-and-forth of each conversation is separate.

## What gets its own session?

Every place you can talk to the agent gets its own session:

- **Direct messages** — one session per person, on each platform
  (Slack, LINE, Telegram, Discord).
- **Groups** — one session per group.
- **Channels / threads** — see the next section; this is configurable.

A handful of internal, non-chat activities share a single common session
called **`global`**: scheduled jobs (cron), the periodic self-check
(heartbeat), agent-to-agent messages, and the local terminal (TUI). Normal
conversations never land in `global`.

### Why this matters

If one conversation gets stuck, it only affects that one conversation.
Every other chat keeps working. (Before this design, all direct messages
shared one session, so a single stuck DM could freeze every DM.)

## Channels: one session per channel, or one per thread?

For **Slack channels**, you can choose how finely conversations are split.
Two modes:

- **`thread`** — every thread in a channel is its own session.
  Maximum isolation. Best for channels where separate, long, or parallel
  discussions happen (e.g. development work) — each topic keeps its own
  clean context and won't crowd out the others.

- **`channel`** — the whole channel is one session.
  Fewer sessions, and the agent carries one shared context across the
  channel. Good for channels that stay on one general topic. Uses less
  memory.

You set this **per agent**. You can also override specific channels.

### How to configure

In the agent's `settings.json`, under `slack`:

```json
{
  "slack": {
    "sessionGranularity": "channel",
    "sessionChannelOverrides": {
      "C0LONGPROJECT": "thread"
    }
  }
}
```

- `sessionGranularity` — the agent's default for **all** its channels.
  Set it to `"thread"` to make every channel split by thread, or
  `"channel"` to make every channel share one session.
  If you don't set it, the default is `"thread"`.
- `sessionChannelOverrides` — exceptions for specific channels. The channel
  ID (looks like `C0AB12CD34`) maps to `"thread"` or `"channel"`. An entry
  here wins over the default above.

A change takes effect after the agent restarts.

### Things to know

- **Direct messages are always one session per person** — this channel
  setting does not change that.
- **`channel` mode has a trade-off**: if two people are active in two
  different threads of the same channel at once, that mode handles them one
  after another (not at the same time), and their contexts mix. For busy or
  important channels, prefer `thread`.
- **Switching is not retroactive**: if you change a channel from `thread`
  to `channel`, old threads keep their existing separate sessions; only new
  messages follow the new setting.
- **It's per agent**: changing one agent's setting never affects another
  agent.

## Quick reference

| You want… | Set |
|---|---|
| Every Slack thread isolated (default) | `sessionGranularity: "thread"` |
| Each Slack channel as one conversation | `sessionGranularity: "channel"` |
| Mostly channel-level, but isolate one busy channel | `sessionGranularity: "channel"` + that channel `"thread"` in `sessionChannelOverrides` |
| Separate DMs / groups / Telegram chats | Automatic — nothing to set |
