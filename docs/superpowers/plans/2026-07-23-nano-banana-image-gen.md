# Nano Banana Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AIOS agents can generate images from a text prompt via Google's Nano Banana (Gemini 2.5 Flash Image), delivered through the existing attachment path, with authoring guidance packaged as an AIOS agent skill and a Claude Code skill.

**Architecture:** A pure `generateImage` module (built-in `fetch` → Gemini REST → base64 PNG under `/tmp/aios-media-*`) is wrapped by a new `generate_image` tool in the existing `media` MCP server. The tool is added to the `media-gen` capability so the 6 media-gen agents inherit it. Two skills teach prompt craft: an AIOS `SKILL.md` and a Claude Code skill.

**Tech Stack:** TypeScript, Node 23 (built-in `fetch` + `AbortController`), vitest, Gemini 2.5 Flash Image REST API.

**Spec:** `docs/superpowers/specs/2026-07-23-nano-banana-image-gen-design.md`

## Global Constraints

- No new npm dependencies — Gemini REST via built-in `fetch` only.
- Subscription auth is the rule; `GEMINI_API_KEY` is the ONE documented exception (a non-Anthropic provider with no subscription path). Key lives only in `.env`, never logged, never in tool output.
- Trunk-based: commit on main, EXPLICIT file paths only in `git add` (a parallel session shares this checkout).
- v1 is **text→image only**. No `input_image_path`, no local file reads (editing is a deferred fast-follow).
- Model id is a config knob: `AIOS_GEMINI_IMAGE_MODEL`, default `"gemini-2.5-flash-image"`.
- Request body uses `responseModalities: ["TEXT", "IMAGE"]` (canonical form; IMAGE-only can be rejected). The response parse scans all parts for `inlineData`.
- Output PNG lands under `/tmp/aios-media-*` (already admitted by the attachment guard's literal `/tmp/aios-` prefix — do not change that guard).
- Read vitest's "Tests" summary line, not exit codes. `npx tsc --noEmit` must be clean.

---

### Task 1: `generateImage` module + tests

**Files:**
- Create: `src/media/image.ts`
- Test: `test/media-image.test.ts` (new)

**Interfaces:**
- Consumes: `RenderResult` from `./server.js` (`{ ok: true; path: string } | { ok: false; error: string }`).
- Produces: `generateImage(prompt: string, opts: { apiKey: string; model: string; outDir: string }): Promise<RenderResult>`. Task 2 calls it from the media server.

- [ ] **Step 1: Write the failing tests**

Create `test/media-image.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/media-image.test.ts`
Expected: FAIL — cannot resolve `../src/media/image.js`.

- [ ] **Step 3: Implement**

Create `src/media/image.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/media-image.test.ts && npx tsc --noEmit`
Expected: 4 passed, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/media/image.ts test/media-image.test.ts
git commit -m "feat(media): generateImage — Nano Banana text→image via Gemini REST (no SDK dep)"
```

---

### Task 2: `generate_image` tool + config + capability wiring

**Files:**
- Modify: `src/config.ts` (interface ~:8-130, assignment ~:290 near `pythonBin`)
- Modify: `src/media/server.ts` (`MediaServerDeps` ~:115-120, add tool ~:124-175, tools array ~:175)
- Modify: `src/agents/resolve.ts:112` (SERVER_BUILDERS.media)
- Modify: `agents/_capabilities.yaml:15` (media-gen tool list)
- Modify: `test/fixtures/org-golden.json` (regenerated, not hand-edited)
- Test: add to `test/media-server.test.ts`

**Interfaces:**
- Consumes: `generateImage` from Task 1.
- Produces: `MediaServerDeps.geminiApiKey?: string`, `MediaServerDeps.geminiImageModel?: string`; `Config.geminiApiKey?: string`, `Config.geminiImageModel: string`; tool `generate_image` reachable as `mcp__media__generate_image`.

- [ ] **Step 1: Write the failing test (no-key refusal)**

Add to `test/media-server.test.ts` (the file already imports `buildMediaServer`):

```ts
describe("generate_image tool", () => {
  it("refuses when no GEMINI_API_KEY is configured (no network call)", async () => {
    const server = buildMediaServer({}) as unknown as {
      _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    };
    const out = (await server._registeredTools["generate_image"].handler({ prompt: "a cat" })).content[0].text;
    expect(out).toContain("not configured");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/media-server.test.ts -t "generate_image"`
Expected: FAIL — `_registeredTools["generate_image"]` is undefined (tool not registered yet).

- [ ] **Step 3: Add config fields**

In `src/config.ts`, add to the `Config` interface (near `pythonBin: string;` at ~:126):

```ts
  /** Nano Banana image generation (spec 2026-07-23). Undefined key ⇒ generate_image refuses. */
  geminiApiKey?: string;
  geminiImageModel: string;
```

In the config object returned by the loader (near `pythonBin: process.env.AIOS_PYTHON_BIN ?? "python3",` at ~:290):

```ts
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiImageModel: process.env.AIOS_GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image",
```

- [ ] **Step 4: Add the tool to the media server**

In `src/media/server.ts`, add the import at the top (after the existing imports):

```ts
import { generateImage } from "./image.js";
```

Add to the `MediaServerDeps` interface (after `pythonBin?: string;`):

```ts
  /** Nano Banana (Gemini 2.5 Flash Image). Absent apiKey ⇒ generate_image refuses. */
  geminiApiKey?: string;
  geminiImageModel?: string;
```

Inside `buildMediaServer`, add the tool (after `speakTool`, before the `return`):

```ts
  const generateImageTool = tool(
    "generate_image",
    "Generate an image from a text prompt using Nano Banana (Gemini 2.5 Flash Image). Returns the " +
      "output PNG path — deliver it with attach_file. The prompt is sent to Google and the image " +
      "carries a SynthID watermark. Use render_chart for data and render_diagram for graphs; use this " +
      "for photographic, illustrative, or creative images.",
    { prompt: z.string().min(1).describe("What to depict — subject, style, composition, lighting, aspect") },
    async (a) => {
      if (!deps.geminiApiKey) {
        return text("Refused: image generation is not configured (no GEMINI_API_KEY).");
      }
      const model = deps.geminiImageModel ?? "gemini-2.5-flash-image";
      const dir = mkdtempSync("/tmp/aios-media-");
      const r = await generateImage(a.prompt, { apiKey: deps.geminiApiKey, model, outDir: dir });
      if (r.ok) {
        deps.log?.(`image generated: ${model} (~$0.039)`); // dormant unless a log sink is wired
        return text(`Image generated: ${r.path} — deliver with attach_file.`);
      }
      return text(`Refused: ${r.error}`);
    },
  );
```

Add `generateImageTool` to the `createSdkMcpServer` tools array:

```ts
  return createSdkMcpServer({ name: "media", version: "0.1.0", tools: [renderChartTool, renderDiagramTool, speakTool, generateImageTool] });
```

- [ ] **Step 5: Wire config through the media server builder**

In `src/agents/resolve.ts:112`, replace:

```ts
  media: (c) => ({ media: buildMediaServer({ voice: c.deps.voice, pythonBin: c.deps.config.pythonBin }) }),
```

with:

```ts
  media: (c) => ({ media: buildMediaServer({
    voice: c.deps.voice, pythonBin: c.deps.config.pythonBin,
    geminiApiKey: c.deps.config.geminiApiKey, geminiImageModel: c.deps.config.geminiImageModel,
  }) }),
```

- [ ] **Step 6: Run the refusal test + typecheck**

Run: `npx vitest run test/media-server.test.ts -t "generate_image" && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 7: Grant the capability**

In `agents/_capabilities.yaml:15`, replace:

```yaml
media-gen:   { server: media, tools: [mcp__media__render_chart, mcp__media__render_diagram, mcp__media__speak] }   # charts/diagrams/speech out (⑤d)
```

with:

```yaml
media-gen:   { server: media, tools: [mcp__media__render_chart, mcp__media__render_diagram, mcp__media__speak, mcp__media__generate_image] }   # charts/diagrams/speech/image out (⑤d + ⑩ nano-banana)
```

- [ ] **Step 8: Regenerate the org-golden fixture and review the diff**

Run: `npx tsx scripts/gen-org-golden.ts`
Then: `git diff test/fixtures/org-golden.json`
Expected: the ONLY change is `"mcp__media__generate_image"` added to the tool list of exactly the 6 media-gen agents (venus, clio, neo, midas, athena, odin). If any other agent changed, STOP and investigate.

- [ ] **Step 9: Full media + golden suite green**

Run: `npx vitest run test/media-server.test.ts test/media-image.test.ts test/org-golden.test.ts && npx tsc --noEmit`
Expected: all green, tsc clean.

- [ ] **Step 10: Commit**

```bash
git add src/config.ts src/media/server.ts src/agents/resolve.ts agents/_capabilities.yaml test/media-server.test.ts test/fixtures/org-golden.json
git commit -m "feat(media): generate_image tool + GEMINI_API_KEY config; media-gen agents inherit it"
```

---

### Task 3: AIOS agent skill — image-generation

**Files:**
- Create: `skills-plugin/skills/image-generation/SKILL.md`
- Modify: `agents/research/venus.yaml` (skills line ~:41), `agents/finance/midas.yaml` (skills line)

**Interfaces:**
- Consumes: nothing at runtime — a skill is progressive-disclosure markdown loaded by the agents that list it.
- Produces: skill name `image-generation`, attachable via `skills: [image-generation]`.

- [ ] **Step 1: Confirm midas's current skills line**

Run: `grep -nE "^skills:|^capabilities:" agents/finance/midas.yaml agents/research/venus.yaml`
Expected: venus has `skills: [design-tokens]`; note midas's line (it may have no `skills:` key yet — if absent, you will add one).

- [ ] **Step 2: Write the skill**

Create `skills-plugin/skills/image-generation/SKILL.md`:

```markdown
---
name: image-generation
description: Use when a request needs a generated picture — a photographic, illustrative, or creative image from a description — via the generate_image tool (Nano Banana / Gemini 2.5 Flash Image).
---

# Image generation

`generate_image` turns a text prompt into a PNG. Deliver the returned path with `attach_file`.

## Pick the right tool

- Numbers, series, comparisons → `render_chart`.
- Structure, graphs, flows, hierarchies → `render_diagram`.
- A photo, illustration, scene, product shot, logo concept, or any creative visual → `generate_image`.

## Write the prompt in one pass

Each call costs ~$0.039 and the prompt goes to Google — get it right the first time, don't spam retries. A strong prompt names, in order:

1. **Subject** — the one thing the image is of, concretely ("a ceramic pour-over coffee dripper").
2. **Style** — photographic / watercolour / 3D render / line art / flat vector; name a medium, not "nice".
3. **Composition** — framing and angle (close-up, top-down, wide establishing shot), and what's in frame.
4. **Lighting & mood** — soft morning light, high-key studio, moody low-key.
5. **Aspect** — say "square", "wide 16:9", or "tall portrait" if it matters.

Example: "A top-down photo of a ceramic pour-over coffee dripper on a light oak table, soft morning window light, minimal styling, shallow depth of field, square."

## Limits

- Weak at rendering long or exact text inside the image, precise charts/data, and fine UI mockups — use the chart/diagram tools for those.
- Every output carries an invisible SynthID watermark.
- Don't send private or sensitive content in a prompt — it leaves the machine.
```

- [ ] **Step 3: Attach the skill to venus and midas**

In `agents/research/venus.yaml`, change `skills: [design-tokens]` to:

```yaml
skills: [design-tokens, image-generation]
```

In `agents/finance/midas.yaml`, there is no `skills:` line yet — add one on its own line immediately before `aliases: [cfo, faris]`:

```yaml
skills: [image-generation]
```

- [ ] **Step 4: Validate the skill loads and the suite stays green**

Run: `npx vitest run test/org-golden.test.ts && npx tsc --noEmit`
Expected: green. If org-golden reddened, run `npx tsx scripts/gen-org-golden.ts`, then `git diff test/fixtures/org-golden.json` — the only changes may be venus/midas skill entries; review and re-run. If any OTHER agent changed, STOP.

- [ ] **Step 5: Commit**

```bash
git add skills-plugin/skills/image-generation/SKILL.md agents/research/venus.yaml agents/finance/midas.yaml
# include test/fixtures/org-golden.json ONLY if step 4 regenerated it:
git add test/fixtures/org-golden.json 2>/dev/null || true
git commit -m "feat(skills): image-generation agent skill; attach to venus + midas"
```

---

### Task 4: Claude Code skill — nano-banana

**Files (outside the AIOS repo — NOT committed to AIOS git):**
- Create: `~/.claude/skills/nano-banana/SKILL.md`
- Create: `~/.claude/skills/nano-banana/nano-banana.ts`

**Interfaces:**
- Consumes: `GEMINI_API_KEY` from the environment, falling back to parsing `~/projects/AIOS/.env`.
- Produces: a CLI-invocable image generator: `npx tsx ~/.claude/skills/nano-banana/nano-banana.ts "<prompt>" [outPath]`.

- [ ] **Step 1: Write the helper script**

Create `~/.claude/skills/nano-banana/nano-banana.ts`:

```ts
// nano-banana.ts — generate a PNG from a prompt via Gemini 2.5 Flash Image.
// Usage: npx tsx nano-banana.ts "<prompt>" [outPath]
// Key: $GEMINI_API_KEY, else parsed from ~/projects/AIOS/.env
import { writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function apiKey(): string {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const env = readFileSync(join(homedir(), "projects", "AIOS", ".env"), "utf8");
    const m = env.match(/^GEMINI_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  throw new Error("no GEMINI_API_KEY in env or ~/projects/AIOS/.env");
}

const prompt = process.argv[2];
if (!prompt) throw new Error('usage: nano-banana.ts "<prompt>" [outPath]');
const outPath = process.argv[3] ?? join(process.cwd(), "nano-banana.png");
const model = process.env.AIOS_GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image";

const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-goog-api-key": apiKey() },
  body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }),
});
if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 300)}`);
const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; inlineData?: { data?: string } }> } }> };
const parts = json.candidates?.[0]?.content?.parts ?? [];
const data = parts.find((p) => p.inlineData?.data)?.inlineData?.data;
if (!data) throw new Error(`no image returned: ${parts.find((p) => p.text)?.text ?? "(empty)"}`);
writeFileSync(outPath, Buffer.from(data, "base64"));
console.log(`wrote ${outPath}`);
```

- [ ] **Step 2: Write the skill doc**

Create `~/.claude/skills/nano-banana/SKILL.md`:

```markdown
---
name: nano-banana
description: Generate an image from a text prompt using Nano Banana (Gemini 2.5 Flash Image). Use when the user asks to create, generate, or make a picture/illustration/photo from a description in this CLI.
---

# Nano Banana image generation

Generate a PNG from a prompt via Google's Gemini 2.5 Flash Image.

## Run it

```bash
npx tsx ~/.claude/skills/nano-banana/nano-banana.ts "<prompt>" [outPath]
```

The key comes from `$GEMINI_API_KEY`, falling back to `~/projects/AIOS/.env`. Default output is `./nano-banana.png`.

## Write a strong prompt

Name, in order: subject, style (photographic / illustration / 3D / line art), composition (framing, angle), lighting/mood, and aspect if it matters. One good prompt beats many retries — each call is billed (~$0.039) and the prompt goes to Google.

## Limits

Weak at exact text-in-image and precise data/charts. Every output carries a SynthID watermark. Don't send sensitive content.
```

- [ ] **Step 3: Verify the script runs (live)**

Run: `npx tsx ~/.claude/skills/nano-banana/nano-banana.ts "a single ripe banana on a plain white background, studio product photo, soft light, square" /tmp/nano-smoke.png`
Expected: `wrote /tmp/nano-smoke.png`, and `/tmp/nano-smoke.png` is a non-trivial PNG (`test $(stat -f%z /tmp/nano-smoke.png) -gt 5000` succeeds). If it errors, read the message (key, model id, or API issue) before proceeding.

- [ ] **Step 4: No commit to AIOS**

These files live under `~/.claude/skills/` and are outside the repo — nothing to add to AIOS git. Skip the commit step for this task.

---

### Task 5: Full suite + deploy + live smoke + push

**Files:** none (verification and shipping only).

- [ ] **Step 1: Typecheck both roots + full suite**

Run: `npx tsc --noEmit && (cd ui2 && npx tsc --noEmit); npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: both tsc clean; full suite green with the new `media-image` file (+4 tests) and the added media-server refusal test. Unrelated failures → STOP and report.

- [ ] **Step 2: Module-level live smoke (isolates the API)**

Run:
```bash
GEMINI_API_KEY=$(grep '^GEMINI_API_KEY=' .env | cut -d= -f2) npx tsx -e "
import { generateImage } from './src/media/image.ts';
import { mkdtempSync } from 'node:fs';
const r = await generateImage('a single ripe banana on a plain white background, studio product photo, soft light, square', { apiKey: process.env.GEMINI_API_KEY, model: 'gemini-2.5-flash-image', outDir: mkdtempSync('/tmp/aios-media-') });
console.log(r);
"
```
Expected: `{ ok: true, path: '/tmp/aios-media-XXXX/image.png' }`, and that PNG is >5 KB. If `{ ok: false }`, read `error` — a `blocked` reason means the prompt tripped safety (try a different prompt); a `404`/model error means the model id needs updating via `AIOS_GEMINI_IMAGE_MODEL`.

- [ ] **Step 3: Deploy**

Run: `npm run build && launchctl kickstart -k gui/501/com.ihab.aios`
Then poll: `sleep 4 && TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2) && curl -s -m 10 -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/state | head -c 80`
Expected: JSON state (daemon healthy).

- [ ] **Step 4: End-to-end chat smoke (delivery through an agent)**

Run:
```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 240 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/chat \
  -d '{"target":"venus","text":"Generate an image: a single ripe banana on a plain white background, studio product photo, soft light. Deliver it."}' | head -c 600
grep -iE "image generated|generate_image" data/aios.log | tail -3
```
Expected: venus calls `generate_image`, gets a path, and delivers it via `attach_file` (the response references an attachment / the log shows the tool ran). Confirm no error in `data/aios.err.log` tail.

- [ ] **Step 5: Push**

```bash
git push origin main
```
