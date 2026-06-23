import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store/db.js";

function text(s: string) { return { content: [{ type: "text" as const, text: s }] }; }

function fmt(rows: { url: string; title: string; topic: string | null; note: string | null }[]): string {
  return rows.map((r) =>
    `  ${r.title} — ${r.url}${r.topic ? ` [${r.topic}]` : ""}${r.note ? `\n    ${r.note}` : ""}`
  ).join("\n") || "(none)";
}

export interface ResearchServerDeps { store: Store; }

/** Direct-CRUD MCP server for the research analyst's source library. Analysis-only — no gate, no outward effects. */
export function buildResearchServer(deps: ResearchServerDeps) {
  const { store } = deps;

  const saveSource = tool(
    "save_source",
    "Save (or update) a research source in the knowledge base, keyed by URL.",
    { url: z.string(), title: z.string(), topic: z.string().optional(), note: z.string().optional() },
    async (a) => {
      store.addResearchSource({ url: a.url, title: a.title, topic: a.topic ?? null, note: a.note ?? null });
      return text(`Saved source: ${a.title} (${a.url}).`);
    },
  );

  const listSources = tool(
    "list_sources",
    "List saved research sources, optionally filtered by exact topic.",
    { topic: z.string().optional() },
    async (a) => text(fmt(store.listResearchSources(a.topic))),
  );

  const searchSources = tool(
    "search_sources",
    "Search saved research sources by keyword (matches title, url, topic, note).",
    { query: z.string() },
    async (a) => text(fmt(store.searchResearchSources(a.query))),
  );

  return createSdkMcpServer({ name: "research", version: "0.1.0", tools: [saveSource, listSources, searchSources] });
}
