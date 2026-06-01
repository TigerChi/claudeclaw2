/**
 * Shared helpers for /cancel detection across messaging channels.
 *
 * Channel handlers use isCancelCommand() to detect when a user wants to
 * cancel the in-flight Claude run, then call cancelThread() from runner.
 */

/**
 * Returns true if the message text is a /cancel command.
 * Accepts: "/cancel", "/Cancel", "/CANCEL", with optional leading/trailing whitespace.
 * Does NOT match messages that contain /cancel as part of longer text — must be the entire message.
 */
export function isCancelCommand(text: string | undefined | null): boolean {
  if (!text) return false;
  return text.trim().toLowerCase() === "/cancel";
}

/** User-facing message confirming cancel was applied. */
export const CANCEL_CONFIRM_MESSAGE = "🛑 已取消當前處理中的訊息。";

/** User-facing message when nothing was in-flight to cancel. */
export const CANCEL_NOTHING_MESSAGE = "目前沒有正在處理的訊息可以取消。";
