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
  it("clips long text with the marker (hard cut when no sentence boundary exists)", () => {
    const long = "x".repeat(MAX_TTS_CHARS + 500);
    const clipped = clipForSpeech(long);
    expect(clipped.length).toBeLessThan(long.length);
    expect(clipped.endsWith(" Full text below.")).toBe(true);
  });
  it("clips at a sentence boundary — the voice never stops mid-sentence", () => {
    const sentence = "This is a complete sentence about a finished goal. ";
    const long = sentence.repeat(Math.ceil((MAX_TTS_CHARS + 500) / sentence.length));
    const clipped = clipForSpeech(long);
    expect(clipped.endsWith(". Full text below.")).toBe(true);
    // Everything before the marker is whole sentences — no dangling fragment.
    const spoken = clipped.replace(" Full text below.", "");
    expect(spoken.endsWith(".")).toBe(true);
    expect(spoken.length).toBeLessThanOrEqual(MAX_TTS_CHARS);
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

describe("TtsEngine kokoro path — long text is chunked, never truncated", () => {
  // Root cause of the "voice cuts mid-dictation" bug: kokoro-js generate() tokenizes with
  // truncation:true against the model's ~510-phoneme window, silently dropping everything
  // past ~30s. The engine must use the library's sentence-stream API and stitch ALL chunks.
  class RecSplitter {
    static instances: RecSplitter[] = [];
    pushed = "";
    closed = false;
    constructor() { RecSplitter.instances.push(this); }
    push(t: string) { this.pushed += t; }
    close() { this.closed = true; }
  }

  function fakeKokoro(sentencesPerCall: string[][]) {
    const inputs: RecSplitter[] = [];
    return {
      inputs,
      async *stream(input: RecSplitter) {
        inputs.push(input);
        for (const s of sentencesPerCall.shift() ?? []) {
          yield {
            text: s,
            audio: { save: async (p: string) => writeFileSync(p, `wav-of:${s}`) },
          };
        }
      },
    };
  }

  it("stitches every streamed sentence chunk into the final ogg (concat list carries all wavs)", async () => {
    const dir = tmp();
    const kokoro = fakeKokoro([["Sentence one.", "Sentence two.", "Sentence three."]]);
    const tts = new TtsEngine({ voice: "af_heart", ffmpegBin: FAKE_FFMPEG, tmpDir: dir, kokoro, splitterCtor: RecSplitter, minPlausibleBytes: 0 });
    const out = await tts.synthesize("Sentence one. Sentence two. Sentence three.");
    expect(out.endsWith(".ogg")).toBe(true);
    const { readFileSync } = await import("node:fs");
    // fake ffmpeg copies its -i input to the output: for a multi-chunk run that input is the
    // concat list — it must reference one wav per streamed sentence.
    const list = readFileSync(out, "utf8");
    expect(list.match(/\.wav/g)?.length).toBe(3);
  });

  it("single-chunk replies still produce a direct ogg conversion", async () => {
    const dir = tmp();
    const kokoro = fakeKokoro([["Just one sentence."]]);
    const tts = new TtsEngine({ voice: "af_heart", ffmpegBin: FAKE_FFMPEG, tmpDir: dir, kokoro, splitterCtor: RecSplitter, minPlausibleBytes: 0 });
    const out = await tts.synthesize("Just one sentence.");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(out, "utf8")).toBe("wav-of:Just one sentence.");
  });

  it("pushes the full text and CLOSES the splitter before streaming (terminal-hang regression)", async () => {
    // kokoro-js's string overload never closes its internal splitter: the terminal next() hangs
    // forever and the last buffered sentence is never spoken. The engine must own the splitter.
    const dir = tmp();
    const kokoro = fakeKokoro([["A."]]);
    const tts = new TtsEngine({ voice: "af_heart", ffmpegBin: FAKE_FFMPEG, tmpDir: dir, kokoro, splitterCtor: RecSplitter, minPlausibleBytes: 0 });
    await tts.synthesize("A.");
    const splitter = kokoro.inputs[0];
    expect(splitter).toBeInstanceOf(RecSplitter);
    expect(splitter.pushed).toBe("A.");
    expect(splitter.closed).toBe(true);
  });

  it("rejects implausibly small audio instead of shipping a blip (broken `say -o` gotcha)", async () => {
    const dir = tmp();
    // Fake say writes a near-empty aiff (the observed macOS failure mode); fake ffmpeg copies
    // it through. For a real sentence this must throw so the caller degrades to text-only.
    const fakeSay = join(dir, "fake-say.sh");
    writeFileSync(fakeSay, `#!/bin/sh\nprev=""\nfor a in "$@"; do\n  if [ "$prev" = "-o" ]; then printf x > "$a"; fi\n  prev="$a"\ndone\n`);
    const { chmodSync } = await import("node:fs");
    chmodSync(fakeSay, 0o755);
    const tts = new TtsEngine({ voice: "say", ffmpegBin: FAKE_FFMPEG, sayBin: fakeSay, tmpDir: dir });
    await expect(tts.synthesize("A real sentence long enough to deserve actual audio output."))
      .rejects.toThrow(/implausibly small/);
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

  it("SECURITY: agent text is passed via -f <file>, never as a positional say arg (argv injection)", async () => {
    const dir = tmp();
    // fake say records its full argv; a real `say` would parse a positional "-f/path" as
    // --input-file. The fix must place text in a temp file, so argv carries "-f <tmpfile>"
    // and the agent's text string never appears as a bare positional argument.
    const argvLog = join(dir, "argv.txt");
    const fakeSay = join(dir, "fake-say.sh");
    writeFileSync(fakeSay, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvLog}"\nprev=""\nfor a in "$@"; do\n  if [ "$prev" = "-o" ]; then echo aiff-bytes > "$a"; fi\n  prev="$a"\ndone\n`);
    const { chmodSync, readFileSync } = await import("node:fs");
    chmodSync(fakeSay, 0o755);
    const tts = new TtsEngine({ voice: "say", ffmpegBin: FAKE_FFMPEG, sayBin: fakeSay, tmpDir: dir });
    await tts.synthesize("-f/etc/passwd");
    const argv = readFileSync(argvLog, "utf8").split("\n");
    // "-f" is present as a flag followed by a TEMP FILE path, and the malicious text is NOT a
    // standalone argv entry (it lives inside the temp file, not on the command line).
    const fIdx = argv.indexOf("-f");
    expect(fIdx).toBeGreaterThan(-1);
    expect(argv[fIdx + 1]).toMatch(/\.txt$/); // temp file, not the agent text
    expect(argv).not.toContain("-f/etc/passwd"); // the injection string is never on argv
  });
});
