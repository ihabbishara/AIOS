// test/attachments.test.ts
//
// Unit tests for src/attachments.ts (fix M3 — zero coverage on new module).
//
// pdf-parse mock note:
//   attachments.ts loads pdf-parse via createRequire() (CJS interop). Vitest's
//   vi.mock() only intercepts ESM imports — createRequire() goes through Node's
//   native Module._load path which Vitest does NOT patch. So we test against the
//   real installed pdf-parse@1.1.1, providing real valid PDF buffers via makePdf().
//
// Node v22+ / pdfjs compatibility note:
//   pdfjs (used by pdf-parse v1) requires Uint8Array input on Node v22+; passing
//   a plain Buffer triggers "bad XRef entry". attachments.ts wraps the buf with
//   new Uint8Array(...) before calling pdfParse — that is tested here implicitly.

import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { processAttachment, processAttachments } from "../src/attachments.js";

// ── PDF fixture builder ───────────────────────────────────────────────────────
//
// Builds a structurally valid minimal PDF by tracking exact byte offsets so the
// xref table is always correct. Real pdf-parse@1.1.1 is used to parse them.

/**
 * Build a minimal valid PDF buffer. When textContent is provided, the PDF
 * contains a content stream with that text (readable by pdf-parse). When
 * omitted, the PDF has no content stream and pdf-parse returns empty text.
 *
 * Byte offsets are computed dynamically so the xref table is always correct.
 * attachments.ts wraps the Buffer in Uint8Array before calling pdfParse —
 * the tests exercise that conversion implicitly.
 */
function makePdf(textContent?: string): Buffer {
  let pos = 0;
  const offsets: number[] = [];

  // Bare header — no binary-comment line. Uint8Array wrapping in attachments.ts
  // is sufficient to make pdfjs v1.10.100 parse correctly on Node v22+.
  const header = "%PDF-1.4\n";
  pos += header.length;

  if (textContent) {
    // 5-object PDF: catalog → pages → page (with content + font) → stream → font
    const stream = `BT /F1 12 Tf 100 700 Td (${textContent}) Tj ET\n`;

    const o1 = "1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n";
    offsets[1] = pos; pos += o1.length;

    const o2 = "2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n";
    offsets[2] = pos; pos += o2.length;

    const o3 =
      "3 0 obj\n" +
      "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]" +
      "/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>\n" +
      "endobj\n";
    offsets[3] = pos; pos += o3.length;

    const o4 =
      `4 0 obj\n<</Length ${stream.length}>>\nstream\n` +
      stream +
      "endstream\nendobj\n";
    offsets[4] = pos; pos += o4.length;

    const o5 =
      "5 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n";
    offsets[5] = pos; pos += o5.length;

    const xrefPos = pos;
    const entries = [
      "0000000000 65535 f \n",
      `${String(offsets[1]).padStart(10, "0")} 00000 n \n`,
      `${String(offsets[2]).padStart(10, "0")} 00000 n \n`,
      `${String(offsets[3]).padStart(10, "0")} 00000 n \n`,
      `${String(offsets[4]).padStart(10, "0")} 00000 n \n`,
      `${String(offsets[5]).padStart(10, "0")} 00000 n \n`,
    ].join("");
    const trailer = `trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`;

    return Buffer.from(header + o1 + o2 + o3 + o4 + o5 + "xref\n0 6\n" + entries + trailer);
  }

  // 3-object PDF with no content stream → pdf-parse returns empty text → image-only path
  const o1 = "1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n";
  offsets[1] = pos; pos += o1.length;

  const o2 = "2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n";
  offsets[2] = pos; pos += o2.length;

  const o3 = "3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\nendobj\n";
  offsets[3] = pos; pos += o3.length;

  const xrefPos = pos;
  const entries = [
    "0000000000 65535 f \n",
    `${String(offsets[1]).padStart(10, "0")} 00000 n \n`,
    `${String(offsets[2]).padStart(10, "0")} 00000 n \n`,
    `${String(offsets[3]).padStart(10, "0")} 00000 n \n`,
  ].join("");
  const trailer = `trailer\n<</Size 4/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`;

  return Buffer.from(header + o1 + o2 + o3 + "xref\n0 4\n" + entries + trailer);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const DOWNLOADS = resolve("data/downloads");

/** Minimal VaultWriter stub — only storeFile is exercised by attachments.ts. */
function makeVault() {
  const storeFile = vi.fn().mockImplementation(
    (subdir: string, filename: string) => `/vault-test/${subdir}/${filename}`,
  );
  return { vault: { storeFile } as any, storeFile };
}

/** Write a small file under data/downloads and return its absolute path. */
function writeDownload(content: Buffer | string, ext: string): string {
  const name = `${randomUUID()}.${ext}`;
  const p = join(DOWNLOADS, name);
  writeFileSync(p, content);
  return p;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(() => {
  mkdirSync(DOWNLOADS, { recursive: true });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("processAttachment — image (disk file)", () => {
  it("stores image in vault and returns annotation with vault path and 'Read tool'", async () => {
    const { vault, storeFile } = makeVault();
    const p = writeDownload(Buffer.alloc(512), "png");

    const result = await processAttachment(
      { kind: "file", path: p, fileName: "photo.png" },
      vault,
    );

    expect(storeFile).toHaveBeenCalledOnce();
    expect(result).toContain("photo.png");
    expect(result).toContain("/vault-test/");
    expect(result).toContain("Read tool");
    // Staging file must be cleaned up.
    expect(existsSync(p)).toBe(false);
  });
});

describe("processAttachment — image (buffer / Gmail)", () => {
  it("stores buffer image in vault via temp file and returns annotation", async () => {
    const { vault, storeFile } = makeVault();

    const result = await processAttachment(
      { kind: "buffer", buf: Buffer.alloc(200), fileName: "snap.jpg", mimeType: "image/jpeg" },
      vault,
    );

    expect(storeFile).toHaveBeenCalledOnce();
    expect(result).toContain("snap.jpg");
    expect(result).toContain("/vault-test/");
    expect(result).toContain("Read tool");
  });
});

describe("processAttachment — image > 5 MB", () => {
  it("returns size-exceeded note without writing to vault", async () => {
    const { vault, storeFile } = makeVault();
    const bigBuf = Buffer.alloc(6 * 1024 * 1024); // 6 MB

    const result = await processAttachment(
      { kind: "buffer", buf: bigBuf, fileName: "huge.png", mimeType: "image/png" },
      vault,
    );

    expect(storeFile).not.toHaveBeenCalled();
    expect(result).toContain("huge.png");
    expect(result).toContain("too large");
    expect(result).toContain("6 MB");
  });
});

describe("processAttachment — PDF with text", () => {
  it("returns extracted text inline without vault write", async () => {
    const { vault, storeFile } = makeVault();
    const pdfBuf = makePdf("Hello PDF");

    const result = await processAttachment(
      { kind: "buffer", buf: pdfBuf, fileName: "doc.pdf", mimeType: "application/pdf" },
      vault,
    );

    expect(storeFile).not.toHaveBeenCalled();
    expect(result).toContain("doc.pdf");
    expect(result).toContain("PDF text follows");
    expect(result).toContain("Hello PDF");
  });
});

describe("processAttachment — PDF with empty text (image-only)", () => {
  it("returns image-only note for PDF with no content stream", async () => {
    const { vault, storeFile } = makeVault();
    const pdfBuf = makePdf(); // no content stream → pdf-parse returns empty text

    const result = await processAttachment(
      { kind: "buffer", buf: pdfBuf, fileName: "scan.pdf", mimeType: "application/pdf" },
      vault,
    );

    expect(storeFile).not.toHaveBeenCalled();
    expect(result).toContain("scan.pdf");
    expect(result).toContain("image-only");
  });
});

describe("processAttachment — PDF > 20 MB", () => {
  it("returns size note without calling pdf-parse", async () => {
    const { vault, storeFile } = makeVault();
    const bigPdf = Buffer.alloc(21 * 1024 * 1024);

    const result = await processAttachment(
      { kind: "buffer", buf: bigPdf, fileName: "huge.pdf", mimeType: "application/pdf" },
      vault,
    );

    expect(storeFile).not.toHaveBeenCalled();
    expect(result).toContain("huge.pdf");
    expect(result).toContain("too large");
  });
});

describe("processAttachment — file not found", () => {
  it("returns not-found note without vault write", async () => {
    const { vault, storeFile } = makeVault();
    const p = join(DOWNLOADS, "does-not-exist.png");

    const result = await processAttachment(
      { kind: "file", path: p, fileName: "does-not-exist.png" },
      vault,
    );

    expect(storeFile).not.toHaveBeenCalled();
    expect(result).toContain("does-not-exist.png");
    expect(result).toContain("not found");
  });
});

describe("processAttachment — path outside downloads directory (m8)", () => {
  it("rejects path outside downloads dir without vault write", async () => {
    const { vault, storeFile } = makeVault();

    const result = await processAttachment(
      { kind: "file", path: "/etc/passwd", fileName: "passwd" },
      vault,
    );

    expect(storeFile).not.toHaveBeenCalled();
    expect(result).toContain("passwd");
    expect(result).toContain("outside downloads directory");
  });

  it("rejects path traversal escape (../../etc/passwd)", async () => {
    const { vault, storeFile } = makeVault();
    const traversal = join(DOWNLOADS, "../../etc/passwd");

    const result = await processAttachment(
      { kind: "file", path: traversal, fileName: "passwd" },
      vault,
    );

    expect(storeFile).not.toHaveBeenCalled();
    expect(result).toContain("outside downloads directory");
  });
});

describe("processAttachment — unsupported type (.xlsx)", () => {
  it("returns unsupported-format note", async () => {
    const { vault, storeFile } = makeVault();

    const result = await processAttachment(
      {
        kind: "buffer",
        buf: Buffer.from("PKdata"),
        fileName: "report.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      vault,
    );

    expect(storeFile).not.toHaveBeenCalled();
    expect(result).toContain("report.xlsx");
    expect(result).toContain("unsupported format");
  });
});

describe("processAttachment — video (.mp4)", () => {
  it("returns video note without vault write", async () => {
    const { vault, storeFile } = makeVault();

    const result = await processAttachment(
      { kind: "buffer", buf: Buffer.alloc(1024), fileName: "clip.mp4", mimeType: "video/mp4" },
      vault,
    );

    expect(storeFile).not.toHaveBeenCalled();
    expect(result).toContain("clip.mp4");
    expect(result).toContain("video");
  });
});

describe("processAttachments — multiple items", () => {
  it("processes each item and joins all annotations with newline", async () => {
    const { vault, storeFile } = makeVault();
    const p1 = writeDownload(Buffer.alloc(100), "png");
    const p2 = writeDownload(Buffer.alloc(100), "png");

    const result = await processAttachments(
      [
        { path: p1, fileName: "a.png" },
        { path: p2, fileName: "b.png" },
      ],
      vault,
    );

    expect(storeFile).toHaveBeenCalledTimes(2);
    expect(result).toContain("a.png");
    expect(result).toContain("b.png");
    // Two annotations joined — at least one newline between them.
    expect(result.split("\n").length).toBeGreaterThanOrEqual(2);
  });
});

describe("processAttachment — filename sanitization (m7)", () => {
  it("strips newlines and brackets from fileName before injecting into annotation and vault path", async () => {
    const { vault } = makeVault();

    const result = await processAttachment(
      {
        kind: "buffer",
        buf: Buffer.alloc(512),
        fileName: "evil\nname[test].png",
        mimeType: "image/png",
      },
      vault,
    );

    // The annotation prefix uses safeName ("evil_name_test_.png")
    expect(result).toContain("evil_name_test_.png");
    // The vault path (inside the annotation string) must NOT contain the original newline
    expect(result).not.toMatch(/evil\nname/);
  });
});
