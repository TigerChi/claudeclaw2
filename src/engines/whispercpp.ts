import { chmod, mkdir, rename, rm, stat, access, readdir, open } from "node:fs/promises";
import { join } from "node:path";
import { withDaemonSafeEnv } from "../agent-env";
import type { TranscribeOptions, WhisperDebugLog, WhisperEngine } from "./types";

function safeEnv(): NodeJS.ProcessEnv {
  return withDaemonSafeEnv(process.env);
}

const WHISPER_MODEL = "base.en";
const WHISPER_ROOT = join(process.cwd(), ".claude", "claudeclaw", "whisper");
const BIN_DIR = join(WHISPER_ROOT, "bin");
const LIB_DIR = join(WHISPER_ROOT, "lib");
const MODEL_FOLDER = join(WHISPER_ROOT, "models");
const TMP_FOLDER = join(WHISPER_ROOT, "tmp");

const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin`;

interface BinarySource {
  url: string;
  format: "tar.gz" | "zip";
  headers?: Record<string, string>;
}

const BINARY_SOURCES: Record<string, BinarySource> = {
  "linux-x64": {
    url: "https://github.com/dscripka/whisper.cpp_binaries/releases/download/commit_3d42463/whisper-bin-linux-x64.tar.gz",
    format: "tar.gz",
  },
  "darwin-arm64": {
    url: "https://ghcr.io/v2/homebrew/core/whisper-cpp/blobs/sha256:f0901568c7babbd3022a043887007400e4b57a22d3a90b9c0824d01fa3a77270",
    format: "tar.gz",
    headers: { Authorization: "Bearer QQ==" },
  },
  "darwin-x64": {
    url: "https://ghcr.io/v2/homebrew/core/whisper-cpp/blobs/sha256:e6c2f78cbc5d6b311dfe24d8c5d4ffc68a634465c5e35ed11746068583d273c4",
    format: "tar.gz",
    headers: { Authorization: "Bearer QQ==" },
  },
  "linux-arm64": {
    url: "https://ghcr.io/v2/homebrew/core/whisper-cpp/blobs/sha256:684199fd6bec28cddfa086c584a49d236386c109f901a443b577b857fd052f83",
    format: "tar.gz",
    headers: { Authorization: "Bearer QQ==" },
  },
  "win32-x64": {
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip",
    format: "zip",
  },
};

let warmupPromise: Promise<void> | null = null;

function getBinaryPath(): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return join(BIN_DIR, `whisper-cli${suffix}`);
}

function getModelPath(): string {
  return join(MODEL_FOLDER, `ggml-${WHISPER_MODEL}.bin`);
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function findExecutable(dir: string, names: string[]): Promise<string | null> {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const targets = names.flatMap((n) => (suffix ? [n + suffix, n] : [n]));

  async function search(current: string): Promise<string | null> {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isFile() && targets.includes(entry.name)) return fullPath;
      if (entry.isDirectory()) {
        const found = await search(fullPath);
        if (found) return found;
      }
    }
    return null;
  }
  return search(dir);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function downloadFile(url: string, destPath: string, headers?: Record<string, string>): Promise<void> {
  const tmpPath = destPath + ".tmp";
  let existingBytes = 0;
  try { existingBytes = (await stat(tmpPath)).size; } catch {}

  const reqHeaders: Record<string, string> = { ...headers };
  if (existingBytes > 0) {
    reqHeaders["Range"] = `bytes=${existingBytes}-`;
    console.log(`whisper: resuming download from ${formatBytes(existingBytes)}`);
  }

  const response = await fetch(url, { redirect: "follow", headers: reqHeaders });
  const isResume = response.status === 206 && existingBytes > 0;
  if (!isResume && !response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  if (existingBytes > 0 && response.status === 200) {
    existingBytes = 0;
    await rm(tmpPath, { force: true });
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  const totalSize = isResume ? existingBytes + contentLength : contentLength;
  const body = response.body;
  if (!body) throw new Error("No response body");

  const fh = await open(tmpPath, isResume ? "a" : "w");
  let received = isResume ? existingBytes : 0;
  let lastLog = Date.now();
  try {
    for await (const chunk of body) {
      await fh.write(new Uint8Array(chunk));
      received += chunk.byteLength;
      if (totalSize > 0 && Date.now() - lastLog > 2000) {
        const pct = Math.round((received / totalSize) * 100);
        console.log(`whisper: downloading ${formatBytes(received)} / ${formatBytes(totalSize)} (${pct}%)`);
        lastLog = Date.now();
      }
    }
  } finally {
    await fh.close();
  }
  await rename(tmpPath, destPath);
}

async function downloadAndExtractBinary(): Promise<void> {
  const platformKey = `${process.platform}-${process.arch}`;
  const source = BINARY_SOURCES[platformKey];
  if (!source) {
    throw new Error(
      `No pre-built whisper binary for ${platformKey}. Supported: ${Object.keys(BINARY_SOURCES).join(", ")}`
    );
  }

  const extractDir = join(TMP_FOLDER, "extract");
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await mkdir(BIN_DIR, { recursive: true });
  await mkdir(LIB_DIR, { recursive: true });

  const archiveExt = source.format === "tar.gz" ? "tar.gz" : "zip";
  const archivePath = join(TMP_FOLDER, `whisper-bin.${archiveExt}`);

  console.log(`whisper: downloading binary for ${platformKey}...`);
  await downloadFile(source.url, archivePath, source.headers);

  console.log("whisper: extracting...");
  if (source.format === "tar.gz") {
    const proc = Bun.spawnSync(["tar", "xzf", archivePath, "-C", extractDir]);
    if (proc.exitCode !== 0) throw new Error(`Failed to extract tar.gz: ${proc.stderr.toString()}`);
  } else {
    const proc = Bun.spawnSync(["unzip", "-o", archivePath, "-d", extractDir]);
    if (proc.exitCode !== 0) throw new Error(`Failed to extract zip: ${proc.stderr.toString()}`);
  }

  const found = await findExecutable(extractDir, ["whisper-cli", "main"]);
  if (!found) throw new Error("Could not find whisper-cli or main binary in downloaded archive");

  const destBinary = getBinaryPath();
  await Bun.write(destBinary, Bun.file(found));
  await chmod(destBinary, 0o755);

  const entries = await readdir(extractDir, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.includes("whisper") && (name.endsWith(".so") || name.endsWith(".dylib") || name.match(/\.so\.\d/))) {
      const parentPath = entry.parentPath ?? "";
      const srcPath = join(parentPath, name);
      const destPath = join(LIB_DIR, name);
      await Bun.write(destPath, Bun.file(srcPath));
    }
  }

  await rm(extractDir, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  console.log("whisper: binary ready");
}

async function downloadModel(): Promise<void> {
  const modelPath = getModelPath();
  if (await fileExists(modelPath)) return;
  await mkdir(MODEL_FOLDER, { recursive: true });
  console.log(`whisper: downloading model ${WHISPER_MODEL}...`);
  await downloadFile(MODEL_URL, modelPath);
  console.log("whisper: model ready");
}

async function prepareAssets(): Promise<void> {
  const startedAt = Date.now();
  console.log(`whisper warmup: start root=${WHISPER_ROOT} model=${WHISPER_MODEL}`);
  await mkdir(WHISPER_ROOT, { recursive: true });
  await mkdir(TMP_FOLDER, { recursive: true });

  const binaryPath = getBinaryPath();
  if (!(await fileExists(binaryPath))) {
    await downloadAndExtractBinary();
  } else {
    console.log("whisper warmup: binary exists");
  }
  await downloadModel();
  console.log(`whisper warmup: complete in ${Date.now() - startedAt}ms`);
}

export const whispercppEngine: WhisperEngine = {
  acceptsRawInput: false,

  async warmup(_log: WhisperDebugLog) {
    if (!warmupPromise) {
      warmupPromise = prepareAssets().catch((err) => {
        console.error(`whisper warmup: failed - ${err instanceof Error ? err.message : String(err)}`);
        warmupPromise = null;
        throw err;
      });
    }
    return warmupPromise;
  },

  async transcribe(wavPath: string, opts: TranscribeOptions): Promise<string> {
    const binaryPath = getBinaryPath();
    const modelPath = getModelPath();

    const args = [binaryPath, "-m", modelPath, "-f", wavPath, "--no-timestamps"];
    if (opts.prompt) args.push("--prompt", opts.prompt);
    if (opts.language) args.push("-l", opts.language);

    const runOnce = () => {
      const proc = Bun.spawnSync(args, {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...safeEnv(),
          LD_LIBRARY_PATH: [LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
          DYLD_LIBRARY_PATH: [LIB_DIR, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":"),
        },
      });
      if (proc.exitCode !== 0) {
        const stderr = proc.stderr.toString().trim();
        throw new Error(`whisper transcription failed (exit ${proc.exitCode}): ${stderr}`);
      }
      return proc.stdout.toString();
    };

    let rawOutput: string;
    try {
      rawOutput = runOnce();
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("ENOENT")) throw err;
      opts.log("voice transcribe: missing whisper executable, forcing re-download and retry");
      warmupPromise = null;
      await rm(BIN_DIR, { recursive: true, force: true });
      await this.warmup(opts.log);
      rawOutput = runOnce();
    }

    return rawOutput
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "[BLANK_AUDIO]")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  },
};

/** Backward-compat: explicit warmup of whisper.cpp assets (used by warmup script). */
export function warmupWhispercppAssets(): Promise<void> {
  return whispercppEngine.warmup(() => {});
}
