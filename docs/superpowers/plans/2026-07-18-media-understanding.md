# Media Understanding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attachments pipeline understands audio (transcript), video (audio-track transcript), image-only PDFs (vault + Read fallback), and oversize images (ffmpeg downscale) — all inside `src/attachments.ts` via injected `MediaDeps`.

**Architecture:** `classifyAndProcess` gains an optional `media?: MediaDeps` parameter with two new branches (audio, rewritten video) sharing a `transcribeToAnnotation` helper, a rewritten PDF-empty-text fallback, and a downscale step in the image branch. `index.ts` builds one `MediaDeps` from the live `VoiceService` and threads it through the two callers (moderator session, gmail readEmail chain).

**Tech Stack:** Node + TypeScript, system ffmpeg (`/usr/local/bin`, resolved as bare `"ffmpeg"` like VoiceService does), existing whisper path (`VoiceService.transcribe` — ffmpeg-converts internally, so video containers work as-is), vitest.

**Spec:** `docs/superpowers/specs/2026-07-18-media-understanding-design.md`

## Global Constraints

- No new npm dependencies; system ffmpeg + existing whisper only.
- Every media failure becomes a per-attachment annotation — nothing throws past `processAttachment`.
- Tmp/staging files deleted in `finally` (existing convention: `try { unlinkSync(p) } catch {}`).
- Caps: audio 25 MB, video 100 MB, transcript 8 000 chars, image 5 MB (downscale target ≤2000px wide JPEG).
- Untrusted filenames stay sanitized via the existing `safeName` pattern.
- Trunk-based on main; push after final task.
- Tests: `npx vitest run test/attachments.test.ts` from repo root; transcribe is ALWAYS stubbed in unit tests; ffmpeg-dependent tests skip when the binary is absent.

---

### Task 1: MediaDeps + audio branch + transcribe helper

**Files:**
- Modify: `src/attachments.ts`
- Test: `test/attachments.test.ts` (append; reuse its existing vault/mkdtemp helpers — read the file first and match its fixture style)

**Interfaces:**
- Consumes: existing `classifyAndProcess(buf, fileName, mimeType, vault, sourcePath?, log?)` and `processAttachment(source, vault, log?)`.
- Produces: `export interface MediaDeps { transcribe?: (path: string) => Promise<string>; available?: () => boolean; ffmpegBin?: string }`; `processAttachment(source, vault, log?, media?)`; `processAttachments(atts, vault, log?, media?)`; module-private `transcribeToAnnotation(...)` reused by Task 2.

- [ ] **Step 1: Write the failing tests**

Append to `test/attachments.test.ts` (a `vault()` helper making a `VaultWriter` over `mkdtempSync` exists or is trivially added in the file's style):

```ts
describe("audio attachments", () => {
  const mp3 = { kind: "buffer" as const, buf: Buffer.from("fake-mp3-bytes"), fileName: "note.mp3", mimeType: "audio/mpeg" };

  it("transcribes via injected media.transcribe and inlines the transcript", async () => {
    const transcribe = vi.fn(async () => "hello from the voice note");
    const out = await processAttachment(mp3, vault(), undefined, { transcribe, available: () => true });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(out).toContain("audio transcript follows");
    expect(out).toContain("hello from the voice note");
  });

  it("caps the transcript at 8000 chars", async () => {
    const transcribe = async () => "x".repeat(9000);
    const out = await processAttachment(mp3, vault(), undefined, { transcribe, available: () => true });
    expect(out).toContain("x".repeat(8000));
    expect(out).not.toContain("x".repeat(8001));
    expect(out).toContain("[transcript truncated]");
  });

  it("voice unavailable → honest note, transcribe not called", async () => {
    const transcribe = vi.fn(async () => "never");
    const out = await processAttachment(mp3, vault(), undefined, { transcribe, available: () => false });
    expect(transcribe).not.toHaveBeenCalled();
    expect(out).toContain("transcription unavailable");
  });

  it("no media deps at all → unavailable note (back-compat default)", async () => {
    const out = await processAttachment(mp3, vault());
    expect(out).toContain("transcription unavailable");
  });

  it("transcribe throwing → failed annotation, no throw", async () => {
    const out = await processAttachment(mp3, vault(), undefined, {
      transcribe: async () => { throw new Error("whisper exploded"); }, available: () => true,
    });
    expect(out).toContain("transcription failed: whisper exploded");
  });

  it("oversize audio → size rejection before transcribe", async () => {
    const transcribe = vi.fn(async () => "never");
    const big = { kind: "buffer" as const, buf: Buffer.alloc(26 * 1024 * 1024), fileName: "long.wav", mimeType: "audio/wav" };
    const out = await processAttachment(big, vault(), undefined, { transcribe, available: () => true });
    expect(transcribe).not.toHaveBeenCalled();
    expect(out).toContain("audio too large");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/attachments.test.ts`
Expected: FAIL — audio files currently hit the "unsupported format" branch, and `processAttachment` takes no 4th argument (tsc error inside vitest).

- [ ] **Step 3: Implement**

In `src/attachments.ts`:

Add to the imports: `import { execFile } from "node:child_process";` and `import { promisify } from "node:util";` (promisified runner is used by Task 3's downscale; harmless to add now: `const run = promisify(execFile);`).

Below the existing type definitions add:

```ts
/** Injected media capabilities — absent deps degrade to honest "unavailable" notes. */
export interface MediaDeps {
  /** VoiceService.transcribe — accepts any ffmpeg-readable path (audio AND video). */
  transcribe?: (path: string) => Promise<string>;
  /** VoiceService.available — false means whisper/ffmpeg missing or disabled. */
  available?: () => boolean;
  /** ffmpeg binary for image downscaling (bare "ffmpeg" resolves via PATH). */
  ffmpegBin?: string;
}

const AUDIO_EXTS = new Set([".mp3", ".m4a", ".wav", ".ogg", ".oga", ".flac"]);
const AUDIO_MIMES = new Set([
  "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/m4a",
  "audio/wav", "audio/x-wav", "audio/ogg", "audio/flac",
]);
const MAX_AUDIO = 25 * 1024 * 1024;   // 25 MB
const MAX_VIDEO = 100 * 1024 * 1024;  // 100 MB
const MAX_TRANSCRIPT = 8_000;         // chars inlined into the prompt
```

Add the shared helper (module-private):

```ts
/**
 * Transcribe an audio/video attachment to an inline annotation. Buffer sources
 * are staged to OS tmp for the transcriber; all staging is cleaned in finally.
 * Failures NEVER throw — they become honest annotations (pipeline convention).
 */
async function transcribeToAnnotation(
  kindLabel: "audio" | "video",
  buf: Buffer,
  safeName: string,
  sizeKb: number,
  media: MediaDeps | undefined,
  sourcePath: string | undefined,
  log?: (line: string) => void,
): Promise<string> {
  if (!media?.transcribe || media.available?.() === false) {
    if (sourcePath) { try { unlinkSync(sourcePath); } catch {} }
    return `[Attachment: ${safeName} — ${kindLabel} file (${sizeKb} KB); transcription unavailable]`;
  }
  let path = sourcePath;
  let stagedTmp: string | undefined;
  if (!path) {
    stagedTmp = join(tmpdir(), `aios-med-${randomUUID()}${extname(safeName) || ""}`);
    writeFileSync(stagedTmp, buf);
    path = stagedTmp;
  }
  try {
    const text = (await media.transcribe(path)).trim();
    if (!text) return `[Attachment: ${safeName} — ${kindLabel} (${sizeKb} KB); no speech detected]`;
    const body = text.slice(0, MAX_TRANSCRIPT);
    const suffix = text.length > MAX_TRANSCRIPT ? "\n…[transcript truncated]" : "";
    log?.(`[attachments] ${safeName} → ${kindLabel} transcript, ${body.length} chars`);
    return `[Attachment: ${safeName} — ${kindLabel} transcript follows]\n${body}${suffix}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`[attachments] ${safeName} — transcription failed: ${msg}`);
    return `[Attachment: ${safeName} — ${kindLabel} transcription failed: ${msg}]`;
  } finally {
    if (stagedTmp) { try { unlinkSync(stagedTmp); } catch {} }
    if (sourcePath) { try { unlinkSync(sourcePath); } catch {} }
  }
}
```

Thread `media` through the signatures:

- `classifyAndProcess(buf, fileName, mimeType, vault, sourcePath?, log?, media?)` — add `media?: MediaDeps` as the last parameter.
- `processAttachment(source, vault, log?, media?)` — pass `media` to both `classifyAndProcess` calls.
- `processAttachments(attachments, vault, log?, media?)` — pass through.

Insert the audio branch in `classifyAndProcess` directly BEFORE the video branch:

```ts
  // ── Audio ──────────────────────────────────────────────────────────────────
  if (AUDIO_EXTS.has(ext) || AUDIO_MIMES.has(mimeType)) {
    if (buf.length > MAX_AUDIO) {
      if (sourcePath) { try { unlinkSync(sourcePath); } catch {} }
      return `[Attachment: ${safeName} — audio too large (${Math.round(buf.length / 1024 / 1024)} MB, limit 25 MB); not transcribed]`;
    }
    return transcribeToAnnotation("audio", buf, safeName, sizeKb, media, sourcePath, log);
  }
```

Extend `guessMimeType`'s map with: `".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".flac": "audio/flac"`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/attachments.test.ts`
Expected: PASS (existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/attachments.ts test/attachments.test.ts
git commit -m "feat(attachments): audio transcription branch via injected MediaDeps"
```

---

### Task 2: Video branch → transcript

**Files:**
- Modify: `src/attachments.ts` (video branch)
- Test: `test/attachments.test.ts` (append)

**Interfaces:**
- Consumes: `transcribeToAnnotation`, `MAX_VIDEO` (Task 1).
- Produces: video attachments transcribed; "no speech detected" on empty transcript.

- [ ] **Step 1: Write the failing tests**

```ts
describe("video attachments", () => {
  const mp4 = { kind: "buffer" as const, buf: Buffer.from("fake-mp4"), fileName: "clip.mp4", mimeType: "video/mp4" };

  it("transcribes the audio track via the same transcribe fn", async () => {
    const transcribe = vi.fn(async () => "words from the video");
    const out = await processAttachment(mp4, vault(), undefined, { transcribe, available: () => true });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(out).toContain("video transcript follows");
    expect(out).toContain("words from the video");
  });

  it("empty transcript → no speech detected", async () => {
    const out = await processAttachment(mp4, vault(), undefined, { transcribe: async () => "  ", available: () => true });
    expect(out).toContain("no speech detected");
  });

  it("unavailable → honest note (previous 'not supported' text gone)", async () => {
    const out = await processAttachment(mp4, vault());
    expect(out).toContain("transcription unavailable");
    expect(out).not.toContain("not supported");
  });

  it("oversize video rejected before transcribe", async () => {
    const transcribe = vi.fn(async () => "never");
    const big = { kind: "buffer" as const, buf: Buffer.alloc(101 * 1024 * 1024), fileName: "movie.mp4", mimeType: "video/mp4" };
    const out = await processAttachment(big, vault(), undefined, { transcribe, available: () => true });
    expect(transcribe).not.toHaveBeenCalled();
    expect(out).toContain("video too large");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/attachments.test.ts`
Expected: FAIL — video branch still returns "video content extraction is not supported".

- [ ] **Step 3: Replace the video branch**

```ts
  // ── Video — transcribe the audio track (ffmpeg inside the transcriber
  //    handles the container; no keyframe extraction this cycle) ─────────────
  if (VIDEO_EXTS.has(ext) || VIDEO_MIMES.has(mimeType)) {
    if (buf.length > MAX_VIDEO) {
      if (sourcePath) { try { unlinkSync(sourcePath); } catch {} }
      return `[Attachment: ${safeName} — video too large (${Math.round(buf.length / 1024 / 1024)} MB, limit 100 MB); not transcribed]`;
    }
    return transcribeToAnnotation("video", buf, safeName, sizeKb, media, sourcePath, log);
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/attachments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/attachments.ts test/attachments.test.ts
git commit -m "feat(attachments): video attachments transcribe their audio track"
```

---

### Task 3: Image-only PDF vault fallback + oversize-image downscale

**Files:**
- Modify: `src/attachments.ts` (PDF branch empty-text path; image branch)
- Test: `test/attachments.test.ts` (append)

**Interfaces:**
- Consumes: `MediaDeps.ffmpegBin`, `run` (promisified execFile, Task 1); existing `makePdf()` fixture builder in the test file (it can build a no-text PDF — check its signature; it already produces text-less PDFs for the current "image-only" test if one exists).
- Produces: scanned PDFs stored at `attachments/pdfs/` with Read annotation; >5 MB images downscaled to ≤2000px JPEG when ffmpeg present.

- [ ] **Step 1: Write the failing tests**

```ts
import { execFileSync } from "node:child_process";
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("image-only PDF fallback", () => {
  it("stores the PDF in the vault and points Read at it", async () => {
    const v = vault();
    const noText = makePdf();           // existing fixture builder, no textContent arg
    const out = await processAttachment(
      { kind: "buffer", buf: noText, fileName: "scan.pdf", mimeType: "application/pdf" }, v,
    );
    expect(out).toContain("scanned PDF (no text layer) saved to vault at");
    expect(out).toContain("Use the Read tool");
    const stored = /saved to vault at ([^\s\]]+)/.exec(out)![1];
    expect(existsSync(stored)).toBe(true);
    expect(stored).toContain("attachments/pdfs");
  });

  it("text-bearing PDFs keep the inline extraction", async () => {
    const withText = makePdf("hello inline world");
    const out = await processAttachment(
      { kind: "buffer", buf: withText, fileName: "doc.pdf", mimeType: "application/pdf" }, vault(),
    );
    expect(out).toContain("PDF text follows");
    expect(out).toContain("hello inline world");
  });
});

describe("oversize image downscale", () => {
  it.skipIf(!hasFfmpeg)("downscales >5MB images instead of rejecting", async () => {
    // Build a real >5MB PNG: large noise image via ffmpeg itself (fixture-free).
    const big = join(tmpdir(), `aios-test-big-${randomUUID()}.png`);
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=4000x4000", "-frames:v", "1", big]);
    // Pad to force >5MB regardless of PNG compression: append random bytes is invalid PNG,
    // so instead lower compression: use bmp (uncompressed, 4000*4000*3 ≈ 48MB > 5MB).
    const bmp = join(tmpdir(), `aios-test-big-${randomUUID()}.bmp`);
    execFileSync("ffmpeg", ["-y", "-i", big, bmp]);
    const buf = readFileSync(bmp);
    expect(buf.length).toBeGreaterThan(5 * 1024 * 1024);
    const out = await processAttachment(
      { kind: "buffer", buf, fileName: "huge.bmp", mimeType: "image/bmp" }, vault(), undefined,
      { ffmpegBin: "ffmpeg" },
    );
    expect(out).toContain("image saved to vault at");
    expect(out).toContain("downscaled from");
    unlinkSync(big); unlinkSync(bmp);
  });

  it("no ffmpeg dep → oversize still rejected with the existing note", async () => {
    const big = { kind: "buffer" as const, buf: Buffer.alloc(6 * 1024 * 1024), fileName: "big.png", mimeType: "image/png" };
    const out = await processAttachment(big, vault());
    expect(out).toContain("image too large");
  });

  it("small images unchanged", async () => {
    const out = await processAttachment(
      { kind: "buffer", buf: Buffer.from("tiny"), fileName: "s.png", mimeType: "image/png" }, vault(),
    );
    expect(out).toContain("image saved to vault at");
    expect(out).not.toContain("downscaled");
  });
});
```

Note: `.bmp` must be classifiable as an image — add `".bmp"` to `IMAGE_EXTS` and `"image/bmp"` to `IMAGE_MIMES` in Step 3 (legit gap anyway). If `makePdf` in the test file requires an argument for no-text PDFs, adapt the call to however the existing "image-only PDF" test constructs one.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/attachments.test.ts`
Expected: FAIL — scanned PDF returns the dead-end note; oversize+ffmpeg returns rejection.

- [ ] **Step 3: Implement both**

Add module-private helper:

```ts
/** Downscale an image to ≤2000px-wide JPEG. Returns the tmp output path, or null on any failure. */
async function downscaleImage(ffmpegBin: string, inPath: string): Promise<string | null> {
  const out = join(tmpdir(), `aios-img-${randomUUID()}.jpg`);
  try {
    await run(ffmpegBin, ["-y", "-i", inPath, "-vf", "scale='min(2000,iw)':-2", "-q:v", "3", out]);
    return existsSync(out) ? out : null;
  } catch {
    try { unlinkSync(out); } catch {}
    return null;
  }
}
```

Rewrite the image branch (replaces the current MAX_IMAGE rejection + store logic; staging for buffer sources is unified so both downscale and store work from a path):

```ts
  // ── Image ──────────────────────────────────────────────────────────────────
  if (IMAGE_EXTS.has(ext) || IMAGE_MIMES.has(mimeType)) {
    const MAX_IMAGE = 5 * 1024 * 1024; // 5 MB
    const destName = `${randomUUID()}-${basename(safeName)}`;
    let stagePath = sourcePath;
    let stagedTmp: string | undefined;
    if (!stagePath) {
      stagedTmp = join(tmpdir(), `aios-att-${randomUUID()}`);
      writeFileSync(stagedTmp, buf);
      stagePath = stagedTmp;
    }
    try {
      if (buf.length > MAX_IMAGE) {
        const down = media?.ffmpegBin ? await downscaleImage(media.ffmpegBin, stagePath) : null;
        const mb = Math.round(buf.length / 1024 / 1024);
        if (!down) {
          log?.(`[attachments] ${safeName} skipped: ${mb} MB > 5 MB limit`);
          return `[Attachment: ${safeName} — image too large (${mb} MB, limit 5 MB); not stored]`;
        }
        try {
          const vaultPath = vault.storeFile("attachments/images", `${destName}.jpg`, down);
          log?.(`[attachments] ${safeName} → downscaled from ${mb} MB → vault at ${vaultPath}`);
          return `[Attachment: ${safeName} — image saved to vault at ${vaultPath} (downscaled from ${mb} MB). Use the Read tool to view it.]`;
        } finally {
          try { unlinkSync(down); } catch {}
        }
      }
      const vaultPath = vault.storeFile("attachments/images", destName, stagePath);
      log?.(`[attachments] ${safeName} → vault at ${vaultPath}`);
      return `[Attachment: ${safeName} — image saved to vault at ${vaultPath}. Use the Read tool to view it.]`;
    } finally {
      if (stagedTmp) { try { unlinkSync(stagedTmp); } catch {} }
      if (sourcePath) { try { unlinkSync(sourcePath); } catch {} }
    }
  }
```

Add `".bmp"` to `IMAGE_EXTS`, `"image/bmp"` to `IMAGE_MIMES`, and `".bmp": "image/bmp"` to `guessMimeType`.

In the PDF branch, replace the current `if (!body) { return "[… image-only; no extractable text]"; }` AND move the `sourcePath` unlink so the fallback can still read the file. The full new PDF branch tail (after `const { text } = await pdfParse(...)`):

```ts
      const MAX_CHARS = 12_000;
      const body = text.trim().slice(0, MAX_CHARS);
      const suffix = text.trim().length > MAX_CHARS ? "\n…[text truncated at 12 000 chars]" : "";
      if (!body) {
        // Scanned/image-only PDF: store the original for visual Read instead of dead-ending.
        const destName = `${randomUUID()}-${basename(safeName)}`;
        let vaultPath: string;
        if (sourcePath) {
          try { vaultPath = vault.storeFile("attachments/pdfs", destName, sourcePath); }
          finally { try { unlinkSync(sourcePath); } catch {} }
        } else {
          const tmpPath = join(tmpdir(), `aios-att-${randomUUID()}.pdf`);
          writeFileSync(tmpPath, buf);
          try { vaultPath = vault.storeFile("attachments/pdfs", destName, tmpPath); }
          finally { try { unlinkSync(tmpPath); } catch {} }
        }
        log?.(`[attachments] ${safeName} → scanned PDF stored at ${vaultPath}`);
        return `[Attachment: ${safeName} — scanned PDF (no text layer) saved to vault at ${vaultPath}. Use the Read tool to view it.]`;
      }
      if (sourcePath) { try { unlinkSync(sourcePath); } catch {} }
      log?.(`[attachments] ${safeName} → extracted ${body.length} chars of PDF text`);
      return `[Attachment: ${safeName} — PDF text follows]\n${body}${suffix}`;
```

(The pre-existing `unlinkSync(sourcePath)` directly after `pdfParse` is REMOVED — the two return paths above each handle it.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/attachments.test.ts`
Expected: PASS (ffmpeg test runs on this machine — binary present at /usr/local/bin).

- [ ] **Step 5: Commit**

```bash
git add src/attachments.ts test/attachments.test.ts
git commit -m "feat(attachments): scanned-PDF vault fallback + oversize-image downscale"
```

---

### Task 4: Thread MediaDeps from index.ts through both callers

**Files:**
- Modify: `src/index.ts` (after `VoiceService.create`, ~line 200-206)
- Modify: `src/moderator/session.ts` (ModeratorDeps + the `processAttachments` call ~line 96)
- Modify: `src/moderator/tools.ts` (ModeratorToolsDeps + `readEmail` call ~line 379)
- Modify: `src/senses/google/read.ts` (`readEmail` + `fetchAttachment` signatures)

**Interfaces:**
- Consumes: `MediaDeps` from `../attachments.js` (Task 1); `voice` (VoiceService) in index.ts scope.
- Produces: live wiring — both channels transcribe/downscale.

- [ ] **Step 1: Build the deps object in index.ts**

After the `VoiceService.create(...)` block:

```ts
  // Media understanding for attachments (spec 2026-07-18-media-understanding):
  // same whisper path as voice notes; bare "ffmpeg" resolves via PATH like VoiceService.
  const media = {
    transcribe: (p: string) => voice.transcribe(p),
    available: () => voice.available(),
    ffmpegBin: "ffmpeg",
  };
```

Pass `media` wherever `ModeratorDeps` and `ModeratorToolsDeps` objects are constructed in index.ts (search for the object literals that already carry `vault` — add `media,` beside them).

- [ ] **Step 2: session.ts**

Add to the `ModeratorDeps` interface: `media?: import("../attachments.js").MediaDeps;` (or a top import `import { processAttachments, type MediaDeps } from "../attachments.js";` and `media?: MediaDeps;`). Change the call:

```ts
    const attachmentBlock = attachments?.length
      ? await processAttachments(attachments, vault, this.deps.log, this.deps.media)
      : "";
```

- [ ] **Step 3: tools.ts + read.ts**

`read.ts`: `fetchAttachment(...)` and `readEmail(...)` each gain a trailing `media?: MediaDeps` parameter (import the type from `../../attachments.js`); `fetchAttachment` passes it as the 4th arg of `processAttachment`; `readEmail` forwards to `fetchAttachment`.

`tools.ts`: `ModeratorToolsDeps` gains `media?: MediaDeps;`; the `readEmail(...)` call at ~line 379 passes `deps.media` in the new trailing position.

- [ ] **Step 4: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | grep -E "Tests |Test Files"`
Expected: clean; green (wiring thin/untested per convention).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/moderator/session.ts src/moderator/tools.ts src/senses/google/read.ts
git commit -m "feat(daemon): thread MediaDeps — attachments transcribe via live VoiceService"
```

---

### Task 5: Deploy + live smoke + push

**Files:** none (verification only)

- [ ] **Step 1: Build + restart**

```bash
npm run build 2>&1 | tail -1 && launchctl kickstart -k gui/501/com.ihab.aios && sleep 6
```

- [ ] **Step 2: Pipeline smoke without Telegram (direct function drive)**

```bash
npx tsx -e "
import { processAttachment } from './src/attachments.js';
import { VaultWriter } from './src/vault/writer.js';
import { VoiceService } from './src/voice/index.js';
import { loadConfig } from './src/config.js';
import { execFileSync } from 'node:child_process';
const cfg = loadConfig();
const vault = new VaultWriter(cfg.vaultPath, cfg.vaultSubdir);
const voice = await VoiceService.create({ enabled: cfg.voiceEnabled, whisperModel: cfg.whisperModel, ttsVoice: cfg.ttsVoice, dataDir: cfg.dataDir, log: console.log });
// synthesize 2s of speech-free tone → expect 'no speech detected'; then say() a wav if macOS 'say' exists
execFileSync('ffmpeg', ['-y','-f','lavfi','-i','sine=frequency=440:duration=2','/tmp/aios-tone.mp3']);
console.log(await processAttachment({ kind: 'file', path: 'data/downloads/aios-tone.mp3', fileName: 'tone.mp3' }, vault, console.log, { transcribe: (p) => voice.transcribe(p), available: () => voice.available(), ffmpegBin: 'ffmpeg' }));
" 2>&1 | tail -5
```
Note: the file must live under `data/downloads/` (path guard) — `cp /tmp/aios-tone.mp3 data/downloads/` first, or adapt to a buffer source. Expected: `no speech detected` (tone) or a transcript if whisper hallucinates a hum — either proves the live chain (ffmpeg → whisper) end-to-end. For a real-speech check: `say -o /tmp/sp.aiff "testing the media pipeline" && ffmpeg -y -i /tmp/sp.aiff /tmp/sp.mp3 && cp /tmp/sp.mp3 data/downloads/` then re-run with `sp.mp3` — expect the phrase in the transcript.

- [ ] **Step 3: Telegram live smoke (user-assisted, optional now)**

Send an .mp3 as a DOCUMENT and a short .mp4 to the Telegram chat — hermes's reply should reflect the content. (Can be done async after push; the Step 2 drive already proves the chain.)

- [ ] **Step 4: Push**

```bash
git push origin main
```

---

## Self-Review Notes

- Spec coverage: audio (T1), video (T2), scanned-PDF fallback + downscale (T3), threading both callers (T4), live verification (T5). Caps and annotation texts match spec section "Branch behavior".
- Type consistency: `MediaDeps` fields (`transcribe`, `available`, `ffmpegBin`) identical across T1 definition, T3 usage, T4 wiring; `processAttachment(source, vault, log?, media?)` arity consistent in all tests.
- `makePdf()` fixture: T3 references the test file's existing builder — executor must check its real signature for the no-text case before writing the test (flagged inline).
- T5 Step 2 script is a smoke, not a test — path-guard note included; adapt to buffer source if simpler.
