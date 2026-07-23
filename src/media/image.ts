// src/media/image.ts — Nano Banana (Gemini 2.5 Flash Image) text→image via REST (spec 2026-07-23).
// No SDK dep: built-in fetch → base64 PNG → outDir. The prompt is sent to Google and the image
// carries a SynthID watermark. Editing (image→image) is a deferred fast-follow (file-exfil surface).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RenderResult } from "./server.js";

const TIMEOUT_MS = 60_000; // image gen is slower than the 20s chart/diagram renders
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiPart { text?: string; inlineData?: { mimeType?: string; data?: string } }
interface GeminiResp { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> }

export async function generateImage(
  prompt: string,
  opts: { apiKey: string; model: string; outDir: string },
): Promise<RenderResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ENDPOINT}/${opts.model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, error: `image generation failed: ${res.status} ${body}` };
    }
    const json = (await res.json()) as GeminiResp;
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const img = parts.find((p) => p.inlineData?.data);
    if (!img?.inlineData?.data) {
      const t = parts.find((p) => p.text)?.text ?? "no image returned";
      return { ok: false, error: `image generation blocked: ${t.slice(0, 300)}` };
    }
    const outPath = join(opts.outDir, "image.png");
    writeFileSync(outPath, Buffer.from(img.inlineData.data, "base64"));
    return { ok: true, path: outPath };
  } catch (err) {
    return { ok: false, error: `image generation failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
