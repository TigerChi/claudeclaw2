#!/bin/sh
# SessionStart hook — inject prompts/USAGE.md into manual (human-driven) sessions.
#
# Skipped for daemon-spawned sessions: those already get USAGE via compose.ts
# --append-system-prompt, and the daemon marks them with CLAUDECLAW_DAEMON=1.
# Also skipped outside a claudeclaw agent project (no .claude/claudeclaw/), so
# unrelated projects don't get polluted with this context.

[ -n "$CLAUDECLAW_DAEMON" ] && exit 0
[ -d "$CLAUDE_PROJECT_DIR/.claude/claudeclaw" ] || exit 0

cat "$CLAUDE_PLUGIN_ROOT/prompts/USAGE.md"
