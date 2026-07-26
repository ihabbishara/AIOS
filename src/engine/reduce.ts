// src/engine/reduce.ts — pure reducer: JournalEvent[] → GoalState. No clock, no IO;
// events carry timestamps. Crash recovery is replay of this same function — the old
// engine's resetRunningNodes / stale-executing sweeps are deleted, replaced by fold.
import type {
  JournalEvent, NodeSpec, AttemptOutcome,
  GoalCreatedPayload, PlanRecordedPayload, ReplanRecordedPayload,
  WorkspacePreparedPayload, AttemptStartedPayload, RoundRecordedPayload,
  AttemptFinishedPayload, NodeCompletedPayload,
  ReviewRequestedPayload, ReviewResolvedPayload,
} from "./journal.js";
import { pausedStatus } from "./journal.js";

export type GoalPhase =
  | "running" | "paused-budget" | "paused-user" | "paused-api" | "awaiting-mail"
  | "done" | "failed" | "abandoned";

export interface NodeState {
  spec: NodeSpec;
  /** Persistent status. "running"/"ready" are DERIVED — see nodeStatus(). */
  status: "pending" | "done" | "failed" | "skipped" | "needs-review";
  /** Finished attempts of THIS node incarnation (reset when a replan replaces the node) —
   *  the retry budget. Attempt NUMBERS are goal-lifetime monotonic: see GoalState.attemptSeq. */
  attempts: number;
  runningAttempt: { attempt: number; deadlineTs: number; startedTs: number } | null;
  lastOutcome: AttemptOutcome | null;
  lastError: string | null;
  currentRound: number;
  loopRounds: number;                                     // critic rounds recorded (loop)
  runnerRounds: number;                                   // runner rounds recorded (verify)
  fixerRounds: number;                                    // highest fixer round recorded (verify)
  lastVerdict: { verdict: "approve" | "revise"; summary: string; reasons: string[] } | null;
  lastReport: { passed: boolean; summary: string; failures: string[] } | null;
  lastFeedback: string | null;
  lastArtifactRef: string | null;
  artifact: string | null;
  costCents: number;
  /** review.resolved{retry} grants one attempt past the cap; cleared by attempt.started. */
  reviewRetry: boolean;
  reviewObjections: string[] | null;
  reviewGuidance: string | null;
}

export interface GoalState {
  goalId: string;
  phase: GoalPhase;
  created: GoalCreatedPayload | null;
  planned: boolean;
  workspacePending: boolean;
  workspace: { taskDir: string | null; mode: "build" | "analyze" | null } | null;
  workspaceError: string | null;
  nodes: Map<string, NodeState>;
  order: string[];
  parkedOn: string | null;
  replansUsed: number;
  replannedFor: Set<string>;      // failed-node keys already answered by a replan patch
  /** Highest attempt# ever STARTED per node key — never reset, even when a replan
   *  replaces the node. The attempt.started UNIQUE claim is journal-wide, so a replaced
   *  node's fresh attempts must keep counting upward or they could never claim. */
  attemptSeq: Map<string, number>;
  lastResumeTs: number;           // wall-time base: goal.created / goal.resumed / ask.resumed
  spendCents: number;
  error: string | null;
}

const freshNode = (spec: NodeSpec): NodeState => ({
  spec, status: "pending", attempts: 0, runningAttempt: null,
  lastOutcome: null, lastError: null,
  currentRound: 0, loopRounds: 0, runnerRounds: 0, fixerRounds: 0,
  lastVerdict: null, lastReport: null, lastFeedback: null, lastArtifactRef: null,
  artifact: null, costCents: 0,
  reviewRetry: false, reviewObjections: null, reviewGuidance: null,
});

const freshState = (goalId: string): GoalState => ({
  goalId, phase: "running", created: null, planned: false,
  workspacePending: true, workspace: null, workspaceError: null,
  nodes: new Map(), order: [], parkedOn: null,
  replansUsed: 0, replannedFor: new Set(), attemptSeq: new Map(),
  lastResumeTs: 0, spendCents: 0, error: null,
});

/** Derived node status: dangling attempt → running; pending with all deps done → ready. */
export function nodeStatus(state: GoalState, key: string):
  "pending" | "ready" | "running" | "done" | "failed" | "skipped" | "needs-review" {
  const n = state.nodes.get(key);
  if (!n) return "pending";
  if (n.runningAttempt) return "running";
  if (n.status !== "pending") return n.status;
  const depsDone = n.spec.dependsOn.every((d) => state.nodes.get(d)?.status === "done");
  return depsDone ? "ready" : "pending";
}

export function reduce(events: JournalEvent[], initial?: GoalState): GoalState {
  const state = initial ? structuredClone(initial) : freshState(events[0]?.goalId ?? "");
  if (!state.goalId && events[0]) state.goalId = events[0].goalId;

  const addNode = (spec: NodeSpec): void => {
    if (!state.nodes.has(spec.key)) state.order.push(spec.key);
    state.nodes.set(spec.key, freshNode(spec));
  };

  for (const ev of events) {
    const p = ev.payload;
    switch (ev.type) {
      case "goal.created":
        state.created = p as unknown as GoalCreatedPayload;
        state.lastResumeTs = ev.ts;
        break;
      case "plan.recorded":
        for (const spec of (p as unknown as PlanRecordedPayload).nodes) addNode(spec);
        state.planned = true;
        break;
      case "replan.recorded": {
        const rp = p as unknown as ReplanRecordedPayload;
        for (const spec of rp.replaced) { addNode(spec); state.replannedFor.delete(spec.key); }
        for (const spec of rp.added) addNode(spec);
        for (const rt of rp.retargets) {
          const n = state.nodes.get(rt.node);
          if (n) n.spec = { ...n.spec, dependsOn: rt.dependsOn };
        }
        if (rp.kind === "replan") {
          state.replansUsed++;
          if (rp.forNode && state.nodes.get(rp.forNode)?.status === "failed") {
            state.replannedFor.add(rp.forNode);
          }
        }
        break;
      }
      case "workspace.prepared": {
        const wp = p as unknown as WorkspacePreparedPayload;
        state.workspacePending = false;
        state.workspace = { taskDir: wp.taskDir, mode: wp.mode };
        if (state.created && wp.taskDir) state.created = { ...state.created, projectDir: wp.taskDir };
        else if (state.created && wp.stripped) state.created = { ...state.created, projectDir: null };
        break;
      }
      case "workspace.failed":
        state.workspacePending = false;
        state.workspaceError = String((p as { error: string }).error);
        break;
      case "attempt.started": {
        const ap = p as unknown as AttemptStartedPayload;
        state.attemptSeq.set(ap.node, Math.max(state.attemptSeq.get(ap.node) ?? 0, ap.attempt));
        const n = state.nodes.get(ap.node);
        if (n) {
          n.runningAttempt = { attempt: ap.attempt, deadlineTs: ap.deadlineTs, startedTs: ev.ts };
          n.reviewRetry = false;
        }
        break;
      }
      case "round.recorded": {
        const rp = p as unknown as RoundRecordedPayload;
        const n = state.nodes.get(rp.node);
        if (!n) break;
        n.currentRound = Math.max(n.currentRound, rp.round);
        if (rp.feedback) n.lastFeedback = rp.feedback;
        n.lastArtifactRef = rp.artifactRef;
        if (rp.role === "critic") { n.loopRounds++; n.lastVerdict = rp.verdict ?? null; }
        if (rp.role === "runner") { n.runnerRounds++; n.lastReport = rp.report ?? null; }
        if (rp.role === "fixer") n.fixerRounds = Math.max(n.fixerRounds, rp.round);
        break;
      }
      case "attempt.finished": {
        const fp = p as unknown as AttemptFinishedPayload;
        const n = state.nodes.get(fp.node);
        if (!n) break;
        n.runningAttempt = null;
        n.attempts += 1;
        n.lastOutcome = fp.outcome;
        n.lastError = fp.error ?? null;
        n.costCents += fp.costCents;
        state.spendCents += fp.costCents;
        break;
      }
      case "node.completed": {
        const np = p as unknown as NodeCompletedPayload;
        const n = state.nodes.get(np.node);
        if (n) {
          n.status = "done";
          n.artifact = np.artifactRef;
          if (np.roundsUsed) n.currentRound = np.roundsUsed;
        }
        break;
      }
      case "node.failed": {
        const n = state.nodes.get(String((p as { node: string }).node));
        if (n) {
          n.status = "failed";
          n.lastError = String((p as { error?: string }).error ?? n.lastError ?? "failed");
        }
        break;
      }
      case "node.skipped": {
        const n = state.nodes.get(String((p as { node: string }).node));
        if (n && n.status === "pending") n.status = "skipped";
        break;
      }
      case "review.requested": {
        const rp = p as unknown as ReviewRequestedPayload;
        const n = state.nodes.get(rp.node);
        if (n) {
          n.status = "needs-review";
          n.reviewObjections = rp.objections;
          n.lastArtifactRef = rp.lastArtifactRef;
        }
        break;
      }
      case "review.resolved": {
        const rp = p as unknown as ReviewResolvedPayload;
        const n = state.nodes.get(rp.node);
        if (!n) break;
        n.reviewObjections = null;
        if (rp.verdict === "retry") {
          n.status = "pending";
          n.reviewRetry = true;
          n.reviewGuidance = rp.guidance ?? null;
          // Fresh rounds for the granted attempt — a resumed loop/verify must not
          // start at the cap it already hit.
          n.currentRound = 0;
          n.loopRounds = 0;
          n.runnerRounds = 0;
          n.fixerRounds = 0;
          // Clear ALL prior-attempt residue, not just the verdict: the verify worker seeds
          // `report = lastReport` on resume, so a stale failing report must not survive a retry.
          // Safety then doesn't rest implicitly on the round-reset + round>0 fixer guard.
          n.lastVerdict = null;
          n.lastReport = null;
          n.lastFeedback = null;
          state.lastResumeTs = ev.ts; // fresh wall-time window for the human-granted retry
        }
        // accept → node.completed follows in the same batch; abandon → node.failed follows.
        break;
      }
      case "ask.parked": {
        const ap = p as { node: string | null; mailId: string };
        if (ap.node) {
          const n = state.nodes.get(ap.node);
          if (n) n.status = "done";
        }
        state.parkedOn = ap.mailId;
        state.phase = "awaiting-mail";
        break;
      }
      case "ask.resumed":
        state.parkedOn = null;
        state.phase = "running";
        state.lastResumeTs = ev.ts;
        break;
      case "goal.paused":
        state.phase = pausedStatus((p as { reason: string }).reason);
        break;
      case "goal.resumed":
        state.phase = "running";
        state.lastResumeTs = ev.ts;
        break;
      case "goal.completed":
        state.phase = "done";
        break;
      case "goal.failed":
        state.phase = "failed";
        state.error = String((p as { error: string }).error);
        state.parkedOn = null;
        break;
      case "goal.abandoned":
        state.phase = "abandoned";
        state.parkedOn = null;
        break;
    }
  }
  return state;
}
