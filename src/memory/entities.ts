// src/memory/entities.ts — entity layer for recall (memory-v2 spec §3): deterministic seeding,
// query expansion (alias ↔ canonical), doc linking, and evening LLM extraction over new titles.
import type { Store } from "../store/db.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import { tokenize } from "./tokenize.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface EntityRow { id: number; name: string; kind: string; aliases: string[] }

const KINDS = new Set(["person", "project", "merchant", "agent", "org"]);
const WATERMARK_KV = "entities:extract:last";

/** Deterministic, idempotent seeding: registry agents (+aliases), departments, bank counterparties.
 *  Counterparty NAMES only — used purely for query expansion; transaction data itself stays out
 *  of memory (pinned exclusion). */
export function seedEntities(store: Store, registry?: LoadedRegistry): void {
  if (registry) {
    const aliasesOf = new Map<string, string[]>();
    for (const [alias, canonical] of registry.agentOf) {
      if (alias !== canonical) aliasesOf.set(canonical, [...(aliasesOf.get(canonical) ?? []), alias]);
    }
    for (const name of registry.agents.keys()) {
      store.upsertEntity({ name, kind: "agent", aliases: aliasesOf.get(name) ?? [] });
    }
    for (const dept of registry.departments.keys()) {
      store.upsertEntity({ name: dept, kind: "org", aliases: [] });
    }
  }
  for (const c of store.distinctCounterparties()) {
    store.upsertEntity({ name: c, kind: "merchant", aliases: [] });
  }
}

const nameTokens = (s: string) => tokenize(s);
const subsetOf = (needles: string[], hay: Set<string>) => needles.length > 0 && needles.every((t) => hay.has(t));

/** Entities whose name (or one alias) is fully contained in the query tokens. */
export function matchEntities(entities: EntityRow[], qTokens: string[]): EntityRow[] {
  const q = new Set(qTokens);
  return entities.filter((e) => subsetOf(nameTokens(e.name), q) || e.aliases.some((a) => subsetOf(nameTokens(a), q)));
}

/** Expanded query: original tokens + every matched entity's name+alias tokens (spec §3). */
export function expandTokens(qTokens: string[], matched: EntityRow[]): string[] {
  const out = new Set(qTokens);
  for (const e of matched) {
    for (const t of nameTokens(e.name)) out.add(t);
    for (const a of e.aliases) for (const t of nameTokens(a)) out.add(t);
  }
  return [...out];
}

/** Entities textually present in a doc's token set — computed at index time. */
export function linkedEntityIds(entities: EntityRow[], docTokens: Set<string>): number[] {
  return entities
    .filter((e) => subsetOf(nameTokens(e.name), docTokens) || e.aliases.some((a) => subsetOf(nameTokens(a), docTokens)))
    .map((e) => e.id);
}

/** Evening extraction (spec §3): LLM over NEW doc titles since the watermark; fail-silent. */
export async function extractNewEntities(deps: {
  store: Store;
  extract: (titles: string[]) => Promise<Array<{ name: string; kind: string; aliases: string[] }>>;
  log?: (l: string) => void;
}): Promise<number> {
  const since = deps.store.kvGet(WATERMARK_KV) ?? "";
  const rows = deps.store.memoryTitlesSince(since, 100);
  if (!rows.length) return 0;
  try {
    const found = await deps.extract(rows.map((r) => r.title).filter(Boolean));
    let n = 0;
    for (const e of found) {
      if (!e.name?.trim() || !KINDS.has(e.kind)) continue;
      deps.store.upsertEntity({ name: e.name.trim(), kind: e.kind, aliases: (e.aliases ?? []).filter(Boolean) });
      n++;
    }
    deps.store.kvSet(WATERMARK_KV, rows[rows.length - 1].indexed_at);
    return n;
  } catch (err) {
    deps.log?.(`entity extraction failed: ${(err as Error).message}`);
    return 0;
  }
}

const EXTRACT_ENTITIES_SYSTEM =
  "You extract named entities from document titles for a personal search index. " +
  "Return ONLY a JSON array of {\"name\", \"kind\", \"aliases\"} objects where kind is one of " +
  "person|project|merchant|agent|org. Only include real, recurring entities (people, projects, " +
  "companies) — skip dates, generic words, and one-off phrases. Empty array if none.";

export function extractEntitiesLLM(model?: string, log?: (l: string) => void) {
  return async (titles: string[]): Promise<Array<{ name: string; kind: string; aliases: string[] }>> => {
    try {
      const q = query({
        prompt: `Titles:\n${titles.map((t) => `- ${t}`).join("\n")}\n\nJSON array only.`,
        options: {
          systemPrompt: EXTRACT_ENTITIES_SYSTEM, allowedTools: [], permissionMode: "dontAsk",
          settingSources: [], persistSession: false, maxTurns: 1, ...(model ? { model } : {}),
        },
      });
      for await (const msg of q) {
        if (msg.type === "result") {
          if (msg.subtype !== "success") return [];
          const m = /\[[\s\S]*\]/.exec(msg.result);
          return m ? (JSON.parse(m[0]) as Array<{ name: string; kind: string; aliases: string[] }>) : [];
        }
      }
      return [];
    } catch (err) {
      log?.(`extractEntitiesLLM failed: ${(err as Error).message}`);
      return [];
    }
  };
}
