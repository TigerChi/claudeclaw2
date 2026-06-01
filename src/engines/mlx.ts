import { spawnSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withDaemonSafeEnv } from "../agent-env";
import type { TranscribeOptions, WhisperDebugLog, WhisperEngine } from "./types";

function safeEnv(): NodeJS.ProcessEnv {
  return withDaemonSafeEnv(process.env);
}

/**
 * Wrapper script ships with the plugin (`<plugin>/whisper/wrapper.py`) so
 * users get it on install with no external skill required.
 *
 * The Python venv with mlx-whisper installed is user-global, sitting under
 * ~/.claude/claudeclaw/mlx-env/. It deliberately lives outside the plugin
 * directory so plugin upgrades don't wipe ~150MB of wheels — installed
 * once per machine, shared by every agent.
 *
 * Model weights live in the HuggingFace cache (~/.cache/huggingface/hub/),
 * also user-global. First agent to use a given model downloads it;
 * everything else pulls from cache.
 */
const VENV_DIR = join(homedir(), ".claude", "claudeclaw", "mlx-env");
const VENV_PYTHON = join(VENV_DIR, "bin", "python3");
const WRAPPER_PATH = fileURLToPath(new URL("../../whisper/wrapper.py", import.meta.url));

export const MLX_MODELS = [
  "tiny",
  "base",
  "small",
  "medium",
  "large-v3",
  "large-v3-turbo",
] as const;
export const DEFAULT_MLX_MODEL = "large-v3-turbo";

let installPromise: Promise<void> | null = null;

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function findSystemPython(): string {
  const candidates = ["python3.13", "python3.12", "python3.11", "python3.10", "python3"];
  for (const cmd of candidates) {
    const result = spawnSync("which", [cmd], { encoding: "utf8", env: safeEnv() });
    if (result.status === 0) {
      const path = result.stdout.trim();
      if (path && !path.startsWith("/usr/bin/")) {
        // /usr/bin/python3 on macOS is a stub — pip install on it fails.
        // Prefer Homebrew (/opt/homebrew/bin) or pyenv first.
        return path;
      }
    }
  }
  for (const cmd of candidates) {
    const result = spawnSync("which", [cmd], { encoding: "utf8", env: safeEnv() });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error("python3 not found — install Homebrew Python (`brew install python@3.12`) and retry");
}

async function isInstalled(): Promise<boolean> {
  if (!(await fileExists(VENV_PYTHON))) return false;
  if (!(await fileExists(WRAPPER_PATH))) return false;
  // Verify mlx-whisper actually installed in the venv (not just empty venv).
  const probe = spawnSync(VENV_PYTHON, ["-c", "import mlx_whisper"], {
    encoding: "utf8",
    env: safeEnv(),
  });
  return probe.status === 0;
}

async function performInstall(log: WhisperDebugLog): Promise<void> {
  log(`mlx install: shared venv at ${VENV_DIR}`);
  await mkdir(dirname(VENV_DIR), { recursive: true });

  if (!(await fileExists(VENV_PYTHON))) {
    const python = findSystemPython();
    log(`mlx install: creating venv with ${python}`);
    const venv = spawnSync(python, ["-m", "venv", VENV_DIR], {
      encoding: "utf8",
      env: safeEnv(),
    });
    if (venv.status !== 0) {
      throw new Error(`venv creation failed: ${venv.stderr?.trim() || "unknown error"}`);
    }
  } else {
    log(`mlx install: venv already exists, ensuring mlx-whisper is installed`);
  }

  log(`mlx install: pip install mlx-whisper (~1-2 min on first run)`);
  const pip = spawnSync(VENV_PYTHON, ["-m", "pip", "install", "--quiet", "mlx-whisper"], {
    encoding: "utf8",
    env: safeEnv(),
  });
  if (pip.status !== 0) {
    throw new Error(`pip install mlx-whisper failed: ${pip.stderr?.trim() || pip.stdout?.trim() || "unknown error"}`);
  }

  if (!(await fileExists(WRAPPER_PATH))) {
    throw new Error(`mlx wrapper script missing at ${WRAPPER_PATH} — plugin install may be corrupted`);
  }
  log(`mlx install: ready`);
}

function isAvailable(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

export const mlxEngine: WhisperEngine = {
  acceptsRawInput: false,

  async warmup(log: WhisperDebugLog) {
    if (!isAvailable()) {
      throw new Error(`mlx engine not available on ${process.platform}-${process.arch}`);
    }
    if (await isInstalled()) return;
    if (!installPromise) {
      installPromise = performInstall(log).catch((err) => {
        installPromise = null;
        throw err;
      });
    }
    return installPromise;
  },

  async transcribe(wavPath: string, opts: TranscribeOptions): Promise<string> {
    // Run wrapper through the shared venv's python explicitly — bypasses
    // shebang resolution so the wrapper script doesn't need a hardcoded path.
    const args: string[] = [VENV_PYTHON, WRAPPER_PATH];

    if (opts.model) args.push("--model", opts.model);
    if (opts.language) args.push("-l", opts.language);

    if (opts.promptFile) {
      args.push("--prompt-file", opts.promptFile);
    } else if (opts.prompt) {
      args.push("--prompt", opts.prompt);
    }

    args.push(wavPath);

    opts.log(`mlx transcribe: ${args.slice(0, -1).join(" ")} <wav>`);
    const proc = Bun.spawnSync(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: safeEnv(),
    });
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString().trim();
      throw new Error(`mlx transcription failed (exit ${proc.exitCode}): ${stderr}`);
    }
    return proc.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "[BLANK_AUDIO]")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  },
};

export const mlxEngineMeta = { isAvailable };
