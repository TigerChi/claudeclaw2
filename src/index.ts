import { ensurePathEntries } from "./agent-env";

// When the hub is launched by launchd / systemd, it inherits a minimal
// PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). Daemons spawned by the hub
// inherit the same minimal PATH and then fail to locate `claude`,
// `node`, `ffmpeg`, etc. when shelling out. Backfill at entry so every
// downstream spawn sees a usable PATH.
process.env.PATH = ensurePathEntries(process.env.PATH);

import { start } from "./commands/start";
import { stop, stopAll, restart } from "./commands/stop";
import { clear } from "./commands/clear";
import { status } from "./commands/status";
import { telegram } from "./commands/telegram";
import { discord } from "./commands/discord";
import { slack } from "./commands/slack";
import { line } from "./commands/line";
import { send } from "./commands/send";
import { proxy } from "./commands/proxy";
import { hub } from "./commands/hub";

const args = process.argv.slice(2);
const command = args[0];

if (command === "--stop-all") {
  stopAll();
} else if (command === "--stop") {
  stop();
} else if (command === "--restart") {
  restart().then(() => start());
} else if (command === "--clear") {
  clear();
} else if (command === "start") {
  start(args.slice(1));
} else if (command === "status") {
  status(args.slice(1));
} else if (command === "telegram") {
  telegram();
} else if (command === "discord") {
  discord();
} else if (command === "slack") {
  slack();
} else if (command === "line") {
  line();
} else if (command === "send") {
  send(args.slice(1));
} else if (command === "proxy") {
  proxy(args.slice(1));
} else if (command === "hub") {
  hub(args.slice(1));
} else {
  start();
}
