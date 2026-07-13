// src/engine/decide.ts — pure scheduler: fold states in, commands out. No IO; `now` is
// a parameter. The engine executes commands, appends the resulting events, and re-folds —
// so every rule here replays identically during crash recovery.
import { nodeStatus, type GoalState } from "./reduce.js";

export interface Caps {
  maxConcurrent: number;
  budgetAllowed: boolean;
  wallTimeMs: number;
  replanCap: number;
  plannerAvailable: boolean;
  maxAttempts: number;
}

export type Command =
  | { cmd: "PrepareWorkspace"; goalId: string }
  | { cmd: "StartAttempt"; goalId: string; node: string; attempt: number }
  | { cmd: "AbortAttempt"; goalId: string; node: string; attempt: number; reason: "timeout" }
  | { cmd: "FailNode"; goalId: string; node: string; error: string }
  | { cmd: "RequestReplan"; goalId: string; node: string; error: string }
  | { cmd: "ParkForBudget"; goalId: string }
  | { cmd: "CompleteGoal"; goalId: string }
  | { cmd: "FailGoal"; goalId: string; error: string };

const isFacade = (s: GoalState): boolean =>
  (s.created?.planSummary ?? "").startsWith("playbook:") ||
  (s.created?.planSummary ?? "").startsWith("mail:");

interface StartCandidate { goalId: string; node: string; attempt: number }

export function decide(states: GoalState[], caps: Caps, now: number): Command[] {
  const commands: Command[] = [];
  let running = 0;
  for (const s of states) for (const n of s.nodes.values()) if (n.runningAttempt) running++;

  const queues: StartCandidate[][] = []; // one queue per goal → round-robin merge below
  const budgetParked: string[] = [];

  for (const s of states) {
    if (!s.created) continue;
    if (s.phase !== "running" && s.phase !== "awaiting-mail") continue;

    // 1. Timeout sweep — applies while parked too; a hung SDK call must not hold a slot.
    for (const n of s.nodes.values()) {
      if (n.runningAttempt && now > n.runningAttempt.deadlineTs) {
        commands.push({ cmd: "AbortAttempt", goalId: s.goalId, node: n.spec.key, attempt: n.runningAttempt.attempt, reason: "timeout" });
      }
    }

    // 2. Exhausted attempts → node fails, journaled and visible — never a silent retry.
    let nodeFailed = false;
    for (const n of s.nodes.values()) {
      if (n.status === "pending" && !n.runningAttempt &&
          n.lastOutcome && n.lastOutcome !== "ok" && n.attempts >= caps.maxAttempts) {
        commands.push({ cmd: "FailNode", goalId: s.goalId, node: n.spec.key, error: n.lastError ?? n.lastOutcome });
        nodeFailed = true;
      }
    }
    if (nodeFailed) continue; // re-fold after node.failed lands

    // 3. Failed node → replan once per node key, else the goal fails (ports onNodeFailure).
    const failed = [...s.nodes.values()].find((n) => n.status === "failed" && !s.replannedFor.has(n.spec.key));
    if (failed) {
      const replannable = !isFacade(s) && caps.plannerAvailable && s.replansUsed < caps.replanCap;
      if (replannable) {
        commands.push({ cmd: "RequestReplan", goalId: s.goalId, node: failed.spec.key, error: failed.lastError ?? "failed" });
      } else {
        const capNote = !isFacade(s) && caps.plannerAvailable && s.replansUsed >= caps.replanCap
          ? ` (re-plans exhausted: ${caps.replanCap})` : "";
        commands.push({ cmd: "FailGoal", goalId: s.goalId, error: `node ${failed.spec.key} failed: ${failed.lastError ?? "unknown"}${capNote}` });
      }
      continue;
    }

    // 4. Start candidates: retries (errored, attempts left) then fresh ready nodes.
    //    Attempt NUMBERS continue from the goal-lifetime high-water mark (attemptSeq) —
    //    a replan-replaced node must not re-claim an attempt# the journal already holds.
    const retries: StartCandidate[] = [];
    const fresh: StartCandidate[] = [];
    for (const key of s.order) {
      const n = s.nodes.get(key)!;
      if (n.status !== "pending" || n.runningAttempt) continue;
      const nextAttempt = (s.attemptSeq.get(key) ?? 0) + 1;
      if (n.reviewRetry) {
        // Human-granted retry (review.resolved{retry}) — bypasses the attempts cap once.
        retries.push({ goalId: s.goalId, node: key, attempt: nextAttempt });
      } else if (n.lastOutcome && n.lastOutcome !== "ok" && n.attempts < caps.maxAttempts) {
        retries.push({ goalId: s.goalId, node: key, attempt: nextAttempt });
      } else if (n.attempts === 0 && !n.lastOutcome && nodeStatus(s, key) === "ready") {
        fresh.push({ goalId: s.goalId, node: key, attempt: nextAttempt });
      }
    }

    // Parked goals: retries only (a failing sibling must still fail the goal — locked
    // decision); no fresh starts, no completion, no wall-time until resumed.
    if (s.phase === "awaiting-mail") {
      if (retries.length && caps.budgetAllowed) queues.push(retries);
      continue;
    }

    // Nodes parked for human review exempt the goal from wall-time and the deadlock
    // guard — a goal waiting on a verdict is not stuck (verification-hardening §4).
    const anyNeedsReview = [...s.nodes.values()].some((n) => n.status === "needs-review");

    // 5. Wall-time — measured from the last resume event: a budget-parked goal resumed
    //    next morning gets a fresh window instead of instant failure.
    if (!anyNeedsReview && now > s.lastResumeTs + caps.wallTimeMs) {
      commands.push({ cmd: "FailGoal", goalId: s.goalId, error: "Goal wall-time budget exceeded" });
      continue;
    }

    // 6. Workspace before any attempt; a failed workspace fails the goal.
    if (s.workspaceError) {
      commands.push({ cmd: "FailGoal", goalId: s.goalId, error: `workspace setup failed: ${s.workspaceError}` });
      continue;
    }
    if (s.workspacePending) {
      commands.push({ cmd: "PrepareWorkspace", goalId: s.goalId });
      continue;
    }
    if (!s.planned) continue; // goal.created without plan.recorded (mid-append crash)

    // 7. All done → complete.
    const all = [...s.nodes.values()];
    if (all.length && all.every((n) => n.status === "done")) {
      commands.push({ cmd: "CompleteGoal", goalId: s.goalId });
      continue;
    }

    const startable = [...retries, ...fresh];
    if (startable.length) {
      if (!caps.budgetAllowed) { budgetParked.push(s.goalId); continue; }
      queues.push(startable);
      continue;
    }

    // 8. Deadlock guard: nothing running, nothing startable, pending remain → some node
    //    depends transitively on a failed/skipped node. Fail loudly, never hang.
    const anyRunning = all.some((n) => n.runningAttempt);
    if (!anyRunning && !anyNeedsReview && all.some((n) => n.status === "pending")) {
      commands.push({ cmd: "FailGoal", goalId: s.goalId, error: "stuck: unfinished nodes depend on failed/skipped nodes" });
    }
  }

  for (const goalId of budgetParked) commands.push({ cmd: "ParkForBudget", goalId });

  // 9. Round-robin fairness across goals — a wide early goal cannot starve later goals.
  let slots = Math.max(0, caps.maxConcurrent - running);
  while (slots > 0 && queues.some((q) => q.length)) {
    for (const q of queues) {
      if (slots === 0) break;
      const c = q.shift();
      if (!c) continue;
      commands.push({ cmd: "StartAttempt", ...c });
      slots--;
    }
  }
  return commands;
}
