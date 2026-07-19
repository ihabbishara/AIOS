// src/voice/tts.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const run = promisify(execFile);

export const MAX_TTS_CHARS = 3000;

const KOKORO_LOAD_TIMEOUT_MS = 120_000;
const KOKORO_GENERATE_TIMEOUT_MS = 60_000;

/** A network stall must reject (→ say fallback), never hang the reply path. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

/** Markdown/emoji → speech-friendly text. The written text keeps its formatting; only the spoken track is cleaned. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block omitted. ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(^|[\s([{])(\*\*|__)(.+?)\2(?=[\s)\]},!?.]|$)/gm, "$1$3")
    .replace(/(^|[\s([{])(\*|_)(.+?)\2(?=[\s)\]},!?.]|$)/gm, "$1$3")
    .replace(/^[ \t]*[-*•]\s+/gm, "")
    .replace(/^[ \t]*\d+\.\s+/gm, "")
    .replace(/[:;]-?[)(DPp](?=\s|$)/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .trim();
}

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
    const speech = clipForSpeech(cleanForSpeech(text));
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
      this.kokoro = await withTimeout(
        KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
          dtype: "q8",
          device: "cpu",
        }),
        KOKORO_LOAD_TIMEOUT_MS,
        "kokoro model load",
      );
    }
    const wav = join(this.deps.tmpDir, `${randomUUID()}.wav`);
    const ogg = join(this.deps.tmpDir, `${randomUUID()}.ogg`);
    try {
      const audio = await withTimeout(
        this.kokoro.generate(text, { voice: this.deps.voice }),
        KOKORO_GENERATE_TIMEOUT_MS,
        "kokoro generation",
      );
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
    // Feed text via -f <file>, NEVER as a positional argv string: `say` parses options anywhere
    // in argv and reads the glued short form `-f<path>` as --input-file, so agent text like
    // "-f/etc/secret" would make say voice an arbitrary local file (argv injection → file-read
    // exfil for a file-confined media-gen agent). A temp file keeps agent text out of argv.
    const txt = join(this.deps.tmpDir, `${randomUUID()}.txt`);
    writeFileSync(txt, text);
    try {
      await run(this.deps.sayBin ?? "/usr/bin/say", ["-o", aiff, "-f", txt]);
      await run(this.deps.ffmpegBin, ["-y", "-i", aiff, "-c:a", "libopus", ogg]);
      return ogg;
    } finally {
      rmSync(aiff, { force: true });
      rmSync(txt, { force: true });
    }
  }
}
