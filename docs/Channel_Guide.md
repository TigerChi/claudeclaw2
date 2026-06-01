# Messaging Access Control

ClaudeClaw integrates four messaging platforms — **LINE, Telegram, Slack, Discord** — each with its own model for "who can talk to the bot, and when does the bot respond." This document compares them side-by-side and tracks the work needed to converge on a unified model.

> **Design goal**: One mental model for access control across all platforms, configured the same way regardless of which channel an agent uses. We're not there yet — see [Roadmap](#roadmap) at the bottom.

---

## At a Glance

| Mechanism | LINE | Telegram | Slack | Discord |
|---|:---:|:---:|:---:|:---:|
| Token / app credentials required | ✓ `channelAccessToken` + `channelSecret` | ✓ `token` | ✓ `botToken` + `appToken` (Socket Mode) | ✓ `token` |
| Webhook signature verification | ✓ via `channelSecret` | n/a (long-poll) | ✓ Slack signing built-in | n/a (Gateway) |
| **DM auto-respond** (private chat) | ✓ | ✓ | ✓ (`im` channel type) | ✓ |
| **User allowlist** (`allowedUserIds`) | ✓ string IDs | ✓ **number** IDs | ✓ string IDs | ✓ string IDs |
| **Pairing code** (self-enroll via secret) | ✓ | ✓ | ✗ | ✗ |
| **Group/Channel auto-respond list** (`listenChannels`) | ✗ | ✗ | ✓ | ✓ |
| **`requireMention` toggle** for groups | ✓ (configurable) | hardcoded ON | hardcoded ON | hardcoded ON |
| **Reply-to-bot triggers** in groups | ✗ | ✓ | (via thread) | ✓ |
| **Per-group / per-channel overrides** | ✓ `groups[].requireMention` | ✗ | ✗ | ✗ |
| **Thread-scoped sessions** | ✗ | ✗ | ✓ `thread_ts` | ✓ thread channels |
| **Group/Channel allowlist** (only respond in these) | ✗ | ✗ | ✗ | ✗ |
| **Time-window / quiet hours** | ✗ | ✗ | ✗ | ✗ |
| **Per-user rate limit** | ✗ | ✗ | ✗ | ✗ |

---

## How "User Access" Works on Each Platform

### Common shape

Every platform has an `allowedUserIds` array in its `<platform>` block of `settings.json`. Semantics today:

- **Empty + no pairing** → bot is fully open (anyone who can DM is allowed)
- **Empty + pairing enabled** *(LINE & Telegram only)* → first user to send the correct pairing code is auto-added to `allowedUserIds`
- **Non-empty** → only listed users are allowed; for LINE/Telegram, unlisted DM users with pairing enabled get prompted for the code; everyone else is silently ignored (or "Unauthorized" for Telegram private chat)

### LINE

```jsonc
"line": {
  "channelAccessToken": "...",
  "channelSecret": "...",
  "allowedUserIds": [],         // strings starting with "U" + 32 hex chars
  "pairing": {
    "enabled": true,
    "code": "<random>",
    "welcomeMessage": "...",
    "successMessage": "..."
  },
  "requireMention": true,       // group default: bot needs @mention
  "groups": {
    "Cxxxxxxxx": { "requireMention": false }   // override for this group
  },
  "webhookPort": 18789,
  "webhookPath": "/line/<agent>"
}
```

- **Group ID** starts with `C` (group), **room ID** with `R`.
- The pairing code is the recommended access-control mechanism — operators don't need to look up LINE User IDs by hand.
- `groups[].requireMention` is the only **per-group override** any platform offers today.

### Telegram

```jsonc
"telegram": {
  "token": "...",
  "allowedUserIds": [],         // numeric user IDs
  "pairing": {
    "enabled": true,
    "code": "<random>",
    "welcomeMessage": "...",
    "successMessage": "..."
  }
}
```

- **No `requireMention` toggle**: groups *always* require one of `reply_to_bot`, `@mention`, `/command`, or `/command@botname`. There is no way to make Telegram act like an unmoderated group bot.
- **No `listenChannels`**: a Telegram group can't be designated as "auto-respond all messages."
- Long-poll based — no webhook port, no signature verification needed.

### Slack

```jsonc
"slack": {
  "botToken": "xoxb-...",
  "appToken": "xapp-...",
  "allowedUserIds": [],         // string Slack user IDs (e.g. "U0123ABC")
  "listenChannels": []          // channel IDs where bot replies without needing @mention
}
```

- **Channel rules**: bot responds when (a) DM channel (`im`), (b) `@mentioned`, (c) channel is in `listenChannels`, or (d) channel is an Assistant Thread.
- **Thread sessions**: each `thread_ts` gets its own Claude session (see [MULTI_SESSION.md](MULTI_SESSION.md)).
- No pairing flow — operators must populate `allowedUserIds` manually.

### Discord

```jsonc
"discord": {
  "token": "...",
  "allowedUserIds": [],         // string Discord snowflake IDs (large numbers stored as strings)
  "listenChannels": []          // channel IDs where bot replies without needing @mention
}
```

- **Guild rules**: bot responds when (a) DM, (b) `@mention`, (c) `reply_to_bot`, (d) channel is in `listenChannels`, or (e) message is in a thread whose parent channel is in `listenChannels`.
- Each Discord thread channel can become an isolated session.
- No pairing flow.

---

## Recommended Conceptual Model (target)

The fragmentation above is historical. The target is a unified **`access`** block per platform:

```jsonc
"line": {
  "credentials": { ... },
  "access": {
    "mode": "pair",                    // "open" | "allowlist" | "pair"
    "users": [],                       // populated by pair flow or manually
    "pairing": { "code": "...", "welcomeMessage": "...", "successMessage": "..." },
    "groupPolicy": "mention",          // "none" | "mention" | "mention_or_reply" | "always"
    "listenChannels": [],              // groups/channels where groupPolicy="always" regardless of default
    "groupOverrides": {                // per-channel groupPolicy override
      "<groupId>": { "groupPolicy": "always" }
    }
  }
}
```

Goal: any operator who learns the access model on one platform knows it on all four.

---

## Roadmap

Track via this checklist. Each item should ideally land as one PR with a `feat(<platform>):` or `feat(access):` prefix.

### Pairing parity

- [ ] **Slack**: implement pairing flow (DM-only, mirror LINE/Telegram)
- [ ] **Discord**: implement pairing flow (DM-only, mirror LINE/Telegram)
- [ ] **All**: extract a shared `pairing` helper module (currently each platform reimplements `addXxxAllowedUser`)

### Group / channel control parity

- [ ] **LINE**: add `listenChannels` concept (groups where bot responds without `@mention`)
- [ ] **Telegram**: add `listenChannels` concept (chats where bot responds to all messages)
- [ ] **Telegram**: add `requireMention` toggle (currently hardcoded on)
- [ ] **Slack**: add per-channel `requireMention` override (currently global)
- [ ] **Discord**: add per-channel `requireMention` override (currently global)
- [ ] **LINE/Telegram**: add `groups[<id>].listenAll` mirror of Slack/Discord `listenChannels`

### Group/channel allowlist (currently absent on all four)

- [ ] **All**: optional `allowedGroupIds` / `allowedChannelIds` — bot only operates in listed groups, ignores invitations to others

### Unified config schema

- [ ] **All**: introduce the `access` block above; keep top-level fields (`allowedUserIds`, `pairing`, etc.) as deprecated aliases for one major version
- [ ] **All**: normalize ID types — Telegram is `number`, the others are `string`; pick one (probably `string`) and add coercion in the parser
- [ ] **`commands/start.md`**: simplify the setup wizard to a single `access` flow regardless of platform

### Operational features (cross-cutting)

- [ ] **All**: time-window / quiet-hours gating (`access.quietHours: [{ start, end, days }]`)
- [ ] **All**: per-user rate limit (`access.rateLimit: { perUser: "10/min" }`)
- [ ] **All**: structured audit log of access decisions (allowed / denied / paired) for forensic review

### Hub UI

- [ ] **Hub**: surface each agent's pairing code with copy button (done for LINE — extend to Telegram once added; not applicable to Slack/Discord until they get pairing)
- [ ] **Hub**: visualize each agent's `access.mode` and `groupPolicy` so operators can audit at a glance

### Documentation

- [ ] Per-platform setup guides for Slack and Discord (parallel to [LINE-GUIDE.md](LINE-GUIDE.md))
- [ ] Migration guide once the unified `access` schema lands

---

## See Also

- [LINE-GUIDE.md](LINE-GUIDE.md) — full LINE setup walkthrough
- [HUB-GUIDE.md](HUB-GUIDE.md) — hub dashboard usage
- [MULTI_SESSION.md](MULTI_SESSION.md) — Discord thread session architecture
