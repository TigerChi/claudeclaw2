---
description: Show LINE bot status and manage global session
---

Show the LINE bot integration status. Check the following:

1. **Configuration**: Read `.claude/claudeclaw/settings.json` and check if `line.channelAccessToken` is set (show masked token: first 5 chars + "..."). Show `channelSecret` (masked), `allowedUserIds`, `webhookPort`, and `webhookPath`.

2. **Global Session**: Read `.claude/claudeclaw/session.json` and show:
   - Session UUID (first 8 chars)
   - Created at
   - Last used at
   - Note: This session is shared across heartbeat, cron jobs, and LINE messages.

3. **If $ARGUMENTS contains "clear"**: Delete `.claude/claudeclaw/session.json` to reset the global session. Confirm to the user. The next run from any source (heartbeat, cron, or LINE) will create a fresh session.

4. **Running**: Check if the daemon is running by reading `.claude/claudeclaw/daemon.pid`. The LINE bot runs a webhook HTTP server in-process with the daemon when credentials are configured.

5. **Webhook URL**: Remind the user that the LINE webhook URL should be set in LINE Developers Console to their public URL + webhookPath (e.g. `https://example.ngrok-free.dev<webhookPath>`).

Format the output clearly for the user.
