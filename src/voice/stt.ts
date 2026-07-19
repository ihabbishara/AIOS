// src/voice/stt.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const run = promisify(execFile);

/** Transcription can run inside a chat turn (video/audio attachment) — cap each subprocess so a
 *  hanging decode falls through to the failed-annotation path instead of stalling the chat. */
const STT_EXEC_TIMEOUT_MS = 120_000;

/** Interrupted/corrupt downloads are smaller than any real ggml model. */
const MIN_MODEL_BYTES = 50 * 1024 * 1024;

export interface EnsureModelOpts {
  /** Injectable for tests. Defaults to global fetch. */
  fetchFn?: (url: string) => Promise<Response>;
  log?: (line: string) => void;
}

/** Download the ggml model on first use; idempotent. Returns the model path. */
export async function ensureModel(
  model: string,
  modelsDir: string,
  opts: EnsureModelOpts = {},
): Promise<string> {
  const path = join(modelsDir, `ggml-${model}.bin`);
  if (existsSync(path) && statSync(path).size >= MIN_MODEL_BYTES) return path;
  mkdirSync(modelsDir, { recursive: true });
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
  opts.log?.(`downloading whisper model ${model} (one-time, ~150MB)…`);
  const res = await (opts.fetchFn ?? fetch)(url);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < MIN_MODEL_BYTES) {
    rmSync(path, { force: true });
    throw new Error(`model download too small (${bytes.length} bytes) — interrupted?`);
  }
  writeFileSync(path, bytes);
  opts.log?.(`whisper model ready: ${path}`);
  return path;
}

export interface SttDeps {
  ffmpegBin: string;
  whisperBin: string;
  modelPath: string;
  tmpDir: string;
  log?: (line: string) => void;
}

/** ffmpeg → 16kHz mono wav → whisper-cli. All invocations via execFile (no shell). */
export class SttEngine {
  constructor(private deps: SttDeps) {
    mkdirSync(deps.tmpDir, { recursive: true });
  }

  async transcribe(audioPath: string): Promise<string> {
    const wav = join(this.deps.tmpDir, `${randomUUID()}.wav`);
    try {
      await run(this.deps.ffmpegBin, ["-y", "-i", audioPath, "-ar", "16000", "-ac", "1", wav], { timeout: STT_EXEC_TIMEOUT_MS });
      const { stdout } = await run(
        this.deps.whisperBin,
        ["-m", this.deps.modelPath, "-f", wav, "--no-timestamps"],
        { maxBuffer: 10 * 1024 * 1024, timeout: STT_EXEC_TIMEOUT_MS },
      );
      return stdout.trim();
    } finally {
      rmSync(wav, { force: true });
    }
  }
}
