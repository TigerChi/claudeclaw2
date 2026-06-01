---
description: Manage the ClaudeClaw Hub — multi-agent dashboard and reverse proxy
---

Manage the ClaudeClaw Hub. The hub is a host-global control plane that lists every ClaudeClaw daemon registered on this machine and lets you start/stop/restart them from one dashboard.

Parse `$ARGUMENTS` to determine the action. The first word is the subcommand; remaining words are passed through. **Always run `start` (and the no-arg default) with `--detach` from this slash command** — the foreground server would block the bash call indefinitely.

### Output handling — IMPORTANT for status / no-args

The CLI's `hub status` output ends with a box-drawing **Available commands** table plus a **Typical first-time flow** block. Claude Code's terminal UI tends to collapse long bash outputs into `… +N lines (ctrl+o to expand)`, which **hides the help table from the user**.

**Whenever `hub status` is called (whether explicitly or as the detect step in the default flow), reproduce the help table and the Typical first-time flow lines verbatim in your final user-facing reply** — copy them out of the bash output into your message body so the user sees them without expanding the collapsed block. The user has explicitly requested the help be visible at the top of the response, not hidden behind `+N lines`.

The two blocks to always surface look like this (the actual values are produced by the CLI; copy the literal output, not this template):

```
┌─────────────────────────────────────┬─────────────────────────────────────────────────────────┐
│ Subcommand                          │ What it does                                            │
├─────────────────────────────────────┼─────────────────────────────────────────────────────────┤
│ (no args)                           │ Detect: print status if running, start --detach if not  │
│ ...                                                                                            │
└─────────────────────────────────────┴─────────────────────────────────────────────────────────┘

Typical first-time flow:
  /claudeclaw:hub             → auto-inits token, asks about autostart, starts hub
  open http://127.0.0.1:4631  → paste the bearer token
```

### Default (no arguments) — detect, then start if needed

**Step 1: detect.** Always run `status` first so the user can see the current state:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub status
```

**Step 2: branch on the output.**

- **If output contains `● Hub running`** — hub is already up. Report the status output verbatim and stop. Do not call `start` again. **Critical: copy the box-drawing Available commands table and the Typical first-time flow lines into your reply body** (see "Output handling" above) — they end up in the collapsed `+N lines` if you don't.

- **If output contains `○ Hub is not running`** — proceed to step 3.

**Step 3: start (only when not running).**

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub start --detach
```

This handles two sub-cases automatically:

- **First run ever (no auth yet)** — auto-generates the bearer token and prints it once. **Tell the user to copy the token immediately, it won't be shown again.** Then **ask the user**: "要不要把 hub 設定成開機自動啟動？(autostart)" — if yes, run `hub autostart enable`.
- **Token exists** — starts hub in background. Print PID + URL.

After start returns, wait 1 second and run `hub status` to confirm.

### `start [--detach] [--host H] [--port P]`

Same behavior as the default. Always include `--detach`:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub start --detach $ARGUMENTS_AFTER_FIRST_WORD
```

Flags:
- `--detach` — run in background, log to `~/.claude/claudeclaw/hub/hub.log`. Slash commands always need this.
- `--host <ip>` — bind a non-loopback IP (e.g. tailscale `100.x.y.z`).
- `--port <n>` — default `4631`.

If this is a first run (no auth yet), `start` auto-inits the bearer token and prints it once. Then ask the user about autostart (see Default section).

### `status`

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub status
```

Reports: hub running (PID + URL), auth state, autostart state (macOS), list of registered daemons, **followed by the Available commands box table and Typical first-time flow lines**. **Copy all of it into your reply body** — see "Output handling" above. The help table is the part most likely to get hidden by Claude Code's `+N lines` collapse, but the user wants it visible every time.

### `init [--force]`

**Usually not needed** — `start` auto-initializes on first run. Manual init is only useful for re-generating after a force reset. Use `token --rotate` (not `init`) to replace an existing token.

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub init
```

Show the token clearly with the "copy now, won't be shown again" warning. Then ask the user about autostart (same as `start`).

### `stop`

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub stop
```

If "Hub already running" errors persist after stop, check `ps aux | grep "hub start"` for orphan processes, kill them manually, then `rm ~/.claude/claudeclaw/hub/hub.pid ~/.claude/claudeclaw/hub/hub.port`.

### `token --rotate`

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub token --rotate
```

Replaces the current token (revokes the old). Show the new token clearly. Anyone using the old token will need the new one.

### `restart <agent-id|path>`

Restart a specific registered daemon (stop + spawn detached at its `cwd`):

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub restart $TARGET
```

`$TARGET` is either the 12-char agent ID (from `hub status`) or the absolute project path.

### `autostart <enable|disable|status>` (macOS only)

Manage launch-on-login via a `~/Library/LaunchAgents/com.claudeclaw.hub.plist` LaunchAgent.

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub autostart enable
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub autostart disable
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub autostart status
```

`enable` writes the plist and runs `launchctl load`. `disable` runs `launchctl unload` and removes the plist. The current state also appears in `hub status` output.

### Key information

- **Sharing access**: The token is stable. Click 🔑 Token in the dashboard to copy it. Bind to a tailscale IP (`hub start --detach --host 100.x.y.z`) to share with teammates over a private network.
- **Daemon discovery**: A daemon registers itself in `~/.claude/claudeclaw/daemons/<hash>.json` when it starts. Existing daemons that pre-date the registry feature need to be restarted once before the hub can see them.
- **Full docs**: see `docs/HUB-GUIDE.md` (usage) and `docs/HUB-INTERNALS.md` (architecture).
