// src/voice/tts.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const run = promisify(execFile);

export const MAX_TTS_CHARS = 3000;

/** Voice notes shouldn't be podcasts — the full text is always sent alongside. */
export function clipForSpeech(text: string): string {
  if (text.length <= MAX_TTS_CHARS) return text;
  return `${text.slice(0, MAX_TTS_CHARS)}… full text below.`;
}

export interface TtsDeps {
  /** Kokoro voice id, or "say" to force the macOS fallback. */
  voice: string;
  ffmpegBin: string;
  /** macOS say binary — injectable for tests. */
  sayBin?: string;
  tmpDir: string;
  log?: (line: string) => void;
}

interface KokoroLike {
  generate(text: string, opts: { voice: string }): Promise<{ save(path: string): Promise<void> }>;
}

/**
 * Kokoro (local ONNX, near-human) with macOS `say` fallback (robotic, never fails).
 * Returns the path of an OGG/opus file ready for Telegram sendVoice / browser playback.
 */
export class TtsEngine {
  private kokoro?: KokoroLike;
  private kokoroFailed = false;

  constructor(private deps: TtsDeps) {
    mkdirSync(deps.tmpDir, { recursive: true });
  }

  async synthesize(text: string): Promise<string> {
    const speech = clipForSpeech(text);
    if (this.deps.voice !== "say" && !this.kokoroFailed) {
      try {
        return await this.viaKokoro(speech);
      } catch (err) {
        this.kokoroFailed = true; // don't retry a broken model every message
        this.deps.log?.(`kokoro failed (${(err as Error).message}) — falling back to say`);
      }
    }
    return this.viaSay(speech);
  }

  private async viaKokoro(text: string): Promise<string> {
    if (!this.kokoro) {
      // Lazy dynamic import: onnxruntime + model load only when first needed.
      const { KokoroTTS } = (await import("kokoro-js")) as {
        KokoroTTS: { from_pretrained(id: string, o: { dtype: string; device: string }): Promise<KokoroLike> };
      };
      this.deps.log?.("loading kokoro tts model (one-time download ~80MB)…");
      this.kokoro = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
        dtype: "q8",
        device: "cpu",
      });
    }
    const wav = join(this.deps.tmpDir, `${randomUUID()}.wav`);
    const ogg = join(this.deps.tmpDir, `${randomUUID()}.ogg`);
    try {
      const audio = await this.kokoro.generate(text, { voice: this.deps.voice });
      await audio.save(wav);
      await run(this.deps.ffmpegBin, ["-y", "-i", wav, "-c:a", "libopus", ogg]);
      return ogg;
    } finally {
      rmSync(wav, { force: true });
    }
  }

  private async viaSay(text: string): Promise<string> {
    const aiff = join(this.deps.tmpDir, `${randomUUID()}.aiff`);
    const ogg = join(this.deps.tmpDir, `${randomUUID()}.ogg`);
    try {
      await run(this.deps.sayBin ?? "/usr/bin/say", ["-o", aiff, text]);
      await run(this.deps.ffmpegBin, ["-y", "-i", aiff, "-c:a", "libopus", ogg]);
      return ogg;
    } finally {
      rmSync(aiff, { force: true });
    }
  }
}
