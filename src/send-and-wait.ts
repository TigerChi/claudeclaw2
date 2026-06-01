#!/usr/bin/env bun
/**
 * send-and-wait — synchronous request/reply over Agent Bus.
 *
 * Sends a message to another agent, registers a pending-reply listener with
 * the local daemon's pending registry, and blocks until the reply file appears
 * or the timeout elapses.
 *
 * Usage:
 *   bun run src/send-and-wait.ts --to <agent> --payload <text> [--from <name>] [--timeout <seconds>]
 *
 * Stdout: pretty-printed reply JSON on success.
 * Stderr: progress messages.
 * Exit codes: 0 = reply received, 1 = timeout, 2 = bad args.
 *
 * Caveat: the routing path requires the local agent's daemon to be running so
 * it can consume the pending entry and write to the listener path. Without a
 * daemon, the reply will fall back to file-inbox and won't trigger the listener.
 */

import { sendToAgent, waitForReply } from "./agent-bus";

const args = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--") && i + 1 < args.length) {
    flags[a.slice(2)] = args[i + 1];
    i++;
  }
}

const to = flags.to;
const from = flags.from ?? "anonymous";
const payload = flags.payload;
const timeoutS = Number(flags.timeout ?? "60");

if (!to || !payload) {
  console.error(
    "Usage: send-and-wait --to <agent> --payload <text> [--from <name>] [--timeout <seconds>]",
  );
  process.exit(2);
}

const listenerPath = `/tmp/send-and-wait-${Date.now()}-${process.pid}.json`;
const sentAt = Date.now();

const { messageId, delivered } = await sendToAgent(to, payload, {
  from,
  expectReply: { listenerPath, ttlMs: timeoutS * 1000 },
});
console.error(
  `[send-and-wait] sent ${messageId} via ${delivered}; waiting up to ${timeoutS}s`,
);

const reply = await waitForReply(listenerPath, timeoutS * 1000);
if (!reply) {
  console.error(`[send-and-wait] timeout after ${timeoutS}s`);
  process.exit(1);
}

const elapsed = Date.now() - sentAt;
console.error(`[send-and-wait] reply received in ${elapsed}ms`);
console.log(JSON.stringify(reply, null, 2));
