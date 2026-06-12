// test/voice-stt.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SttEngine, ensureModel } from "../src/voice/stt.js";

const FIX = resolve("test/fixtures");
const FAKE_FFMPEG = join(FIX, "fake-ffmpeg.sh");
const FAKE_WHISPER = join(FIX, "fake-whisper.sh");
const FAKE_FAIL = join(FIX, "fake-fail.sh");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "aios-stt-"));
}

describe("SttEngine (stubbed binaries)", () => {
  it("converts then transcribes, returning trimmed stdout", async () => {
    const dir = tmp();
    const audio = join(dir, "in.ogg");
    writeFileSync(audio, "fake-ogg-bytes");
    const stt = new SttEngine({
      ffmpegBin: FAKE_FFMPEG, whisperBin: FAKE_WHISPER,
      modelPath: join(dir, "model.bin"), tmpDir: dir,
    });
    const text = await stt.transcribe(audio);
    expect(text).toBe("hello world this is a test");
  });

  it("cleans the temp wav even on success", async () => {
    const dir = tmp();
    const audio = join(dir, "in.ogg");
    writeFileSync(audio, "x");
    const stt = new SttEngine({
      ffmpegBin: FAKE_FFMPEG, whisperBin: FAKE_WHISPER,
      modelPath: join(dir, "m.bin"), tmpDir: dir,
    });
    await stt.transcribe(audio);
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".wav"));
    expect(leftovers).toHaveLength(0);
  });

  it("throws on ffmpeg failure and cleans up", async () => {
    const dir = tmp();
    const audio = join(dir, "in.ogg");
    writeFileSync(audio, "x");
    const stt = new SttEngine({
      ffmpegBin: FAKE_FAIL, whisperBin: FAKE_WHISPER,
      modelPath: join(dir, "m.bin"), tmpDir: dir,
    });
    await expect(stt.transcribe(audio)).rejects.toThrow();
    expect(readdirSync(dir).filter((f) => f.endsWith(".wav"))).toHaveLength(0);
  });

  it("throws on whisper failure", async () => {
    const dir = tmp();
    const audio = join(dir, "in.ogg");
    writeFileSync(audio, "x");
    const stt = new SttEngine({
      ffmpegBin: FAKE_FFMPEG, whisperBin: FAKE_FAIL,
      modelPath: join(dir, "m.bin"), tmpDir: dir,
    });
    await expect(stt.transcribe(audio)).rejects.toThrow();
  });
});

describe("ensureModel", () => {
  it("returns existing model path without fetching", async () => {
    const dir = tmp();
    const path = join(dir, "ggml-base.bin");
    writeFileSync(path, Buffer.alloc(60 * 1024 * 1024)); // 60MB > sanity floor
    let fetched = 0;
    const result = await ensureModel("base", dir, {
      fetchFn: async () => { fetched++; throw new Error("must not fetch"); },
    });
    expect(result).toBe(path);
    expect(fetched).toBe(0);
  });

  it("downloads when missing, writes file, sanity-checks size", async () => {
    const dir = tmp();
    const big = Buffer.alloc(60 * 1024 * 1024);
    const result = await ensureModel("base", dir, {
      fetchFn: async () => new Response(big),
    });
    expect(existsSync(result)).toBe(true);
  });

  it("rejects and removes too-small downloads (interrupted)", async () => {
    const dir = tmp();
    await expect(
      ensureModel("base", dir, { fetchFn: async () => new Response(Buffer.from("tiny")) }),
    ).rejects.toThrow("too small");
    expect(existsSync(join(dir, "ggml-base.bin"))).toBe(false);
  });
});

// Real end-to-end transcription — only when the actual binaries exist on this machine.
const HAS_REAL =
  process.env.AIOS_TEST_REAL_VOICE === "1";
describe.skipIf(!HAS_REAL)("SttEngine (real whisper, opt-in)", () => {
  it("transcribes the fixture as hello world", async () => {
    const dir = tmp();
    const model = await ensureModel("base", join(process.cwd(), "data", "models"), {});
    const stt = new SttEngine({
      ffmpegBin: "ffmpeg", whisperBin: "whisper-cli", modelPath: model, tmpDir: dir,
    });
    const text = await stt.transcribe(join(FIX, "hello.wav"));
    expect(text.toLowerCase()).toContain("hello");
  }, 120_000);
});
