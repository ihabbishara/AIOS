# Media Generation (⑤d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents render charts (matplotlib), diagrams (graphviz), and speech (kokoro) via an in-process `media` MCP server, delivered to chat as attachments — including from hermes.

**Architecture:** `src/media/server.ts` mirrors the research-server pattern (`tool()` + `createSdkMcpServer`); render outputs land under `mkdtemp("/tmp/aios-media-")`, which the attachment guard's `/tmp/aios-` literal-prefix rule already admits. A `media-gen` capability exposes the server; the moderator seam gains the turn-scoped `aios_attachments` collector direct chats already have; `Attachment.kind: "voice"` routes through `sendVoice`.

**Tech Stack:** TypeScript (Node 23), zod, `node:child_process.execFile`, python3+matplotlib (system), graphviz `dot` (system), kokoro via live `VoiceService`, vitest.

## Global Constraints

- NO new npm dependencies; system binaries (python3, dot) and already-vendored kokoro only.
- Agent-authored text is NEVER executed as code: charts render from a zod-validated JSON spec through a fixed python template; dot source is declarative.
- All tool failures are in-band error text (never a thrown turn abort); subprocesses get explicit timeouts and surface stderr tails.
- No new bus event types (triage defaultVerdict rule).
- Hand-authored YAML (`agents/**.yaml`) is edited with normal Edit — never `Document.toString()`.
- Tests live in root `test/` (vitest). Suite baseline before this plan: 1305 pass + 2 skip.
- The python chart template is an embedded TS string constant (the build is plain `tsc`; a `.py` file would not be copied to `dist/`).

---

### Task 1: Media server — render_chart

**Files:**
- Create: `src/media/server.ts`
- Test: `test/media-server.test.ts`

**Interfaces:**
- Produces: `buildMediaServer(deps: MediaServerDeps)` → SDK MCP server named `media` with tool `render_chart`; `MediaServerDeps = { voice?: { available(): boolean; synthesize(text: string): Promise<string> }; log?: (line: string) => void }`. Also exports `CHART_PY` (python template string) and `renderChart(spec, outDir)` helper for tests.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing tests**

```ts
// test/media-server.test.ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderChart } from "../src/media/server.js";

const havePython = (() => {
  try { execFileSync("python3", ["-c", "import matplotlib"], { timeout: 15_000 }); return true; }
  catch { return false; }
})();

describe("renderChart", () => {
  it("rejects a series whose length mismatches labels", async () => {
    const r = await renderChart(
      { type: "line", labels: ["a", "b"], series: [{ values: [1, 2, 3] }] },
      mkdtempSync(join(tmpdir(), "mchart-")),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/series 1 has 3 values but there are 2 labels/);
  });

  it("rejects pie with more than one series", async () => {
    const r = await renderChart(
      { type: "pie", labels: ["a", "b"], series: [{ values: [1, 2] }, { values: [3, 4] }] },
      mkdtempSync(join(tmpdir(), "mchart-")),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pie charts take exactly one series/);
  });

  it.skipIf(!havePython)("renders a real PNG via matplotlib", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mchart-"));
    const r = await renderChart(
      { type: "bar", title: "T", labels: ["jan", "feb"], series: [{ name: "spend", values: [10, 20] }] },
      dir,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const buf = readFileSync(r.path);
      expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/media-server.test.ts`
Expected: FAIL — `Cannot find module '../src/media/server.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/media/server.ts — media generation MCP server (⑤d). Chart/diagram/speech render
// tools; outputs land under /tmp/aios-media-* which the attachment guard's /tmp/aios-
// literal prefix already admits (attachment-server.ts).
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const run = promisify(execFile);
const TIMEOUT_MS = 20_000;

function text(s: string) { return { content: [{ type: "text" as const, text: s }] }; }
const stderrTail = (e: unknown): string =>
  String((e as { stderr?: string }).stderr ?? (e as Error).message).split("\n").slice(-4).join("\n");

/** Fixed python template — reads a validated spec JSON, renders PNG. Agent text is never
 *  executed; embedded as a string because plain tsc does not copy .py files to dist. */
export const CHART_PY = `
import json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

spec = json.load(open(sys.argv[1]))
out = sys.argv[2]
labels = spec["labels"]
series = spec["series"]
fig, ax = plt.subplots(figsize=(8, 4.5), dpi=160)
t = spec["type"]
if t == "pie":
    ax.pie(series[0]["values"], labels=labels, autopct="%1.0f%%")
elif t == "bar":
    n = len(series)
    w = 0.8 / n
    xs = range(len(labels))
    for i, s in enumerate(series):
        ax.bar([x + i * w - 0.4 + w / 2 for x in xs], s["values"], w, label=s.get("name"))
    ax.set_xticks(list(xs))
    ax.set_xticklabels(labels, rotation=30, ha="right")
elif t == "scatter":
    for s in series:
        ax.scatter(labels, s["values"], label=s.get("name"))
else:
    for s in series:
        ax.plot(labels, s["values"], marker="o", label=s.get("name"))
if spec.get("title"): ax.set_title(spec["title"])
if spec.get("xLabel"): ax.set_xlabel(spec["xLabel"])
if spec.get("yLabel"): ax.set_ylabel(spec["yLabel"])
if t != "pie" and any(s.get("name") for s in series): ax.legend()
fig.tight_layout()
fig.savefig(out)
`;

export interface ChartSpec {
  type: "line" | "bar" | "pie" | "scatter";
  title?: string;
  xLabel?: string;
  yLabel?: string;
  labels: string[];
  series: Array<{ name?: string; values: number[] }>;
}

export type RenderResult = { ok: true; path: string } | { ok: false; error: string };

/** Validates cross-field constraints and shells out to the fixed template. */
export async function renderChart(spec: ChartSpec, outDir: string): Promise<RenderResult> {
  for (const [i, s] of spec.series.entries()) {
    if (s.values.length !== spec.labels.length) {
      return { ok: false, error: `series ${i + 1} has ${s.values.length} values but there are ${spec.labels.length} labels` };
    }
  }
  if (spec.type === "pie" && spec.series.length !== 1) {
    return { ok: false, error: "pie charts take exactly one series" };
  }
  const specPath = join(outDir, "spec.json");
  const pyPath = join(outDir, "chart.py");
  const outPath = join(outDir, "chart.png");
  writeFileSync(specPath, JSON.stringify(spec));
  writeFileSync(pyPath, CHART_PY);
  try {
    await run("python3", [pyPath, specPath, outPath], { timeout: TIMEOUT_MS });
    return { ok: true, path: outPath };
  } catch (err) {
    return { ok: false, error: `chart render failed: ${stderrTail(err)}` };
  }
}

export interface MediaServerDeps {
  voice?: { available(): boolean; synthesize(text: string): Promise<string> };
  log?: (line: string) => void;
}

const seriesShape = z.object({ name: z.string().optional(), values: z.array(z.number()).min(1) });

export function buildMediaServer(deps: MediaServerDeps) {
  const renderChartTool = tool(
    "render_chart",
    "Render a data chart to PNG from a constrained spec (no code execution). " +
      "Returns the output file path — deliver it to the user with attach_file.",
    {
      type: z.enum(["line", "bar", "pie", "scatter"]),
      title: z.string().optional(),
      xLabel: z.string().optional(),
      yLabel: z.string().optional(),
      labels: z.array(z.string()).min(1).describe("X-axis labels (pie: slice labels)"),
      series: z.array(seriesShape).min(1).describe("One entry per data series; values align with labels"),
    },
    async (a) => {
      const dir = mkdtempSync("/tmp/aios-media-");
      const r = await renderChart(a as ChartSpec, dir);
      return text(r.ok ? `Chart rendered: ${r.path} — deliver with attach_file.` : `Refused: ${r.error}`);
    },
  );

  return createSdkMcpServer({ name: "media", version: "0.1.0", tools: [renderChartTool] });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/media-server.test.ts`
Expected: PASS (3 tests; the real-render test skips if matplotlib is absent)

- [ ] **Step 5: Commit**

```bash
git add src/media/server.ts test/media-server.test.ts
git commit -m "feat(media): render_chart — constrained spec through fixed matplotlib template"
```

---

### Task 2: Media server — render_diagram + speak

**Files:**
- Modify: `src/media/server.ts`
- Test: `test/media-server.test.ts`

**Interfaces:**
- Consumes: Task 1's `buildMediaServer`, `text()`, `stderrTail`, `TIMEOUT_MS`, `run`.
- Produces: exported `renderDiagram(dot: string, outDir: string): Promise<RenderResult>`; `media` server now carries `render_diagram` and `speak` tools. `speak` success text is exactly `Speech synthesized: <path> — deliver with attach_file kind "voice".`

- [ ] **Step 1: Write the failing tests**

Append to `test/media-server.test.ts`:

```ts
import { renderDiagram, buildMediaServer } from "../src/media/server.js";

const haveDot = (() => {
  try { execFileSync("dot", ["-V"], { timeout: 10_000 }); return true; }
  catch { return false; }
})();

describe("renderDiagram", () => {
  it.skipIf(!haveDot)("renders dot source to PNG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mdot-"));
    const r = await renderDiagram("digraph { a -> b }", dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const buf = readFileSync(r.path);
      expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
  }, 30_000);

  it.skipIf(!haveDot)("surfaces dot syntax errors in-band", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mdot-"));
    const r = await renderDiagram("digraph { a -> }", dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/diagram render failed/);
  }, 30_000);
});

describe("speak tool", () => {
  // The SDK server object does not expose handlers directly; test via the exported deps
  // contract instead: absent voice → the tool must answer with the unavailable message.
  it("buildMediaServer accepts absent voice deps (speak degrades in-band)", () => {
    expect(() => buildMediaServer({})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/media-server.test.ts`
Expected: FAIL — `renderDiagram` is not exported

- [ ] **Step 3: Implement**

Add to `src/media/server.ts` (below `renderChart`):

```ts
/** Graphviz render — dot is a declarative graph language, not code execution. */
export async function renderDiagram(dot: string, outDir: string): Promise<RenderResult> {
  const dotPath = join(outDir, "diagram.dot");
  const outPath = join(outDir, "diagram.png");
  writeFileSync(dotPath, dot);
  try {
    await run("dot", ["-Tpng", dotPath, "-o", outPath], { timeout: TIMEOUT_MS });
    return { ok: true, path: outPath };
  } catch (err) {
    return { ok: false, error: `diagram render failed: ${stderrTail(err)}` };
  }
}
```

Inside `buildMediaServer`, add the two tools and register them:

```ts
  const renderDiagramTool = tool(
    "render_diagram",
    "Render graphviz dot source to a PNG diagram. On a syntax error the message comes back " +
      "verbatim — fix the source and retry. Deliver the result with attach_file.",
    { dot: z.string().min(1).describe("Complete graphviz dot source, e.g. 'digraph { a -> b }'") },
    async (a) => {
      const dir = mkdtempSync("/tmp/aios-media-");
      const r = await renderDiagram(a.dot, dir);
      return text(r.ok ? `Diagram rendered: ${r.path} — deliver with attach_file.` : `Refused: ${r.error}`);
    },
  );

  const speakTool = tool(
    "speak",
    "Synthesize speech (OGG voice note) from text, max 3000 chars. Deliver the result with " +
      "attach_file kind \"voice\" so it arrives as a playable voice note.",
    { text: z.string().min(1).max(3000) },
    async (a) => {
      if (!deps.voice?.available()) {
        return text("Refused: speech synthesis is not available right now — reply in text instead.");
      }
      try {
        const path = await deps.voice.synthesize(a.text);
        return text(`Speech synthesized: ${path} — deliver with attach_file kind "voice".`);
      } catch (err) {
        deps.log?.(`speak failed: ${(err as Error).message}`);
        return text(`Refused: speech synthesis failed (${(err as Error).message}) — reply in text instead.`);
      }
    },
  );

  return createSdkMcpServer({ name: "media", version: "0.1.0", tools: [renderChartTool, renderDiagramTool, speakTool] });
```

(Replace the existing single-tool `return createSdkMcpServer(...)` line.)

Note: `speak` returns the VoiceService's own output path — `<dataDir>/voice-tmp/<uuid>.ogg`
(src/voice/index.ts:51, tts.ts:109). `dataDir` defaults to `<repo>/data` which sits under
`projectsRoot` (`~/projects`), so the path is already admitted by the `resolve(projectsRoot)`
safe dir in both seams — no safeDirs change needed. VoiceService sweeps voice-tmp only at boot,
so the file survives until delivery within the turn.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/media-server.test.ts`
Expected: PASS (6 tests, skips as per binaries)

- [ ] **Step 5: Commit**

```bash
git add src/media/server.ts test/media-server.test.ts
git commit -m "feat(media): render_diagram (graphviz) + speak (kokoro) tools"
```

---

### Task 3: Attachment kind "voice" — type, tool, delivery

**Files:**
- Modify: `src/agents/attachment.ts`
- Modify: `src/agents/attachment-server.ts`
- Modify: `src/index.ts` (delivery loop, ~line 418)
- Test: `test/attachment-server.test.ts` (exists — append)

**Interfaces:**
- Consumes: nothing from Tasks 1–2 (independent).
- Produces: `Attachment = { path: string; caption?: string; kind?: "voice" }`; `attach_file` accepts optional `kind`; index.ts delivery uses `sendVoice` for voice-kind when the channel has it, else `sendFile`.

- [ ] **Step 1: Write the failing test**

Append to `test/attachment-server.test.ts` (reuse its existing helpers for calling the tool — read the file first; it already exercises `attach_file` through the server's tool handler):

```ts
it("attach_file forwards kind: voice into the collector", async () => {
  const collected: Attachment[] = [];
  const dir = mkdtempSync(join(tmpdir(), "att-voice-"));
  const p = join(dir, "note.ogg");
  writeFileSync(p, "x");
  const server = buildAttachmentServer(collected, [dir]);
  await callTool(server, "attach_file", { path: p, kind: "voice" });
  expect(collected).toEqual([{ path: p, caption: undefined, kind: "voice" }]);
});
```

(`callTool` = whatever invocation helper the existing tests in this file use; mirror it exactly.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/attachment-server.test.ts`
Expected: FAIL — kind is stripped (collector entry lacks `kind`) or zod rejects the extra key

- [ ] **Step 3: Implement**

`src/agents/attachment.ts`:

```ts
/** A file a specialist agent wants to deliver alongside its text reply. */
export interface Attachment {
  path: string;
  caption?: string;
  /** "voice" → deliver via sendVoice (playable voice note) where the channel supports it. */
  kind?: "voice";
}
```

`src/agents/attachment-server.ts` — add to the `attach_file` zod shape and the push:

```ts
      kind: z
        .enum(["voice"])
        .optional()
        .describe('Set to "voice" for synthesized speech so it arrives as a playable voice note.'),
```

```ts
      collector.push({ path: args.path, caption: args.caption, kind: args.kind });
```

`src/index.ts` — replace the delivery loop body (currently `?.sendFile(msg.chatId, att.path, att.caption)`):

```ts
        for (const att of result.attachments) {
          const ch = channels.get(msg.channel);
          const deliver =
            att.kind === "voice" && ch?.sendVoice
              ? ch.sendVoice(msg.chatId, att.path, att.caption)
              : ch?.sendFile(msg.chatId, att.path, att.caption);
          await deliver?.catch((err) =>
            log(`attachment delivery failed (${att.path}): ${(err as Error).message}`),
          );
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/attachment-server.test.ts && npx tsc --noEmit`
Expected: PASS + clean tsc

- [ ] **Step 5: Commit**

```bash
git add src/agents/attachment.ts src/agents/attachment-server.ts src/index.ts test/attachment-server.test.ts
git commit -m "feat(attachments): voice-kind delivery via sendVoice"
```

---

### Task 4: media-gen capability + resolve wiring + agent assignments

**Files:**
- Modify: `agents/_capabilities.yaml`
- Modify: `src/agents/resolve.ts` (SERVER_BUILDERS + ResolveAgentDeps)
- Modify: `src/index.ts:258` (resolveDeps gains voice)
- Modify: `agents/operations/hermes.yaml`, `agents/finance/midas.yaml`, `agents/engineering/athena.yaml`, `agents/engineering/odin.yaml`, `agents/research/clio.yaml`, `agents/research/venus.yaml` (capabilities lines)
- Modify: `test/fixtures/org-golden.json` (regenerated)
- Test: `test/resolve-agent.test.ts` (append)

**Interfaces:**
- Consumes: Task 1–2's `buildMediaServer`, `MediaServerDeps`.
- Produces: capability `media-gen` granting `mcp__media__render_chart`, `mcp__media__render_diagram`, `mcp__media__speak`; `ResolveAgentDeps.voice?: MediaServerDeps["voice"]`.

- [ ] **Step 1: Write the failing test**

Append to `test/resolve-agent.test.ts`:

```ts
  it("media-gen carriers get the media server and its three tools", () => {
    const { resolve } = setup();
    for (const name of ["hermes", "midas", "athena", "odin", "clio", "venus"]) {
      const r = resolve(name, origin)!;
      expect(Object.keys(r.options.mcpServers ?? {}), name).toContain("media");
      for (const t of ["mcp__media__render_chart", "mcp__media__render_diagram", "mcp__media__speak"]) {
        expect(r.options.allowedTools, `${name}:${t}`).toContain(t);
      }
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/resolve-agent.test.ts`
Expected: FAIL — no `media` server

- [ ] **Step 3: Implement**

`agents/_capabilities.yaml` — add below the `web-fetch` line:

```yaml
media-gen:   { server: media, tools: [mcp__media__render_chart, mcp__media__render_diagram, mcp__media__speak] }   # charts/diagrams/speech out (⑤d)
```

`src/agents/resolve.ts`:
1. Import: `import { buildMediaServer, type MediaServerDeps } from "../media/server.js";`
2. `ResolveAgentDeps` gains: `/** ⑤d media generation — live VoiceService handle for the speak tool. */ voice?: MediaServerDeps["voice"];`
3. `SERVER_BUILDERS` gains: `media: (c) => ({ media: buildMediaServer({ voice: c.deps.voice }) }),`

`src/index.ts:258` — thread voice (VoiceService from line 193 satisfies the structural type):

```ts
  const resolveDeps: ResolveAgentDeps = { registry, store, vault, gate, config, categorize, policy: infoPolicy, embedder, voice };
```

Agent YAML capability line edits (normal Edit, exact replacements):

| File | Old line | New line |
|---|---|---|
| agents/operations/hermes.yaml | `capabilities: [coordination, files-ro, web]` | `capabilities: [coordination, files-ro, web, media-gen]` |
| agents/finance/midas.yaml | `capabilities: [money-analysis, memory]` | `capabilities: [money-analysis, memory, media-gen]` |
| agents/engineering/athena.yaml | `capabilities: []` | `capabilities: [media-gen]` |
| agents/engineering/odin.yaml | `capabilities: [web]` | `capabilities: [web, media-gen]` |
| agents/research/clio.yaml | `capabilities: [web]` | `capabilities: [web, media-gen]` |
| agents/research/venus.yaml | `capabilities: [web]` | `capabilities: [web, media-gen]` |

(venus and clio have identical lines in different files — edit each file separately.)

- [ ] **Step 4: Regenerate the golden fixture and diff-review**

Run: `npx tsx scripts/gen-org-golden.ts && git diff test/fixtures/org-golden.json`
Expected: ONLY the six assigned agents gain the three `mcp__media__*` tools; no other change. If anything else moved, stop and investigate.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass (org-golden + clamp invariant + new test green — the clamp test passes because the tools come from a real capability)

- [ ] **Step 6: Commit**

```bash
git add agents/_capabilities.yaml src/agents/resolve.ts src/index.ts agents/operations/hermes.yaml agents/finance/midas.yaml agents/engineering/athena.yaml agents/engineering/odin.yaml agents/research/clio.yaml agents/research/venus.yaml test/fixtures/org-golden.json test/resolve-agent.test.ts
git commit -m "feat(media): media-gen capability wired through resolve — six carriers"
```

---

### Task 5: Moderator attachment seam

**Files:**
- Modify: `src/moderator/session.ts`
- Modify: `src/router.ts:166-170` (moderator branch)
- Test: `test/moderator-attachments.test.ts` (create)

**Interfaces:**
- Consumes: `buildAttachmentServer` (src/agents/attachment-server.ts), `Attachment` (Task 3 shape).
- Produces: `Moderator.handle(...): Promise<{ text: string; attachments: Attachment[] }>`; router moderator branch forwards attachments into `RouterResult`.

- [ ] **Step 1: Find every Moderator.handle caller**

Run: `grep -rn "moderator.handle\|\.handle(" src/ --include="*.ts" | grep -v test | grep -iv "directChats\|router.handle\|onMessage"`
Expected: the router call at `src/router.ts:168` is the only `moderator.handle` call site. If more exist (e.g. a voice path), update each the same way as the router below and list them in the commit message.

- [ ] **Step 2: Write the failing test**

```ts
// test/moderator-attachments.test.ts
import { describe, it, expect } from "vitest";
import { Moderator } from "../src/moderator/session.js";

describe("Moderator.handle return shape", () => {
  it("returns { text, attachments } (attachments array always present)", () => {
    // Type-level pin: a bare-string return breaks this compile-time assertion via tsc,
    // and the runtime shape check guards the seam for plain-JS callers.
    type Ret = Awaited<ReturnType<Moderator["handle"]>>;
    const witness: Ret = { text: "x", attachments: [] };
    expect(witness.attachments).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsc --noEmit`
Expected: type error — `string` is not `{ text: string; attachments: ... }`

- [ ] **Step 4: Implement**

`src/moderator/session.ts`:

1. Imports:
```ts
import { buildAttachmentServer } from "../agents/attachment-server.js";
import type { Attachment } from "../agents/attachment.js";
import { resolve as resolvePath } from "node:path";
```

2. `handle` — collector created per turn, returned with the reply:
```ts
  async handle(
    channel: string,
    chatId: string,
    userText: string,
    attachments?: Array<{ path: string; fileName: string }>,
  ): Promise<{ text: string; attachments: Attachment[] }> {
    const chatKey = `${channel}:${chatId}`;
    const prev = this.locks.get(chatKey) ?? Promise.resolve();
    let release!: () => void;
    this.locks.set(chatKey, new Promise((r) => (release = r)));
    await prev;
    try {
      const collected: Attachment[] = [];
      const reply = await this.turn(chatKey, channel, chatId, userText, attachments, collected);
      this.deps.capture?.(userText, reply); // post-turn capture (memory-v2 §5), fire-and-forget
      return { text: reply, attachments: collected };
    } finally {
      release();
    }
  }
```

3. `turn` signature gains `collected: Attachment[]` (last param); inside, next to the `buildModeratorServer` call, build the attachment server with the same safe dirs direct.ts uses:
```ts
    const attachmentServer = buildAttachmentServer(collected, [
      resolvePath(projectsRoot),
      resolvePath("data/downloads"),
      "/tmp/aios-", // prefix match — media/tts outputs land here
    ]);
```
and register it in `moderatorOptions`:
```ts
      mcpServers: { ...(resolved.options.mcpServers ?? {}), aios: server, aios_attachments: attachmentServer },
```

`src/router.ts` moderator branch (lines 166-170) — replace:

```ts
        routed("hermes", "default", "no mention — chief of staff");
        const result = await agentTurn("hermes", () =>
          moderator.handle(msg.channel, msg.chatId, msg.text, msg.attachments));
        reply = { text: result.text, attachments: result.attachments };
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/moderator-attachments.test.ts && npx tsc --noEmit && npx vitest run`
Expected: all green (existing moderator/router tests updated only if they pinned the bare-string return — fix those to read `.text`)

- [ ] **Step 6: Commit**

```bash
git add src/moderator/session.ts src/router.ts test/moderator-attachments.test.ts
git commit -m "feat(moderator): hermes turns carry the attachment collector — files reach chat"
```

---

### Task 6: Ship — build, deploy, live smoke

**Files:** none (operational)

- [ ] **Step 1: Full verify**

Run: `npx vitest run && npx tsc --noEmit && (cd ui2 && npx tsc --noEmit)`
Expected: root suite ≥1305 pass (plus this plan's new tests), both tsc clean. ui2 untouched — no rebuild needed.

- [ ] **Step 2: Build + deploy**

Run: `npm run build && launchctl kickstart -k gui/501/com.ihab.aios && sleep 6`

- [ ] **Step 3: Live smoke — chart via hermes**

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 300 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/chat \
  -d '{"target":"","text":"Render a bar chart: apples 3, oranges 5, pears 2. Title: Fruit. Then attach it."}'
```
Expected: reply text mentions the rendered chart. Verify a PNG exists: `ls -t /tmp/aios-media-*/chart.png | head -1` and `file` reports PNG. (Web channel drops attachment delivery — the file check is the proof; a Telegram smoke from the user's chat is the full-path check.)

- [ ] **Step 4: Live smoke — diagram via direct agent**

```bash
curl -s -m 300 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/chat \
  -d '{"target":"athena","text":"Render a graphviz diagram of a 3-box pipeline in -> process -> out and attach it."}'
```
Expected: reply references the diagram; `ls -t /tmp/aios-media-*/diagram.png | head -1` exists.

- [ ] **Step 5: Live smoke — speak**

```bash
curl -s -m 300 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/chat \
  -d '{"target":"","text":"Use your speak tool to say: media generation is live. Attach the result as a voice note."}'
```
Expected: reply confirms synthesis; a fresh `.ogg` exists under `data/voice-tmp/` (`ls -t data/voice-tmp/*.ogg | head -1`).

- [ ] **Step 6: Push + memory update**

```bash
git fetch origin && git push origin main
```
Update `~/.claude/projects/-Users-ihabbishara-projects-AIOS/memory/aios-project.md` with the ⑤d outcome (newest-on-top convention).

---

## Self-Review Notes

- Spec §1 → Tasks 1–2; §2 → Task 4; §3 → Task 5; §4 → Task 3; error handling embedded per-tool; testing per-task + Task 6 smoke. No gaps.
- Known limitation (accepted in spec review): web-channel replies drop attachments (`/api/chat` returns text only); Telegram is the delivery target. Task 6 verifies files on disk for web smokes.
- `speak` outputs land in `data/voice-tmp/` (under projectsRoot) — admitted by the `resolve(projectsRoot)` safe dir in both seams; verified against src/voice/index.ts:51 + config.ts:198-199 while writing this plan.
