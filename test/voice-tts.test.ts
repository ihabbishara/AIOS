// test/voice-tts.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TtsEngine, clipForSpeech, withTimeout, MAX_TTS_CHARS, cleanForSpeech } from "../src/voice/tts.js";

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

describe("withTimeout", () => {
  it("passes through a resolving promise", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "thing")).resolves.toBe("ok");
  });
  it("rejects a stalled promise after ms with the message", async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 10, "kokoro model load")).rejects.toThrow(
      "kokoro model load timed out after 10ms",
    );
  });
});

describe("cleanForSpeech", () => {
  it("strips markdown emphasis and headers", () => {
    expect(cleanForSpeech("**Good morning** and *welcome* to __the__ _brief_")).toBe("Good morning and welcome to the brief");
    expect(cleanForSpeech("## Today\nAll good")).toBe("Today All good");
  });
  it("strips emoji and emoticons", () => {
    expect(cleanForSpeech("Good morning :) 🌞")).toBe("Good morning");
    expect(cleanForSpeech("Done! 🎉🎉 ;)")).toBe("Done!");
  });
  it("converts links and code for speech", () => {
    expect(cleanForSpeech("See [the docs](https://x.com/y) and `npm test`")).toBe("See the docs and npm test");
    expect(cleanForSpeech("Visit https://example.com/long/path now")).toBe("Visit link now");
  });
  it("flattens bullets, numbered lists, and newlines", () => {
    expect(cleanForSpeech("- one\n- two\n\n1. three")).toBe("one two. three");
  });
  it("omits code blocks", () => {
    expect(cleanForSpeech("Run this:\n```bash\nnpm i\n```\ndone")).toContain("code block omitted");
  });
  it("leaves snake_case, intraword emphasis, and math intact", () => {
    expect(cleanForSpeech("set some_var_name and x*y*z then 2*3")).toBe("set some_var_name and x*y*z then 2*3");
    // A space-flanked __word__ is valid markdown strong emphasis — syntactically
    // indistinguishable from __the__ (asserted above) — so a bare dunder loses its
    // underscores for speech. Backtick-quoted dunders are out of reach here because
    // inline code is unwrapped earlier in the chain.
    expect(cleanForSpeech("call __init__ now")).toBe("call init now");
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
