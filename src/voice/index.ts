// src/voice/index.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SttEngine, ensureModel } from "./stt.js";
import { TtsEngine } from "./tts.js";

const run = promisify(execFile);

export interface VoiceServiceOpts {
  enabled: boolean;
  whisperModel: string;
  ttsVoice: string;
  dataDir: string;
  log?: (line: string) => void;
  /** Injectable binary probe for tests. Default: `which <bin>` succeeds. */
  probeFn?: (bin: string) => Promise<boolean>;
  /** Injectable model downloader for tests. Default: the real ensureModel. */
  ensureModelFn?: (model: string, dir: string, opts: { log?: (line: string) => void }) => Promise<string>;
}

async function defaultProbe(bin: string): Promise<boolean> {
  try {
    await run("which", [bin]);
    return true;
  } catch {
    return false;
  }
}

interface SttLike {
  transcribe(path: string): Promise<string>;
}

/**
 * Single voice facade: boot-time binary probe, lazy whisper-model download on
 * first transcription, serialized whisper queue (one process at a time).
 * Voice failing or missing NEVER breaks text flows — callers check available().
 */
export class VoiceService {
  private stt?: SttLike;
  private tts?: TtsEngine;
  private reason = "not initialized";
  private queue: Promise<unknown> = Promise.resolve();
  private modelReady?: Promise<string>;

  private constructor(private opts: VoiceServiceOpts, private bins?: { whisper: string; ffmpeg: string }) {}

  static async create(opts: VoiceServiceOpts): Promise<VoiceService> {
    const tmpDir = join(opts.dataDir, "voice-tmp");
    mkdirSync(tmpDir, { recursive: true });
    for (const f of readdirSync(tmpDir)) rmSync(join(tmpDir, f), { force: true }); // boot sweep

    if (!opts.enabled) {
      const v = new VoiceService(opts);
      v.reason = "disabled via AIOS_VOICE_ENABLED";
      opts.log?.(`voice disabled: ${v.reason}`);
      return v;
    }

    const probe = opts.probeFn ?? defaultProbe;
    const whisper = (await probe("whisper-cli")) ? "whisper-cli" : (await probe("whisper-cpp")) ? "whisper-cpp" : undefined;
    const ffmpeg = (await probe("ffmpeg")) ? "ffmpeg" : undefined;
    if (!whisper || !ffmpeg) {
      const v = new VoiceService(opts);
      v.reason = `missing binaries (${!whisper ? "whisper-cli " : ""}${!ffmpeg ? "ffmpeg" : ""}). brew install whisper-cpp ffmpeg`;
      opts.log?.(`voice disabled: ${v.reason}`);
      return v;
    }

    const v = new VoiceService(opts, { whisper, ffmpeg });
    v.reason = "";
    v.tts = new TtsEngine({ voice: opts.ttsVoice, ffmpegBin: ffmpeg, tmpDir, log: opts.log });
    opts.log?.("voice ready (whisper + tts)");
    return v;
  }

  available(): boolean {
    return this.reason === "";
  }

  disabledReason(): string {
    return this.reason;
  }

  /** Serialized: one whisper process at a time (parallel spawns thrash memory). */
  transcribe(audioPath: string): Promise<string> {
    const job = this.queue.then(async () => {
      if (!this.available()) throw new Error(`voice disabled: ${this.reason}`);
      const stt = await this.ensureStt();
      return stt.transcribe(audioPath);
    });
    this.queue = job.catch(() => {}); // a failed job never blocks the queue
    return job;
  }

  async synthesize(text: string): Promise<string> {
    if (!this.available() || !this.tts) throw new Error(`voice disabled: ${this.reason}`);
    return this.tts.synthesize(text);
  }

  private async ensureStt(): Promise<SttLike> {
    if (this.stt) return this.stt;
    // Lazy model download — first voice note pays the ~150MB one-time cost.
    this.modelReady ??= (this.opts.ensureModelFn ?? ensureModel)(
      this.opts.whisperModel,
      join(this.opts.dataDir, "models"),
      { log: this.opts.log },
    ).catch((err) => {
      this.modelReady = undefined; // interrupted download → retry on next transcribe (spec guarantee)
      throw err;
    });
    const modelPath = await this.modelReady;
    this.stt = new SttEngine({
      ffmpegBin: this.bins!.ffmpeg,
      whisperBin: this.bins!.whisper,
      modelPath,
      tmpDir: join(this.opts.dataDir, "voice-tmp"),
      log: this.opts.log,
    });
    return this.stt;
  }

  /** Test-only: swap the STT pipeline to verify queue behavior. */
  _setSttForTests(stt: SttLike): void {
    this.stt = stt;
  }
}
