// src/heartbeat/wiki.ts — nightly wiki maintenance: ingest what the record gained into
// the LLM Wiki, so knowledge compounds instead of being re-derived per run.
//
// Measured before this existed: of 324 recall hits, 308 (95.1%) landed on 22 hand-written
// knowledge/ files, while 436 per-run pipeline artifacts were almost never read and jobs/
// (162 docs) never once. The pile grows on its own; the understanding did not.
//
// Discipline that matters more than the code:
//   - The agent NEVER edits the record. The schema says so, and vault_write is gated.
//   - The watermark only advances on a SUCCESSFUL pass. A failed or budget-skipped night
//     must re-offer the same files, or a day's record is silently never ingested.
import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import { capabilityTools } from "../agents/registry/loader.js";
import type { SpecialistRunFn } from "../agents/runner.js";
import type { SpendGuard } from "../engine/budget.js";
import type { AiosEvent } from "../events.js";

/** The record — everything the org writes. `wiki/` is deliberately absent: it is the output. */
export const RECORD_DIRS = [
  "briefs", "goals", "daily", "knowledge", "notes",
  "memos", "reports", "research", "finance", "ideas",
] as const;

const WATERMARK = "wiki:last-ingest";

/** Bounds one night's cost. A backlog drains over several nights instead of in one bill. */
export const DEFAULT_BATCH = 25;

/**
 * The agent that maintains the wiki, chosen by CAPABILITY rather than by name — every
 * install's org is generated at onboarding, so no specific agent is guaranteed to exist.
 *
 * Needs to write the wiki and read the record. Prefers a librarian-shaped department
 * (memoDomain "research"), its lead first; then the coordinator; then the first candidate
 * alphabetically so the choice is stable across boots.
 */
export function pickMaintainer(registry: LoadedRegistry, configured?: string): string | null {
  const can = (name: string): boolean => {
    const tools = capabilityTools(registry, name);
    return tools.some((t) => t.endsWith("vault_write"))
      && tools.some((t) => t.endsWith("recall") || t.endsWith("vault_read"));
  };
  const candidates = [...registry.agents.keys()].filter(can).sort();
  if (!candidates.length) return null;

  if (configured) {
    const canonical = registry.agentOf.get(configured) ?? configured;
    if (candidates.includes(canonical)) return canonical;
  }
  for (const [name, dept] of [...registry.departments].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (dept.memoDomain !== "research") continue;
    if (dept.lead && candidates.includes(dept.lead)) return dept.lead;
    const member = candidates.find((c) => registry.agents.get(c)?.department === name);
    if (member) return member;
  }
  if (candidates.includes(registry.coordinator)) return registry.coordinator;
  return candidates[0];
}

export interface WikiDeps {
  store: Store;
  vault: VaultWriter;
  registry: LoadedRegistry;
  run: SpecialistRunFn;
  spendGuard: SpendGuard;
  agent?: string;
  batch?: number;
  onEvent?: (e: AiosEvent) => void;
  log?: (l: string) => void;
  nowFn?: () => Date;
}

export interface WikiResult {
  status: "ingested" | "nothing-new" | "no-maintainer" | "budget" | "failed";
  files: number;
  agent?: string;
}

const PROMPT = (files: Array<{ path: string; mtime: string }>): string =>
  `You are the wiki maintainer for this vault. Run the INGEST workflow.

FIRST, read \`CLAUDE.md\` at the vault root. It is the schema and it governs everything
you do here. Then read \`index.md\` to see what already exists.

ABSOLUTE RULES:
- The record is IMMUTABLE. Read it. Never edit, move or delete anything in it.
- You may only create or edit files under \`wiki/\`.
- Never invent a fact. Ground every claim in the document you read.

These record files are new or changed since the last pass:

${files.map((f) => `- ${f.path}  (${f.mtime.slice(0, 10)})`).join("\n")}

Most of this is routine and deserves no page at all — briefs and per-run goal artifacts
usually restate what is already known. DO NOT create a page per file. The wiki earns its
keep by synthesising ACROSS the record: update the entity, concept and topic pages these
files bear on, and create a new page only where a genuinely new subject has appeared.

Prefer updating an existing page over creating a new one. Merge, do not duplicate.

Then, per the schema: update \`index.md\` for anything you created, and append ONE
\`ingest\` entry to \`log.md\` naming what you touched and any contradictions you found.
Flag contradictions rather than resolving them silently.

Report in plain text: pages created, pages updated, contradictions found, and anything
you deliberately skipped as too routine to file.`;

/**
 * One maintenance pass. Returns what happened so the caller can log it; never throws —
 * a failed wiki pass must not take down the clock tick.
 */
export async function runWikiMaintenance(deps: WikiDeps): Promise<WikiResult> {
  const now = (deps.nowFn ?? (() => new Date()))();
  // First ever run: look back a day rather than ingesting the entire history in one bill.
  // The existing corpus is seeded deliberately, not swept up by a cron.
  const since = deps.store.kvGet(WATERMARK) ?? new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

  const changed = deps.vault.notesModifiedSince(since, RECORD_DIRS);
  if (!changed.length) {
    deps.store.kvSet(WATERMARK, now.toISOString());
    deps.log?.("wiki: nothing new in the record");
    return { status: "nothing-new", files: 0 };
  }

  // Budget check BEFORE choosing an agent, and without advancing the watermark: these
  // files must be re-offered tomorrow rather than skipped forever.
  if (!deps.spendGuard.allow()) {
    deps.log?.(`wiki: budget cap reached, deferring ${changed.length} file(s)`);
    return { status: "budget", files: changed.length };
  }

  const agent = pickMaintainer(deps.registry, deps.agent);
  if (!agent) {
    deps.log?.("wiki: no agent holds both vault_write and recall — skipping");
    return { status: "no-maintainer", files: changed.length };
  }

  const batch = changed.slice(0, deps.batch ?? DEFAULT_BATCH);
  const context = "wiki:maintain";
  // start/end must be paired: an unpaired start leaves the agent stuck "working" forever
  // in the org view, whose liveRuns map clears only on agent.end.
  deps.onEvent?.({ type: "agent.start", agent, context });
  let res;
  try {
    res = await deps.run(agent, PROMPT(batch), { cwd: process.cwd() });
  } catch (err) {
    deps.onEvent?.({ type: "agent.end", agent, context, ok: false });
    // Watermark stays put: a failed pass re-offers the same files next night.
    deps.log?.(`wiki: ingest failed (${(err as Error).message}) — ${batch.length} file(s) deferred`);
    return { status: "failed", files: batch.length, agent };
  }

  // Advance only to the last file actually handed over, so a truncated batch leaves the
  // remainder queued rather than silently dropped.
  deps.store.kvSet(WATERMARK, batch[batch.length - 1].mtime);
  // costUsd MUST ride on agent.end: the ledger and the cost_daily rollup both key off it,
  // and an unattended nightly run recorded as free is exactly the gap that made chat spend
  // invisible for months (see router.ts / engine/budget.ts).
  deps.onEvent?.({ type: "agent.end", agent, context, ok: true, costUsd: res.costUsd });
  const left = changed.length - batch.length;
  deps.log?.(`wiki: ${agent} ingested ${batch.length} file(s)${left ? `, ${left} queued for tomorrow` : ""}`);
  return { status: "ingested", files: batch.length, agent };
}
