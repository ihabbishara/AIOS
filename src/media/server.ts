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
export async function renderChart(spec: ChartSpec, outDir: string, pythonBin = "python3"): Promise<RenderResult> {
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
    await run(pythonBin, [pyPath, specPath, outPath], { timeout: TIMEOUT_MS });
    return { ok: true, path: outPath };
  } catch (err) {
    return { ok: false, error: `chart render failed: ${stderrTail(err)}` };
  }
}

/** Graphviz honors file-referencing attributes (image/imagepath/shapefile/fontpath/labelloc
 *  file loads) — an agent could embed an arbitrary local image's pixels into the delivered PNG,
 *  exfiltrating a file past its confinement. Strip those attributes from agent DOT before render
 *  (belt: also set GV_FILE_PATH to the staging dir so any survivor can't escape it). */
const GV_FILE_ATTRS = /\b(image|imagepath|shapefile|fontpath|imagescale)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s,;\]]+)/gi;
export function sanitizeDot(dot: string): string {
  return dot.replace(GV_FILE_ATTRS, "");
}

/** Graphviz render — dot is a declarative graph language, not code execution. */
export async function renderDiagram(dot: string, outDir: string): Promise<RenderResult> {
  const dotPath = join(outDir, "diagram.dot");
  const outPath = join(outDir, "diagram.png");
  writeFileSync(dotPath, sanitizeDot(dot));
  try {
    await run("dot", ["-Tpng", dotPath, "-o", outPath], {
      timeout: TIMEOUT_MS,
      env: { ...process.env, GV_FILE_PATH: outDir },
    });
    return { ok: true, path: outPath };
  } catch (err) {
    return { ok: false, error: `diagram render failed: ${stderrTail(err)}` };
  }
}

export interface MediaServerDeps {
  voice?: { available(): boolean; synthesize(text: string): Promise<string> };
  /** Python interpreter for chart renders (launchd PATH may lack the matplotlib one). */
  pythonBin?: string;
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
      const r = await renderChart(a as ChartSpec, dir, deps.pythonBin ?? "python3");
      return text(r.ok ? `Chart rendered: ${r.path} — deliver with attach_file.` : `Refused: ${r.error}`);
    },
  );

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
      'attach_file kind "voice" so it arrives as a playable voice note.',
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
}
