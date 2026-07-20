// src/voice/tts.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const run = promisify(execFile);

/** Spoken cap. Local q8 kokoro runs near realtime warm — 1200 chars ≈ ~90s of audio is the
 *  honest upper bound for a voice note; the full text always accompanies it in the chat.
 *  (The old 3000 was fiction: generate() truncated at the model window ≈30s regardless.) */
export const MAX_TTS_CHARS = 1200;

const KOKORO_LOAD_TIMEOUT_MS = 120_000;
/** Per-sentence-chunk watchdog. Generous on purpose: a warm chunk takes seconds, a cold first
 *  chunk can take a minute+. This must only fire on a genuinely wedged inference — timing out a
 *  LIVE onnx run and abandoning it can abort the whole process natively (observed: libc++abi
 *  "mutex lock failed" SIGABRT), so a trigger-happy timeout is worse than a slow reply. */
const KOKORO_GENERATE_TIMEOUT_MS = 180_000;

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

/** Voice notes shouldn't be podcasts — the full text is always sent alongside.
 *  Clips at the last sentence end inside the cap so the voice never stops mid-sentence;
 *  hard-cuts only when there is no sentence boundary to use. */
export function clipForSpeech(text: string): string {
  if (text.length <= MAX_TTS_CHARS) return text;
  const window = text.slice(0, MAX_TTS_CHARS);
  const lastEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  const cut = lastEnd > MAX_TTS_CHARS / 2 ? window.slice(0, lastEnd + 1) : window;
  return `${cut} Full text below.`;
}

export interface TtsDeps {
  /** Kokoro voice id, or "say" to force the macOS fallback. */
  voice: string;
  ffmpegBin: string;
  /** macOS say binary — injectable for tests. */
  sayBin?: string;
  tmpDir: string;
  log?: (line: string) => void;
  /** Injectable kokoro engine — tests stub the stream without loading the model. */
  kokoro?: KokoroLike;
  /** Injectable splitter class (tests record push/close; real path uses kokoro's own). */
  splitterCtor?: new () => SplitterLike;
  /** Plausibility floor for output audio bytes (tests with stub binaries set 0). */
  minPlausibleBytes?: number;
}

export interface SplitterLike {
  push(text: string): void;
  close(): void;
}

interface KokoroLike {
  /** Sentence-splitting stream — the ONLY safe entry point for long text. generate() tokenizes
   *  with truncation:true against the model's ~510-phoneme window (~30s) and silently drops the
   *  rest, which is exactly the "voice cuts mid-dictation" bug.
   *  MUST be fed a splitter we pushed AND CLOSED ourselves: kokoro-js's string overload never
   *  closes its internal splitter, so the iterator hangs forever on the terminal next() and the
   *  last buffered sentence is never spoken (observed live: chunks in 7s, then a 180s timeout). */
  stream(input: SplitterLike, opts?: { voice: string }): AsyncIterable<{ audio: { save(path: string): Promise<void> } }>;
}

/**
 * Kokoro (local ONNX, near-human) with macOS `say` fallback (robotic, never fails).
 * Returns the path of an OGG/opus file ready for Telegram sendVoice / browser playback.
 */
export class TtsEngine {
  private kokoro?: KokoroLike;
  private kokoroFailed = false;
  private splitterCtor?: new () => SplitterLike;

  constructor(private deps: TtsDeps) {
    mkdirSync(deps.tmpDir, { recursive: true });
    this.kokoro = deps.kokoro;
    this.splitterCtor = deps.splitterCtor;
  }

  async synthesize(text: string): Promise<string> {
    const speech = clipForSpeech(cleanForSpeech(text));
    if (this.deps.voice !== "say" && !this.kokoroFailed) {
      try {
        return this.checkPlausible(await this.viaKokoro(speech), speech);
      } catch (err) {
        // Latch say-fallback ONLY on model-load failure (broken install stays broken). A
        // generation timeout is usually transient CPU contention — latching it would strand
        // the daemon on the fallback voice until restart.
        if (!this.kokoro) this.kokoroFailed = true;
        this.deps.log?.(`kokoro failed (${(err as Error).message}) — falling back to say`);
      }
    }
    return this.checkPlausible(await this.viaSay(speech), speech);
  }

  /** A voice note that is a fraction of a second for a real sentence is garbage (observed:
   *  a broken `say -o` writes a near-empty aiff → 12ms ogg). Better no audio — the caller
   *  degrades to text-only — than shipping a blip. */
  private checkPlausible(ogg: string, speech: string): string {
    const bytes = statSync(ogg).size;
    if (speech.length > 40 && bytes < (this.deps.minPlausibleBytes ?? 2048)) {
      rmSync(ogg, { force: true });
      throw new Error(`tts produced implausibly small audio (${bytes}B for ${speech.length} chars)`);
    }
    return ogg;
  }

  private async viaKokoro(text: string): Promise<string> {
    if (!this.kokoro) {
      // Lazy dynamic import: onnxruntime + model load only when first needed.
      const { KokoroTTS, TextSplitterStream } = (await import("kokoro-js")) as {
        KokoroTTS: { from_pretrained(id: string, o: { dtype: string; device: string }): Promise<KokoroLike> };
        TextSplitterStream: new () => SplitterLike;
      };
      this.splitterCtor ??= TextSplitterStream;
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
    if (!this.splitterCtor) throw new Error("no splitter available for kokoro stream");
    // Stream per sentence — each chunk fits the model window — then stitch. The per-chunk
    // timeout wraps each generation step so a mid-stream stall still rejects into say-fallback.
    const ogg = join(this.deps.tmpDir, `${randomUUID()}.ogg`);
    const wavs: string[] = [];
    const listFile = join(this.deps.tmpDir, `${randomUUID()}.txt`);
    const t0 = Date.now();
    try {
      this.deps.log?.(`tts: streaming ${text.length} chars`);
      // Push-then-CLOSE before iterating: close() flushes the final buffered sentence and lets
      // the stream terminate — kokoro's string overload does neither.
      const splitter = new this.splitterCtor();
      splitter.push(text);
      splitter.close();
      const it = this.kokoro.stream(splitter, { voice: this.deps.voice })[Symbol.asyncIterator]();
      for (;;) {
        const step = await withTimeout(it.next(), KOKORO_GENERATE_TIMEOUT_MS, "kokoro generation");
        if (step.done) break;
        const wav = join(this.deps.tmpDir, `${randomUUID()}.wav`);
        await step.value.audio.save(wav);
        wavs.push(wav);
        this.deps.log?.(`tts: chunk ${wavs.length} at ${Date.now() - t0}ms`);
      }
      if (wavs.length === 0) throw new Error("kokoro produced no audio");
      if (wavs.length === 1) {
        await run(this.deps.ffmpegBin, ["-y", "-i", wavs[0], "-c:a", "libopus", ogg]);
      } else {
        // ffmpeg concat demuxer: all chunks are same-format model output (24kHz mono wav).
        writeFileSync(listFile, wavs.map((w) => `file '${w}'\n`).join(""));
        await run(this.deps.ffmpegBin, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c:a", "libopus", ogg]);
      }
      return ogg;
    } finally {
      for (const w of wavs) rmSync(w, { force: true });
      rmSync(listFile, { force: true });
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
