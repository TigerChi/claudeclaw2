---
description: Restart the heartbeat daemon (stop + start)
---

Restart the heartbeat daemon by running:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts --restart
```

Report the output to the user. The daemon will stop, then automatically start again with the latest code and settings.
