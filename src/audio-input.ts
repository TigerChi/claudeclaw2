import { execSync, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withDaemonSafeEnv } from "./agent-env";
import type { WhisperDebugLog } from "./engines/types";

function safeEnv(): NodeJS.ProcessEnv {
  return withDaemonSafeEnv(process.env);
}

const WHISPER_ROOT = join(process.cwd(), ".claude", "claudeclaw", "whisper");
const TMP_FOLDER = join(WHISPER_ROOT, "tmp");
const OGG_MJS_CONVERTER = fileURLToPath(new URL("./ogg.mjs", import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));

function ensureOggDeps(): void {
  const marker = join(PLUGIN_ROOT, "node_modules", "ogg-opus-decoder");
  try {
    statSync(marker);
  } catch {
    console.log("whisper: installing ogg-opus-decoder...");
    const pkgMgr = (() => {
      try { execSync("bun --version", { stdio: "ignore", env: safeEnv() }); return "bun"; } catch {}
      return "npm";
    })();
    execSync(`${pkgMgr} install`, { cwd: PLUGIN_ROOT, stdio: "inherit", env: safeEnv() });
  }
}

function decodeOggOpusToWavViaNode(inputPath: string, wavPath: string, log: WhisperDebugLog): void {
  ensureOggDeps();
  log(`voice decode: running node converter`);
  const result = spawnSync("node", [OGG_MJS_CONVERTER, inputPath, wavPath], {
    encoding: "utf8",
    env: safeEnv(),
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "";
    const stdout = result.stdout?.trim() || "";
    throw new Error(
      `node decode failed (exit ${result.status ?? "unknown"})${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`
    );
  }

  if (result.stderr?.trim()) log(`voice decode(node): ${result.stderr.trim()}`);
  log(`voice decode: node converter completed`);
}

function hasFfmpeg(): boolean {
  try {
    execSync("ffmpeg -version", { stdio: "ignore", env: safeEnv() });
    return true;
  } catch {
    return false;
  }
}

function decodeViaFfmpeg(inputPath: string, wavPath: string, log: WhisperDebugLog): void {
  log(`voice decode: running ffmpeg ${inputPath} → ${wavPath}`);
  // 16kHz mono PCM — what whisper.cpp / mlx-whisper expect
  const result = spawnSync(
    "ffmpeg",
    ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
    { encoding: "utf8", env: safeEnv() }
  );
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "";
    throw new Error(`ffmpeg decode failed (exit ${result.status ?? "unknown"})${stderr ? `: ${stderr}` : ""}`);
  }
  log(`voice decode: ffmpeg completed`);
}

export async function ensureWavInput(inputPath: string, log: WhisperDebugLog): Promise<string> {
  const ext = extname(inputPath).toLowerCase();
  log(`voice input: path=${inputPath} ext=${ext || "(none)"}`);
  if (ext === ".wav") return inputPath;

  await mkdir(TMP_FOLDER, { recursive: true });
  const wavPath = join(TMP_FOLDER, `${basename(inputPath, extname(inputPath))}-${Date.now()}.wav`);

  if (ext === ".ogg" || ext === ".oga") {
    decodeOggOpusToWavViaNode(inputPath, wavPath, log);
    return wavPath;
  }

  if (hasFfmpeg()) {
    decodeViaFfmpeg(inputPath, wavPath, log);
    return wavPath;
  }

  throw new Error(`unsupported audio format "${ext || "(none)"}" — install ffmpeg to handle ${ext} files, or use .wav/.ogg`);
}
