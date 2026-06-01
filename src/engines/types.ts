export type WhisperDebugLog = (message: string) => void;

export interface TranscribeOptions {
  log: WhisperDebugLog;
  language?: string;
  prompt?: string;
  /** Path to a file containing the prompt text. Engines that prefer file
   *  input (mlx) use this; engines that need a string (api / whispercpp)
   *  fall back to `prompt`. Both are normally supplied. */
  promptFile?: string;
  /** Engine-specific model identifier (e.g. mlx short name like "large-v3-turbo"). */
  model?: string;
}

export interface WhisperEngine {
  /** Idempotent — safe to call repeatedly. May download / install assets. */
  warmup(log: WhisperDebugLog): Promise<void>;
  /** Returns transcript text (post-cleaned, no [BLANK_AUDIO] markers). */
  transcribe(audioPath: string, opts: TranscribeOptions): Promise<string>;
  /** True if engine reads raw input directly (skip ensureWavInput). */
  acceptsRawInput: boolean;
}
