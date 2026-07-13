# Verification Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the goal engine's soft quality gates (verify-no-report, loop-cap proceed, self-approval) and replace approval-streak trust graduation with shadow-match evidence.

**Architecture:** Two new journal events (`review.requested` / `review.resolved`) drive a new `needs-review` node state through the existing fold→decide→dispatch loop; the attention queue gains a `review` kind resolved via a new `/api/goals/:id/review/:node` route. Shadow graduation adds a `shadow_decision` column on actions and a `shadow_matches` counter on trust; the gate scores human verdicts against what autonomy would have done and only proposes `trust.promote` after N consecutive matches.

**Tech Stack:** TypeScript, node:sqlite (`src/store/db.ts`), vitest, React (ui2/).

**Spec:** `docs/superpowers/specs/2026-07-11-verification-hardening-design.md`

## Global Constraints

- node:sqlite ONLY — no better-sqlite3, no FTS5, no new dependencies.
- Subscription auth only (CLAUDE_CODE_OAUTH_TOKEN) — never ANTHROPIC_API_KEY.
- Verify EVERY task with BOTH `npx vitest run <file>` AND (at the end) `npx tsc --noEmit` — vitest does not typecheck.
- Suite baseline before this plan: 1095 passed + 1 skipped. Never merge below green.
- New journal event kinds are a 3-file change: `journal.ts` (union + payload), `reduce.ts` (fold), `project.ts` (projection) — plus optional bus mapping in `engine.ts`.
- ui2 has its own node_modules; in a fresh worktree run `npm install` inside `ui2/` before `tsc` there.
- `AIOS_SHADOW_MATCHES` default 10 (spec §6). `maxRounds`/`maxAttempts` defaults unchanged (spec §9).

## Locked interpretation decisions (flag to user in final report)

1. **Verify failing-report-at-cap → `needs-review`** (spec gap): the spec's problem statement lists only "no report" and "loop cap", but the journaled engine also soft-passes a verify node whose final `TestReport.passed === false` (`workers.ts:271-274` always `finish("ok")`). This plan escalates that case through the same `review.requested` path with `objections = [summary, ...failures]`. A "verification hardening" spec that leaves verify unable to fail on a failing report would be absurd; this follows §4's "escalate, don't proceed" for the exact analog of loop-cap-without-approval.
2. **Wall-time + deadlock guard exempt while any node is `needs-review`**: a goal parked on a human verdict must not be failed by `wallTimeMs` or the "stuck" deadlock rule while it waits (mirrors how `awaiting-mail` goals skip wall-time). `review.resolved{retry}` resets `lastResumeTs` so the granted attempt gets a fresh window.

---

### Task 1: `review.requested` / `review.resolved` journal events + reducer

**Files:**
- Modify: `src/engine/journal.ts:8-15` (union), `:80` (payloads)
- Modify: `src/engine/reduce.ts` (NodeState, cases)
- Test: `test/review-lifecycle.test.ts` (new file)

**Interfaces:**
- Produces: `JournalEventType` gains `"review.requested" | "review.resolved"`.
- Produces: `ReviewRequestedPayload { node: string; lastArtifactRef: string; objections: string[] }`; `ReviewResolvedPayload { node: string; verdict: "accept" | "retry" | "abandon"; by: string; guidance?: string }`.
- Produces: `NodeState.status` gains `"needs-review"`; new fields `reviewRetry: boolean`, `reviewObjections: string[] | null`, `reviewGuidance: string | null`.

- [ ] **Step 1: Write the failing tests**

Create `test/review-lifecycle.test.ts`:

```ts
// test/review-lifecycle.test.ts — reducer + decide + projection for the needs-review
// lifecycle (verification-hardening spec §4, §7).
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { appendEvents, readJournal, type JournalEvent, type JournalEventType } from "../src/engine/journal.js";
import { reduce, nodeStatus } from "../src/engine/reduce.js";
import { decide, type Caps } from "../src/engine/decide.js";

let seq = 0;
const ev = (goalId: string, gseq: number, type: JournalEventType, payload: Record<string, unknown>, ts = 1000): JournalEvent =>
  ({ seq: ++seq, goalId, gseq, type, payload, v: 1, ts });

const node = (key: string, kind: "run" | "loop" = "loop", dependsOn: string[] = []) =>
  ({ key, kind, agent: "vulcan", critic: kind === "loop" ? "minos" : null, brief: "b", dependsOn, maxRounds: 3 });

/** created + planned + workspace-prepared base for one goal. */
function base(goalId: string, keys: Array<{ key: string; kind?: "run" | "loop"; deps?: string[] }>) {
  let g = 0;
  return [
    ev(goalId, ++g, "goal.created", {
      slug: goalId, title: goalId, request: "r", department: "engineering", lead: "athena",
      origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
      planSummary: "planned", goalDir: `d-${goalId}`, projectDir: null,
    }),
    ev(goalId, ++g, "plan.recorded", { summary: "s", needsWorkspace: "none", nodes: keys.map((k) => node(k.key, k.kind ?? "loop", k.deps ?? [])) }),
    ev(goalId, ++g, "workspace.prepared", { taskDir: null, mode: null }),
  ];
}
const more = (evs: JournalEvent[], type: JournalEventType, payload: Record<string, unknown>, ts = 1000) =>
  [...evs, ev(evs[0].goalId, evs[evs.length - 1].gseq + 1, type, payload, ts)];

const CAPS: Caps = { maxConcurrent: 2, budgetAllowed: true, wallTimeMs: 60_000, replanCap: 2, plannerAvailable: true, maxAttempts: 2 };

/** loop node "a" that ran attempt 1 to the cap and parked. */
function parked(extraNodes: Array<{ key: string; kind?: "run" | "loop"; deps?: string[] }> = []) {
  let evs = base("g1", [{ key: "a" }, ...extraNodes]);
  evs = more(evs, "attempt.started", { node: "a", attempt: 1, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:a:1" });
  evs = more(evs, "round.recorded", { node: "a", attempt: 1, round: 3, role: "critic",
    verdict: { verdict: "revise", summary: "no", reasons: ["r1", "r2"] }, feedback: "no", artifactRef: "a-v3.md" });
  evs = more(evs, "attempt.finished", { node: "a", attempt: 1, outcome: "ok", costCents: 0, turns: 1 });
  evs = more(evs, "review.requested", { node: "a", lastArtifactRef: "a-v3.md", objections: ["r1", "r2"] });
  return evs;
}

describe("reduce — review lifecycle", () => {
  it("review.requested parks the node as needs-review with objections + lastArtifactRef", () => {
    const s = reduce(parked());
    const n = s.nodes.get("a")!;
    expect(n.status).toBe("needs-review");
    expect(n.reviewObjections).toEqual(["r1", "r2"]);
    expect(n.lastArtifactRef).toBe("a-v3.md");
    expect(nodeStatus(s, "a")).toBe("needs-review");
  });

  it("dependents of a parked node stay pending (not ready)", () => {
    const s = reduce(parked([{ key: "b", kind: "run", deps: ["a"] }]));
    expect(nodeStatus(s, "b")).toBe("pending");
  });

  it("review.resolved{retry} → pending + reviewRetry + guidance, rounds reset, fresh wall-time base", () => {
    const evs = more(parked(), "review.resolved", { node: "a", verdict: "retry", by: "ihab", guidance: "shorter" }, 5000);
    const s = reduce(evs);
    const n = s.nodes.get("a")!;
    expect(n.status).toBe("pending");
    expect(n.reviewRetry).toBe(true);
    expect(n.reviewGuidance).toBe("shorter");
    expect(n.currentRound).toBe(0);
    expect(n.lastVerdict).toBeNull();
    expect(s.lastResumeTs).toBe(5000);
  });

  it("attempt.started consumes the reviewRetry grant", () => {
    let evs = more(parked(), "review.resolved", { node: "a", verdict: "retry", by: "ihab" });
    evs = more(evs, "attempt.started", { node: "a", attempt: 2, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:a:2" });
    expect(reduce(evs).nodes.get("a")!.reviewRetry).toBe(false);
  });

  it("review.resolved{accept} + node.completed in one batch completes the node", () => {
    let evs = more(parked(), "review.resolved", { node: "a", verdict: "accept", by: "ihab" });
    evs = more(evs, "node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 3 });
    const n = reduce(evs).nodes.get("a")!;
    expect(n.status).toBe("done");
    expect(n.reviewObjections).toBeNull();
  });

  it("review.resolved{abandon} + node.failed fails the node", () => {
    let evs = more(parked(), "review.resolved", { node: "a", verdict: "abandon", by: "ihab" });
    evs = more(evs, "node.failed", { node: "a", error: "review: abandoned by user" });
    expect(reduce(evs).nodes.get("a")!.status).toBe("failed");
  });
});

describe("decide — review rules", () => {
  it("a needs-review node is not started, not failed, and blocks completion", () => {
    const cmds = decide([reduce(parked())], CAPS, 1000);
    expect(cmds).toEqual([]); // idles awaiting the human — no FailGoal, no StartAttempt
  });

  it("wall-time does NOT fail a goal parked on review", () => {
    const cmds = decide([reduce(parked())], CAPS, 10_000_000);
    expect(cmds.filter((c) => c.cmd === "FailGoal")).toEqual([]);
  });

  it("deadlock guard does NOT fire while a node is needs-review", () => {
    const cmds = decide([reduce(parked([{ key: "b", kind: "run", deps: ["a"] }]))], CAPS, 1000);
    expect(cmds.filter((c) => c.cmd === "FailGoal")).toEqual([]);
  });

  it("review.resolved{retry} grants exactly one StartAttempt with the next attempt number", () => {
    const evs = more(parked(), "review.resolved", { node: "a", verdict: "retry", by: "ihab" }, 2000);
    const cmds = decide([reduce(evs)], CAPS, 2500);
    expect(cmds).toEqual([{ cmd: "StartAttempt", goalId: "g1", node: "a", attempt: 2 }]);
  });

  it("other branches keep running while one node is parked", () => {
    const evs = parked([{ key: "c", kind: "run" }]); // c has no deps
    const starts = decide([reduce(evs)], CAPS, 1000).filter((c) => c.cmd === "StartAttempt");
    expect(starts).toEqual([{ cmd: "StartAttempt", goalId: "g1", node: "c", attempt: 1 }]);
  });
});

describe("projection — review lifecycle", () => {
  function seeded() {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [
      { type: "goal.created", payload: {
        slug: "g1", title: "G", request: "r", department: "engineering", lead: "athena",
        origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
        planSummary: "planned", goalDir: "d-g1", projectDir: null } },
      { type: "plan.recorded", payload: { summary: "s", needsWorkspace: "none", nodes: [node("a")] } },
      { type: "workspace.prepared", payload: { taskDir: null, mode: null } },
      { type: "review.requested", payload: { node: "a", lastArtifactRef: "a-v3.md", objections: ["r1", "r2"] } },
    ]);
    return store;
  }

  it("review.requested projects needs-review + objections in error + artifact = last version", () => {
    const row = seeded().listNodes("g1")[0];
    expect(row.status).toBe("needs-review");
    expect(row.error).toBe("r1; r2");
    expect(row.artifact).toBe("a-v3.md");
    expect(row.finished_at).toBeTruthy();
  });

  it("review.resolved{retry} projects the node back to ready", () => {
    const store = seeded();
    appendEvents(store, "g1", [{ type: "review.resolved", payload: { node: "a", verdict: "retry", by: "ihab" } }]);
    expect(store.listNodes("g1")[0].status).toBe("ready");
  });

  it("needsReviewNodes lists parked nodes of unfinished goals only", () => {
    const store = seeded();
    const rows = store.needsReviewNodes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ goal_id: "g1", node_key: "a", goal_slug: "g1", error: "r1; r2" });
    appendEvents(store, "g1", [{ type: "goal.failed", payload: { error: "x" } }]);
    expect(store.needsReviewNodes()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`review.requested` not in `JournalEventType`, `reviewObjections` missing, etc.)

Run: `npx vitest run test/review-lifecycle.test.ts`

- [ ] **Step 3: Implement journal.ts**

In `src/engine/journal.ts` extend the union (line 8-15):

```ts
export type JournalEventType =
  | "goal.created" | "plan.recorded" | "replan.recorded"
  | "workspace.prepared" | "workspace.failed"
  | "attempt.started" | "round.recorded" | "attempt.finished"
  | "node.completed" | "node.failed" | "node.skipped"
  | "review.requested" | "review.resolved"
  | "ask.parked" | "ask.resumed"
  | "goal.paused" | "goal.resumed"
  | "goal.completed" | "goal.failed" | "goal.abandoned";
```

After `NodeCompletedPayload` (line 80) add:

```ts
/** Loop cap / verify cap reached without approval — node parks as needs-review (spec §4). */
export interface ReviewRequestedPayload { node: string; lastArtifactRef: string; objections: string[] }
export interface ReviewResolvedPayload {
  node: string;
  verdict: "accept" | "retry" | "abandon";
  by: string;
  /** retry only: injected as producer feedback on the granted attempt. */
  guidance?: string;
}
```

- [ ] **Step 4: Implement reduce.ts**

Import the new payload types in the type import at `src/engine/reduce.ts:4-9` (add `ReviewRequestedPayload, ReviewResolvedPayload`).

`NodeState` (line 15): status union + fields:

```ts
  /** Persistent status. "running"/"ready" are DERIVED — see nodeStatus(). */
  status: "pending" | "done" | "failed" | "skipped" | "needs-review";
```

and after `costCents: number;`:

```ts
  /** review.resolved{retry} grants one attempt past the cap; cleared by attempt.started. */
  reviewRetry: boolean;
  reviewObjections: string[] | null;
  reviewGuidance: string | null;
```

`freshNode` (line 59) gains `reviewRetry: false, reviewObjections: null, reviewGuidance: null,`.

`nodeStatus` return type (line 76-77) gains `| "needs-review"` (the existing `if (n.status !== "pending") return n.status;` already passes it through).

In the `attempt.started` case (line 134-139), after setting `runningAttempt`:

```ts
        if (n) {
          n.runningAttempt = { attempt: ap.attempt, deadlineTs: ap.deadlineTs, startedTs: ev.ts };
          n.reviewRetry = false;
        }
```

New cases after `node.skipped` (line 187):

```ts
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
          n.lastVerdict = null;
          state.lastResumeTs = ev.ts; // fresh wall-time window for the human-granted retry
        }
        // accept → node.completed follows in the same batch; abandon → node.failed follows.
        break;
      }
```

- [ ] **Step 5: Implement decide.ts**

In `src/engine/decide.ts`, rule 4's candidate loop (line 80-89) — add the review-retry branch first:

```ts
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
```

Right before rule 5 (the wall-time check, line 98-103), compute the exemption and guard rules 5 and 8:

```ts
    // Nodes parked for human review exempt the goal from wall-time and the deadlock
    // guard — a goal waiting on a verdict is not stuck (verification-hardening §4).
    const anyNeedsReview = [...s.nodes.values()].some((n) => n.status === "needs-review");

    // 5. Wall-time — measured from the last resume event: ...
    if (!anyNeedsReview && now > s.lastResumeTs + caps.wallTimeMs) {
```

and rule 8 (line 132-135):

```ts
    const anyRunning = all.some((n) => n.runningAttempt);
    if (!anyRunning && !anyNeedsReview && all.some((n) => n.status === "pending")) {
```

- [ ] **Step 6: Implement projection + store (needed by this test file)**

`src/store/db.ts:8`:

```ts
export type NodeStatus = "pending" | "ready" | "running" | "done" | "failed" | "skipped" | "needs-review";
```

`updateNodeStatus` (line 659-667) — stamp `finished_at` for needs-review too (it is when work stopped; the attention queue sorts by it):

```ts
    const stamps =
      status === "running" ? ", started_at = ?" :
      status === "done" || status === "failed" || status === "skipped" || status === "needs-review" ? ", finished_at = ?" : "";
```

After `listNodes` (line 654-657) add:

```ts
  /** Nodes parked for human review on still-live goals (verification-hardening §4). */
  needsReviewNodes(): Array<{
    goal_id: string; node_key: string; agent: string; artifact: string | null;
    error: string | null; finished_at: string | null; goal_title: string; goal_slug: string;
  }> {
    return this.db.prepare(
      `SELECT tn.goal_id, tn.node_key, tn.agent, tn.artifact, tn.error, tn.finished_at,
              g.title AS goal_title, g.slug AS goal_slug
       FROM task_nodes tn JOIN goals g ON g.id = tn.goal_id
       WHERE tn.status = 'needs-review' AND g.status NOT IN ('done', 'failed', 'abandoned')
       ORDER BY tn.finished_at DESC`,
    ).all() as unknown as Array<{
      goal_id: string; node_key: string; agent: string; artifact: string | null;
      error: string | null; finished_at: string | null; goal_title: string; goal_slug: string;
    }>;
  }
```

`src/engine/project.ts` — import `ReviewRequestedPayload, ReviewResolvedPayload` in the type import (line 7-12) and add cases after `node.skipped` (line 101-108):

```ts
    case "review.requested": {
      const p = ev.payload as unknown as ReviewRequestedPayload;
      // artifact = last produced version so the UI can show it while parked;
      // node.completed overwrites it with the final file on accept.
      store.setNodeArtifact(goalId, p.node, p.lastArtifactRef);
      store.updateNodeStatus(goalId, p.node, "needs-review", p.objections.join("; ") || undefined);
      return;
    }
    case "review.resolved": {
      const p = ev.payload as unknown as ReviewResolvedPayload;
      if (p.verdict === "retry") store.updateNodeStatus(goalId, p.node, "ready");
      return; // accept → node.completed / abandon → node.failed project in the same batch
    }
```

- [ ] **Step 7: Run — expect PASS**

Run: `npx vitest run test/review-lifecycle.test.ts` → all pass.
Run: `npx vitest run test/reduce.test.ts test/decide.test.ts test/project.test.ts test/journal.test.ts` → no regressions.

- [ ] **Step 8: Commit**

```bash
git add src/engine/journal.ts src/engine/reduce.ts src/engine/decide.ts src/engine/project.ts src/store/db.ts test/review-lifecycle.test.ts
git commit -m "feat(verify): review.requested/resolved events — needs-review node lifecycle in reducer, decide, projection"
```

---

### Task 2: Workers — verify with no structured report = failed attempt (spec §3)

**Files:**
- Modify: `src/engine/workers.ts:236-276` (verify case)
- Test: `test/workers.test.ts` (extend verify describe)

**Interfaces:**
- Consumes: `AttemptOutcome`, `appendEvents` (already imported in workers.ts).
- Produces: a verify attempt whose runner yields no `structured` report journals `attempt.finished{outcome:"error", error:"no structured report"}` and NO `node.completed`; `runAttempt` returns `outcome: "error"`.

- [ ] **Step 1: Write the failing tests** — append inside `describe("runAttempt — verify nodes", ...)` in `test/workers.test.ts`:

```ts
  it("no structured report → attempt.finished{error}, no node.completed (spec §3 hard gate)", async () => {
    const { store, deps, goal } = harness(async () =>
      ({ text: "prose, no report", costUsd: 0.01, numTurns: 1 }), [VERIFY]);
    const res = await runAttempt(goal(), VERIFY, 1, deps);
    expect(res.outcome).toBe("error");
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({ outcome: "error", error: "no structured report" });
    expect(journalTypes(store)).not.toContain("node.completed");
  });

  it("retry after a no-report attempt runs the runner again (does not instant-fail)", async () => {
    let calls = 0;
    const { store, deps, goal } = harness(async () => {
      calls++;
      return calls === 1
        ? { text: "no report", costUsd: 0, numTurns: 1 }
        : { text: "ok", structured: { passed: true, summary: "s", failures: [] }, costUsd: 0, numTurns: 1 };
    }, [VERIFY]);
    await runAttempt(goal(), VERIFY, 1, deps);   // no-report → error
    const res = await runAttempt(goal(), VERIFY, 2, deps); // retry must actually run
    expect(calls).toBe(2);
    expect(res.outcome).toBe("ok");
    expect(payloadOf(store, "node.completed")[0]).toMatchObject({ node: "test" });
  });
```

- [ ] **Step 2: Run — expect FAIL** (today both finish `ok`)

Run: `npx vitest run test/workers.test.ts`

- [ ] **Step 3: Implement** — replace the `case "verify"` block (`workers.ts:236-276`) with (loop-cap escalation lands in Task 3; this task only changes the no-report exit and the loop condition):

```ts
      case "verify": {
        const st = nodeState();
        let report: TestReport | undefined = st?.lastReport ?? undefined;
        let round = st?.runnerRounds ?? 0;
        let fixedThrough = st?.fixerRounds ?? 0;
        // (!report && round > 0) = a fresh retry after a no-report attempt: run the runner again.
        while (round < spec.maxRounds && (!report || !report.passed)) {
          if (round > 0 && report && !report.passed && fixedThrough < round) {
            const fixBrief = [
              ctx,
              `# Failing verification (round ${round}) — fix these\n${report.summary}\n${report.failures.map((f) => `- ${f}`).join("\n")}`,
            ].join("\n\n");
            const fix = await runAgent(spec.critic!, fixBrief);
            save(`${spec.key}-fix-${round}.md`, fix.text, spec.critic!);
            recordRound({ node: spec.key, attempt, round, role: "fixer", feedback: report.summary, artifactRef: `${spec.key}-fix-${round}.md` });
            fixedThrough = round;
          }
          round++;
          const runnerBrief = [spec.brief, ctx, "Run the verification now."].filter(Boolean).join("\n\n");
          const res = await runAgent(spec.agent, runnerBrief);
          report = res.structured as TestReport | undefined;
          save(`${spec.key}-run-${round}.md`,
            report ? `**Passed:** ${report.passed}\n\n${report.summary}\n\n${report.failures.map((f) => `- ${f}`).join("\n")}` : res.text,
            spec.agent);
          recordRound({
            node: spec.key, attempt, round, role: "runner", report,
            feedback: report && !report.passed ? [report.summary, ...report.failures].join("\n- ") : "",
            artifactRef: `${spec.key}-run-${round}.md`,
          });
          if (!report) break;
        }
        if (!report) {
          // No parseable TestReport = the verification never ran — a failed attempt,
          // never a silent pass (spec §3). Normal attempt policy retries once.
          save(`${spec.key}.md`, "No structured test report produced.", spec.agent);
          appendEvents(store, goal.id, [{ type: "attempt.finished", payload: {
            node: spec.key, attempt, outcome: "error", costCents, turns, error: "no structured report",
          } }]);
          return { claimed: true, outcome: "error", sessionLimit: false };
        }
        const summary = `**Passed:** ${report.passed}\n\n${report.summary}${report.failures.length ? `\n\nFailures:\n${report.failures.map((f) => `- ${f}`).join("\n")}` : ""}`;
        const file = `${spec.key}.md`;
        save(file, summary, spec.agent);
        finish("ok", undefined, { artifactRef: file, roundsUsed: round });
        if (report && !report.passed) {
          deps.log?.(`node ${spec.key}: verification still failing after ${spec.maxRounds} rounds`);
        }
        break;
      }
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run test/workers.test.ts` — the two new tests pass; existing verify tests ("failing report triggers fixer…", "crash-resume after failing runner round…") still pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/workers.ts test/workers.test.ts
git commit -m "feat(verify): no structured TestReport = failed attempt, not silent pass (spec §3)"
```

---

### Task 3: Workers — cap without approval escalates via `review.requested` (spec §4 + interpretation #1)

**Files:**
- Modify: `src/engine/workers.ts` (loop case `:199-235`, verify case tail from Task 2)
- Test: `test/workers.test.ts` (invert `:126` soft-gate test; add verify + guidance tests)

**Interfaces:**
- Consumes: `ReviewRequestedPayload` shape from Task 1 (payload literal, no import needed).
- Produces: loop-at-cap and verify-failing-at-cap append `[attempt.finished{ok}, review.requested{node, lastArtifactRef, objections}]` atomically, no `node.completed`. `NodeState.reviewGuidance` is injected into producer/fixer briefs.

- [ ] **Step 1: Invert the pinned soft-gate test** — replace `test/workers.test.ts:126-133` with:

```ts
  it("cap without approval: review.requested with critic objections, no node.completed (spec §4)", async () => {
    const { store, deps, goal } = harness(async (role) =>
      role === "minos-eng"
        ? { text: "r", structured: { verdict: "revise", summary: "no", reasons: ["too long"] }, costUsd: 0, numTurns: 1 }
        : { text: "draft", costUsd: 0, numTurns: 1 }, [LOOP]);
    await runAttempt(goal(), LOOP, 1, deps);
    expect(journalTypes(store)).not.toContain("node.completed");
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({ outcome: "ok" });
    expect(payloadOf(store, "review.requested")[0]).toMatchObject({
      node: "impl", lastArtifactRef: "impl-v3.md", objections: ["too long"],
    });
    expect(store.listNodes("g1")[0]).toMatchObject({ status: "needs-review", error: "too long" });
  });

  it("review-retry attempt injects user guidance into the producer brief and runs fresh rounds", async () => {
    const briefs: string[] = [];
    const { store, deps, goal } = harness(async (role, brief) => {
      briefs.push(`${role}:${brief}`);
      if (role === "minos-eng") return { text: "r", structured: { verdict: "approve", summary: "ok", reasons: [] }, costUsd: 0, numTurns: 1 };
      return { text: "v", costUsd: 0, numTurns: 1 };
    }, [LOOP]);
    // seed: attempt 1 hit the cap, parked, user granted a retry with guidance
    appendEvents(store, "g1", [
      { type: "attempt.started", payload: { node: "impl", attempt: 1, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:impl:1" } },
      { type: "round.recorded", payload: { node: "impl", attempt: 1, round: 3, role: "critic",
        verdict: { verdict: "revise", summary: "no", reasons: ["r1"] }, feedback: "no", artifactRef: "impl-v3.md" } },
      { type: "attempt.finished", payload: { node: "impl", attempt: 1, outcome: "ok", costCents: 0, turns: 0 } },
      { type: "review.requested", payload: { node: "impl", lastArtifactRef: "impl-v3.md", objections: ["r1"] } },
      { type: "review.resolved", payload: { node: "impl", verdict: "retry", by: "ihab", guidance: "cut it to one page" } },
    ]);
    await runAttempt(goal(), LOOP, 2, deps);
    const producerBrief = briefs.find((b) => b.startsWith("vulcan:"))!;
    expect(producerBrief).toContain("cut it to one page");
    const rounds = payloadOf(store, "round.recorded");
    expect(rounds[rounds.length - 1]).toMatchObject({ round: 1, attempt: 2 }); // fresh rounds, not 4
    expect(payloadOf(store, "node.completed")[0]).toMatchObject({ node: "impl" });
  });
```

And append inside the verify describe:

```ts
  it("failing report at cap: review.requested with failures as objections (hard gate)", async () => {
    const { store, deps, goal } = harness(async (role) =>
      role === "vulcan"
        ? { text: "fix", costUsd: 0, numTurns: 1 }
        : { text: "r", structured: { passed: false, summary: "2 tests fail", failures: ["t1", "t2"] }, costUsd: 0, numTurns: 1 },
      [VERIFY]);
    await runAttempt(goal(), VERIFY, 1, deps);
    expect(journalTypes(store)).not.toContain("node.completed");
    expect(payloadOf(store, "review.requested")[0]).toMatchObject({
      node: "test", lastArtifactRef: "test-run-3.md", objections: ["2 tests fail", "t1", "t2"],
    });
  });
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run test/workers.test.ts`

- [ ] **Step 3: Implement the loop case** — replace `workers.ts:199-235` (`case "loop"`) with:

```ts
      case "loop": {
        const st = nodeState();
        let feedback = st?.lastFeedback ?? "";
        let lastOutput = st?.lastArtifactRef ? (vault.readGoalArtifact(goal.goal_dir!, st.lastArtifactRef) ?? "") : "";
        let approved = st?.lastVerdict?.verdict === "approve";
        let lastReasons: string[] = st?.lastVerdict?.reasons ?? [];
        let round = st?.currentRound ?? 0;
        const guidance = st?.reviewGuidance;
        while (!approved && round < spec.maxRounds) {
          round++;
          const producerBrief = [
            spec.brief, ctx,
            guidance ? `# User guidance (from review) — follow this\n${guidance}` : "",
            feedback ? `# Reviewer feedback (round ${round - 1}) — address every point\n${feedback}` : "",
            lastOutput ? `# Your previous version\n${truncate(lastOutput)}` : "",
          ].filter(Boolean).join("\n\n");
          const produced = await runAgent(spec.agent, producerBrief);
          lastOutput = produced.text;
          save(`${spec.key}-v${round}.md`, produced.text, spec.agent);

          const criticBrief = [
            `Review the following ${spec.agent} output against the original task.`,
            ctx,
            `# Output under review (round ${round})\n${truncate(produced.text)}`,
          ].join("\n\n");
          const review = await runAgent(spec.critic!, criticBrief);
          const verdict = review.structured as Verdict | undefined;
          save(`${spec.key}-review-${round}.md`,
            verdict ? `**Verdict:** ${verdict.verdict}\n\n${verdict.summary}\n\n${verdict.reasons.map((r) => `- ${r}`).join("\n")}` : review.text,
            spec.critic!);
          feedback = verdict ? [verdict.summary, ...verdict.reasons].join("\n- ") : review.text;
          if (verdict) lastReasons = verdict.reasons;
          recordRound({ node: spec.key, attempt, round, role: "critic", verdict, feedback, artifactRef: `${spec.key}-v${round}.md` });
          if (verdict?.verdict === "approve") approved = true;
        }
        if (!approved) {
          // Cap reached without approval: escalate, don't proceed (spec §4). One atomic
          // append — a crash can never leave a finished attempt without its park.
          appendEvents(store, goal.id, [
            { type: "attempt.finished", payload: { node: spec.key, attempt, outcome: "ok", costCents, turns } },
            { type: "review.requested", payload: { node: spec.key, lastArtifactRef: `${spec.key}-v${round}.md`, objections: lastReasons } },
          ]);
          break;
        }
        const file = `${spec.key}.md`;
        save(file, lastOutput, spec.agent);
        finish("ok", undefined, { artifactRef: file, roundsUsed: round });
        break;
      }
```

- [ ] **Step 4: Implement the verify tail** — in the Task-2 verify case, add guidance to the fix brief and replace the passed-check tail. The `fixBrief` literal becomes:

```ts
            const fixBrief = [
              ctx,
              guidance ? `# User guidance (from review) — follow this\n${guidance}` : "",
              `# Failing verification (round ${round}) — fix these\n${report.summary}\n${report.failures.map((f) => `- ${f}`).join("\n")}`,
            ].filter(Boolean).join("\n\n");
```

with `const guidance = st?.reviewGuidance;` added next to the other `st?.` reads at the top of the case. Then replace everything from `const summary = ...` down to the closing `break;` of the case with:

```ts
        if (!report.passed) {
          // Verification ran and FAILED at the cap — same escalation as loop-cap (spec §4;
          // plan interpretation #1). Failures become the outstanding objections.
          appendEvents(store, goal.id, [
            { type: "attempt.finished", payload: { node: spec.key, attempt, outcome: "ok", costCents, turns } },
            { type: "review.requested", payload: {
              node: spec.key, lastArtifactRef: `${spec.key}-run-${round}.md`,
              objections: [report.summary, ...report.failures],
            } },
          ]);
          break;
        }
        const summary = `**Passed:** true\n\n${report.summary}`;
        const file = `${spec.key}.md`;
        save(file, summary, spec.agent);
        finish("ok", undefined, { artifactRef: file, roundsUsed: round });
        break;
```

(The `deps.log?.("… still failing …")` line from Task 2 is deleted — that state now escalates.)

- [ ] **Step 5: Run — expect PASS**

Run: `npx vitest run test/workers.test.ts test/review-lifecycle.test.ts test/engine-core.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/engine/workers.ts test/workers.test.ts
git commit -m "feat(verify): loop/verify cap without approval parks node as needs-review via review.requested (spec §4)"
```

---

### Task 4: Engine — `resolveReview` verdicts + bus mapping (spec §4.4)

**Files:**
- Modify: `src/engine/engine.ts` (journal() switch `:99-120`; new method after `abandonGoal` `:466`)
- Test: `test/engine-review.test.ts` (new file)

**Interfaces:**
- Consumes: `harness`, `fixtureRegistry` exported from `test/engine-core.test.ts`; Task 1 events; `VaultWriter.writeGoalArtifact(goalDirName, fileName, content, frontmatter)` / `readGoalArtifact`.
- Produces: `GoalEngine.resolveReview(idOrSlug: string, nodeKey: string, verdict: "accept" | "retry" | "abandon", opts: { by: string; guidance?: string }): string` — the server route (Task 7) calls this.

- [ ] **Step 1: Write the failing tests** — create `test/engine-review.test.ts`:

```ts
// test/engine-review.test.ts — resolveReview verdict paths on the live engine (spec §4).
import { describe, it, expect, vi } from "vitest";
import { harness } from "./engine-core.test.js";
import { readJournal } from "../src/engine/journal.js";
import type { GoalEngine } from "../src/engine/engine.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";

/** run fn: producer emits drafts, critic always revises with reason "r1" → loop parks at cap. */
const alwaysRevise: SpecialistRunFn = async (role) =>
  role === "minos"
    ? { text: "r", structured: { verdict: "revise", summary: "no", reasons: ["r1"] }, costUsd: 0, numTurns: 1 }
    : { text: "draft", costUsd: 0, numTurns: 1 };

function loopGoal(engine: GoalEngine) {
  return engine.startPlannedGoal({
    title: "L", request: "loop it", department: "engineering", lead: "athena",
    origin: { channel: "t", chatId: "1" }, summary: "planned", needsWorkspace: "none",
    nodes: [{ node_key: "impl", type: "loop", agent: "vulcan", critic: "minos",
              brief: "b", depends_on: [], max_rounds: 2 }],
  });
}

async function parkedGoal(over: { run?: SpecialistRunFn } = {}) {
  const h = harness({ run: over.run ?? alwaysRevise });
  const g = loopGoal(h.engine);
  await vi.waitFor(() => expect(h.store.listNodes(g.id)[0].status).toBe("needs-review"));
  return { ...h, g };
}

describe("GoalEngine.resolveReview", () => {
  it("accept: node completes with waiver frontmatter, goal finishes", async () => {
    const { engine, store, vault, g } = await parkedGoal();
    const msg = engine.resolveReview(g.id, "impl", "accept", { by: "ihab" });
    expect(msg).toContain("accept");
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    const types = readJournal(store, g.id).map((e) => e.type);
    expect(types).toContain("review.resolved");
    expect(types).toContain("node.completed");
    const final = vault.readGoalArtifact(store.getGoal(g.id)!.goal_dir!, "impl.md")!;
    expect(final).toContain("approved-with-waiver: true"); // writeGoalArtifact renders `key: JSON(value)`
    expect(final).toContain("r1"); // objections listed in frontmatter
    expect(final).toContain("draft"); // body carried over, old frontmatter stripped
    expect(final.match(/^---$/gm)!.length).toBe(2); // exactly ONE frontmatter block (open+close), none doubled
  });

  it("retry: one new attempt runs with guidance; approval completes the node", async () => {
    let critiques = 0;
    const run: SpecialistRunFn = async (role, brief) => {
      if (role === "minos") {
        critiques++;
        // attempt 1 (2 rounds at cap): revise; retry attempt: approve
        return critiques <= 2
          ? { text: "r", structured: { verdict: "revise", summary: "no", reasons: ["r1"] }, costUsd: 0, numTurns: 1 }
          : { text: "r", structured: { verdict: "approve", summary: "ok", reasons: [] }, costUsd: 0, numTurns: 1 };
      }
      return { text: `draft(${brief.includes("make it shorter") ? "guided" : "unguided"})`, costUsd: 0, numTurns: 1 };
    };
    const { engine, store, g } = await parkedGoal({ run });
    engine.resolveReview(g.id, "impl", "retry", { by: "ihab", guidance: "make it shorter" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(store.listNodes(g.id)[0].status).toBe("done");
  });

  it("abandon: node fails and the normal failure path takes over", async () => {
    const { engine, store, g } = await parkedGoal();
    engine.resolveReview(g.id, "impl", "abandon", { by: "ihab" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    const types = readJournal(store, g.id).map((e) => e.type);
    expect(types).toContain("node.failed");
  });

  it("rejects a verdict on a node that is not awaiting review", async () => {
    const { engine, g, store } = await parkedGoal();
    expect(engine.resolveReview(g.id, "nope", "accept", { by: "ihab" })).toContain("not awaiting review");
    engine.resolveReview(g.id, "impl", "abandon", { by: "ihab" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(engine.resolveReview(g.id, "impl", "accept", { by: "ihab" })).toContain("not awaiting review");
  });
});
```

Note: `harness()` passes no `planner`, so the abandoned node's failure goes straight to `FailGoal` (replan unavailable) — that IS the normal `onNodeFailure` path.

- [ ] **Step 2: Run — expect FAIL** (`resolveReview` does not exist)

Run: `npx vitest run test/engine-review.test.ts`

- [ ] **Step 3: Implement** — in `src/engine/engine.ts`:

(a) `journal()` bus switch (after the `node.skipped` case, line 117-118):

```ts
        case "review.requested":
          this.emit({ type: "node.status", goalId, nodeKey: String(p.node), status: "needs-review", agent: agentOf(String(p.node)) }); break;
```

(b) New public method after `abandonGoal` (line 466):

```ts
  /** Apply a human verdict to a needs-review node (verification-hardening §4).
   *  accept → completes with a waiver in the artifact frontmatter; retry → one
   *  human-granted attempt with guidance as producer feedback; abandon → node fails
   *  into the normal onNodeFailure path. */
  resolveReview(idOrSlug: string, nodeKey: string, verdict: "accept" | "retry" | "abandon",
    opts: { by: string; guidance?: string }): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (g.legacy) return `Goal ${g.slug} is a frozen legacy goal — read-only.`;
    const state = this.fold(g.id);
    const n = state.nodes.get(nodeKey);
    if (!n || n.status !== "needs-review") return `Node ${nodeKey} of ${g.slug} is not awaiting review.`;
    const resolved: EventInput = { type: "review.resolved", payload: {
      node: nodeKey, verdict, by: opts.by, ...(opts.guidance ? { guidance: opts.guidance } : {}),
    } };
    if (verdict === "accept") {
      // Waiver is recorded in the FINAL artifact's frontmatter — "done with waiver"
      // is queryable, never silent (spec §4).
      const src = n.lastArtifactRef ? this.deps.vault.readGoalArtifact(g.goal_dir!, n.lastArtifactRef) : undefined;
      const body = src ? src.replace(/^---\n[\s\S]*?\n---\n\n?/, "") : `(missing artifact ${n.lastArtifactRef ?? "?"})`;
      const file = `${nodeKey}.md`;
      this.deps.vault.writeGoalArtifact(g.goal_dir!, file, body, {
        goal: g.id, node: nodeKey, role: n.spec.agent,
        "approved-with-waiver": true,
        objections: (n.reviewObjections ?? []).join("; "),
        "waived-by": opts.by,
      });
      this.journal(g.id, [resolved,
        { type: "node.completed", payload: { node: nodeKey, artifactRef: file, roundsUsed: n.currentRound } }]);
    } else if (verdict === "abandon") {
      this.journal(g.id, [resolved,
        { type: "node.failed", payload: { node: nodeKey, error: "review: abandoned by user" } }]);
    } else {
      this.journal(g.id, [resolved]);
    }
    this.tick();
    return `Node ${nodeKey} of ${g.slug}: ${verdict}.`;
  }
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run test/engine-review.test.ts test/engine-core.test.ts test/workers.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/engine/engine.ts test/engine-review.test.ts
git commit -m "feat(verify): GoalEngine.resolveReview — accept-with-waiver / guided retry / abandon verdicts (spec §4)"
```

---

### Task 5: `validateGraph` — no self-approval (spec §5)

**Files:**
- Modify: `src/engine/plan.ts:39-78`
- Test: `test/validate-selfcritic.test.ts` (new file)

**Interfaces:**
- Consumes: `validateGraph(nodes: GraphNodeSpec[], ctx: ValidateCtx)`; `ctx.registry.agentOf` canonicalizes aliases.
- Produces: loop with `agent === critic` (canonically) → `{ ok: false, error: "node <k>: producer and critic must be different agents (no self-approval) — pick a critic from another team" }`; verify analog with "runner and fixer … (no self-verification)". Planner retry feedback already relays this string verbatim (`validateOrExplain` → 2-attempt retry).

- [ ] **Step 1: Write the failing tests** — create `test/validate-selfcritic.test.ts`:

```ts
// test/validate-selfcritic.test.ts — producer≠critic / runner≠fixer (verification-hardening §5).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { validateGraph } from "../src/engine/plan.js";
import type { GraphNodeSpec } from "../src/engine/compile.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "vsc-"));
  const eng = join(root, "agents", "engineering");
  mkdirSync(eng, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  const agents: Array<[string, string]> = [
    ["athena", "kind: coordinator\n"],
    ["vulcan", ""],
    ["minos", "outputSchema: verdict\n"],
    ["janus", "outputSchema: verdict\naliases: [two-face]\n"],
    ["argus", "outputSchema: test-report\n"],
  ];
  for (const [n, extra] of agents) {
    writeFileSync(join(eng, `${n}.yaml`),
      `name: ${n}\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n${extra}`);
  }
  return loadRegistry(join(root, "agents"), join(root, "playbooks"));
}

const registry = fixtureRegistry();
const ctx = { registry, department: "engineering", origin: { channel: "telegram", chatId: "1" } };
const N = (over: Partial<GraphNodeSpec>): GraphNodeSpec =>
  ({ key: "a", type: "run", agent: "vulcan", brief: "b", deps: [], ...over });

describe("validateGraph — no self-approval (spec §5)", () => {
  it("rejects a loop whose producer is its own critic", () => {
    const r = validateGraph([N({ type: "loop", agent: "minos", critic: "minos" })], ctx);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("no self-approval");
  });

  it("catches self-approval hidden behind an alias", () => {
    const r = validateGraph([N({ type: "loop", agent: "janus", critic: "two-face" })], ctx);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("no self-approval");
  });

  it("rejects a verify whose runner is its own fixer", () => {
    const r = validateGraph([N({ type: "verify", agent: "argus", critic: "argus" })], ctx);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("no self-verification");
  });

  it("accepts a loop with a distinct (foreign) critic and a verify with a distinct fixer", () => {
    expect(validateGraph([N({ type: "loop", agent: "vulcan", critic: "minos" })], ctx)).toMatchObject({ ok: true });
    expect(validateGraph([N({ type: "verify", agent: "argus", critic: "vulcan" })], ctx)).toMatchObject({ ok: true });
  });
});
```

(If the loader rejects the `aliases:` key in this minimal manifest, check `src/agents/registry/types.ts` for the exact field name used by `AgentManifest` and adjust the YAML key — the alias test must stay.)

- [ ] **Step 2: Run — expect FAIL** (self-critic graphs validate ok today)

Run: `npx vitest run test/validate-selfcritic.test.ts`

- [ ] **Step 3: Implement** — in `src/engine/plan.ts`, inside the per-node loop, after the verify schema check (line 60-65) and before the loop's closing brace:

```ts
    // No self-approval (verification-hardening §5): a loop's producer may not be its own
    // critic; a verify's runner may not be its own fixer. Compare canonically — aliases
    // must not smuggle the same agent into both seats. Cross-department planning means a
    // foreign critic is always available, so this never makes a plan unsatisfiable.
    if ((n.type === "loop" || n.type === "verify") && n.critic) {
      const canon = (name: string) => ctx.registry.agentOf.get(name) ?? name;
      if (canon(n.agent) === canon(n.critic)) {
        return n.type === "loop"
          ? { ok: false, error: `node ${n.key}: producer and critic must be different agents (no self-approval) — pick a critic from another team` }
          : { ok: false, error: `node ${n.key}: runner and fixer must be different agents (no self-verification) — pick a fixer from another team` };
      }
    }
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run test/validate-selfcritic.test.ts test/validate-graph.test.ts test/goal-planner.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/engine/plan.ts test/validate-selfcritic.test.ts
git commit -m "feat(verify): validateGraph rejects self-critic loops and self-fixer verifies (spec §5)"
```

---

### Task 6: Trust shadow primitives — record fields, `recordShadowMatch`, schema, config (spec §6)

**Files:**
- Modify: `src/kernel/trust.ts`, `src/kernel/actions.ts` (ActionRow), `src/store/db.ts` (ALTERs `:386` area, `insertAction`, `upsertTrust`, `toTrustRecord`, new `shadowStats`), `src/config.ts:221-232`
- Test: `test/trust-shadow.test.ts` (new file)

**Interfaces:**
- Produces: `TrustRecord.shadowMatches: number`; `TrustPolicy.shadowMatches: number` (threshold, default 10, env `AIOS_SHADOW_MATCHES`); `recordShadowMatch(record, policy): { record: TrustRecord; promotionReady: boolean }`; `ActionRow.shadow_decision?: string | null`; `Store.shadowStats(): Array<{ type: string; matches: number; mismatches: number }>`.

- [ ] **Step 1: Write the failing tests** — create `test/trust-shadow.test.ts`:

```ts
// test/trust-shadow.test.ts — shadow-match counter semantics (verification-hardening §6).
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import {
  newRecord, recordApproval, recordRejection, recordShadowMatch, promote, demote,
  type TrustPolicy,
} from "../src/kernel/trust.js";

const NOW = "2026-07-14T10:00:00.000Z";
const POLICY: TrustPolicy = {
  graduationStreak: 3, graduationAgeDays: 0, shadowMatches: 3, alwaysSupervised: new Set(["trust.promote"]),
};

describe("recordShadowMatch", () => {
  it("counts consecutive matches while graduating and flags promotion at the threshold", () => {
    let rec = { ...newRecord("fake.op", NOW), state: "graduating" as const };
    let ready = false;
    for (let i = 1; i <= 3; i++) {
      ({ record: rec, promotionReady: ready } = recordShadowMatch(rec, POLICY));
      expect(rec.shadowMatches).toBe(i);
      expect(ready).toBe(i >= 3);
    }
  });

  it("is a no-op for non-graduating states", () => {
    const rec = newRecord("fake.op", NOW); // supervised
    expect(recordShadowMatch(rec, POLICY)).toEqual({ record: rec, promotionReady: false });
  });

  it("rejection resets the match counter AND demotes (mismatch semantics)", () => {
    const rec = { ...newRecord("fake.op", NOW), state: "graduating" as const, shadowMatches: 2 };
    const after = recordRejection(rec, NOW);
    expect(after.state).toBe("supervised");
    expect(after.shadowMatches).toBe(0);
  });

  it("promote and demote both reset the counter", () => {
    const rec = { ...newRecord("fake.op", NOW), state: "graduating" as const, shadowMatches: 5 };
    expect(promote(rec, NOW).shadowMatches).toBe(0);
    expect(demote(rec).shadowMatches).toBe(0);
  });
});

describe("store — shadow columns", () => {
  it("round-trips shadowMatches through upsertTrust/getTrust", () => {
    const store = new Store(":memory:");
    store.upsertTrust({ ...newRecord("fake.op", NOW), shadowMatches: 7 });
    expect(store.getTrust("fake.op")!.shadowMatches).toBe(7);
  });

  it("shadowStats aggregates matches (approved) vs mismatches (rejected) per type", () => {
    const store = new Store(":memory:");
    const base = {
      type: "fake.op", payload: "{}", preview: "p", origin_channel: "cli", origin_chat_id: "l",
      trust_state: "graduating", verdict_by: null as string | null, reject_reason: null, result: null,
      created_at: NOW, resolved_at: null as string | null, expires_at: "2099-01-01T00:00:00.000Z",
      shadow_decision: "execute" as string | null,
    };
    store.insertAction({ ...base, id: "a1", status: "executed", verdict_by: "ihab", resolved_at: NOW });
    store.insertAction({ ...base, id: "a2", status: "rejected", verdict_by: "ihab", resolved_at: NOW });
    store.insertAction({ ...base, id: "a3", status: "proposed" }); // pending — counts as neither
    store.insertAction({ ...base, id: "a4", status: "executed", verdict_by: "ihab", resolved_at: NOW, shadow_decision: null }); // not shadowed
    expect(store.shadowStats()).toEqual([{ type: "fake.op", matches: 1, mismatches: 1 }]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run test/trust-shadow.test.ts`

- [ ] **Step 3: Implement trust.ts** — in `src/kernel/trust.ts`:

`TrustRecord` gains (after `streak`):

```ts
  /** Consecutive shadow matches while graduating: human verdict agreed with what
   *  autonomy would have done. Reset by any mismatch/demotion/promotion (spec §6). */
  shadowMatches: number;
```

`TrustPolicy` gains (after `graduationAgeDays`):

```ts
  /** Consecutive shadow matches required while graduating before a promotion is proposed. */
  shadowMatches: number;
```

`DEFAULT_POLICY` gains `shadowMatches: 10,`. `newRecord` return gains `shadowMatches: 0,`. `recordRejection` gains `shadowMatches: 0,` in its return literal. `promote` becomes `{ ...record, state: "autonomous", graduatedAt: now, streak: 0, shadowMatches: 0 }`. `demote` becomes `{ ...record, state: "supervised", streak: 0, graduatedAt: null, shadowMatches: 0 }`.

New function after `recordApproval`:

```ts
/** Score one shadow match: the human approved an action autonomy would have executed.
 *  Only meaningful while graduating; promotionReady at the policy threshold (spec §6). */
export function recordShadowMatch(
  record: TrustRecord, policy: TrustPolicy,
): { record: TrustRecord; promotionReady: boolean } {
  if (record.state !== "graduating") return { record, promotionReady: false };
  const next = { ...record, shadowMatches: record.shadowMatches + 1 };
  return { record: next, promotionReady: next.shadowMatches >= policy.shadowMatches };
}
```

- [ ] **Step 4: Implement schema + store** — in `src/store/db.ts`, right after the `idx_actions_idem` migration block (line 386-387):

```ts
    // Migration (verification-hardening §6): shadow-mode graduation. shadow_decision is
    // stamped on graduating-type actions at propose time ("execute" = what autonomy would
    // have done); trust.shadow_matches counts consecutive human-verdict matches.
    try { this.db.exec("ALTER TABLE actions ADD COLUMN shadow_decision TEXT"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE trust ADD COLUMN shadow_matches INTEGER NOT NULL DEFAULT 0"); } catch { /* exists */ }
```

`insertAction` (line 1089): add `shadow_decision` to the column list and `a.shadow_decision ?? null` to the values (16 placeholders total):

```ts
  insertAction(a: ActionRow): void {
    this.db
      .prepare(
        `INSERT INTO actions (id, type, payload, preview, status, origin_channel, origin_chat_id,
                              trust_state, verdict_by, reject_reason, result, created_at, resolved_at, expires_at,
                              idempotency_key, shadow_decision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id, a.type, a.payload, a.preview, a.status, a.origin_channel, a.origin_chat_id,
        a.trust_state, a.verdict_by, a.reject_reason, a.result, a.created_at, a.resolved_at, a.expires_at,
        a.idempotency_key ?? null, a.shadow_decision ?? null,
      );
  }
```

`upsertTrust` — add the column and value:

```ts
  upsertTrust(t: TrustRecord): void {
    this.db
      .prepare(
        `INSERT INTO trust (action_type, state, approvals, rejections, streak, shadow_matches, first_seen, last_rejection, graduated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(action_type) DO UPDATE SET
           state=excluded.state, approvals=excluded.approvals, rejections=excluded.rejections,
           streak=excluded.streak, shadow_matches=excluded.shadow_matches, last_rejection=excluded.last_rejection,
           graduated_at=excluded.graduated_at, updated_at=excluded.updated_at`,
      )
      .run(
        t.actionType, t.state, t.approvals, t.rejections, t.streak, t.shadowMatches,
        t.firstSeen, t.lastRejection, t.graduatedAt, new Date().toISOString(),
      );
  }
```

`toTrustRecord` (line 1502) gains `shadowMatches: (r.shadow_matches as number) ?? 0,`.

New method after `expireActions` (line 1157):

```ts
  /** Per-type shadow scoring: human verdicts on actions proposed while graduating.
   *  match = approved (executed/failed with a verdict), mismatch = rejected (spec §6). */
  shadowStats(): Array<{ type: string; matches: number; mismatches: number }> {
    return this.db.prepare(
      `SELECT type,
              SUM(CASE WHEN status IN ('executed', 'failed') AND verdict_by IS NOT NULL THEN 1 ELSE 0 END) AS matches,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS mismatches
       FROM actions WHERE shadow_decision IS NOT NULL GROUP BY type ORDER BY type`,
    ).all() as unknown as Array<{ type: string; matches: number; mismatches: number }>;
  }
```

`src/kernel/actions.ts` — `ActionRow` gains (after `idempotency_key`):

```ts
  /** What autonomy would have done, stamped at propose time for graduating types ("execute"); null otherwise. */
  shadow_decision?: string | null;
```

`src/config.ts:221-232` — `trustPolicy` literal gains, after `graduationAgeDays`:

```ts
      shadowMatches: Number(process.env.AIOS_SHADOW_MATCHES ?? 10),
```

- [ ] **Step 5: Fix TrustPolicy literals flagged by the compiler**

Run: `npx tsc --noEmit` — every `TrustPolicy` object literal now missing `shadowMatches` fails (expected: `test/gate.test.ts:34`, `test/trust.test.ts`, possibly `test/permission-gate.test.ts`, `test/gate-idempotency.test.ts`, `test/router-gate.test.ts`). Add `shadowMatches: 3,` to test fixtures (small threshold keeps tests fast) — EXCEPT where a test would accidentally trigger promotion proposals it doesn't expect; for those use `shadowMatches: 99,`. In `test/gate.test.ts` `setup()` make it configurable:

```ts
  const policy: TrustPolicy = {
    graduationStreak: opts.streak ?? 3,
    graduationAgeDays: opts.ageDays ?? 0,
    shadowMatches: opts.shadowMatches ?? 2,
    alwaysSupervised: new Set(["trust.promote"]),
  };
```

with `opts` type extended to `{ expiryMs?: number; streak?: number; ageDays?: number; shadowMatches?: number }`.

- [ ] **Step 6: Run — expect PASS**

Run: `npx vitest run test/trust-shadow.test.ts test/trust.test.ts test/actions.test.ts && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add src/kernel/trust.ts src/kernel/actions.ts src/store/db.ts src/config.ts test/trust-shadow.test.ts test/gate.test.ts test/trust.test.ts
git commit -m "feat(trust): shadow-match primitives — shadow_decision column, shadow_matches counter, AIOS_SHADOW_MATCHES policy (spec §6)"
```

(Include any other test files touched in Step 5.)

---

### Task 7: Gate — shadow scoring replaces streak-time promotion proposal (spec §6)

**Files:**
- Modify: `src/kernel/gate.ts` (`propose` `:61-77`, `authoredPreview` `:93-97`, `trainOnApprove` `:183-205`)
- Test: `test/gate.test.ts` (rework `graduation loop` describe `:208-243`; update preview assertion at `:75`)

**Interfaces:**
- Consumes: `recordShadowMatch` from Task 6 (add to the `trust.js` import at gate.ts:6-8).
- Produces: promotion proposals now fire only after `policy.shadowMatches` consecutive matches while graduating; preview format `Promote <type> to autonomous (<n>/<threshold> consecutive shadow matches, <a> lifetime approvals, currently <state>)`.

- [ ] **Step 1: Rework the graduation tests** — replace `describe("graduation loop", ...)` in `test/gate.test.ts` with:

```ts
describe("graduation loop (shadow-mode, spec §6)", () => {
  /** Drive n propose+approve cycles of fake.op. */
  async function approveN(gate: ActionGate, n: number) {
    for (let i = 0; i < n; i++) {
      const row = await gate.propose({ type: "fake.op", payload: { v: `r${i}` }, preview: `run ${i}` }, ORIGIN);
      await gate.resolve(row.id, "approve", { by: "ihab" });
    }
  }

  it("streak flips to graduating WITHOUT proposing a promotion", async () => {
    const { gate, store } = setup({ streak: 3, ageDays: 0, shadowMatches: 2 });
    await approveN(gate, 3);
    expect(store.getTrust("fake.op")?.state).toBe("graduating");
    expect(store.listActions("proposed")).toHaveLength(0); // no promote yet — evidence first
  });

  it("graduating actions carry shadow_decision=execute; N consecutive matches propose promotion with evidence", async () => {
    const { gate, store } = setup({ streak: 3, ageDays: 0, shadowMatches: 2 });
    await approveN(gate, 3); // now graduating
    await approveN(gate, 2); // two shadowed approvals = two matches
    const shadowed = store.listActions().filter((a) => a.shadow_decision === "execute");
    expect(shadowed.length).toBe(2);
    expect(store.getTrust("fake.op")?.shadowMatches).toBe(2);
    const pending = store.listActions("proposed");
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe("trust.promote");
    expect(pending[0].preview).toContain("2/2 consecutive shadow matches");

    await gate.resolve(pending[0].id, "approve", { by: "ihab" });
    expect(store.getTrust("fake.op")?.state).toBe("autonomous");
    const auto = await gate.propose({ type: "fake.op", payload: { v: "free" }, preview: "free" }, ORIGIN);
    expect(auto.status).toBe("executed");
    expect(auto.shadow_decision ?? null).toBeNull(); // autonomous runs are not shadowed
  });

  it("a mismatch (reject while graduating) resets the counter AND demotes to supervised", async () => {
    const { gate, store } = setup({ streak: 3, ageDays: 0, shadowMatches: 3 });
    await approveN(gate, 3); // graduating
    await approveN(gate, 2); // 2 matches
    const row = await gate.propose({ type: "fake.op", payload: { v: "bad" }, preview: "bad" }, ORIGIN);
    await gate.resolve(row.id, "reject", { by: "ihab" });
    const trust = store.getTrust("fake.op")!;
    expect(trust.state).toBe("supervised");
    expect(trust.shadowMatches).toBe(0);
    expect(store.listActions("proposed")).toHaveLength(0);
  });

  it("no duplicate promotion proposal while one is already pending", async () => {
    const { gate, store } = setup({ streak: 3, ageDays: 0, shadowMatches: 1 });
    await approveN(gate, 3); // graduating
    await approveN(gate, 2); // 1st match proposes; 2nd must not duplicate
    expect(store.listActions("proposed").filter((a) => a.type === "trust.promote")).toHaveLength(1);
  });

  it("rejecting the promotion sends the target type back to supervised", async () => {
    const { gate, store } = setup({ streak: 3, ageDays: 0, shadowMatches: 1 });
    await approveN(gate, 4); // graduating after 3, 4th is the shadow match → promote proposed
    const promo = store.listActions("proposed").find((a) => a.type === "trust.promote")!;
    await gate.resolve(promo.id, "reject", { by: "ihab" });
    const trust = store.getTrust("fake.op")!;
    expect(trust.state).toBe("supervised");
    expect(trust.streak).toBe(0);
    expect(trust.shadowMatches).toBe(0);
    expect(store.getTrust("trust.promote")?.rejections ?? 0).toBe(0);
  });
});
```

Also update the authored-preview assertion in `it("gate authors trust.promote previews, ignoring caller-supplied text")` (`:75`): the expected string becomes the new format — assert `expect(row.preview).toContain("consecutive shadow matches")` instead of the old streak wording (keep the "ignores caller text" assertion).

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run test/gate.test.ts`

- [ ] **Step 3: Implement** — in `src/kernel/gate.ts`:

(a) Import: add `recordShadowMatch` to the import from `./trust.js`.

(b) `propose` — stamp the shadow decision on the row literal (after `trust_state: trust.state,`):

```ts
      // Shadow mode (spec §6): while graduating, record what autonomy would have done.
      // The human verdict is then scored as match/mismatch against it.
      shadow_decision: trust.state === "graduating" ? "execute" : null,
```

(c) `authoredPreview` trust.promote case:

```ts
      case "trust.promote": {
        const target = String(p.action_type ?? "");
        const t = this.deps.store.getTrust(target);
        return `Promote ${target} to autonomous (${t?.shadowMatches ?? 0}/${this.deps.policy.shadowMatches} consecutive shadow matches, ${t?.approvals ?? 0} lifetime approvals, currently ${t?.state ?? "unknown"})`;
      }
```

(d) Replace `trainOnApprove` and add `pendingPromotion`:

```ts
  private async trainOnApprove(row: ActionRow, now: string): Promise<void> {
    // Promotions carry their own bookkeeping (the executor flips the target type).
    if (row.type === "trust.promote") return;
    const { store, policy, bus } = this.deps;
    const trust = store.getTrust(row.type) ?? newRecord(row.type, now);
    const approved = recordApproval(trust, policy, now);
    let record = approved.record;
    if (approved.graduationReady) {
      // Streak+age earned only the GRADUATING state; promotion evidence is now
      // consecutive shadow matches, not the streak itself (spec §6).
      bus.emit({ type: "trust.changed", actionType: row.type, state: "graduating" });
    }
    let promotionReady = false;
    if (record.state === "graduating" && row.shadow_decision === "execute") {
      const scored = recordShadowMatch(record, policy);
      record = scored.record;
      promotionReady = scored.promotionReady;
    }
    store.upsertTrust(record);
    if (promotionReady && !this.pendingPromotion(row.type)) {
      try {
        await this.propose(
          // Preview text is gate-authored (authoredPreview) — carries the match record.
          { type: "trust.promote", payload: { action_type: row.type }, preview: "" },
          { channel: row.origin_channel, chatId: row.origin_chat_id },
        );
      } catch (err) {
        this.deps.log?.(`promotion proposal failed: ${(err as Error).message}`);
      }
    }
  }

  /** True when a trust.promote for this target is already queued — never double-propose. */
  private pendingPromotion(target: string): boolean {
    return this.deps.store.listActions("proposed", 200).some((a) =>
      a.type === "trust.promote" &&
      (JSON.parse(a.payload) as { action_type?: string }).action_type === target);
  }
```

(`trainOnReject` needs no change — `recordRejection`/`demote` now reset `shadowMatches` from Task 6.)

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run test/gate.test.ts test/gate-idempotency.test.ts test/permission-gate.test.ts test/router-gate.test.ts test/trust.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/kernel/gate.ts test/gate.test.ts
git commit -m "feat(trust): gate scores shadow matches while graduating; promotion proposed on N consecutive matches with evidence preview (spec §6)"
```

---

### Task 8: Attention kind `review` + review route + trust match rate (spec §4.3, §6)

**Files:**
- Modify: `src/web/dto.ts:155-168` (AttentionItem), `:47-56` (TrustInfo), `src/web/attention-view.ts`, `src/web/server.ts` (`/api/trust` `:240-242`, new review route near `:453`)
- Test: `test/attention-review.test.ts` (new file)

**Interfaces:**
- Consumes: `Store.needsReviewNodes()` (Task 1), `GoalEngine.resolveReview` (Task 4), `Store.shadowStats()` (Task 6).
- Produces: `AttentionItem.kind` gains `"review"` (severity 2, actions `["accept","retry","abandon","open"]`, ref `{goalId, node, slug, artifact?}`); `POST /api/goals/:id/review/:node` `{verdict, guidance?}` → `{message}`; `GET /api/trust` rows gain `matches`/`mismatches`.

- [ ] **Step 1: Write the failing tests** — create `test/attention-review.test.ts`:

```ts
// test/attention-review.test.ts — review kind in the needs-you queue (spec §4.3).
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { appendEvents } from "../src/engine/journal.js";
import { buildAttentionView } from "../src/web/attention-view.js";

function parkedStore() {
  const store = new Store(":memory:");
  appendEvents(store, "g1", [
    { type: "goal.created", payload: {
      slug: "build-x", title: "Build X", request: "r", department: "engineering", lead: "athena",
      origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
      planSummary: "planned", goalDir: "d", projectDir: null } },
    { type: "plan.recorded", payload: { summary: "s", needsWorkspace: "none", nodes: [
      { key: "impl", kind: "loop", agent: "vulcan", critic: "minos", brief: "b", dependsOn: [], maxRounds: 2 },
    ] } },
    { type: "workspace.prepared", payload: { taskDir: null, mode: null } },
    { type: "review.requested", payload: { node: "impl", lastArtifactRef: "impl-v2.md", objections: ["r1", "r2"] } },
  ]);
  return store;
}

describe("attention — review kind", () => {
  it("a parked node surfaces as kind review with verdict actions and goal/node refs", () => {
    const items = buildAttentionView(parkedStore());
    const review = items.find((i) => i.kind === "review")!;
    expect(review).toMatchObject({
      severity: 2,
      actions: ["accept", "retry", "abandon", "open"],
      ref: { goalId: "g1", node: "impl", slug: "build-x", artifact: "impl-v2.md" },
    });
    expect(review.title).toContain("Build X");
    expect(review.meta).toContain("r1");
  });

  it("resolving the review removes the item", () => {
    const store = parkedStore();
    appendEvents(store, "g1", [
      { type: "review.resolved", payload: { node: "impl", verdict: "accept", by: "ihab" } },
      { type: "node.completed", payload: { node: "impl", artifactRef: "impl.md", roundsUsed: 2 } },
    ]);
    expect(buildAttentionView(store).filter((i) => i.kind === "review")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run test/attention-review.test.ts`

- [ ] **Step 3: Implement dto.ts** — `AttentionItem` (line 155-168):

```ts
/** One row of the unified needs-you queue (Ember Cockpit spec §5, §9.1). */
export interface AttentionItem {
  kind: "approval" | "review" | "ask" | "goal" | "mail" | "sense";
  id: string;
  title: string;
  meta: string;
  /** 1 approvals · 2 reviews + asks · 3 failed/paused goals · 4 unread mail · 5 ambient. */
  severity: 1 | 2 | 3 | 4 | 5;
  ts: string;
  /** Inline verbs the row offers: approve, reject, accept, retry, answer, open, read, resume, abandon. */
  actions: string[];
  /** Kind-specific pointers the canvas needs (actionId, mailId, threadId, goalId, node, slug, status, sense, artifact). */
  ref: Record<string, string>;
}
```

`TrustInfo` (line 47-56) gains:

```ts
  shadowMatches: number;
  /** Shadow scoring across all resolved graduating-era actions (matches = approved, mismatches = rejected). */
  matches?: number;
  mismatches?: number;
```

- [ ] **Step 4: Implement attention-view.ts** — update the header comment (line 3-4: replace "Graduation offers join here when the verification-hardening spec ships." with "+ nodes parked for review (verification-hardening §4)"), and insert between section 1 (approvals) and section 2 (asks):

```ts
  // 2 — nodes parked at a quality cap awaiting a verdict (verification-hardening §4)
  for (const n of store.needsReviewNodes()) {
    items.push({
      kind: "review", id: `${n.goal_id}:${n.node_key}`,
      title: `${n.goal_title} · ${n.node_key} hit its quality cap`,
      meta: firstLine(n.error ?? "no objections recorded"),
      severity: 2, ts: n.finished_at ?? nowIso,
      actions: ["accept", "retry", "abandon", "open"],
      ref: {
        goalId: n.goal_id, node: n.node_key, slug: n.goal_slug,
        ...(n.artifact ? { artifact: n.artifact } : {}),
      },
    });
  }
```

- [ ] **Step 5: Implement server.ts** — after the `goalCtl` route (line 453-461) add:

```ts
        const reviewCtl = /^\/api\/goals\/([\w-]+)\/review\/([\w-]+)$/.exec(path);
        if (reviewCtl && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { verdict?: string; guidance?: string };
          if (body.verdict !== "accept" && body.verdict !== "retry" && body.verdict !== "abandon") {
            return json(res, 400, { error: "verdict must be accept, retry, or abandon" });
          }
          const message = goals.resolveReview(reviewCtl[1], reviewCtl[2], body.verdict,
            { by: "ui", guidance: body.guidance?.trim() || undefined });
          return json(res, 200, { message });
        }
```

and replace the `/api/trust` GET handler (line 240-242):

```ts
        if (path === "/api/trust" && req.method === "GET") {
          // Per-type shadow match rate rides along for the Governance table (spec §6).
          const stats = new Map(store.shadowStats().map((s) => [s.type, s]));
          return json(res, 200, store.listTrust().map((t) => ({
            ...t,
            matches: stats.get(t.actionType)?.matches ?? 0,
            mismatches: stats.get(t.actionType)?.mismatches ?? 0,
          })));
        }
```

- [ ] **Step 6: Run — expect PASS**

Run: `npx vitest run test/attention-review.test.ts test/attention-view.test.ts test/goal-endpoints.test.ts && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add src/web/dto.ts src/web/attention-view.ts src/web/server.ts test/attention-review.test.ts
git commit -m "feat(verify): review attention kind + POST /api/goals/:id/review/:node + trust match rate on /api/trust (spec §4, §6)"
```

---

### Task 9: ui2 — review card, verdict round-trip, Governance shadow column

**Files:**
- Modify: `ui2/src/api.ts`, `ui2/src/lib/queue.ts`, `ui2/src/lib/topics.ts:9`, `ui2/src/views/Queue.tsx:9-12,58`, `ui2/src/views/Home.tsx:34-54`, `ui2/src/views/canvas/index.tsx`, `ui2/src/views/Staff.tsx:253-276`
- Create: `ui2/src/views/canvas/Review.tsx`
- Test: `ui2/test/queue.test.ts` (rewrite for kind grouping)

**Interfaces:**
- Consumes: `AttentionItem` kind `review` + `/api/goals/:id/review/:node` (Task 8); `GoalDetail.artifacts`, `GoalNodeView.error/artifact`; `useLiveQuery(fn, events, topics, extraDeps)`; ui components `Button/Empty/SectionLabel/TwoStepButton`.
- Produces: `api.resolveReview(goalId, node, verdict, guidance?)`; kind-keyed `GROUPS`.

- [ ] **Step 1: Rewrite the queue test** — replace `ui2/test/queue.test.ts` content with:

```ts
// ui2/test/queue.test.ts
import { describe, it, expect } from "vitest";
import { groupQueue, flatQueue } from "../src/lib/queue.js";
import type { AttentionItem } from "../src/api.js";

const item = (id: string, kind: AttentionItem["kind"], severity: 1 | 2 | 3 | 4 | 5, ts: string): AttentionItem =>
  ({ kind, id, title: id, meta: "", severity, ts, actions: [], ref: {} });

describe("groupQueue", () => {
  it("groups by kind in cockpit order, drops empty groups, ts-desc inside", () => {
    const groups = groupQueue([
      item("m", "mail", 4, "2026-01-02"), item("a2", "approval", 1, "2026-01-03"),
      item("a1", "approval", 1, "2026-01-01"), item("s", "sense", 5, "2026-01-01"),
      item("rv", "review", 2, "2026-01-01"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Approvals", "Reviews", "Mail", "Ambient"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a2", "a1"]);
  });
  it("flatQueue walks groups in order", () => {
    const groups = groupQueue([item("b", "goal", 3, "1"), item("a", "approval", 1, "1")]);
    expect(flatQueue(groups).map((i) => i.id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd ui2 && npx vitest run test/queue.test.ts`

- [ ] **Step 3: Implement queue.ts** — replace `GROUPS`/`groupQueue` in `ui2/src/lib/queue.ts`:

```ts
export const GROUPS = [
  { kind: "approval", severity: 1, label: "Approvals" },
  { kind: "review", severity: 2, label: "Reviews" },
  { kind: "ask", severity: 2, label: "Asks" },
  { kind: "goal", severity: 3, label: "Goals" },
  { kind: "mail", severity: 4, label: "Mail" },
  { kind: "sense", severity: 5, label: "Ambient" },
] as const;

export interface QueueGroup { label: string; severity: number; items: AttentionItem[] }

export function groupQueue(items: AttentionItem[]): QueueGroup[] {
  return GROUPS.map((g) => ({
    label: g.label,
    severity: g.severity,
    items: items.filter((i) => i.kind === g.kind).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)),
  })).filter((g) => g.items.length > 0);
}
```

- [ ] **Step 4: Implement the rest**

(a) `ui2/src/api.ts` — after `goalAction`:

```ts
  resolveReview: (goalId: string, node: string, verdict: "accept" | "retry" | "abandon", guidance?: string) =>
    request<{ message: string }>(
      `/api/goals/${encodeURIComponent(goalId)}/review/${encodeURIComponent(node)}`,
      { method: "POST", body: JSON.stringify({ verdict, ...(guidance?.trim() ? { guidance } : {}) }) },
    ),
```

(b) `ui2/src/lib/topics.ts:9` — review parks/resolves ride node.status:

```ts
  attention: ["action.", "mail.sent", "mail.read", "goal.status", "node.status", "trust.changed"],
```

(c) `ui2/src/views/Queue.tsx:9-12` — `ACTION_LABEL` gains `accept: "Accept", retry: "Retry",`; line 58 variant check gains accept: `variant={verb === "approve" || verb === "answer" || verb === "accept" ? "primary" : verb === "reject" ? "danger" : "ghost"}`.

(d) `ui2/src/views/Home.tsx` `act()` — extend the optimistic set and branch on review before the generic verbs (replace lines 38-46):

```ts
    const optimistic = ["approve", "reject", "read", "abandon", "resume", "accept", "retry"].includes(verb);
    if (optimistic) mark(setHandled, item.id, true);
    try {
      if (item.kind === "review" && (verb === "accept" || verb === "retry" || verb === "abandon")) {
        await api.resolveReview(item.ref.goalId, item.ref.node, verb);
      } else if (verb === "approve" || verb === "reject") await api.resolveAction(item.ref.actionId, verb);
      else if (verb === "read") {
        const thread = await api.mailThreadView(item.ref.threadId);
        await Promise.all(thread.filter((m) => m.to === "user" && m.status === "unread").map((m) => api.markMailRead(m.id)));
      } else if (verb === "abandon") await api.goalAction(item.ref.goalId, "abandon");
      else if (verb === "resume") await api.goalAction(item.ref.goalId, "resume");
```

(e) Create `ui2/src/views/canvas/Review.tsx`:

```tsx
// ui2/src/views/canvas/Review.tsx — parked needs-review node: last version + objections + verdict (spec §4).
import { useState } from "react";
import { api, type AttentionItem, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { Button, Empty, SectionLabel } from "../../components/ui.js";
import { TwoStepButton } from "../../components/TwoStepButton.js";

export function ReviewCanvas({ item, events, onDone }: {
  item: AttentionItem; events: StoredEvent[]; onDone: () => void;
}) {
  const { data: goal } = useLiveQuery(() => api.goal(item.ref.goalId), events, T.goals, [item.ref.goalId]);
  const [guidance, setGuidance] = useState("");
  const [error, setError] = useState("");
  const node = goal?.nodes.find((n) => n.key === item.ref.node);
  const artifact = goal?.artifacts.find((a) => a.file === node?.artifact);
  const resolve = async (verdict: "accept" | "retry" | "abandon") => {
    setError("");
    try {
      await api.resolveReview(item.ref.goalId, item.ref.node, verdict, verdict === "retry" ? guidance : undefined);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (!goal) return <Empty>Loading…</Empty>;
  return (
    <div className="max-w-3xl">
      <div className="text-[15px] text-strong mb-1">{goal.title} · {item.ref.node}</div>
      <div className="text-[12px] text-dim mb-4">{node?.agent} hit the quality cap without approval — your call.</div>
      <SectionLabel>Outstanding objections</SectionLabel>
      <ul className="text-[13px] mb-4 list-disc pl-5">
        {(node?.error ?? "").split("; ").filter(Boolean).map((o, i) => <li key={i}>{o}</li>)}
      </ul>
      <SectionLabel>Last version{node?.artifact ? ` (${node.artifact})` : ""}</SectionLabel>
      <pre className="text-[12px] whitespace-pre-wrap bg-raised rounded p-3 mb-4 max-h-80 overflow-y-auto">
        {artifact?.content ?? "(artifact not found)"}
      </pre>
      <textarea
        value={guidance} onChange={(e) => setGuidance(e.target.value)} rows={3}
        placeholder="Guidance for a retry (optional — injected as producer feedback)"
        className="w-full bg-raised rounded p-2 text-[13px] mb-3"
      />
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void resolve("accept")}>Accept with waiver</Button>
        <Button variant="ghost" onClick={() => void resolve("retry")}>Retry</Button>
        <TwoStepButton label="Abandon node" onConfirm={() => void resolve("abandon")} />
      </div>
      {error && <div className="text-[12px] text-err mt-2">{error}</div>}
    </div>
  );
}
```

(If `GoalDetail.artifacts` turns out not to include the parked node's version file — `buildGoalDetail` reads `listNodes` artifacts, and Task 1's projection sets `task_nodes.artifact = lastArtifactRef`, so it should — fall back to showing only objections and note it in the final report.)

(f) `ui2/src/views/canvas/index.tsx` — import `import { ReviewCanvas } from "./Review.js";` and add before the `ask` case:

```tsx
    case "review": return <ReviewCanvas item={item} events={events} onDone={onDone} />;
```

(g) `ui2/src/views/Staff.tsx` Governance table — header row (line 260) becomes:

```tsx
        <thead><tr className="label text-left"><th className="py-1">action type</th><th>state</th><th>✓</th><th>✗</th><th>streak</th><th>shadow</th><th>last rejection</th><th /></tr></thead>
```

and the body row gains, after the streak cell (line 266):

```tsx
              <td>{t.shadowMatches}{(t.matches ?? 0) + (t.mismatches ?? 0) > 0 ? ` · ${t.matches ?? 0}✓/${t.mismatches ?? 0}✗` : ""}</td>
```

- [ ] **Step 5: Run — expect PASS**

Run: `cd ui2 && npx vitest run && npx tsc --noEmit` (all ui2 tests including queue-render; tsc needs ui2/node_modules — `npm install` first in a fresh worktree).

- [ ] **Step 6: Commit**

```bash
git add ui2/src/api.ts ui2/src/lib/queue.ts ui2/src/lib/topics.ts ui2/src/views/Queue.tsx ui2/src/views/Home.tsx ui2/src/views/canvas/Review.tsx ui2/src/views/canvas/index.tsx ui2/src/views/Staff.tsx ui2/test/queue.test.ts
git commit -m "feat(ui2): Reviews queue group + ReviewCanvas verdicts + Governance shadow-match column"
```

---

### Task 10: Full verification + merge prep

**Files:** none new.

- [ ] **Step 1: Full root suite**

Run: `npx vitest run` — expect ≥ 1095 pass + 1 skip + all new tests, 0 fail. Investigate ANY regression before proceeding (likely spots: `engine-core.test.ts` goals that relied on loop soft-pass; `attention-view.test.ts` item counts; `dto` consumers).

- [ ] **Step 2: Typecheck both roots**

Run: `npx tsc --noEmit && cd ui2 && npx tsc --noEmit`

- [ ] **Step 3: Grep for leftovers**

Run: `grep -rn "Loop cap reached" src/ && grep -rn "verification still failing" src/` — expect no hits in src (both soft-gate paths deleted).

- [ ] **Step 4: Commit any stragglers, then hand off to superpowers:finishing-a-development-branch**

Merge is FF-only onto main per the locked process; deploy = `npm run build && (cd ui2 && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`; live smoke: `data/aios.log` boot clean, `/api/attention` 200 with token, `/api/trust` rows carry `shadowMatches`.

---

## Self-review checklist (run after writing, before executing)

1. Spec coverage: §3 → Task 2; §4 → Tasks 1, 3, 4, 8, 9; §5 → Task 5; §6 → Tasks 6, 7, 8(trust route), 9(Governance); §7 → Task 1 (reducer + decide cases); §8 test list → Tasks 1-9 test files. §9 respected (no maxRounds/maxAttempts changes; UI limited to queue kind + Governance column).
2. Type consistency: `ReviewResolvedPayload.node` present everywhere it's read; `shadowMatches` spelled identically in TrustRecord/TrustPolicy/TrustInfo; `resolveReview` signature identical in engine, server, api.ts.
3. Every task's tests runnable standalone; new test files self-contained (no reliance on unread fixture internals except the exported engine-core harness).
