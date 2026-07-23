// test/media-image.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { generateImage } from "../src/media/image.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
const B64 = PNG_BYTES.toString("base64");

function mockFetch(impl: () => Promise<unknown> | unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => impl()));
}

afterEach(() => vi.unstubAllGlobals());

const opts = () => ({ apiKey: "k", model: "gemini-2.5-flash-image", outDir: mkdtempSync("/tmp/aios-media-") });

describe("generateImage", () => {
  it("writes the returned image and reports its path", async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: B64 } }] } }] }),
    }));
    const o = opts();
    const r = await generateImage("a red cube on white", o);
    expect(r.ok).toBe(true);
    if (r.ok) expect(readFileSync(r.path).equals(PNG_BYTES)).toBe(true);
  });

  it("reports an HTTP error with its status", async () => {
    mockFetch(() => ({ ok: false, status: 400, text: async () => "bad request: quota" }));
    const r = await generateImage("x", opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("400");
  });

  it("surfaces a safety block (text part, no image) as blocked", async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "I can't create that image." }] } }] }),
    }));
    const r = await generateImage("disallowed", opts());
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain("blocked"); expect(r.error).toContain("can't create"); }
  });

  it("reports a network/abort failure", async () => {
    mockFetch(() => { throw new Error("ENOTFOUND generativelanguage.googleapis.com"); });
    const r = await generateImage("x", opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("failed");
  });
});
