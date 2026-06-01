import { rm, stat } from "node:fs/promises";
import { ensureWavInput } from "./audio-input";
import { getSettings } from "./config";
import { createApiEngine } from "./engines/api";
import { mlxEngine, mlxEngineMeta } from "./engines/mlx";
import type { WhisperDebugLog, WhisperEngine } from "./engines/types";
import { warmupWhispercppAssets, whispercppEngine } from "./engines/whispercpp";
import { loadVocab } from "./whisper-vocab";

export interface TranscriptionResult {
  /** Cleaned transcript text. */
  text: string;
  /** Optional vocabulary hint to attach when forwarding to the main-conversation Claude.
   *  Empty string when no vocabulary file is configured. */
  vocabHint: string;
}

type EngineKind = "api" | "mlx" | "whispercpp";

function noopLog(): void {}

interface ResolvedEngine {
  kind: EngineKind;
  engine: WhisperEngine;
  model?: string;
  language?: string;
}

/**
 * Pick engine based on settings.whisper.engine + platform availability.
 *
 *   - explicit "api" / "mlx" / "whispercpp" → forced (errors if unavailable)
 *   - "auto" (default): api (if stt.baseUrl) > mlx (mac arm64) > whispercpp
 */
function resolveEngine(): ResolvedEngine {
  const settings = getSettings();
  const choice = settings.whisper?.engine ?? "auto";
  const stt = settings.stt;
  const language = settings.whisper?.language || undefined;
  const mlxModel = settings.whisper?.model || undefined;

  if (choice === "api" || (choice === "auto" && stt?.baseUrl)) {
    if (!stt?.baseUrl) {
      throw new Error('whisper.engine="api" but stt.baseUrl is empty — set stt.baseUrl in settings');
    }
    return {
      kind: "api",
      engine: createApiEngine({ baseUrl: stt.baseUrl, model: stt.model }),
      language,
    };
  }

  if (choice === "mlx" || (choice === "auto" && mlxEngineMeta.isAvailable())) {
    if (choice === "mlx" && !mlxEngineMeta.isAvailable()) {
      throw new Error(`whisper.engine="mlx" but unsupported on ${process.platform}-${process.arch}`);
    }
    return { kind: "mlx", engine: mlxEngine, model: mlxModel, language };
  }

  return { kind: "whispercpp", engine: whispercppEngine, language };
}

/**
 * Backward-compat: warm up the local-binary path. The warmup script calls
 * this; in mlx-only environments it's still safe (whisper.cpp won't be
 * downloaded unless the engine is actually selected).
 */
export function warmupWhisperAssets(_options?: { printOutput?: boolean }): Promise<void> {
  // Only warm whisper.cpp here — mlx warmup is lazy at first transcription
  // (large download, only run when actually needed).
  return warmupWhispercppAssets();
}

export async function transcribeAudioToText(
  inputPath: string,
  options?: { debug?: boolean; log?: WhisperDebugLog }
): Promise<TranscriptionResult> {
  const log = options?.debug ? (options?.log ?? console.log) : noopLog;
  const { kind, engine, model, language } = resolveEngine();
  log(`voice transcribe: engine=${kind} cwd=${process.cwd()} input=${inputPath}`);

  try {
    const inputStat = await stat(inputPath);
    log(`voice transcribe: input size=${inputStat.size} bytes`);
  } catch (err) {
    log(`voice transcribe: failed to stat input - ${err instanceof Error ? err.message : String(err)}`);
  }

  const vocab = await loadVocab();
  if (vocab.words.length) {
    log(`voice transcribe: vocab words=${vocab.words.length} prompt-chars=${vocab.asPrompt.length}`);
  }

  await engine.warmup(log);

  let audioPath = inputPath;
  let cleanupWav = false;
  if (!engine.acceptsRawInput) {
    audioPath = await ensureWavInput(inputPath, log);
    cleanupWav = audioPath !== inputPath;
  }

  try {
    const text = await engine.transcribe(audioPath, {
      log,
      model,
      language,
      prompt: vocab.asPrompt || undefined,
      promptFile: vocab.asPromptFile || undefined,
    });
    log(`voice transcribe: transcript chars=${text.length}`);
    return { text, vocabHint: vocab.asHint };
  } finally {
    if (cleanupWav) {
      log(`voice transcribe: cleanup wav=${audioPath}`);
      await rm(audioPath, { force: true }).catch(() => {});
    }
  }
}
