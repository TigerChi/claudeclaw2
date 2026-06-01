import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const GLOBAL_VOCAB_PATH = join(homedir(), ".claude", "whisper", "vocab.txt");
const agentWhisperDir = () => join(process.cwd(), "_claude", "whisper");
const AGENT_VOCAB_PATH = () => join(agentWhisperDir(), "vocab.txt");
/** Where the final merged prompt (the string actually fed to Whisper) is written
 *  on every transcription. Persistent — overwritten each call. Useful for
 *  debugging "why did Whisper hear X instead of Y" by inspecting the prompt. */
const MERGED_PROMPT_PATH = () => join(agentWhisperDir(), "merged-prompt.txt");

const COMMENT_RE = /^\s*#/;
/** Split each line on commas / Chinese commas / whitespace runs. */
const SPLIT_RE = /[,，\s]+/;

/** Whisper initial_prompt soft cap — empirical safe size for biasing. */
const PROMPT_CHAR_LIMIT = 240;

export interface VocabBundle {
  /** De-duplicated word list (in order of first appearance, global before agent). */
  words: string[];
  /** Phrase joined for Whisper initial_prompt (truncated). Empty if no words. */
  asPrompt: string;
  /** Path to the persistent merged-prompt.txt — written iff words.length > 0.
   *  Empty string when no vocab is configured. */
  asPromptFile: string;
  /** Hint string for the main-conversation Claude. Empty if no words. */
  asHint: string;
}

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

function parseVocabFile(content: string): string[] {
  const out: string[] = [];
  for (const rawLine of content.split("\n")) {
    if (COMMENT_RE.test(rawLine)) continue;
    const line = rawLine.trim();
    if (!line) continue;
    for (const tok of line.split(SPLIT_RE)) {
      const word = tok.trim();
      if (word) out.push(word);
    }
  }
  return out;
}

function dedupe(words: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function buildPrompt(words: string[]): string {
  if (!words.length) return "";
  let acc = "以下內容可能包含以下常用詞彙：";
  for (let i = 0; i < words.length; i++) {
    const sep = i === 0 ? "" : "、";
    const next = `${sep}${words[i]}`;
    if ((acc + next).length > PROMPT_CHAR_LIMIT) break;
    acc += next;
  }
  acc += "。";
  return acc;
}

function buildHint(words: string[]): string {
  if (!words.length) return "";
  return `agent 常用詞參考（轉錄結果若有怪字，請優先用同音相符的下列詞替換）：${words.join("、")}`;
}

export async function loadVocab(): Promise<VocabBundle> {
  const [globalRaw, agentRaw] = await Promise.all([
    readIfExists(GLOBAL_VOCAB_PATH),
    readIfExists(AGENT_VOCAB_PATH()),
  ]);

  const merged = dedupe([...parseVocabFile(globalRaw), ...parseVocabFile(agentRaw)]);
  const asPrompt = buildPrompt(merged);

  let asPromptFile = "";
  if (asPrompt) {
    const path = MERGED_PROMPT_PATH();
    await mkdir(agentWhisperDir(), { recursive: true });
    await writeFile(path, asPrompt + "\n", "utf8");
    asPromptFile = path;
  }

  return {
    words: merged,
    asPrompt,
    asPromptFile,
    asHint: buildHint(merged),
  };
}
