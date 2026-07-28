# Goal Resurrection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failed or abandoned goal can be reopened at its exact frontier — failed and skipped nodes retry with fresh budgets and optional human guidance, done work replays free.

**Architecture:** One new journal event, `goal.reopened`. The reduce fold rewinds terminal state (phase, node counters, workspace error); the store projection mirrors it; decide needs zero changes because reset nodes re-enter as fresh candidates. An engine method guards status, one route verb and a ui2 button expose it.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, node:sqlite, React (ui2).

## Global Constraints

- **No new npm dependencies.**
- **Commit explicitly named paths only** — never `git add -A`. A parallel session shares the checkout; `agents/_retired/` stays untracked.
- **Trunk-based:** land on `main`.
- **Read the vitest "Tests" summary line**, not exit codes. Baseline: 191 files, 1475 passed + 2 skipped.
- **Routes stay thin and untested** (standing decision) — no server.ts tests.
- **ui2 touched** → deploy step must run `(cd ui2 && npm run build)` in a subshell BEFORE `npm run build` (Bash cwd persists — always subshell).
- The guidance block string is exactly `# User guidance (from review) — follow this\n${guidance}` — existing tests pin this format for loop/verify; run reuses it verbatim.
- Spec: `docs/superpowers/specs/2026-07-28-goal-resurrection-design.md`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/engine/journal.ts` | Event vocabulary | **Modify** — `"goal.reopened"` in the union (line 8-16), `GoalReopenedPayload` beside the other payloads |
| `src/engine/reduce.ts` | Pure fold | **Modify** — `goal.reopened` case; comment at line 60 gains the event name |
| `src/engine/project.ts` | Journal → store projection | **Modify** — `goal.reopened` case beside `goal.resumed` (line 139) |
| `src/engine/engine.ts` | Goal control methods | **Modify** — `reopenGoal()` after `abandonGoal` (line 476) |
| `src/engine/workers.ts` | Attempt runner | **Modify** — run brief reads `reviewGuidance` |
| `src/web/server.ts` | HTTP API | **Modify** — route regex at line 534 gains `reopen`; body read for that verb |
| `ui2/src/api.ts` | UI client | **Modify** — `goalAction` verb union + optional body (line 69) |
| `ui2/src/views/Goals.tsx` | Goal detail view | **Modify** — Reopen button + guidance input in the actions row (line 170-172) |
| `test/reduce.test.ts` | Fold tests | **Modify** — one describe block |
| `test/decide.test.ts` | Scheduler pins | **Modify** — one describe block |
| `test/reopen.test.ts` | Engine chain tests | **Create** — modeled on `test/abandon-terminal.test.ts` |
| `test/workers.test.ts` | Worker tests | **Modify** — one guidance test |

---

## Task 1: The event and the fold

**Files:**
- Modify: `src/engine/journal.ts:8-16` (union), `:90` region (payload interface)
- Modify: `src/engine/reduce.ts` (new case near `goal.resumed`, line 252; comment line 60)
- Test: `test/reduce.test.ts`

**Interfaces:**
- Produces: `"goal.reopened"` as a `JournalEventType`; `export interface GoalReopenedPayload { by: string; guidance?: string }`; the fold behaviour every later task relies on.

- [ ] **Step 1: Write the failing tests**

Append to `test/reduce.test.ts` (helpers `ev`, `created`, `plan`, `ws` exist at the top of the file):

```ts
describe("reduce — goal.reopened", () => {
  const failedGoal = () => [
    created(), plan("a", "b"), ws(),
    ev("attempt.started", { node: "a", attempt: 1, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:a:1" }),
    ev("attempt.finished", { node: "a", attempt: 1, outcome: "error", costCents: 5, turns: 2, error: "boom" }),
    ev("attempt.started", { node: "a", attempt: 2, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:a:2" }),
    ev("attempt.finished", { node: "a", attempt: 2, outcome: "error", costCents: 5, turns: 2, error: "boom" }),
    ev("node.failed", { node: "a", error: "boom" }),
    ev("node.skipped", { node: "b" }),
    ev("goal.failed", { error: "node a failed: boom" }),
  ];

  it("rewinds a failed goal: phase running, failed+skipped nodes pending with counters wiped", () => {
    const s = reduce([...failedGoal(), ev("goal.reopened", { by: "user", guidance: "the file exists now" }, 5000)]);
    expect(s.phase).toBe("running");
    expect(s.lastResumeTs).toBe(5000);
    const a = s.nodes.get("a")!;
    expect(a.status).toBe("pending");
    expect(a.attempts).toBe(0);
    expect(a.lastOutcome).toBeNull();
    expect(a.lastError).toBeNull();
    expect(a.currentRound).toBe(0);
    expect(a.loopRounds).toBe(0);
    expect(a.runnerRounds).toBe(0);
    expect(a.fixerRounds).toBe(0);
    expect(a.lastVerdict).toBeNull();
    expect(a.lastReport).toBeNull();
    expect(a.lastFeedback).toBeNull();
    expect(a.reviewGuidance).toBe("the file exists now");
    expect(s.nodes.get("b")!.status).toBe("pending");
    expect(s.nodes.get("b")!.reviewGuidance).toBe("the file exists now");
  });

  it("leaves done and needs-review nodes untouched", () => {
    const s = reduce([
      created(), plan("a", "b", "c"), ws(),
      ev("node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 1 }),
      ev("review.requested", { node: "b", lastArtifactRef: "b-a1-v3.md", objections: ["too long"] }),
      ev("node.failed", { node: "c", error: "boom" }),
      ev("goal.failed", { error: "node c failed: boom" }),
      ev("goal.reopened", { by: "user" }),
    ]);
    expect(s.nodes.get("a")!.status).toBe("done");
    expect(s.nodes.get("a")!.artifact).toBe("a.md");
    expect(s.nodes.get("b")!.status).toBe("needs-review");
    expect(s.nodes.get("c")!.status).toBe("pending");
    expect(s.nodes.get("c")!.reviewGuidance).toBeNull(); // no guidance given
  });

  it("clears a workspace error so PrepareWorkspace re-runs", () => {
    const s = reduce([
      created(), plan("a"),
      ev("workspace.failed", { error: "Refused: source path is on the secret denylist" }),
      ev("goal.failed", { error: "workspace setup failed: …" }),
      ev("goal.reopened", { by: "user" }),
    ]);
    expect(s.workspaceError).toBeNull();
    expect(s.workspacePending).toBe(true);
  });

  it("does not touch replan bookkeeping", () => {
    const s = reduce([...failedGoal(), ev("goal.reopened", { by: "user" })]);
    expect(s.replansUsed).toBe(0); // untouched — reopen is the human's loop, replan the planner's
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/reduce.test.ts -t "goal.reopened"`
Expected: FAIL — 4 tests. TypeScript may reject `"goal.reopened"` as not in `JournalEventType` first; that is the same failure, at compile time.

- [ ] **Step 3: Add the event to the vocabulary**

`src/engine/journal.ts` — the union (lines 8-16) gains one member on the goal line:

```ts
  | "goal.paused" | "goal.resumed" | "goal.reopened"
```

And beside the other payload interfaces (after `ReviewResolvedPayload`, ~line 95):

```ts
export interface GoalReopenedPayload { by: string; guidance?: string }
```

- [ ] **Step 4: Write the fold case**

`src/engine/reduce.ts`, directly after the `goal.resumed` case (line 252-254). Also append `goal.reopened` to the `lastResumeTs` comment on line 60 (`// wall-time base: goal.created / goal.resumed / ask.resumed / goal.reopened`).

```ts
      case "goal.reopened": {
        // Resurrection (goal-resurrection spec §1): rewind the terminal state. Done nodes keep
        // their artifacts — the goal resumes at its exact frontier and finished work is not
        // re-paid. Counters reset to zero (not a reviewRetry-style one-shot) so the normal
        // retry policy applies from scratch; decide then sees these nodes as FRESH candidates
        // (attempts === 0 && !lastOutcome), so no new scheduler rule exists for reopen.
        const rp = p as unknown as GoalReopenedPayload;
        state.phase = "running";
        state.lastResumeTs = ev.ts; // fresh wall-time window, same as resume
        for (const n of state.nodes.values()) {
          if (n.status !== "failed" && n.status !== "skipped") continue;
          n.status = "pending";
          n.attempts = 0;
          n.lastOutcome = null;
          n.lastError = null;
          n.currentRound = 0;
          n.loopRounds = 0;
          n.runnerRounds = 0;
          n.fixerRounds = 0;
          n.lastVerdict = null;
          n.lastReport = null;
          n.lastFeedback = null;
          n.reviewGuidance = rp.guidance ?? null;
        }
        // A goal that died at workspace setup must be able to try again — without this,
        // decide re-issues FailGoal from the stale error before any node can start.
        if (state.workspaceError) {
          state.workspaceError = null;
          state.workspacePending = true;
        }
        break;
      }
```

Import `GoalReopenedPayload` in reduce.ts's existing journal import list.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/reduce.test.ts && npx tsc --noEmit`
Expected: all reduce tests pass (existing + 4 new); tsc silent.

- [ ] **Step 6: Commit**

```bash
git add src/engine/journal.ts src/engine/reduce.ts test/reduce.test.ts
git commit -m "feat(engine): goal.reopened rewinds a terminal goal in the fold

Failed and skipped nodes return to pending with counters wiped and
optional human guidance attached; done and needs-review nodes are
untouched; a stale workspace error clears so PrepareWorkspace can
re-run. Nothing emits the event yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Decide non-regression pins

**Files:**
- Test: `test/decide.test.ts` (no src change expected — that is the point)

**Interfaces:**
- Consumes: the Task 1 fold. Pins that `decide` needs zero changes: reset nodes are fresh candidates, and neither the attempts-cap sweep nor the workspace-error rule re-fires after reopen.

- [ ] **Step 1: Write the tests**

Append to `test/decide.test.ts` (helpers `ev`, `goal`, `withGseq`, `CAPS` exist; `goal()` seeds created+plan+workspace):

```ts
describe("decide after goal.reopened", () => {
  const failedThenReopened = (guidance?: string) => {
    let events = goal("g1", [{ key: "a" }]);
    const g0 = events[events.length - 1].gseq;
    events = [...events,
      ev("g1", g0 + 1, "attempt.started", { node: "a", attempt: 1, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:a:1" }),
      ev("g1", g0 + 2, "attempt.finished", { node: "a", attempt: 1, outcome: "error", costCents: 0, turns: 1, error: "boom" }),
      ev("g1", g0 + 3, "attempt.started", { node: "a", attempt: 2, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:a:2" }),
      ev("g1", g0 + 4, "attempt.finished", { node: "a", attempt: 2, outcome: "error", costCents: 0, turns: 1, error: "boom" }),
      ev("g1", g0 + 5, "node.failed", { node: "a", error: "boom" }),
      ev("g1", g0 + 6, "goal.failed", { error: "node a failed: boom" }),
      ev("g1", g0 + 7, "goal.reopened", { by: "user", ...(guidance ? { guidance } : {}) }, 2000),
    ];
    return events;
  };

  it("a reopened node is a FRESH start candidate — not FailNode'd by the attempts sweep", () => {
    const cmds = decide([reduce(failedThenReopened())], CAPS, 2500);
    expect(cmds).toEqual([{ cmd: "StartAttempt", goalId: "g1", node: "a", attempt: 3 }]);
  });

  it("attempt numbering continues from the high-water mark (attempt 3, not 1)", () => {
    const cmds = decide([reduce(failedThenReopened())], CAPS, 2500);
    expect((cmds[0] as { attempt: number }).attempt).toBe(3);
  });

  it("a reopened workspace-failed goal re-issues PrepareWorkspace, not FailGoal", () => {
    let events = goal("g1", [{ key: "a" }]).slice(0, 2); // created + plan, NO workspace.prepared
    const g0 = events[events.length - 1].gseq;
    events = [...events,
      ev("g1", g0 + 1, "workspace.failed", { error: "Refused: source path is on the secret denylist" }),
      ev("g1", g0 + 2, "goal.failed", { error: "workspace setup failed: …" }),
      ev("g1", g0 + 3, "goal.reopened", { by: "user" }, 2000),
    ];
    const cmds = decide([reduce(events)], CAPS, 2500);
    expect(cmds).toEqual([{ cmd: "PrepareWorkspace", goalId: "g1" }]);
  });

  it("wall-time is measured from the reopen, not the original creation", () => {
    // reopen at ts=2000, wallTimeMs=60_000 → at now=61_000 (past created+wall, within reopen+wall) no FailGoal
    const cmds = decide([reduce(failedThenReopened())], CAPS, 61_000);
    expect(cmds.some((c) => c.cmd === "FailGoal")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they pass immediately**

Run: `npx vitest run test/decide.test.ts -t "after goal.reopened"`
Expected: **PASS (4 passed)** — these are pins, not drivers. If any FAILS, the Task 1 fold is wrong (most likely the counter wipe or the workspace clear); fix reduce.ts, not decide.ts. decide.ts must remain untouched this cycle.

- [ ] **Step 3: Commit**

```bash
git add test/decide.test.ts
git commit -m "test(engine): pin the scheduler's behaviour after goal.reopened

Reopened nodes re-enter as fresh candidates at the attempt high-water
mark; a reopened workspace failure re-prepares instead of re-failing;
wall-time counts from the reopen. Zero decide.ts changes — pinned so a
future edit that breaks resurrection fails loudly.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Projection + engine method

**Files:**
- Modify: `src/engine/project.ts` (case beside `goal.resumed`, line 139-141)
- Modify: `src/engine/engine.ts` (method after `abandonGoal`, line 476)
- Test: `test/reopen.test.ts` (create; modeled on `test/abandon-terminal.test.ts`)

**Interfaces:**
- Consumes: Task 1's event + fold; `harness`/`plannedGoal` from `test/engine-core.test.js`; `this.findGoal`, `this.journal`, `this.tick` (existing engine privates, used exactly as `abandonGoal` does).
- Produces: `reopenGoal(idOrSlug: string, opts: { by: string; guidance?: string }): string` — Task 5's route calls this.

- [ ] **Step 1: Write the failing tests**

Create `test/reopen.test.ts`:

```ts
// test/reopen.test.ts — goal resurrection: a failed or abandoned goal reopens at its exact
// frontier. Done nodes replay free; failed/skipped nodes retry fresh; done goals never reopen.
import { describe, it, expect, vi } from "vitest";
import { readJournal } from "../src/engine/journal.js";
import { harness, plannedGoal } from "./engine-core.test.js";

describe("reopenGoal", () => {
  it("failed goal → reopen → node retries → done; store agrees at every step", async () => {
    let fail = true;
    const { engine, store } = harness({
      run: async () => {
        if (fail) throw new Error("boom");
        return { text: "recovered", costUsd: 0.01, numTurns: 1 };
      },
    });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));

    fail = false;
    const msg = engine.reopenGoal(g.slug, { by: "user", guidance: "the flake is fixed, retry" });
    expect(msg).toContain("reopened");

    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    const types = readJournal(store, g.id).map((e) => e.type);
    expect(types).toContain("goal.reopened");
    expect(types).toContain("goal.completed");
    // projection: the node row recovered too
    expect(store.listNodes(g.id)[0]).toMatchObject({ status: "done" });
  });

  it("projection flips the goals row to running with error cleared immediately on reopen", async () => {
    const { engine, store } = harness({ run: async () => { throw new Error("boom"); } });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(store.getGoal(g.id)!.error).toBeTruthy();

    engine.pauseGoal(g.slug); // no-op guard sanity: failed goals cannot pause
    engine.reopenGoal(g.slug, { by: "user" });

    const row = store.getGoal(g.id)!;
    // status may already be past "running" if the retry raced ahead — assert it LEFT failed.
    expect(row.status).not.toBe("failed");
  });

  it("abandoned goal reopens: skipped nodes retry", async () => {
    let fail = true;
    const { engine, store } = harness({
      run: async () => {
        if (fail) throw new Error("boom");
        return { text: "recovered", costUsd: 0.01, numTurns: 1 };
      },
    });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    engine.abandonGoal(g.slug);
    expect(store.getGoal(g.id)!.status).toBe("abandoned");

    fail = false;
    const msg = engine.reopenGoal(g.slug, { by: "user" });
    expect(msg).toContain("reopened");
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
  });

  it("refuses done, running, unknown, and legacy goals", async () => {
    const { engine, store } = harness();
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(engine.reopenGoal(g.slug, { by: "user" })).toMatch(/only failed or abandoned/);
    expect(readJournal(store, g.id).map((e) => e.type)).not.toContain("goal.reopened");

    expect(engine.reopenGoal("no-such-goal", { by: "user" })).toContain("No goal");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/reopen.test.ts`
Expected: FAIL at compile — `reopenGoal` does not exist on `GoalEngine`.

- [ ] **Step 3: The projection case**

`src/engine/project.ts`, after the `goal.resumed` case (line 139-141):

```ts
    case "goal.reopened": {
      // The store must agree with the fold (goal-resurrection spec §1): without this case the
      // engine folds "running" while the goals table — and every UI reading it — says "failed".
      store.updateGoalStatus(goalId, "running");
      for (const n of store.listNodes(goalId)) {
        if (n.status === "failed" || n.status === "skipped") {
          store.updateNodeStatus(goalId, n.node_key, "pending");
        }
      }
      return;
    }
```

Note: `updateGoalStatus(goalId, "running")` with no error argument must clear the stored error. Check the implementation at `src/store/db.ts:720` — if it preserves the old error when `error` is undefined, change the call to pass an explicit empty/null per that function's convention (follow how `goal.resumed` ends up rendering; the goals view must not show a stale error on a running goal).

- [ ] **Step 4: The engine method**

`src/engine/engine.ts`, after `abandonGoal` (line 476), same shape as its siblings:

```ts
  /** Resurrection (goal-resurrection spec §2): reopen a failed or abandoned goal at its
   *  frontier. One event; the fold rewinds node state and the projection follows. */
  reopenGoal(idOrSlug: string, opts: { by: string; guidance?: string }): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (g.legacy) return `Goal ${g.slug} is a frozen legacy goal — read-only.`;
    if (g.status !== "failed" && g.status !== "abandoned") {
      return `Goal ${g.slug} is ${g.status} — only failed or abandoned goals can be reopened.`;
    }
    this.journal(g.id, [{ type: "goal.reopened", payload: {
      by: opts.by, ...(opts.guidance ? { guidance: opts.guidance } : {}),
    } }]);
    this.tick();
    return `Goal ${g.slug} reopened; failed and skipped nodes will retry.`;
  }
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/reopen.test.ts && npx tsc --noEmit`
Expected: 4 passed; tsc silent.

- [ ] **Step 6: Commit**

```bash
git add src/engine/project.ts src/engine/engine.ts test/reopen.test.ts
git commit -m "feat(engine): reopenGoal resurrects a failed or abandoned goal

One journal event; the fold rewinds, the projection follows, and the
next tick retries the frontier. done is never reopenable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Guidance reaches run briefs

**Files:**
- Modify: `src/engine/workers.ts` (run case brief assembly, ~line 253)
- Test: `test/workers.test.ts`

**Interfaces:**
- Consumes: `NodeState.reviewGuidance` (set by Task 1's fold); the existing `nodeState()` closure in `runAttempt`.
- Produces: nothing new — run briefs now honour a field loop/verify already honour.

- [ ] **Step 1: Write the failing test**

Append inside the `describe("run nodes demand a work report", ...)` block of `test/workers.test.ts` — the journal-seeding pattern matches the existing "retry after completed:false" test:

```ts
  it("a reopened run node carries the human guidance in its brief", async () => {
    const briefs: string[] = [];
    const { store, deps, goal } = harness(async (_r, brief) => {
      briefs.push(brief);
      return { text: "recovered", structured: { completed: true, summary: "ok", blockers: [] }, costUsd: 0.01, numTurns: 1 };
    });
    appendEvents(store, "g1", [
      { type: "attempt.finished", payload: { node: "design", attempt: 1, outcome: "error", costCents: 0, turns: 1, error: "boom" } },
      { type: "attempt.finished", payload: { node: "design", attempt: 2, outcome: "error", costCents: 0, turns: 1, error: "boom" } },
      { type: "node.failed", payload: { node: "design", error: "boom" } },
      { type: "goal.failed", payload: { error: "node design failed: boom" } },
      { type: "goal.reopened", payload: { by: "user", guidance: "the missing file now exists — use vault_read" } },
    ]);

    const res = await runAttempt(goal(), SPEC(), 3, deps);
    expect(res.outcome).toBe("ok");
    expect(briefs[0]).toContain("# User guidance (from review) — follow this");
    expect(briefs[0]).toContain("the missing file now exists — use vault_read");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/workers.test.ts -t "reopened run node"`
Expected: FAIL — brief lacks the guidance block (run briefs never read `reviewGuidance`).

- [ ] **Step 3: Add guidance to the run brief**

`src/engine/workers.ts`, run case — the brief assembly currently reads `priorError`/`priorBlockers` from `nodeState()`. Hoist one `st` call and add the guidance line (final shape shown — replace the existing `priorError`…`brief` lines):

```ts
        // A deterministic refusal ("the source file does not exist") re-fails identically if the
        // retry brief is byte-identical, burning the second attempt for nothing. The prefix test
        // is what keeps this honest: lastError also holds timeouts and wall-clock messages, and
        // only errors this file wrote are read back.
        const st = nodeState();
        const priorError = st?.lastError;
        const priorBlockers = priorError?.startsWith(BLOCKED_PREFIX) ? priorError.slice(BLOCKED_PREFIX.length) : "";
        // Guidance was unreachable for run nodes until goal.reopened (they never park for
        // review); same block, exact same string, as loop/verify.
        const guidance = st?.reviewGuidance;
        const brief = [
          spec.brief, ctx,
          guidance ? `# User guidance (from review) — follow this\n${guidance}` : "",
          priorBlockers && `# Your previous attempt reported it could not complete\n${priorBlockers}\n\nResolve these, or report completed:false again with what is still missing.`,
        ].filter(Boolean).join("\n\n");
```

(Note: after a reopen, `lastError` is null — the fold wiped it — so guidance and blockers never
collide from a reopen. They CAN co-exist when a ⑭-gated attempt retries normally; both blocks
appearing is correct and intended.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/workers.test.ts`
Expected: all pass (baseline 35 + 1 new = 36).

- [ ] **Step 5: Commit**

```bash
git add src/engine/workers.ts test/workers.test.ts
git commit -m "feat(engine): run briefs carry human guidance after a reopen

reviewGuidance was unreachable for run nodes — they never park for
review. goal.reopened made it reachable; the brief gains the same
guidance block loop and verify already honour.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Route + UI

**Files:**
- Modify: `src/web/server.ts:534-542` (route regex + body)
- Modify: `ui2/src/api.ts:69-70` (`goalAction`)
- Modify: `ui2/src/views/Goals.tsx:142-146` (verb) and `:169-173` (actions row)

**Interfaces:**
- Consumes: `goals.reopenGoal(ref, { by, guidance? })` from Task 3.
- Produces: `POST /api/goals/:ref/reopen` with optional JSON body `{ guidance }`.

No route tests (standing decision: routes thin + untested). ui2 has no test suite; verification is `tsc` + build + the live check in Task 6.

- [ ] **Step 1: Extend the route**

`src/web/server.ts` — replace the `goalCtl` block (lines 534-542):

```ts
        const goalCtl = /^\/api\/goals\/([\w-]+)\/(pause|resume|abandon|reopen)$/.exec(path);
        if (goalCtl && req.method === "POST") {
          const [, ref, verb] = goalCtl;
          if (verb === "reopen") {
            // Only reopen reads a body — { guidance? } rides the retried nodes' briefs.
            const body = JSON.parse((await readBody(req)) || "{}") as { guidance?: string };
            const message = goals.reopenGoal(ref, { by: "web", guidance: body.guidance?.trim() || undefined });
            return json(res, 200, { message });
          }
          const message =
            verb === "pause" ? goals.pauseGoal(ref)
            : verb === "resume" ? goals.resumeGoal(ref)
            : goals.abandonGoal(ref);
          return json(res, 200, { message });
        }
```

- [ ] **Step 2: Extend the UI client**

`ui2/src/api.ts` — replace `goalAction` (lines 69-70):

```ts
  goalAction: (idOrSlug: string, verb: "pause" | "resume" | "abandon" | "reopen", body?: { guidance?: string }) =>
    request<{ message: string }>(`/api/goals/${encodeURIComponent(idOrSlug)}/${verb}`,
      { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) }),
```

- [ ] **Step 3: The Reopen button**

`ui2/src/views/Goals.tsx`. Two edits in the goal-detail component:

1. Widen `verb` and add reopen state (replace lines 142-146):

```tsx
  const [reopenGuidance, setReopenGuidance] = useState("");
  const verb = async (v: "pause" | "resume" | "abandon" | "reopen") => {
    setActionError("");
    try {
      const body = v === "reopen" && reopenGuidance.trim() ? { guidance: reopenGuidance.trim() } : undefined;
      setActionError((await api.goalAction(goal.id, v, body)).message);
      if (v === "reopen") setReopenGuidance("");
    }
    catch (err) { setActionError((err as Error).message); }
  };
```

(`useState` is already imported in this file.)

2. In the actions row (`<span className="ml-auto flex gap-2">`, lines 170-172), add after the Abandon button:

```tsx
          {["failed", "abandoned"].includes(goal.status) && <Button variant="primary" onClick={() => verb("reopen")}>Reopen</Button>}
```

3. Directly under the header row (after the `{actionError && …}` line), add the guidance input, visible only when reopenable:

```tsx
      {["failed", "abandoned"].includes(goal.status) && (
        <div className="flex gap-2 mb-2 max-w-2xl">
          <input value={reopenGuidance} onChange={(e) => setReopenGuidance(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && verb("reopen")}
            placeholder="Optional guidance for the retry (what changed?)…"
            className="flex-1 bg-bg border border-line rounded-md px-3 py-2 outline-none focus:border-dim text-[12px]" />
        </div>
      )}
```

- [ ] **Step 4: Typecheck + build both roots**

Run: `npx tsc --noEmit && (cd ui2 && npx tsc --noEmit && npm run build)`
Expected: both silent, ui2 build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts ui2/src/api.ts ui2/src/views/Goals.tsx
git commit -m "feat(web): Reopen action for failed and abandoned goals

POST /api/goals/:ref/reopen with optional { guidance }; a Reopen
button and guidance input appear on terminal goals in mission control.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Full suite, deploy, live resurrection

**Files:** none — verify and ship.

- [ ] **Step 1: Full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected **Tests** line: 192 files (191 + reopen.test.ts), **1485 passed + 2 skipped** (1475 baseline + 4 reduce + 4 decide + 4 reopen + 1 workers + 2 duplicate re-registrations of engine-core's 2 own tests via the reopen.test.ts harness import — if the count differs from 1485, recount from the actual duplicate behaviour: engine-core currently registers its describe in every importer, house style; whatever the number, ZERO failures is the requirement and the delta must be explainable by the 13 new tests + duplication).

- [ ] **Step 2: Deploy (ui2 first, subshell)**

```bash
(cd ui2 && npm run build) && npm run build && launchctl kickstart -k gui/501/com.ihab.aios
```

- [ ] **Step 3: Prepare the resurrection subject**

Goal `c1844130` (⑭'s deliberately-impossible goal) sits `failed`: its node must edit
`goals/2026-01-01-does-not-exist/report.md`, which does not exist. Make it exist:

```bash
mkdir -p "/Users/ihabbishara/Desktop/AI-Vault/AIOS/goals/2026-01-01-does-not-exist"
cat > "/Users/ihabbishara/Desktop/AI-Vault/AIOS/goals/2026-01-01-does-not-exist/report.md" <<'EOF'
# Quarterly report

This report summarises the quarter.

The second paragraph is deliberately long. It contains one sentence too many. The final sentence of this paragraph is removable without loss of meaning.

Closing remarks.
EOF
```

- [ ] **Step 4: Reopen it with guidance, via the new API**

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/goals/c1844130-85db-4408-9f55-f3ee3755852d/reopen \
  -d '{"guidance":"The file goals/2026-01-01-does-not-exist/report.md exists in the vault now — vault_read will find it. Do the edit as briefed."}'
```

Expected: `{"message":"Goal shorten-second-paragraph-of-report-md reopened; failed and skipped nodes will retry."}`

- [ ] **Step 5: Watch the journal to the end**

```bash
until sqlite3 data/aios.sqlite "select 1 from goal_journal where goal_id like 'c1844130%' and type in ('goal.completed','goal.failed') and gseq > 9 limit 1;" | grep -q 1; do sleep 5; done
sqlite3 -header data/aios.sqlite "select gseq,type,substr(payload,1,180) from goal_journal where goal_id like 'c1844130%' and gseq >= 10 order by gseq;"
```

Each is a distinct claim:
- `goal.reopened` with the guidance in the payload;
- a fresh `attempt.started` (attempt 3 — high-water mark, not 1);
- `node.completed` — the node that could never succeed now has;
- `goal.completed` — full circle: ⑭'s gate failed it honestly, ⑮'s reopen finished it.
- The vault file's second paragraph is actually shorter (read it).

If the node fails again instead: read the attempt error. `did not complete:` naming the file →
the agent could not see it (wrong path in guidance?); that is a real finding, not a broken
feature — the reopen mechanics are proven by the journal shape regardless.

- [ ] **Step 6: UI spot-check + push**

Open `http://localhost:4280` → Goals → any failed goal shows the Reopen button + guidance input.
Then:

```bash
git push origin main
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 event + fold (resets, workspace clear, done/needs-review untouched, replan untouched) | Task 1 |
| §1 fresh-candidate path, attempt high-water mark | Task 2 (pins) |
| §1 store projection | Task 3, Step 3 |
| §2 engine method + guards | Task 3, Step 4 |
| §3 guidance in run briefs | Task 4 |
| §4 route + api.ts + Goals.tsx | Task 5 |
| §5 accepted edges (second mail report, deliverBranch re-fire, deterministic workspace refusal) | No code — Task 6 Step 5 observes; edges documented in spec |
| Testing 1-9 | Tasks 1-4 (tests 1-8), Task 6 Step 1 (test 9) |
| Live verification | Task 6 |

**Placeholder scan:** clean — every code step carries literal code; the only conditional instruction (Task 3 Step 3's `updateGoalStatus` error-clearing note) names the exact file, line, and decision criterion.

**Type consistency:** `reopenGoal(idOrSlug, { by, guidance? })` identical in Task 3 (definition), Task 5 (route call). `GoalReopenedPayload { by; guidance? }` matches every test payload. `goalAction(idOrSlug, verb, body?)` matches the Goals.tsx call. Node reset field list in Task 1's fold matches the reduce test's assertions field-for-field.
