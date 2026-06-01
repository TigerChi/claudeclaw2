---
description: Start daemon mode or run one-shot prompt/trigger
---

Start the heartbeat daemon for this project. Follow these steps exactly:

1. **Block home-directory starts (CRITICAL, BLOCKER)**:
   - Run `pwd` and `echo "$HOME"`.
   - If `pwd` equals `$HOME`, STOP immediately.
   - Tell the user exactly:
     - "CRITICAL BLOCKER: For security reasons, close this session and start a new one from the folder you want to initialize ClaudeClaw in."
   - Do not continue with any other step until they restart from a non-home project directory.

2. **Runtime checker (Bun + Node)**:
   - Run:
     ```bash
     which bun
     which node
     ```
   - If `bun` is missing:
     - Tell the user Bun is required and will be auto-installed.
     - Run:
       ```bash
       curl -fsSL https://bun.sh/install | bash
       ```
     - Then source the shell profile to make `bun` available in the current session:
       ```bash
       source ~/.bashrc 2>/dev/null || source ~/.zshrc 2>/dev/null || true
       ```
     - Verify again with `which bun`. If still not found, tell the user installation failed and to install manually from https://bun.sh, then exit.
     - Tell the user Bun was auto-installed successfully.
   - If `node` is missing:
     - Tell the user Node.js is required for the OGG converter helper.
     - Ask them to install Node.js LTS and rerun start, then exit.

3. **Check existing config**: Read `.claude/claudeclaw/settings.json` (if it exists). Determine which sections are already configured:
   - **Heartbeat configured** = `heartbeat.enabled` is `true` AND `heartbeat.prompt` is non-empty
   - **Telegram configured** = `telegram.token` is non-empty
   - **Discord configured** = `discord.token` is non-empty
   - **Slack configured** = `slack.botToken` is non-empty
   - **LINE configured** = `line.channelAccessToken` is non-empty
   - **Security configured** = `security.level` exists and is not `"moderate"` (the default), OR `security.allowedTools`/`security.disallowedTools` are non-empty

4. **Interactive setup — smart mode** (BEFORE launching the daemon):

   **If ALL sections are already configured**, show a summary of the current config and ask ONE question:

   Use AskUserQuestion:
   - "Your settings are already configured. Want to change anything?" (header: "Settings", options: "Keep current settings", "Reconfigure")

   If they choose "Keep current settings", skip to step 6 (first contact question).
   If they choose "Reconfigure", proceed to step 5 below as if nothing was configured.

   **If SOME sections are configured and others are not**, show the already-configured sections as a summary, then only ask about the unconfigured sections in step 5.

   **If NOTHING is configured** (fresh install), ask about all sections in step 5.

5. **Ask setup questions**:

   Use **AskUserQuestion** to ask unconfigured sections. Ask in TWO batches if needed (AskUserQuestion supports up to 4 questions per call):

   **Batch 1** — Model + Heartbeat + messaging platforms:
   - **Model** (always ask if `model` is empty/unset): "Which Claude model should ClaudeClaw use?" (header: "Model", options: "opus (default)", "sonnet", "haiku", "glm")
   - **If heartbeat is NOT configured**: "Enable heartbeat? Example: I can remind you to drink water every 30 minutes, or you can fully customize what runs." (header: "Heartbeat", options: "Yes" / "No")
   - **If Telegram is NOT configured**: "Configure Telegram? Recommended if you want it 24/7 live." (header: "Telegram", options: "Yes" / "No")
   - **If Discord is NOT configured**: "Configure Discord? Connect your bot to Discord servers." (header: "Discord", options: "Yes" / "No")

   **Batch 2** — remaining messaging platforms + security (ask immediately after batch 1):
   - **If Slack is NOT configured**: "Configure Slack? Connect your bot to a Slack workspace." (header: "Slack", options: "Yes" / "No")
   - **If LINE is NOT configured**: "Configure LINE? Connect your bot to LINE Messaging API." (header: "LINE", options: "Yes" / "No")
   - **If security is NOT configured**: "What security level for Claude?" (header: "Security", options:
     - "Moderate (Recommended)" (description: "Full access scoped to project directory")
     - "Locked" (description: "Read-only — can only search and read files, no edits, bash, or web")
     - "Strict" (description: "Can edit files but no bash or web access")
     - "Unrestricted" (description: "Full access with no directory restriction — dangerous"))

   Then, based on their answers:

   - **Model**: Set `model` in settings to their choice (e.g. `"opus"`, `"sonnet"`, `"haiku"`, `"glm"`). Default is `"opus"` if they don't pick.
   - **If model is `glm`**: Ask in normal free-form text for API token and set top-level `api` to that value (optional; user can skip). Only ask this token question when the selected model is `glm`.

   - **Agentic mode**: Use AskUserQuestion to ask:
     - "Enable agentic model routing? This automatically selects models based on task type using configurable modes." (header: "Agentic", options: "Yes — default modes (Recommended)", "No — use single model")
     - If "Yes": Set `agentic.enabled` to `true` with default modes (planning→opus, implementation→sonnet). The user can customize modes later via `/config`.
     - If "No": Set `agentic.enabled` to `false`.
   - Ask whether to set a fallback model. Recommend `glm` first so fallback uses a different provider path than the primary Claude model. If yes, set `fallback.model` and optionally `fallback.api`.
   - Ask whether to enable GLM fallback (kicks in automatically when your Claude token limit is hit). The fallback model is always `glm` — no other model is supported. Use AskUserQuestion: "Enable GLM fallback? Automatically switches to GLM when your Claude limit is hit." (header: "Fallback", options: "Yes — enable GLM fallback", "Skip"). If yes, ask in normal free-form text for the GLM API token (optional, user can skip). Set `fallback.model` to `"glm"` and `fallback.api` to the token if provided.

   - **If yes to heartbeat**: Use AskUserQuestion again with one question:
     - "How often should it run in minutes?" (header: "Interval", options: "5", "15", "30 (Recommended)", "60")
     - Set `heartbeat.enabled` to `true` and `heartbeat.interval` to their answer.
     - Ask for timezone as simple UTC offset text (example: `UTC+1`, `UTC-5`, `UTC+03:30`) and set top-level `timezone`.
   - **If heartbeat is no but `timezone` is missing**: set top-level `timezone` to `UTC+0`.

   - **If yes to Telegram**: First ask for the bot token in free-form text:
     - Telegram bot token (hint: create/get it from `@BotFather`)
     - Set `telegram.token` to the answer.
     - Then choose access control mode via AskUserQuestion: "How should access be controlled?" (header: "Access", options: "Pairing code (Recommended)", "User ID allowlist", "No restriction (open)"). Branch on the answer:
       - **Pairing code**: Set `telegram.allowedUserIds` to `[]`. Generate a fresh, random 10-character code containing a mix of upper-case letters, lower-case letters, digits, and at least one symbol from `!@#%&*-_`. **Never reuse the same code across machines or sessions** — generate it fresh every time you run setup. Recommended generation method: `python3 -c "import secrets,string; chars=string.ascii_letters+string.digits+'!@#%&*-_'; print(''.join(secrets.choice(chars) for _ in range(10)))"`. After generating, show the code clearly and use AskUserQuestion: "Pairing code generated: `<CODE>`. Keep it or change?" (header: "Pairing", options: "Keep generated code (Recommended)", "Type my own"). If they pick "Type my own", ask in free-form text. Set `telegram.pairing.enabled` to `true` and `telegram.pairing.code` to the chosen value. Leave `welcomeMessage` and `successMessage` as defaults. Anyone who DMs the bot will be prompted for the code; the first user to enter the correct code is auto-added to `allowedUserIds`.
       - **User ID allowlist**: Ask in free-form text for allowed Telegram user IDs (hint: have each user message `@userinfobot` to get their numeric ID, or use Telegram Desktop → click profile → ID is visible). Set `telegram.allowedUserIds` to the answer (array of numbers). Set `telegram.pairing.enabled` to `false`.
       - **No restriction (open)**: Set `telegram.allowedUserIds` to `[]` and `telegram.pairing.enabled` to `false`. Any user who DMs the bot can interact with it. Warn the user this is the least secure option.
     - Note: Telegram bot runs in-process with the daemon. All components (heartbeat, cron, telegram, discord) share one Claude session.

   - **If yes to Discord**: First ask for the bot token in free-form text:
     - Discord bot token (hint: create a bot at https://discord.com/developers/applications → Bot → Token. Enable **Message Content Intent** under Privileged Gateway Intents.)
     - Set `discord.token` to the answer.
     - Then choose access control mode via AskUserQuestion: "How should access be controlled?" (header: "Access", options: "User ID allowlist (Recommended)", "No restriction (open)"). Branch on the answer:
       - **User ID allowlist**: Ask in free-form text for allowed Discord user IDs (hint: enable Developer Mode in Discord settings → right-click your profile → Copy User ID). These are large numbers — they will be stored as strings. Set `discord.allowedUserIds` (as array of strings) to the answer. The allowlist applies to messages, slash commands, and button interactions.
       - **No restriction (open)**: Set `discord.allowedUserIds` to `[]`. Any user who DMs or @mentions the bot can interact with it. Warn the user this is the least secure option. (Note: Discord doesn't yet support pairing-code self-enrollment in ClaudeClaw.)
     - Listen channel IDs (optional, ask in free-form text — hint: right-click a channel in Discord with Developer Mode enabled → Copy Channel ID). Channels where the bot responds to all messages without requiring an @mention.
     - Set `discord.listenChannels` (as array of strings) accordingly.
     - Note: Discord bot connects via WebSocket gateway in-process with the daemon. It supports DMs, guild mentions/replies, slash commands (/start, /reset), voice messages, and image attachments.

   - **If yes to Slack**: First ask for the tokens in free-form text:
     - Slack Bot Token (hint: create a Slack App at https://api.slack.com/apps → OAuth & Permissions → Bot User OAuth Token, starts with `xoxb-`)
     - Slack App Token (hint: Settings → Basic Information → App-Level Tokens, create one with `connections:write` scope, starts with `xapp-`)
     - Set `slack.botToken` and `slack.appToken` accordingly.
     - Then choose access control mode via AskUserQuestion: "How should access be controlled?" (header: "Access", options: "User ID allowlist (Recommended)", "No restriction (open)"). Branch on the answer:
       - **User ID allowlist**: Ask in free-form text for allowed Slack user IDs (hint: click a user's profile in Slack → More → Copy member ID). Set `slack.allowedUserIds` (as array of strings) to the answer.
       - **No restriction (open)**: Set `slack.allowedUserIds` to `[]`. All workspace members can interact with the bot. Warn the user this is the least secure option. (Note: Slack doesn't yet support pairing-code self-enrollment in ClaudeClaw.)
     - Listen channel IDs (optional, ask in free-form text — channels where the bot responds to all messages without requiring an @mention).
     - Set `slack.listenChannels` (as array of strings) accordingly.
     - Required Bot Token Scopes: `app_mentions:read`, `assistant:write`, `channels:history`, `channels:read`, `chat:write`, `commands`, `files:read`, `files:write`, `groups:history`, `im:history`, `im:read`, `im:write`, `reactions:read`, `reactions:write`, `users:read`
     - Required Event Subscriptions: `app_mention`, `assistant_thread_started`, `message.channels`, `message.groups`, `message.im`
     - Socket Mode must be enabled in the Slack App settings.
     - Note: Slack bot connects via Socket Mode WebSocket in-process with the daemon. It supports DMs, channel mentions, thread sessions, file upload/download, Block Kit buttons, and message edit/delete.

   - **If yes to LINE**: First ask for the credentials and webhook config in free-form text:
     - LINE Channel Access Token (hint: create a Messaging API channel at https://developers.line.biz → Messaging API → Channel access token (long-lived), click "Issue")
     - LINE Channel Secret (hint: same page → Basic settings → Channel secret)
     - Webhook port (default: 18789 — the local port the webhook HTTP server listens on)
     - Webhook path (default: `/line/webhook` — set to agent name for multi-agent setups, e.g. `/line/AgentName`)
     - Set `line.channelAccessToken`, `line.channelSecret`, `line.webhookPort` (as number), and `line.webhookPath` (as string).
     - Group mention policy is `requireMention: true` by default (groups must @mention the bot). Edit `line.requireMention` or per-group `line.groups[<groupId>].requireMention` after setup if needed.
     - Then choose access control mode via AskUserQuestion: "How should access be controlled?" (header: "Access", options: "Pairing code (Recommended)", "User ID allowlist", "No restriction (open)"). Branch on the answer:
       - **Pairing code**: Set `line.allowedUserIds` to `[]`. Generate a fresh, random 10-character code containing a mix of upper-case letters, lower-case letters, digits, and at least one symbol from `!@#%&*-_`. **Never reuse the same code across machines or sessions** — generate it fresh every time you run setup. Recommended generation method: `python3 -c "import secrets,string; chars=string.ascii_letters+string.digits+'!@#%&*-_'; print(''.join(secrets.choice(chars) for _ in range(10)))"`. After generating, show the code to the user clearly and use AskUserQuestion: "Pairing code generated: `<CODE>`. Keep it or change?" (header: "Pairing", options: "Keep generated code (Recommended)", "Type my own"). If they pick "Type my own", ask in free-form text for the code they want. Set `line.pairing.enabled` to `true` and `line.pairing.code` to the chosen value. Leave `welcomeMessage` and `successMessage` as defaults (the LINE config parser will fill them in). Anyone who DMs the bot will be prompted for the code; the first user to enter the correct code is auto-added to `allowedUserIds`.
       - **User ID allowlist**: Ask in free-form text for allowed LINE user IDs (hint: each LINE user ID looks like `U` followed by 32 hex characters; you can find one by sending a message to the bot and checking the daemon log). Set `line.allowedUserIds` (as array of strings) to the answer. Set `line.pairing.enabled` to `false`.
       - **No restriction (open)**: Set `line.allowedUserIds` to `[]` and `line.pairing.enabled` to `false`. Any user who DMs the bot can interact with it. Warn the user this is the least secure option.
     - The user needs to set the Webhook URL in LINE Developers Console to point to their public URL + webhookPath (e.g. `https://example.ngrok-free.dev/line/webhook`). Remind them to use ngrok or a similar tunnel for local development: `ngrok http <webhookPort>`.
     - Note: LINE bot runs a local HTTP webhook server in-process with the daemon. It supports DMs, group chats (with @mention gating), text/image/video/audio/file/sticker/location messages, loading animations, and reply/push messaging.

   - **Security level mapping** — set `security.level` in settings based on their choice:
     - "Locked" → `"locked"`
     - "Strict" → `"strict"`
     - "Moderate" → `"moderate"`
     - "Unrestricted" → `"unrestricted"`

   - **If security is "Strict" or "Locked"**: Use AskUserQuestion to ask:
     - "Allow any specific tools on top of the security level? (e.g. Bash(git:*) to allow only git commands)" (header: "Allow tools", options: "None — use level defaults (Recommended)", "Bash(git:*) — git only", "Bash(git:*) Bash(npm:*) — git + npm")
     - If they pick an option with tools or type custom ones, set `security.allowedTools` to the list.

   Update `.claude/claudeclaw/settings.json` with their answers.

6. **Launch/start action**:
   ```bash
   mkdir -p .claude/claudeclaw/logs && nohup bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts start --web > .claude/claudeclaw/logs/daemon.log 2>&1 & echo $!
   ```
   Use the description "Starting ClaudeClaw server" for this command.
   Wait 1 second, then check `cat .claude/claudeclaw/logs/daemon.log`. If it contains "Aborted: daemon already running", tell the user and exit.
   - Read `.claude/claudeclaw/settings.json` for `web.port` (default `4632` if missing) and `web.host` (default `127.0.0.1`).
   - Then try to open the dashboard directly:
     - Linux: `xdg-open http://<HOST>:<PORT>`
     - macOS: `open http://<HOST>:<PORT>`
     - If open command fails, print the URL clearly so user can open it manually.

7. **Capture session ID**: Read `.claude/claudeclaw/session.json` and extract the `sessionId` field. This is the shared Claude session used by the daemon for heartbeat, jobs, Telegram, and Discord.

8. **Report**: Print the ASCII art below then show the PID, session, status info, Telegram bot next step, and the Web UI URL.

CRITICAL: Output the ASCII art block below EXACTLY as-is inside a markdown code block. Do NOT re-indent, re-align, or adjust ANY whitespace. Copy every character verbatim. Only replace `<PID>` and `<WORKING_DIR>` with actual values.

```
🦞         🦞
   ▐▛███▜▌
  ▝▜█████▛▘
    ▘▘ ▝▝
```

# HELLO, I AM YOUR CLAUDECLAW!
**Daemon is running! PID: \<PID> | Dir: \<WORKING_DIR>**

```
/heartbeat:status  - check status
/heartbeat:stop    - stop daemon
/heartbeat:clear   - back up session & restart fresh
/heartbeat:config  - show config
```

**To start chatting on Telegram**
Go to your bot, send `/start`, and start talking.

**To start chatting on Discord**
DM your bot directly — no server invite needed: `https://discord.com/users/<DISCORD_BOT_ID>`
Or mention it in any server it's in. Use `/start` and `/reset` slash commands.
To get `<DISCORD_BOT_ID>`: read the daemon log for the bot's user ID (shown in the "Ready as <name> (<ID>)" line).

**To start chatting on Slack**
DM your bot directly in Slack, or @mention it in any channel it's been added to.
The bot supports file upload/download, Block Kit buttons, message editing/deleting, and thread sessions.

**To start chatting on LINE**
Add your bot as a friend on LINE and send a message directly.
In group chats, @mention the bot's display name. Make sure your Webhook URL is set in LINE Developers Console.
The bot supports text, images, video, audio, files, stickers, and location messages.

**To talk to your agent directly on Claude Code**
`cd <WORKING_DIR> && claude --resume <SESSION_ID>`

Show this direct Web UI URL:
```bash
http://<WEB_HOST>:<WEB_PORT>
```
Defaults: `WEB_HOST=127.0.0.1`, `WEB_PORT=4632` unless changed via settings or `--web-port`.

---

## Reference: File Formats

### Settings — `.claude/claudeclaw/settings.json`
```json
{
  "model": "opus",
  "api": "",
  "fallback": {
    "model": "glm",
    "api": ""
  },
  "agentic": {
    "enabled": true,
    "defaultMode": "implementation",
    "modes": [
      {
        "name": "planning",
        "model": "opus",
        "keywords": ["plan", "design", "architect", "research", "analyze", "think", "evaluate", "review"],
        "phrases": ["how should i", "what's the best way to", "help me decide"]
      },
      {
        "name": "implementation",
        "model": "sonnet",
        "keywords": ["implement", "code", "write", "fix", "deploy", "test", "commit"]
      }
    ]
  },
  "timezone": "UTC+0",
  "heartbeat": {
    "enabled": true,
    "interval": 15,
    "prompt": "Check git status and summarize recent changes."
    // OR use a file path:
    // "prompt": "prompts/heartbeat.md"
  },
  "telegram": {
    "token": "123456:ABC-DEF...",
    "allowedUserIds": [123456789]
  },
  "discord": {
    "token": "MTIz...",
    "allowedUserIds": ["123456789012345678"],
    "listenChannels": ["987654321098765432"]
  },
  "slack": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "allowedUserIds": ["U0123ABC"],
    "listenChannels": ["C0123ABC"]
  },
  "line": {
    "channelAccessToken": "long-lived-token...",
    "channelSecret": "hex-secret...",
    "allowedUserIds": ["U0123456789abcdef0123456789abcdef"],
    "pairing": {
      "enabled": true,
      "code": "<auto-generated 10-char code, unique per machine>",
      "welcomeMessage": "Hi! 我是受保護的 bot，請輸入配對碼以開始使用。",
      "successMessage": "✅ 配對成功，歡迎加入！現在可以開始對話了。"
    },
    "requireMention": true,
    "groups": {
      "C0123456789abcdef0123456789abcdef": { "requireMention": false }
    },
    "webhookPort": 18789,
    "webhookPath": "/line/webhook"
  },
  "security": {
    "level": "moderate",
    "allowedTools": [],
    "disallowedTools": []
  }
}
```
- `model` — Claude model to use (`opus`, `sonnet`, `haiku`, `glm`, or full model ID). Empty string uses default. Ignored when `agentic.enabled` is true.
- `api` — API token used when `model` is `glm` (passed as `ANTHROPIC_AUTH_TOKEN` for that provider path).
- `fallback.model` — backup model used automatically if the primary run returns a rate-limit message. Prefer `glm` for provider diversity.
- `fallback.api` — optional API token to use with `fallback.model`.
- `agentic.enabled` — when true, automatically routes tasks to appropriate models based on task type
- `agentic.defaultMode` — which mode to use when no keywords match (default: `"implementation"`)
- `agentic.modes` — array of routing modes, each with: `name` (string), `model` (string), `keywords` (string[]), optional `phrases` (string[], checked before keywords with higher priority). Old `planningModel`/`implementationModel` format is auto-converted.
- `timezone` — canonical app timezone as UTC offset text (example: `UTC+1`, `UTC-5`, `UTC+03:30`). Heartbeat windows, jobs, and UI all use this timezone.
- `heartbeat.enabled` — whether the recurring heartbeat runs
- `heartbeat.interval` — minutes between heartbeat runs
- `heartbeat.prompt` — the prompt sent to Claude on each heartbeat. Can be an inline string or a file path ending in `.md`, `.txt`, or `.prompt` (relative to project root). File contents are re-read on each tick, so edits take effect without restarting the daemon.
- Heartbeat template override (optional) — create `.claude/claudeclaw/prompts/HEARTBEAT.md` to replace the built-in heartbeat template for this project.
- `telegram.token` — Telegram bot token from @BotFather
- `telegram.allowedUserIds` — array of numeric Telegram user IDs allowed to interact
- `discord.token` — Discord bot token from the Developer Portal
- `discord.allowedUserIds` — array of string Discord user IDs (snowflakes) allowed to interact
- `discord.listenChannels` — array of string channel IDs where the bot responds to all messages without requiring an @mention
- `slack.botToken` — Slack Bot OAuth token (starts with `xoxb-`)
- `slack.appToken` — Slack App-level token for Socket Mode (starts with `xapp-`)
- `slack.allowedUserIds` — array of string Slack user IDs allowed to interact (empty = all)
- `slack.listenChannels` — array of string channel IDs where the bot responds without @mention
- `line.channelAccessToken` — LINE channel access token (long-lived, from LINE Developers Console)
- `line.channelSecret` — LINE channel secret (for webhook signature verification)
- `line.allowedUserIds` — array of allowed LINE user IDs. Empty + pairing disabled = all users allowed. Empty + pairing enabled = only paired users (recommended). Pairing auto-adds the first user who enters the correct code.
- `line.pairing.enabled` — when `true` with a `code` set, unknown DM users are prompted for the code; correct entries are auto-added to `allowedUserIds`
- `line.pairing.code` — the secret code strangers must send to join. **Auto-generated by setup wizard, unique per machine. Never use a hardcoded default.**
- `line.pairing.welcomeMessage` — message shown to unknown users prompting for the pairing code
- `line.pairing.successMessage` — message shown after a successful pairing
- `line.requireMention` — global default for whether bot requires @mention to respond in groups/rooms (default: `true`)
- `line.groups` — per-group config overrides, keyed by group/room ID. Each entry can override `requireMention` for that specific group. Group IDs start with `C`, room IDs with `R`.
- `line.webhookPort` — local port for the webhook HTTP server (default: 18789)
- `line.webhookPath` — webhook URL path (default: `/line/webhook`). Set to agent name for multi-agent setups (e.g. `/line/AgentName`)
- `security.level` — one of: `locked`, `strict`, `moderate`, `unrestricted`
- `security.allowedTools` — extra tools to allow on top of the level (e.g. `["Bash(git:*)"]`)
- `security.disallowedTools` — tools to block on top of the level

### Security Levels
All levels run without permission prompts (headless). Security is enforced via tool restrictions and project-directory scoping.

| Level | Tools available | Directory scoped |
|-------|----------------|-----------------|
| `locked` | Read, Grep, Glob only | Yes — project dir only |
| `strict` | Everything except Bash, WebSearch, WebFetch | Yes — project dir only |
| `moderate` | All tools | Yes — project dir only |
| `unrestricted` | All tools | No — full system access |

### Jobs — `.claude/claudeclaw/jobs/<name>.md`
Jobs are markdown files with cron schedule frontmatter and a prompt body:
```markdown
---
schedule: "0 9 * * *"
---
Your prompt here. Claude will run this at the scheduled time.
```
- Schedule uses standard cron syntax: `minute hour day-of-month month day-of-week`
- **Timezone-aware**: cron times are evaluated in the configured `timezone`. E.g. `0 9 * * *` with `timezone: "UTC+2"` fires at 9:00 AM local time.
- The filename (without `.md`) becomes the job name
- Jobs are loaded at daemon startup from `.claude/claudeclaw/jobs/`
