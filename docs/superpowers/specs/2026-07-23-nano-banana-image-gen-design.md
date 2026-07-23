# Nano Banana image generation

**Date:** 2026-07-23
**Status:** Approved
**Cycle:** ⑩

## Problem

AIOS agents can render data charts (`render_chart`), graphviz diagrams (`render_diagram`), and speech (`speak`) via the `media` MCP server, but cannot generate or edit *pictures* — photorealistic or creative images from a text prompt. The user wants image generation via Google's **Nano Banana** (Gemini 2.5 Flash Image), exposed to AIOS agents as a native media tool, plus authoring guidance packaged as a skill.

## Non-goals / scope

- **v1 is text→image only.** Nano banana's image→image editing (local edits, multi-image fusion, character consistency) requires passing a local image path to Google — a file-exfiltration surface (an agent could feed an arbitrary file's pixels out, the same class as the graphviz `image=`/`fontpath=` attribute exfil already patched in `sanitizeDot`). Editing is a **fast-follow**, gated on input-path confinement (reuse `isSafe` from `attachment-server.ts`). Not in this cycle.
- No new npm dependency — Gemini's REST `generateContent` returns inline base64 PNG, callable with Node's built-in `fetch`.
- No change to how media is *delivered* — `generate_image` returns a file path handed to the existing `attach_file` path, exactly like `render_chart`.

## Auth (documented exception)

Nano banana has **no subscription-auth path**; it needs a Google **Gemini API key**. This is a deliberate, documented exception to the project's "subscription auth, never API keys" rule — the rule targets Claude/Anthropic token auth, and this is a different provider for a capability with no subscription option.

- New secret `GEMINI_API_KEY` in `.env` (Google AI Studio). It is **not** covered by the existing Google Workspace OAuth (`gmail`/`calendar` scopes) — a separate credential.
- Data boundary: every prompt is sent to Google; each generated image carries Google's SynthID watermark. Stated in the tool description so agents (and via them, the user) are aware.
- Cost: ~$0.039 per image (1290 output tokens @ $30/1M). A per-image log line gives cost visibility. The key is never logged.

## Architecture

### 1. Config — `src/config.ts`

- `geminiApiKey: string | undefined` from `GEMINI_API_KEY`.
- `geminiImageModel: string` from `AIOS_GEMINI_IMAGE_MODEL`, default `"gemini-2.5-flash-image"`. A config knob because Google churns model ids (`-preview` → GA → future versions); a rename must not require a code change.

### 2. Image-gen module — `src/media/image.ts` (new)

Pure and unit-testable. Signature:

```ts
generateImage(
  prompt: string,
  opts: { apiKey: string; model: string; outDir: string },
): Promise<RenderResult>   // RenderResult reused from media/server.ts
```

Behaviour:
- POST `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with header `x-goog-api-key: {apiKey}` and body `{ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }`, via built-in `fetch`. (`["TEXT","IMAGE"]` is Google's canonical form for the image model; IMAGE-only can be rejected. The parse below scans all parts, so a returned text part is tolerated.)
- `AbortController` timeout 60s (image gen is slower than the 20s chart/diagram renders).
- Parse `candidates[0].content.parts[]`, find the entry with `inlineData.data` (base64), decode, write to `{outDir}/image.png`, return `{ ok: true, path }`.
- Distinct failure paths, each `{ ok: false, error }`:
  - HTTP non-2xx → `image generation failed: <status> <tail of body>`.
  - **No `inlineData` in the response** (Gemini returned only text — a safety block or refusal) → surface the returned text as the reason (`image generation blocked: <text>`).
  - Network/timeout (`fetch` throw / abort) → `image generation failed: <message>`.

### 3. Tool — `generate_image` in `src/media/server.ts`

Mirrors `render_chart`/`render_diagram`:
- `MediaServerDeps` gains `geminiApiKey?: string` and `geminiImageModel?: string`.
- Tool input: `{ prompt: z.string().min(1) }`.
- If `deps.geminiApiKey` is unset → `text("Refused: image generation is not configured (no GEMINI_API_KEY).")`.
- Else `mkdtempSync("/tmp/aios-media-")`, call `generateImage`, on success `deps.log?("image generated: <model> (~$0.039)")` and return `Image generated: <path> — deliver with attach_file.`; on failure return `Refused: <error>`.
- Registered in the `createSdkMcpServer` tools array.
- Wired in `src/index.ts` where `buildMediaServer` is constructed: pass `geminiApiKey: config.geminiApiKey, geminiImageModel: config.geminiImageModel`.

### 4. Capability — `agents/_capabilities.yaml`

Add `mcp__media__generate_image` to the `media-gen` capability's tool list. The 6 current media-gen holders (venus, clio, neo, midas, athena, odin) inherit it automatically. The org-golden fixture re-pins — a media-gen-only diff, expected.

### 5. AIOS agent skill — `skills-plugin/skills/image-generation/SKILL.md` (new)

Standard `SKILL.md` (frontmatter `name` + `description`, then body). Teaches:
- Prompt craft: subject, style, composition, lighting, aspect ratio; what nano banana does well (photoreal, scenes, product shots) and poorly (dense text, precise data).
- Tool selection: data → `render_chart`; structure/graph → `render_diagram`; anything visual/creative/photographic → `generate_image`.
- Cost discipline: $0.039/call, one good prompt over many retries; every image goes to Google (don't send sensitive content).

Attached via `skills: [image-generation]` on the media-gen agents that produce visual deliverables (venus, clio, midas at minimum; exact set pinned in the plan). Skills fold into the agent surface hash — attaching invalidates those agents' session surface once (expected, benign).

### 6. Claude Code skill — `~/.claude/skills/nano-banana/` (new, outside the repo)

A skill for the CLI environment (this assistant), not the AIOS daemon:
- `SKILL.md` describing when/how to generate an image.
- `nano-banana.ts` helper run via `npx tsx` — takes a prompt (and output path), hits the same Gemini endpoint using `GEMINI_API_KEY` from env, saves a PNG. Self-contained, no repo coupling.

## Data flow (text→image, happy path)

agent calls `generate_image({prompt})` → media server checks key → `mkdtemp` → `generateImage` POSTs to Gemini → base64 PNG decoded to `/tmp/aios-media-*/image.png` → tool returns path → agent calls `attach_file(path)` → existing attachment registry/dispatch delivers it to the chat (Telegram file, web inline, etc.), unchanged.

## Security

- **v1 reads no local files** — text→image only, so no file-exfil surface. (Editing deferred precisely for this reason.)
- Output lands under `/tmp/aios-media-*`, already inside the attachment guard's admitted prefix.
- `GEMINI_API_KEY` lives only in `.env`, passed through config → deps; never logged, never in tool output.
- Prompts are sent to Google — documented in the tool description and the skill.

## Testing

- `test/media-image.test.ts` (new), `generateImage` with mocked `fetch`:
  - success → base64 decoded, PNG written, `{ ok: true, path }`.
  - HTTP 4xx/5xx → `{ ok: false, error }` with status.
  - safety block (response has text, no `inlineData`) → `{ ok: false }` surfacing the text.
  - abort/network throw → `{ ok: false }`.
- Tool-level: `generate_image` refuses when `geminiApiKey` is undefined (no network call).
- Org-golden re-pin for the media-gen tool-list change.

## Future (fast-follow, not this cycle)

- **Image editing (image→image):** add optional `input_image_path`, confined via `isSafe` to the attachment/vault/media dirs before base64-encoding into the request. Unlocks nano banana's edit/consistency features.
- Aspect-ratio / size controls once Gemini exposes them stably in the REST config.
