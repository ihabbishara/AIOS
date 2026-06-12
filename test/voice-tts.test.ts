// test/voice-tts.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TtsEngine, clipForSpeech, MAX_TTS_CHARS } from "../src/voice/tts.js";

const FIX = resolve("test/fixtures");
const FAKE_FFMPEG = join(FIX, "fake-ffmpeg.sh");
const FAKE_FAIL = join(FIX, "fake-fail.sh");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "aios-tts-"));
}

describe("clipForSpeech", () => {
  it("passes short text through", () => {
    expect(clipForSpeech("hello")).toBe("hello");
  });
  it("clips long text with the marker", () => {
    const long = "x".repeat(MAX_TTS_CHARS + 500);
    const clipped = clipForSpeech(long);
    expect(clipped.length).toBeLessThan(long.length);
    expect(clipped.endsWith("… full text below.")).toBe(true);
  });
});

describe("TtsEngine say-fallback path (stub ffmpeg, fake say)", () => {
  it("synthesizes via sayBin and converts to ogg", async () => {
    const dir = tmp();
    // fake say: writes a file at the -o argument
    const fakeSay = join(dir, "fake-say.sh");
    writeFileSync(fakeSay, `#!/bin/sh\nprev=""\nfor a in "$@"; do\n  if [ "$prev" = "-o" ]; then echo aiff-bytes > "$a"; fi\n  prev="$a"\ndone\n`);
    const { chmodSync } = await import("node:fs");
    chmodSync(fakeSay, 0o755);

    const tts = new TtsEngine({
      voice: "say", ffmpegBin: FAKE_FFMPEG, sayBin: fakeSay, tmpDir: dir,
    });
    const out = await tts.synthesize("hello there");
    expect(out.endsWith(".ogg")).toBe(true);
    expect(existsSync(out)).toBe(true);
  });

  it("throws when both engines fail", async () => {
    const dir = tmp();
    const tts = new TtsEngine({
      voice: "say", ffmpegBin: FAKE_FFMPEG, sayBin: FAKE_FAIL, tmpDir: dir,
    });
    await expect(tts.synthesize("hello")).rejects.toThrow();
  });
});
