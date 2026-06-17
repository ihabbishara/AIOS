import type { Store } from "../store/db.js";
import type { Initiative } from "./dream.js";
import { localParts } from "./clock.js";

/** One research task the planner emits: a title + the research question (becomes the job's `request`). */
export interface ResearchTask {
  title: string;
  question: string;
}

/** What we persist per task in `speculate:latest` so the morning brief can resolve status by job id. */
export interface SpeculateTask {
  title: string;
  slug: string;
  id: string;
}

/** Minimal slice of JobManager that runSpeculate needs — lets tests inject a stub. */
export interface SpeculateJobs {
  createJob(params: {
    playbook: string;
    title: string;
    request: string;
    channel: string;
    chatId: string;
  }): { id: string; slug: string };
}

export interface SpeculateDeps {
  store: Store;
  jobs: SpeculateJobs;
  /** Injected one-shot planner. The real one is `speculatePlanLLM`; tests pass a stub. */
  plan: (initiatives: Initiative[], recentTitles: string[]) => Promise<ResearchTask[]>;
  /** Hard cap on jobs enqueued per night (config.speculateMaxJobs). */
  maxJobs: number;
  nowFn?: () => Date;
  log?: (line: string) => void;
}

/**
 * The nightly speculate pass: read tonight's propose initiatives → plan ≤K research questions →
 * enqueue read-only research-report jobs → stamp `speculate:latest`.
 * Read-only: only ever calls jobs.createJob + store kv. Never gate.propose, never vault.write.
 */
export async function runSpeculate(deps: SpeculateDeps): Promise<void> {
  const now = (deps.nowFn ?? (() => new Date()))();
  const today = localParts(now).date;

  const raw = deps.store.kvGet("dream:latest");
  if (!raw) { deps.log?.("speculate: no dream:latest"); return; }

  let parsed: { date?: string; initiatives?: Initiative[] };
  try {
    parsed = JSON.parse(raw) as { date?: string; initiatives?: Initiative[] };
  } catch {
    deps.log?.("speculate: malformed dream:latest");
    return;
  }
  if (parsed.date !== today || !parsed.initiatives?.length) {
    deps.log?.("speculate: no fresh initiatives");
    return;
  }

  const recentTitles = readRecentTitles(deps.store);
  let planned: ResearchTask[];
  try {
    planned = await deps.plan(parsed.initiatives, recentTitles);
  } catch (err) {
    deps.log?.(`speculate: planner failed: ${(err as Error).message}`);
    return; // fail-silent
  }
  const tasks = (Array.isArray(planned) ? planned : []).slice(0, deps.maxJobs);
  if (!tasks.length) { deps.log?.("speculate: planner returned nothing"); return; }

  const stored: SpeculateTask[] = [];
  for (const t of tasks) {
    try {
      const job = deps.jobs.createJob({
        playbook: "research-report",
        title: t.title,
        request: t.question,
        channel: "system",
        chatId: "speculate",
      });
      stored.push({ title: t.title, slug: job.slug, id: job.id });
    } catch (err) {
      deps.log?.(`speculate: createJob failed for "${t.title}": ${(err as Error).message}`);
    }
  }
  if (!stored.length) return;
  deps.store.kvSet("speculate:latest", JSON.stringify({ date: today, tasks: stored }));
}

/** Prior night's task titles, for anti-repeat. Bad/absent value → none. */
function readRecentTitles(store: Store): string[] {
  try {
    const prev = store.kvGet("speculate:latest");
    if (!prev) return [];
    const tasks = (JSON.parse(prev).tasks ?? []) as SpeculateTask[];
    return tasks.map((t) => t.title);
  } catch {
    return [];
  }
}
