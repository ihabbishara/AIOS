# Media Understanding — Design Spec

Date: 2026-07-18
Cycle: ⑤b in the platform-evolution series (media/research modalities, part 1 of 3:
understand → research depth → generate).

## Current state (audited)

`src/attachments.ts` (`classifyAndProcess`) handles: images → vault + Read-tool
annotation (SDK vision works); PDFs → pdf-parse text inline (12 000-char cap);
video → "not supported" note; everything else → "unsupported format". Telegram voice
NOTES are already transcribed upstream (`src/voice/stt.ts` `SttEngine`: ffmpeg → 16 kHz
mono wav → whisper-cli; `VoiceService.transcribe(path)`, `available()` guard) — but audio
FILES sent as documents/attachments never reach that path. `ffmpeg`/`ffprobe` exist at
/usr/local/bin. Key fact: `SttEngine.transcribe` runs ffmpeg itself, so it accepts any
container ffmpeg reads — including video (audio track auto-extracted).

## Scope (locked — all four gaps)

1. **Audio files** (.mp3/.m4a/.wav/.ogg/.oga/.flac as Telegram documents or Gmail
   attachments) → transcribed inline.
2. **Video** → transcript of the audio track (no keyframe extraction this cycle).
3. **Image-only PDFs** (no text layer) → stored in vault, Read-tool annotation
   (SDK reads PDF pages visually). Text-bearing PDFs unchanged.
4. **Oversize images** (>5 MB) → ffmpeg downscale then normal vault flow, instead of
   rejection.

Non-goals: eager image captioning (Read-on-demand suffices), keyframes, OCR beyond the
vault-store fallback, new npm dependencies (system ffmpeg + existing whisper only).

## Architecture

Everything lands in `src/attachments.ts` — it is the single seam both channels already
converge on. New optional dependency parameter threaded from the callers:

```ts
export interface MediaDeps {
  /** VoiceService.transcribe — accepts any ffmpeg-readable path (audio AND video). */
  transcribe?: (path: string) => Promise<string>;
  /** VoiceService.available — false → honest "transcription unavailable" notes. */
  available?: () => boolean;
  /** Absolute ffmpeg path (same binary the voice config uses). */
  ffmpegBin?: string;
}
```

`processAttachment(source, vault, log?, media?)` / `processAttachments(atts, vault,
log?, media?)`. `src/index.ts` builds the object once from the live `VoiceService` +
voice config's ffmpeg path and passes it at the Telegram and Gmail call sites. Absent
deps (tests, callers that don't care) degrade to today's behavior.

### Branch behavior

**Audio** — new `AUDIO_EXTS`/`AUDIO_MIMES` classification. Cap 25 MB. Buffer sources
write to OS tmp first (existing pattern). `media.available?.()` false or `transcribe`
absent → `[Attachment: x — audio file (N KB); transcription unavailable]`. Otherwise
`[Attachment: x — audio transcript follows]\n<text>` with transcript capped at 8 000
chars (`…[transcript truncated]` suffix). Nothing stored in the vault. Tmp/staging files
deleted in `finally`.

**Video** — cap 100 MB. Same `transcribe(path)` call (ffmpeg pulls the audio track).
Empty/whitespace transcript → `[Attachment: x — video (N KB); no speech detected]`.
Unavailable → `[… video file (N KB); transcription unavailable]`.

**Image-only PDF fallback** — in the existing PDF branch, when extracted text is empty
(today's dead-end), store the original PDF via
`vault.storeFile("attachments/pdfs", `${randomUUID()}-${safeName}`, path)` and return
`[Attachment: x — scanned PDF (no text layer) saved to vault at <path>. Use the Read
tool to view it.]`. Text-bearing PDFs keep the current inline extraction verbatim.

**Oversize image** — when >5 MB and `media.ffmpegBin` present: downscale to a tmp file
(`ffmpeg -y -i in -vf "scale='min(2000,iw)':-2" -q:v 3 out.jpg`), then continue the
normal vault-store flow with the downscaled file; annotation gains
`(downscaled from N MB)`. ffmpeg absent or command fails → today's rejection note.
≤5 MB images completely unchanged.

### Error handling

Every branch try/catches to an honest annotation (`— transcription failed: <msg>`,
`— downscale failed; image too large`), cleans staging/tmp files in `finally`, and never
throws past `processAttachment` — the message flow must survive any media failure
(existing convention, kept).

## Testing

`test/attachments.test.ts` (extend if present, else create) — transcribe is stubbed,
VaultWriter is real against mkdtemp:

- audio file → stub called, transcript annotation, 8 000-char cap applied
- audio with `available: () => false` → unavailable note, stub NOT called
- buffer-source audio → tmp file created for the stub, cleaned after
- video → stub called with the original path; empty transcript → "no speech detected"
- transcribe throws → "transcription failed" annotation, no throw out
- text PDF → unchanged inline extraction; empty-text PDF → vault path annotation,
  file exists in vault
- oversize image + real ffmpeg → downscaled, stored, "(downscaled from N MB)" note
  (test skips when ffmpeg is absent from the machine); ≤5 MB image → byte-identical
  current behavior
- caps: >25 MB audio, >100 MB video → size-rejection notes (constructed sparse buffers)

## Verification (post-deploy)

1. Suites + tsc clean, daemon rebuilt + kickstarted.
2. Live: send an .mp3 (or voice note forwarded as file) as a Telegram DOCUMENT →
   hermes reply reflects transcript content; send a short .mp4 → same.
3. Scanned/image-only PDF → agent Reads it from the vault path when asked about it.
4. Regression: normal photo + text PDF annotations unchanged.
