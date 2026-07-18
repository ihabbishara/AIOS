/**
 * Shared attachment processing utility.
 *
 * Converts incoming files (from disk or in-memory) into Claude-readable
 * prompt annotations:
 *   - Images  → stored in vault; Claude uses the Read tool to view them.
 *   - PDFs    → text extracted inline (pdf-parse, truncated at 12 000 chars).
 *   - Videos /
 *     Others  → filename + size + "unsupported" note.
 *
 * Both the Telegram path (disk files in data/downloads/) and the Gmail path
 * (in-memory Buffers from the attachments API) converge here via
 * AttachmentSource.
 */
import { readFileSync, writeFileSync, unlinkSync, statSync, existsSync } from "node:fs";
import { extname, basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VaultWriter } from "./vault/writer.js";

const run = promisify(execFile);

// pdf-parse is CommonJS; use createRequire for safe interop in ESM context.
// pdf-parse v1 passes the input directly to pdfjs's getDocument(). On Node v22+,
// pdfjs requires a Uint8Array — passing a Buffer (which extends Uint8Array but has
// a different internal representation in newer V8) triggers "bad XRef entry".
// Wrapping with new Uint8Array(...) before every call resolves this.
const _require = createRequire(import.meta.url);
type PdfParseResult = { text: string; numpages: number; numrender: number };
type PdfParseFn = (buf: Uint8Array) => Promise<PdfParseResult>;
const pdfParse: PdfParseFn = _require("pdf-parse");

/** Known-safe root for disk attachments — paths outside are rejected (m8). */
const DOWNLOADS_ROOT = resolve("data/downloads");

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * A discriminated union covering both file-on-disk (Telegram) and
 * in-memory Buffer (Gmail) sources.
 */
export type AttachmentSource =
  | { kind: "file"; path: string; fileName: string }
  | { kind: "buffer"; buf: Buffer; fileName: string; mimeType: string };

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

// ── MIME classification helpers ──────────────────────────────────────────────

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);
const VIDEO_MIMES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/avi",
  "video/x-msvideo",
  "video/webm",
  "video/x-matroska",
]);

function guessMimeType(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".flac": "audio/flac",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
  };
  return map[ext] ?? "application/octet-stream";
}

// ── Core processing ─────────────────────────────────────────────────────────

async function classifyAndProcess(
  buf: Buffer,
  fileName: string,
  mimeType: string,
  vault: VaultWriter,
  sourcePath?: string,
  log?: (line: string) => void,
  media?: MediaDeps,
): Promise<string> {
  const ext = extname(fileName).toLowerCase();
  const sizeKb = Math.round(buf.length / 1024);

  // m7: strip chars that could manipulate prompt structure when injected into
  // annotation strings.  `fileName` comes from Telegram/Gmail and is untrusted.
  const safeName = fileName.replace(/[\r\n\[\]]/g, "_");

  // ── Image ──────────────────────────────────────────────────────────────────
  if (IMAGE_EXTS.has(ext) || IMAGE_MIMES.has(mimeType)) {
    const MAX_IMAGE = 5 * 1024 * 1024; // 5 MB
    if (buf.length > MAX_IMAGE) {
      // m3: inline cleanup — no misleading cleanup() closure.
      if (sourcePath) { try { unlinkSync(sourcePath); } catch {} }
      const mb = Math.round(buf.length / 1024 / 1024);
      log?.(`[attachments] ${safeName} skipped: ${mb} MB > 5 MB limit`);
      return `[Attachment: ${safeName} — image too large (${mb} MB, limit 5 MB); not stored]`;
    }

    // M1: randomUUID() prevents filename collision under concurrent processing.
    // m7: use safeName so a crafted filename with \n/[] can't inject into the vault path.
    const destName = `${randomUUID()}-${basename(safeName)}`;

    // Initialize to "" so TypeScript's CFA knows vaultPath is always assigned
    // before the return statement. If vault.storeFile throws, the finally block
    // runs and re-throws — the empty string is never returned because the return
    // on the last line of this branch is never reached.
    let vaultPath = "";

    if (sourcePath) {
      // Disk file (Telegram): copy into vault, always remove staging file.
      // M2: try/finally guarantees deletion even when vault.storeFile throws.
      try {
        vaultPath = vault.storeFile("attachments/images", destName, sourcePath);
      } finally {
        try { unlinkSync(sourcePath); } catch {}
      }
    } else {
      // In-memory buffer (Gmail): write to OS temp, copy to vault, clean up.
      // m2: path.join() instead of string template for OS-agnostic separator.
      const tmpPath = join(tmpdir(), `aios-att-${randomUUID()}`);
      writeFileSync(tmpPath, buf);
      try {
        vaultPath = vault.storeFile("attachments/images", destName, tmpPath);
      } finally {
        try { unlinkSync(tmpPath); } catch {}
      }
    }

    log?.(`[attachments] ${safeName} → vault at ${vaultPath}`);
    return (
      `[Attachment: ${safeName} — image saved to vault at ${vaultPath}. ` +
      `Use the Read tool to view it.]`
    );
  }

  // ── PDF ────────────────────────────────────────────────────────────────────
  if (ext === ".pdf" || mimeType === "application/pdf") {
    const MAX_PDF = 20 * 1024 * 1024; // 20 MB
    if (buf.length > MAX_PDF) {
      if (sourcePath) { try { unlinkSync(sourcePath); } catch {} }
      return `[Attachment: ${safeName} — PDF too large (${Math.round(buf.length / 1024 / 1024)} MB, limit 20 MB); not extracted]`;
    }

    try {
      // Convert to Uint8Array — pdfjs requires this on Node v22+ (Buffer's V8
      // backing-store differs from plain Uint8Array and breaks xref reading).
      const { text } = await pdfParse(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      if (sourcePath) { try { unlinkSync(sourcePath); } catch {} }
      const MAX_CHARS = 12_000;
      const body = text.trim().slice(0, MAX_CHARS);
      const suffix = text.trim().length > MAX_CHARS ? "\n…[text truncated at 12 000 chars]" : "";
      log?.(`[attachments] ${safeName} → extracted ${body.length} chars of PDF text`);
      if (!body) {
        return `[Attachment: ${safeName} — PDF appears to be image-only; no extractable text]`;
      }
      return `[Attachment: ${safeName} — PDF text follows]\n${body}${suffix}`;
    } catch (err) {
      if (sourcePath) { try { unlinkSync(sourcePath); } catch {} }
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`[attachments] ${safeName} — PDF parse error: ${msg}`);
      return `[Attachment: ${safeName} — PDF parse failed: ${msg}]`;
    }
  }

  // ── Audio ──────────────────────────────────────────────────────────────────
  if (AUDIO_EXTS.has(ext) || AUDIO_MIMES.has(mimeType)) {
    if (buf.length > MAX_AUDIO) {
      if (sourcePath) { try { unlinkSync(sourcePath); } catch {} }
      return `[Attachment: ${safeName} — audio too large (${Math.round(buf.length / 1024 / 1024)} MB, limit 25 MB); not transcribed]`;
    }
    return transcribeToAnnotation("audio", buf, safeName, sizeKb, media, sourcePath, log);
  }

  // ── Video — transcribe the audio track (ffmpeg inside the transcriber
  //    handles the container; no keyframe extraction this cycle) ─────────────
  if (VIDEO_EXTS.has(ext) || VIDEO_MIMES.has(mimeType)) {
    if (buf.length > MAX_VIDEO) {
      if (sourcePath) { try { unlinkSync(sourcePath); } catch {} }
      return `[Attachment: ${safeName} — video too large (${Math.round(buf.length / 1024 / 1024)} MB, limit 100 MB); not transcribed]`;
    }
    return transcribeToAnnotation("video", buf, safeName, sizeKb, media, sourcePath, log);
  }

  // ── Unsupported / unknown ──────────────────────────────────────────────────
  if (sourcePath) { try { unlinkSync(sourcePath); } catch {} }
  return `[Attachment: ${safeName} — unsupported format (${ext || mimeType}), ${sizeKb} KB; not processed]`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Process a single attachment from either a disk file or an in-memory buffer.
 *
 * Returns a prompt annotation string ready to be injected into the user message.
 * Disk staging files are deleted after processing.
 */
export async function processAttachment(
  source: AttachmentSource,
  vault: VaultWriter,
  log?: (line: string) => void,
  media?: MediaDeps,
): Promise<string> {
  if (source.kind === "file") {
    // m8: reject paths that escape the known downloads directory.
    // resolve() normalises `../` traversal so the startsWith check is safe.
    const resolvedPath = resolve(source.path);
    if (
      resolvedPath !== DOWNLOADS_ROOT &&
      !resolvedPath.startsWith(DOWNLOADS_ROOT + sep)
    ) {
      const safeName = source.fileName.replace(/[\r\n\[\]]/g, "_");
      return `[Attachment: ${safeName} — path outside downloads directory; not processed]`;
    }

    const stats = statSync(source.path, { throwIfNoEntry: false });
    if (!stats) {
      const safeName = source.fileName.replace(/[\r\n\[\]]/g, "_");
      return `[Attachment: ${safeName} — file not found at ${source.path}]`;
    }
    const buf = readFileSync(source.path);
    const mimeType = guessMimeType(source.fileName);
    return classifyAndProcess(buf, source.fileName, mimeType, vault, source.path, log, media);
  }

  // Buffer path (e.g. Gmail).
  return classifyAndProcess(source.buf, source.fileName, source.mimeType, vault, undefined, log, media);
}

/**
 * Process an array of disk-based attachments (Telegram path).
 *
 * Returns a combined annotation block — one line (or multi-line for PDFs) per
 * attachment — ready to prepend to the user prompt. Returns an empty string
 * when the array is empty.
 */
export async function processAttachments(
  attachments: Array<{ path: string; fileName: string }>,
  vault: VaultWriter,
  log?: (line: string) => void,
  media?: MediaDeps,
): Promise<string> {
  if (!attachments.length) return "";
  const parts = await Promise.all(
    attachments.map((att) =>
      processAttachment({ kind: "file", path: att.path, fileName: att.fileName }, vault, log, media),
    ),
  );
  return parts.join("\n");
}
