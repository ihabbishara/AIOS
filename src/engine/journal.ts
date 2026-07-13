// src/engine/journal.ts — goal_journal append/read. The journal is the source of truth
// for goal execution; tables are projections (project.ts, wired in a later task).
// Append-only; optimistic gseq claims: a failed INSERT on (goal_id, gseq) IS the
// claim-loss signal. Synchronous node:sqlite makes each append a natural critical section.
import type { Store, JournalRow } from "../store/db.js";
import { projectEvent } from "./project.js";

export type JournalEventType =
  | "goal.created" | "plan.recorded" | "replan.recorded"
  | "workspace.prepared" | "workspace.failed"
  | "attempt.started" | "round.recorded" | "attempt.finished"
  | "node.completed" | "node.failed" | "node.skipped"
  | "review.requested" | "review.resolved"
  | "ask.parked" | "ask.resumed"
  | "goal.paused" | "goal.resumed"
  | "goal.completed" | "goal.failed" | "goal.abandoned";

export interface NodeSpec {
  key: string;
  kind: "run" | "loop" | "verify";
  agent: string;
  critic: string | null;
  brief: string;
  dependsOn: string[];
  maxRounds: number;
}

export type AttemptOutcome = "ok" | "error" | "timeout" | "aborted" | "orphaned";

export interface JournalEvent {
  seq: number;
  goalId: string;
  gseq: number;
  type: JournalEventType;
  payload: Record<string, unknown>;
  v: number;
  ts: number;
}

export interface EventInput { type: JournalEventType; payload: Record<string, unknown> }

// ---- Payload shapes (constructed by engine/workers; read by reduce/project) ----

export interface GoalCreatedPayload {
  slug: string; title: string; request: string; department: string; lead: string;
  origin: { channel: string; chatId: string }; chainDepth: number;
  spawnedByMail: string | null; planSummary: string; goalDir: string | null;
  projectDir: string | null;
}
export interface PlanRecordedPayload { summary: string; needsWorkspace: string; nodes: NodeSpec[] }
export interface ReplanRecordedPayload {
  kind: "replan" | "resume";          // resume continuations don't count against the replan cap
  forNode: string | null;             // the failed/asking node this patch answers
  replaced: NodeSpec[];
  added: NodeSpec[];
  retargets: Array<{ node: string; dependsOn: string[] }>;
  reason: string;
}
export interface WorkspacePreparedPayload {
  taskDir: string | null;
  mode: "build" | "analyze" | null;
  /** Ineligible mail-goal carrying a planner-passed dir: hard-strip project_dir. */
  stripped?: boolean;
}
export interface AttemptStartedPayload {
  node: string; attempt: number; agent: string; deadlineTs: number; idempotencyKey: string;
}
export interface RoundRecordedPayload {
  node: string; attempt: number; round: number;
  /** One event per completed producer+critic pair ("critic"), runner round ("runner"),
   *  or fixer pass ("fixer"). */
  role: "critic" | "runner" | "fixer";
  verdict?: { verdict: "approve" | "revise"; summary: string; reasons: string[] };
  report?: { passed: boolean; summary: string; failures: string[] };
  feedback: string;
  artifactRef: string;
}
export interface AttemptFinishedPayload {
  node: string; attempt: number; outcome: AttemptOutcome; costCents: number; turns: number; error?: string;
}
export interface NodeCompletedPayload { node: string; artifactRef: string; roundsUsed: number }
/** Loop cap / verify cap reached without approval — node parks as needs-review (spec §4). */
export interface ReviewRequestedPayload { node: string; lastArtifactRef: string; objections: string[] }
export interface ReviewResolvedPayload {
  node: string;
  verdict: "accept" | "retry" | "abandon";
  by: string;
  /** retry only: injected as producer feedback on the granted attempt. */
  guidance?: string;
}

// ---- Append / read ----

const toEvent = (r: JournalRow): JournalEvent => ({
  seq: r.seq, goalId: r.goal_id, gseq: r.gseq, type: r.type as JournalEventType,
  payload: JSON.parse(r.payload) as Record<string, unknown>, v: r.v, ts: r.ts,
});

export function readJournal(store: Store, goalId: string): JournalEvent[] {
  return store.journalRead(goalId).map(toEvent);
}

const runTx = <T>(store: Store, fn: () => T): T =>
  store.inTransaction ? fn() : store.transaction(fn);

const isGseqConflict = (err: unknown): boolean =>
  err instanceof Error && err.message.includes("UNIQUE constraint failed") &&
  err.message.includes("goal_journal");

/** Append events atomically (sequential gseqs) plus optional relational writes in the
 *  same transaction. `claimLost(existing)` true → another context already won this
 *  claim → returns null, appends nothing. gseq conflicts from async interleaving retry
 *  with a fresh gseq (bounded). Joins an already-open Store.transaction. */
export function appendEvents(
  store: Store,
  goalId: string,
  events: EventInput[],
  opts?: { claimLost?: (existing: JournalEvent[]) => boolean; also?: () => void },
): JournalEvent[] | null {
  for (let tries = 0; tries < 20; tries++) {
    const existing = readJournal(store, goalId);
    if (opts?.claimLost?.(existing)) return null;
    const base = existing.length ? existing[existing.length - 1].gseq : 0;
    const now = Date.now();
    try {
      return runTx(store, () => {
        const out: JournalEvent[] = [];
        events.forEach((e, i) => {
          const seq = store.journalInsert(goalId, base + 1 + i, e.type, JSON.stringify(e.payload), now);
          const ev: JournalEvent = { seq, goalId, gseq: base + 1 + i, type: e.type, payload: e.payload, v: 1, ts: now };
          projectEvent(store, ev);
          out.push(ev);
        });
        opts?.also?.();
        return out;
      });
    } catch (err) {
      if (!isGseqConflict(err)) throw err;
      // Lost the gseq race to another async context — re-read, re-check the claim, retry.
    }
  }
  throw new Error(`goal ${goalId}: could not win a journal gseq after 20 tries`);
}

/** Claim predicate for attempt.started: true when this node+attempt is already claimed. */
export const attemptClaimed = (node: string, attempt: number) =>
  (events: JournalEvent[]): boolean =>
    events.some((e) => e.type === "attempt.started" &&
      e.payload.node === node && e.payload.attempt === attempt);

/** Test/recovery helper: write pre-built events with their original gseqs/timestamps. */
export function replayInto(store: Store, events: JournalEvent[]): void {
  for (const ev of events) {
    runTx(store, () => {
      store.journalInsert(ev.goalId, ev.gseq, ev.type, JSON.stringify(ev.payload), ev.ts);
      projectEvent(store, ev);
    });
  }
}
