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
  void deps; // speak (Task 2) consumes voice/log
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
