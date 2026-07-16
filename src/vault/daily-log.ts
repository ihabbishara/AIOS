// src/vault/daily-log.ts — the daily-note integration the JobManager→GoalEngine migration dropped
// (commit 964e27a). A decoupled bus subscriber owns the Obsidian daily-note format; the engine is
// untouched. Spec: docs/superpowers/specs/2026-07-16-obsidian-daily-log-design.md.
import type { AiosEvent } from "../events.js";
import type { Store, GoalRow } from "../store/db.js";
import type { VaultWriter } from "./writer.js";
import { localDate, localHM } from "./writer.js";

const TERMINAL = new Set(["done", "failed", "abandoned"]);

/** `[[goals/<dir>/goal|<title>]]` when the goal dir is stamped (goal.md exists there), else the
 *  plain title — goal.created can fire before the dir is stamped. */
function goalLink(title: string, goalDir: string | null): string {
  return goalDir ? `[[goals/${goalDir}/goal|${title}]]` : title;
}

function terminalSuffix(status: string, error: string | null | undefined): string {
  return status === "failed" && error ? ` — ${error.slice(0, 80)}` : "";
}

/**
 * Bus handler: goal lifecycle → daily note. goal.created → "goal started", terminal goal.status →
 * "goal <status>". Everything else is a no-op (NO new bus event types — unknown types would hit the
 * LLM triage classifier). Any FS/store error is logged and swallowed: a daily-note miss must never
 * break goal processing or the bus.
 */
export function makeDailyLogger(deps: { vault: VaultWriter; store: Store; log?: (m: string) => void }): (e: AiosEvent) => void {
  return (e: AiosEvent): void => {
    try {
      if (e.type === "goal.created") {
        const g = deps.store.getGoal(e.goalId);
        deps.vault.appendDaily(`goal started: ${goalLink(g?.title ?? e.title, g?.goal_dir ?? null)}`);
      } else if (e.type === "goal.status" && TERMINAL.has(e.status)) {
        const g = deps.store.getGoal(e.goalId);
        const title = g?.title ?? e.goalId.slice(0, 8); // store race → id prefix, never a dropped line
        deps.vault.appendDaily(`goal ${e.status}: ${goalLink(title, g?.goal_dir ?? null)}${terminalSuffix(e.status, e.error)}`);
      }
    } catch (err) {
      deps.log?.(`daily-log: ${(err as Error).message}`);
    }
  };
}

/**
 * One-time backfill of the daily-note gap: date → ordered `- HH:MM <line>` strings, in LOCAL time
 * (matching the fixed appendDaily). A started line at created_at, a terminal line at updated_at when
 * the goal ended. Dates already present in `existingDates` are omitted entirely — never append to an
 * existing file, so re-running the backfill is a no-op.
 */
export function buildBackfillDays(goals: GoalRow[], existingDates: Set<string>): Map<string, string[]> {
  const byDate = new Map<string, Array<{ hm: string; line: string }>>();
  const add = (iso: string, body: string) => {
    const d = new Date(iso);
    const date = localDate(d);
    if (existingDates.has(date)) return;
    const hm = localHM(d);
    (byDate.get(date) ?? byDate.set(date, []).get(date)!).push({ hm, line: `- ${hm} ${body}` });
  };
  for (const g of goals) {
    add(g.created_at, `goal started: ${goalLink(g.title, g.goal_dir)}`);
    if (TERMINAL.has(g.status)) {
      add(g.updated_at, `goal ${g.status}: ${goalLink(g.title, g.goal_dir)}${terminalSuffix(g.status, g.error)}`);
    }
  }
  const out = new Map<string, string[]>();
  for (const [date, items] of byDate) {
    items.sort((a, b) => a.hm.localeCompare(b.hm));
    out.set(date, items.map((i) => i.line));
  }
  return out;
}
