import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { TranscribeOptions, WhisperDebugLog, WhisperEngine } from "./types";

export interface ApiEngineConfig {
  baseUrl: string;
  /** Optional model name passed in the multipart form. */
  model: string;
}

const DEFAULT_API_MODEL = "Systran/faster-whisper-large-v3";

const MIME_MAP: Record<string, string> = {
  ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav",
  mp3: "audio/mpeg", m4a: "audio/mp4", webm: "audio/webm",
};

export function createApiEngine(config: ApiEngineConfig): WhisperEngine {
  return {
    acceptsRawInput: true,
    async warmup(_log: WhisperDebugLog) {
      // No-op — remote service handles its own assets.
    },
    async transcribe(inputPath: string, opts: TranscribeOptions): Promise<string> {
      const apiModel = config.model || DEFAULT_API_MODEL;
      const url = `${config.baseUrl}/v1/audio/transcriptions`;
      opts.log(`voice transcribe: using STT API url=${url} model=${apiModel}`);

      const audioBytes = await readFile(inputPath);
      const ext = extname(inputPath).toLowerCase().replace(".", "") || "ogg";
      const mimeType = MIME_MAP[ext] ?? "audio/ogg";

      const form = new FormData();
      form.append("file", new Blob([audioBytes], { type: mimeType }), `audio.${ext}`);
      form.append("model", apiModel);
      if (opts.prompt) form.append("prompt", opts.prompt);
      if (opts.language) form.append("language", opts.language);

      const response = await fetch(url, { method: "POST", body: form });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`STT API error (${response.status}): ${body}`);
      }

      const data = (await response.json()) as { text?: string };
      const transcript = (data.text ?? "").trim();
      opts.log(`voice transcribe: API transcript chars=${transcript.length}`);
      return transcript;
    },
  };
}
