import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { readFile, writeFile } from "fs/promises";
import { HUB_AUTH_FILE, ensureHubDir } from "./paths";

interface StoredToken {
  hash: string;
  createdAt: number;
}

interface AuthFile {
  primary: StoredToken | null;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

async function readAuthFile(): Promise<AuthFile> {
  try {
    const raw = await readFile(HUB_AUTH_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      primary:
        parsed?.primary && typeof parsed.primary.hash === "string"
          ? { hash: String(parsed.primary.hash), createdAt: Number(parsed.primary.createdAt) || 0 }
          : null,
    };
  } catch {
    return { primary: null };
  }
}

async function writeAuthFile(file: AuthFile): Promise<void> {
  await ensureHubDir();
  await writeFile(HUB_AUTH_FILE, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
}

export async function hasAuth(): Promise<boolean> {
  const file = await readAuthFile();
  return file.primary !== null;
}

/**
 * Generate a new token, persist its hash, and return the plaintext token
 * (only chance to capture it). Throws if auth already exists and `force` is false.
 */
export async function initAuth(force = false): Promise<string> {
  const file = await readAuthFile();
  if (file.primary && !force) {
    throw new Error("Auth already initialized. Use --rotate to replace.");
  }
  const token = generateToken();
  await writeAuthFile({
    primary: { hash: `sha256:${sha256Hex(token)}`, createdAt: Date.now() },
  });
  return token;
}

export async function rotateAuth(): Promise<string> {
  return initAuth(true);
}

function parseHash(stored: string): Buffer | null {
  if (!stored.startsWith("sha256:")) return null;
  const hex = stored.slice("sha256:".length);
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

/**
 * Validate a bearer token. Returns true if the token matches the stored hash.
 * Always performs a constant-time compare against a fake hash if no token is
 * configured, to avoid leaking auth state via timing.
 */
export async function verifyBearerToken(presented: string | null): Promise<boolean> {
  const file = await readAuthFile();
  const fakeHash = Buffer.alloc(32);
  if (!file.primary) {
    if (presented) {
      const presentedHash = Buffer.from(sha256Hex(presented), "hex");
      timingSafeEqual(presentedHash, fakeHash);
    }
    return false;
  }
  if (!presented) return false;
  const expected = parseHash(file.primary.hash);
  if (!expected || expected.length !== 32) return false;
  const presentedHash = Buffer.from(sha256Hex(presented), "hex");
  if (presentedHash.length !== expected.length) return false;
  return timingSafeEqual(presentedHash, expected);
}

export function extractBearer(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return match[1].trim() || null;
}
