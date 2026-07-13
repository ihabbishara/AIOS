# Journaled Execution Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite GoalEngine internals as full event sourcing per `docs/superpowers/specs/2026-07-11-journaled-execution-core-design.md`: `goal_journal` is the source of truth, `goals`/`task_nodes` become materialized projections, recovery is replay. Public API, `dto.ts`, views, moderator tools, `/api/goals` unchanged.

**Architecture:** Six modules replace the 787-line `src/engine/goals.ts` scheduler: `journal.ts` (append/read, optimistic gseq), `reduce.ts` (pure fold), `decide.ts` (pure scheduler), `project.ts` (projection updaters, same-transaction), `workers.ts` (attempt runner + abort registry), `engine.ts` (wiring + public GoalEngine). New modules are built and tested alongside the old engine (suite stays green every task); one cutover task swaps `goals.ts` to a barrel and deletes the old internals. Legacy goal rows are frozen `legacy=1`.

**Tech Stack:** TypeScript, Node `node:sqlite` (synchronous — each append is a natural critical section), vitest.

## Global Constraints

- `node:sqlite` only — no better-sqlite3, no FTS5.
- Subscription auth only — never introduce `ANTHROPIC_API_KEY`.
- Migrations = idempotent `CREATE TABLE IF NOT EXISTS` / try-catch `ALTER TABLE` (existing db.ts pattern).
- `goal_journal` is append-only: never UPDATE/DELETE, never pruned by retention (same rule as `budget_ledger`).
- Run `npx vitest run` AND `npx tsc --noEmit` per task (vitest doesn't typecheck). Baseline: 963 pass + 1 skip.
- Suite must be green at the END of every task. New modules coexist with the old engine until Task 8 (cutover).
- Commit after every task.
- If building in a worktree: `git worktree add .worktrees/journal-core -b journal-core && ln -s $PWD/node_modules .worktrees/journal-core/node_modules`; remove the worktree before trusting root-suite counts.

## Accepted behavior deltas (do not "fix" these — they are decisions)

1. Transient `replanning` goal status becomes a cosmetic projection touch (no journal event); a crash mid-replan re-decides and the crash-retry does not count against the replan cap.
2. Node cost lands in `task_nodes.cost_cents` at attempt end (from `attempt.finished`), not per agent call. `budget_ledger`/`cost_daily` still accrue per `agent.end` event — unchanged.
3. Orphaned attempts (daemon restart mid-attempt) count toward `maxAttempts` (2). Repeated restarts fail the node visibly instead of silently re-running forever.
4. A session-limit-paused goal, when resumed, retries the interrupted node (attempt n+1) instead of dead-ending.
5. `ask_mail` park: the mail insert and the `ask.parked` journal append share the mailbox's transaction via re-entrant join — atomicity preserved.

---

### Task 1: Journal storage — `goal_journal` table + `src/engine/journal.ts`

**Files:**
- Modify: `src/store/db.ts` (DDL in constructor, `JournalRow`, 2 methods, `inTransaction` getter)
- Create: `src/engine/journal.ts`
- Test: `test/journal.test.ts` (create)

**Interfaces:**
- Consumes: `Store.transaction(fn)` (db.ts:888), which throws on nesting — this task adds the `inTransaction` getter that lets `appendEvents` join an open transaction.
- Produces (later tasks depend on these exact names):
  - db.ts: `journalInsert(goalId: string, gseq: number, type: string, payloadJson: string, ts: number): number` (throws on `(goal_id, gseq)` UNIQUE conflict), `journalRead(goalId: string): JournalRow[]`, `get inTransaction(): boolean`, `interface JournalRow { seq: number; goal_id: string; gseq: number; type: string; payload: string; v: number; ts: number }`.
  - journal.ts: `JournalEventType`, `NodeSpec`, `AttemptOutcome`, `JournalEvent`, `EventInput`, all payload interfaces below, `readJournal(store, goalId): JournalEvent[]`, `appendEvents(store, goalId, events, opts?): JournalEvent[] | null`, `attemptClaimed(node, attempt)`, `replayInto(store, events)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/journal.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { appendEvents, readJournal, attemptClaimed, replayInto } from "../src/engine/journal.js";

describe("goal_journal", () => {
  it("appendEvents assigns sequential gseqs and round-trips payloads", () => {
    const store = new Store(":memory:");
    const a = appendEvents(store, "g1", [
      { type: "goal.created", payload: { slug: "x" } },
      { type: "plan.recorded", payload: { nodes: [] } },
    ]);
    expect(a!.map((e) => e.gseq)).toEqual([1, 2]);
    const b = appendEvents(store, "g1", [{ type: "goal.completed", payload: {} }]);
    expect(b![0].gseq).toBe(3);
    const all = readJournal(store, "g1");
    expect(all.map((e) => e.type)).toEqual(["goal.created", "plan.recorded", "goal.completed"]);
    expect(all[0].payload).toEqual({ slug: "x" });
    expect(all[0].v).toBe(1);
    expect(typeof all[0].ts).toBe("number");
  });

  it("journals are per-goal: gseq restarts for another goal", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [{ type: "goal.created", payload: {} }]);
    const b = appendEvents(store, "g2", [{ type: "goal.created", payload: {} }]);
    expect(b![0].gseq).toBe(1);
  });

  it("claimLost: a pre-existing attempt.started for the same node+attempt wins", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [
      { type: "attempt.started", payload: { node: "a", attempt: 1 } },
    ]);
    const lost = appendEvents(store, "g1",
      [{ type: "attempt.started", payload: { node: "a", attempt: 1 } }],
      { claimLost: attemptClaimed("a", 1) });
    expect(lost).toBeNull();
    // a different attempt number is a fresh claim
    const won = appendEvents(store, "g1",
      [{ type: "attempt.started", payload: { node: "a", attempt: 2 } }],
      { claimLost: attemptClaimed("a", 2) });
    expect(won).not.toBeNull();
  });

  it("gseq conflict retries with a fresh gseq (raced append)", () => {
    const store = new Store(":memory:");
    // occupy gseq 1 directly — appendEvents' first read sees an empty journal only if
    // we race it; simulate by pre-inserting after export of the low-level method
    store.journalInsert("g1", 1, "goal.created", "{}", Date.now());
    const a = appendEvents(store, "g1", [{ type: "plan.recorded", payload: {} }]);
    expect(a![0].gseq).toBe(2);
  });

  it("also() runs in the same transaction — a throw rolls back the events", () => {
    const store = new Store(":memory:");
    expect(() =>
      appendEvents(store, "g1", [{ type: "goal.created", payload: {} }], {
        also: () => { throw new Error("boom"); },
      }),
    ).toThrow("boom");
    expect(readJournal(store, "g1")).toHaveLength(0);
  });

  it("joins an open Store.transaction instead of nesting", () => {
    const store = new Store(":memory:");
    store.transaction(() => {
      store.kvSet("k", "1");
      appendEvents(store, "g1", [{ type: "goal.created", payload: {} }]);
    });
    expect(readJournal(store, "g1")).toHaveLength(1);
    expect(store.kvGet("k")).toBe("1");
  });

  it("replayInto writes fixed gseqs with original timestamps", () => {
    const store = new Store(":memory:");
    const src = new Store(":memory:");
    const evs = appendEvents(src, "g1", [
      { type: "goal.created", payload: { slug: "x" } },
      { type: "goal.completed", payload: {} },
    ])!;
    replayInto(store, evs);
    expect(readJournal(store, "g1").map((e) => [e.gseq, e.type])).toEqual([
      [1, "goal.created"], [2, "goal.completed"],
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/journal.test.ts`
Expected: FAIL — `src/engine/journal.ts` does not exist.

- [ ] **Step 3: db.ts — DDL, JournalRow, methods**

In the `Store` constructor, immediately after the `events` CREATE TABLE exec block (db.ts:310-315), add:

```ts
    // Journaled engine: the goal journal is the source of truth for goal execution;
    // goals/task_nodes are projections of it. APPEND-ONLY — never UPDATE/DELETE,
    // never pruned by retention (same rule as budget_ledger). The UNIQUE(goal_id, gseq)
    // constraint is the optimistic-concurrency claim: a losing INSERT throws.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goal_journal (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT NOT NULL,
        gseq    INTEGER NOT NULL,
        type    TEXT NOT NULL,
        payload TEXT NOT NULL,
        v       INTEGER NOT NULL DEFAULT 1,
        ts      INTEGER NOT NULL,
        UNIQUE (goal_id, gseq)
      );
    `);
```

Add the row type next to `TaskNodeRow` (top of file, with the other interfaces):

```ts
export interface JournalRow {
  seq: number;
  goal_id: string;
  gseq: number;
  type: string;
  payload: string;
  v: number;
  ts: number;
}
```

Add methods next to `resetRunningNodes` (db.ts:647):

```ts
  /** Raw journal insert. Throws on a (goal_id, gseq) UNIQUE conflict — that throw IS
   *  the optimistic-claim-loss signal; journal.ts interprets it. */
  journalInsert(goalId: string, gseq: number, type: string, payloadJson: string, ts: number): number {
    const r = this.db.prepare(
      "INSERT INTO goal_journal (goal_id, gseq, type, payload, ts) VALUES (?, ?, ?, ?, ?)",
    ).run(goalId, gseq, type, payloadJson, ts);
    return Number(r.lastInsertRowid);
  }

  journalRead(goalId: string): JournalRow[] {
    return this.db.prepare("SELECT * FROM goal_journal WHERE goal_id = ? ORDER BY gseq ASC")
      .all(goalId) as unknown as JournalRow[];
  }
```

Add the getter next to the private `inTx` field (db.ts:886):

```ts
  /** True while inside transaction() — journal appends join instead of nesting. */
  get inTransaction(): boolean { return this.inTx; }
```

- [ ] **Step 4: Create `src/engine/journal.ts`**

```ts
// src/engine/journal.ts — goal_journal append/read. The journal is the source of truth
// for goal execution; tables are projections (project.ts, wired in a later task).
// Append-only; optimistic gseq claims: a failed INSERT on (goal_id, gseq) IS the
// claim-loss signal. Synchronous node:sqlite makes each append a natural critical section.
import type { Store, JournalRow } from "../store/db.js";

export type JournalEventType =
  | "goal.created" | "plan.recorded" | "replan.recorded"
  | "workspace.prepared" | "workspace.failed"
  | "attempt.started" | "round.recorded" | "attempt.finished"
  | "node.completed" | "node.failed" | "node.skipped"
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
          out.push({ seq, goalId, gseq: base + 1 + i, type: e.type, payload: e.payload, v: 1, ts: now });
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
    });
  }
}
```

NOTE: `projectEvent` is deliberately absent — Task 4 wires projections into `appendEvents` and `replayInto`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/journal.test.ts`
Expected: PASS (7 tests). If the gseq-conflict test fails on the error-message match, print the actual `node:sqlite` UNIQUE-violation message and adjust `isGseqConflict` to match it (keep the `goal_journal` substring check).

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean; 963+7 pass, 1 skip.

- [ ] **Step 7: Commit**

```bash
git add src/store/db.ts src/engine/journal.ts test/journal.test.ts
git commit -m "feat(engine): goal_journal table + append/read with optimistic gseq claims"
```

---

### Task 2: Pure reducer — `src/engine/reduce.ts`

**Files:**
- Create: `src/engine/reduce.ts`
- Test: `test/reduce.test.ts` (create)

**Interfaces:**
- Consumes: `JournalEvent`, `NodeSpec`, `AttemptOutcome` and payload interfaces from `./journal.js` (Task 1).
- Produces (decide/workers/engine depend on these exact names):
  - `GoalPhase = "running" | "paused-budget" | "paused-user" | "awaiting-mail" | "done" | "failed" | "abandoned"`
  - `NodeState` and `GoalState` as written below.
  - `reduce(events: JournalEvent[], initial?: GoalState): GoalState` — pure, no clock, no IO. `initial` is deep-cloned, never mutated.
  - `nodeStatus(state: GoalState, key: string): "pending" | "ready" | "running" | "done" | "failed" | "skipped"` — derived status ("running" = dangling attempt, "ready" = pending with all deps done).

- [ ] **Step 1: Write the failing test**

```ts
// test/reduce.test.ts
import { describe, it, expect } from "vitest";
import { reduce, nodeStatus, type GoalState } from "../src/engine/reduce.js";
import type { JournalEvent, JournalEventType } from "../src/engine/journal.js";

let g = 0;
const ev = (type: JournalEventType, payload: Record<string, unknown>, ts = 1000): JournalEvent =>
  ({ seq: ++g, goalId: "g1", gseq: g, type, payload, v: 1, ts });

const created = (over: Record<string, unknown> = {}) => ev("goal.created", {
  slug: "x", title: "X", request: "do x", department: "engineering", lead: "athena",
  origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
  planSummary: "planned", goalDir: "2026-07-13-x", projectDir: null, ...over,
});
const node = (key: string, dependsOn: string[] = [], kind = "run") =>
  ({ key, kind, agent: "vulcan", critic: null, brief: "b", dependsOn, maxRounds: 3 });
const plan = (...keys: string[]) => ev("plan.recorded", { summary: "s", needsWorkspace: "none", nodes: keys.map((k) => node(k)) });
const ws = () => ev("workspace.prepared", { taskDir: null, mode: null });

/** Map/Set-free snapshot for equality assertions. */
const snap = (s: GoalState) => ({
  ...s,
  nodes: Object.fromEntries([...s.nodes.entries()]),
  replannedFor: [...s.replannedFor].sort(),
});

describe("reduce — golden states per event type", () => {
  it("goal.created + plan.recorded: running, pending nodes, wall-clock base set", () => {
    const s = reduce([created(), plan("a", "b")]);
    expect(s.phase).toBe("running");
    expect(s.created!.slug).toBe("x");
    expect(s.planned).toBe(true);
    expect(s.workspacePending).toBe(true);
    expect(s.order).toEqual(["a", "b"]);
    expect(s.nodes.get("a")!.status).toBe("pending");
    expect(s.lastResumeTs).toBe(1000);
  });

  it("workspace.prepared clears pending; taskDir lands; stripped nulls projectDir", () => {
    const s1 = reduce([created({ projectDir: "/p" }), plan("a"), ev("workspace.prepared", { taskDir: "/ws/t1", mode: "build" })]);
    expect(s1.workspacePending).toBe(false);
    expect(s1.workspace).toEqual({ taskDir: "/ws/t1", mode: "build" });
    expect(s1.created!.projectDir).toBe("/ws/t1");
    const s2 = reduce([created({ projectDir: "/p" }), plan("a"), ev("workspace.prepared", { taskDir: null, mode: null, stripped: true })]);
    expect(s2.created!.projectDir).toBeNull();
    const s3 = reduce([created(), plan("a"), ev("workspace.failed", { error: "no disk" })]);
    expect(s3.workspaceError).toBe("no disk");
    expect(s3.workspacePending).toBe(false);
  });

  it("attempt.started/finished: running derived from dangling attempt; cost accrues", () => {
    const base = [created(), plan("a"), ws()];
    const started = reduce([...base, ev("attempt.started", { node: "a", attempt: 1, agent: "vulcan", deadlineTs: 99, idempotencyKey: "g1:a:1" })]);
    expect(started.nodes.get("a")!.runningAttempt).toEqual({ attempt: 1, deadlineTs: 99, startedTs: 1000 });
    expect(nodeStatus(started, "a")).toBe("running");
    const finished = reduce([...base,
      ev("attempt.started", { node: "a", attempt: 1, agent: "vulcan", deadlineTs: 99, idempotencyKey: "g1:a:1" }),
      ev("attempt.finished", { node: "a", attempt: 1, outcome: "error", costCents: 12, turns: 3, error: "boom" }),
    ]);
    const n = finished.nodes.get("a")!;
    expect(n.runningAttempt).toBeNull();
    expect(n.attempts).toBe(1);
    expect(n.lastOutcome).toBe("error");
    expect(n.lastError).toBe("boom");
    expect(n.costCents).toBe(12);
    expect(finished.spendCents).toBe(12);
    expect(nodeStatus(finished, "a")).toBe("ready"); // retryable
  });

  it("round.recorded: loop critic rounds, verify runner/fixer rounds, feedback carried", () => {
    const base = [created(), ev("plan.recorded", { summary: "s", needsWorkspace: "none",
      nodes: [{ key: "l", kind: "loop", agent: "vulcan", critic: "minos", brief: "b", dependsOn: [], maxRounds: 3 },
              { key: "v", kind: "verify", agent: "argus", critic: "vulcan", brief: "b", dependsOn: [], maxRounds: 3 }] }), ws()];
    const s = reduce([...base,
      ev("round.recorded", { node: "l", attempt: 1, round: 1, role: "critic",
        verdict: { verdict: "revise", summary: "needs work", reasons: ["r1"] }, feedback: "needs work\n- r1", artifactRef: "l-v1.md" }),
      ev("round.recorded", { node: "v", attempt: 1, round: 1, role: "runner",
        report: { passed: false, summary: "f", failures: ["f1"] }, feedback: "f\n- f1", artifactRef: "v-run-1.md" }),
      ev("round.recorded", { node: "v", attempt: 1, round: 1, role: "fixer", feedback: "f", artifactRef: "v-fix-1.md" }),
    ]);
    const l = s.nodes.get("l")!;
    expect(l.loopRounds).toBe(1);
    expect(l.currentRound).toBe(1);
    expect(l.lastVerdict!.verdict).toBe("revise");
    expect(l.lastFeedback).toBe("needs work\n- r1");
    expect(l.lastArtifactRef).toBe("l-v1.md");
    const v = s.nodes.get("v")!;
    expect(v.runnerRounds).toBe(1);
    expect(v.fixerRounds).toBe(1);
    expect(v.lastReport!.passed).toBe(false);
  });

  it("node.completed/failed/skipped + goal terminal events", () => {
    const s = reduce([created(), plan("a", "b", "c"), ws(),
      ev("node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 2 }),
      ev("node.failed", { node: "b", error: "boom" }),
      ev("node.skipped", { node: "c" }),
      ev("goal.failed", { error: "node b failed: boom" }),
    ]);
    expect(s.nodes.get("a")).toMatchObject({ status: "done", artifact: "a.md", currentRound: 2 });
    expect(s.nodes.get("b")).toMatchObject({ status: "failed", lastError: "boom" });
    expect(s.nodes.get("c")!.status).toBe("skipped");
    expect(s.phase).toBe("failed");
    expect(s.error).toBe("node b failed: boom");
  });

  it("ready derivation: deps gate; done unlocks dependents", () => {
    const s = reduce([created(), ev("plan.recorded", { summary: "s", needsWorkspace: "none",
      nodes: [node("a"), node("b", ["a"])] }), ws()]);
    expect(nodeStatus(s, "a")).toBe("ready");
    expect(nodeStatus(s, "b")).toBe("pending");
    const s2 = reduce([created(), ev("plan.recorded", { summary: "s", needsWorkspace: "none",
      nodes: [node("a"), node("b", ["a"])] }), ws(),
      ev("node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 0 })]);
    expect(nodeStatus(s2, "b")).toBe("ready");
  });

  it("ask.parked/ask.resumed: park marks asking node done; resume resets wall-clock", () => {
    const s = reduce([created(), plan("a"), ws(),
      ev("ask.parked", { node: "a", mailId: "m1" })]);
    expect(s.phase).toBe("awaiting-mail");
    expect(s.parkedOn).toBe("m1");
    expect(s.nodes.get("a")!.status).toBe("done");
    const s2 = reduce([created(), plan("a"), ws(),
      ev("ask.parked", { node: "a", mailId: "m1" }),
      ev("ask.resumed", { mailId: "m1", resumeNodeKey: "resume_1" }, 5000)]);
    expect(s2.phase).toBe("running");
    expect(s2.parkedOn).toBeNull();
    expect(s2.lastResumeTs).toBe(5000);
  });

  it("goal.paused/resumed: budget vs user; resume resets wall-clock", () => {
    const p = reduce([created(), plan("a"), ev("goal.paused", { reason: "budget" })]);
    expect(p.phase).toBe("paused-budget");
    const u = reduce([created(), plan("a"), ev("goal.paused", { reason: "user" })]);
    expect(u.phase).toBe("paused-user");
    const r = reduce([created(), plan("a"), ev("goal.paused", { reason: "budget" }),
      ev("goal.resumed", { by: "budget-reset" }, 9000)]);
    expect(r.phase).toBe("running");
    expect(r.lastResumeTs).toBe(9000);
  });

  it("replan.recorded: replace resets node, add appends, retarget rewires, cap counting", () => {
    const s = reduce([created(), plan("a", "b"), ws(),
      ev("node.failed", { node: "a", error: "boom" }),
      ev("replan.recorded", { kind: "replan", forNode: "a",
        replaced: [node("a")], added: [node("c", ["a"])],
        retargets: [{ node: "b", dependsOn: ["c"] }], reason: "boom" }),
    ]);
    expect(s.replansUsed).toBe(1);
    expect(s.nodes.get("a")!.status).toBe("pending"); // reset by replace
    expect(s.replannedFor.has("a")).toBe(false);       // replaced key can fail+replan again
    expect(s.order).toEqual(["a", "b", "c"]);
    expect(s.nodes.get("b")!.spec.dependsOn).toEqual(["c"]);
    // resume-kind does not count against the cap but marks forNode addressed
    const s2 = reduce([created(), plan("a"), ws(),
      ev("ask.parked", { node: "a", mailId: "m1" }),
      ev("ask.resumed", { mailId: "m1", resumeNodeKey: "resume_1" }),
      ev("replan.recorded", { kind: "resume", forNode: "a",
        replaced: [], added: [node("resume_1", ["a"])], retargets: [], reason: "ask-resume" }),
    ]);
    expect(s2.replansUsed).toBe(0);
    expect(s2.nodes.get("resume_1")!.status).toBe("pending");
  });

  it("goal.abandoned + goal.completed terminal phases", () => {
    expect(reduce([created(), plan("a"), ev("goal.abandoned", { by: "user" })]).phase).toBe("abandoned");
    expect(reduce([created(), plan("a"),
      ev("node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 0 }),
      ev("goal.completed", {})]).phase).toBe("done");
  });
});

describe("reduce — replay determinism", () => {
  const script = () => [created(), plan("a", "b"), ws(),
    ev("attempt.started", { node: "a", attempt: 1, agent: "vulcan", deadlineTs: 9, idempotencyKey: "k" }),
    ev("attempt.finished", { node: "a", attempt: 1, outcome: "ok", costCents: 7, turns: 2 }),
    ev("node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 0 }),
    ev("attempt.started", { node: "b", attempt: 1, agent: "vulcan", deadlineTs: 9, idempotencyKey: "k2" }),
    ev("attempt.finished", { node: "b", attempt: 1, outcome: "ok", costCents: 3, turns: 1 }),
    ev("node.completed", { node: "b", artifactRef: "b.md", roundsUsed: 0 }),
    ev("goal.completed", {}),
  ];

  it("fold twice ≡ fold once", () => {
    const evs = script();
    expect(snap(reduce(evs))).toEqual(snap(reduce(evs)));
  });

  it("fold(prefix)+fold(suffix) ≡ fold(all), at every split point", () => {
    const evs = script();
    const whole = snap(reduce(evs));
    for (let k = 0; k <= evs.length; k++) {
      const partial = reduce(evs.slice(k), reduce(evs.slice(0, k)));
      expect(snap(partial), `split at ${k}`).toEqual(whole);
    }
  });

  it("initial state is not mutated by continued folding", () => {
    const evs = script();
    const mid = reduce(evs.slice(0, 5));
    const before = snap(mid);
    reduce(evs.slice(5), mid);
    expect(snap(mid)).toEqual(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/reduce.test.ts`
Expected: FAIL — `src/engine/reduce.ts` does not exist.

- [ ] **Step 3: Create `src/engine/reduce.ts`**

```ts
// src/engine/reduce.ts — pure reducer: JournalEvent[] → GoalState. No clock, no IO;
// events carry timestamps. Crash recovery is replay of this same function — the old
// engine's resetRunningNodes / stale-executing sweeps are deleted, replaced by fold.
import type {
  JournalEvent, NodeSpec, AttemptOutcome,
  GoalCreatedPayload, PlanRecordedPayload, ReplanRecordedPayload,
  WorkspacePreparedPayload, AttemptStartedPayload, RoundRecordedPayload,
  AttemptFinishedPayload, NodeCompletedPayload,
} from "./journal.js";

export type GoalPhase =
  | "running" | "paused-budget" | "paused-user" | "awaiting-mail"
  | "done" | "failed" | "abandoned";

export interface NodeState {
  spec: NodeSpec;
  /** Persistent status. "running"/"ready" are DERIVED — see nodeStatus(). */
  status: "pending" | "done" | "failed" | "skipped";
  attempts: number;                                       // finished attempts (max attempt#)
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
});

const freshState = (goalId: string): GoalState => ({
  goalId, phase: "running", created: null, planned: false,
  workspacePending: true, workspace: null, workspaceError: null,
  nodes: new Map(), order: [], parkedOn: null,
  replansUsed: 0, replannedFor: new Set(), lastResumeTs: 0, spendCents: 0, error: null,
});

/** Derived node status: dangling attempt → running; pending with all deps done → ready. */
export function nodeStatus(state: GoalState, key: string):
  "pending" | "ready" | "running" | "done" | "failed" | "skipped" {
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
        const n = state.nodes.get(ap.node);
        if (n) n.runningAttempt = { attempt: ap.attempt, deadlineTs: ap.deadlineTs, startedTs: ev.ts };
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
        n.attempts = Math.max(n.attempts, fp.attempt);
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
        state.phase = (p as { reason: string }).reason === "budget" ? "paused-budget" : "paused-user";
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/reduce.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Typecheck + full suite, then commit**

Run: `npx tsc --noEmit && npx vitest run`

```bash
git add src/engine/reduce.ts test/reduce.test.ts
git commit -m "feat(engine): pure reducer — fold goal_journal events into GoalState"
```

---

### Task 3: Pure scheduler — `src/engine/decide.ts`

**Files:**
- Create: `src/engine/decide.ts`
- Test: `test/decide.test.ts` (create)

**Interfaces:**
- Consumes: `GoalState`, `nodeStatus` from `./reduce.js` (Task 2).
- Produces (engine.ts depends on these exact names):
  - `interface Caps { maxConcurrent: number; budgetAllowed: boolean; wallTimeMs: number; replanCap: number; plannerAvailable: boolean; maxAttempts: number }`
  - `type Command` — the 8-member union written below.
  - `decide(states: GoalState[], caps: Caps, now: number): Command[]` — pure; `now` is a parameter, never `Date.now()`.

- [ ] **Step 1: Write the failing test**

Build states through `reduce(events)` — never hand-assemble `GoalState`.

```ts
// test/decide.test.ts
import { describe, it, expect } from "vitest";
import { reduce } from "../src/engine/reduce.js";
import { decide, type Caps } from "../src/engine/decide.js";
import type { JournalEvent, JournalEventType } from "../src/engine/journal.js";

let seq = 0;
const ev = (goalId: string, gseq: number, type: JournalEventType, payload: Record<string, unknown>, ts = 1000): JournalEvent =>
  ({ seq: ++seq, goalId, gseq, type, payload, v: 1, ts });

const node = (key: string, dependsOn: string[] = []) =>
  ({ key, kind: "run", agent: "vulcan", critic: null, brief: "b", dependsOn, maxRounds: 1 });

/** Ready-to-run goal: created + planned + workspace done. */
function goal(goalId: string, keys: Array<{ key: string; deps?: string[] }>, over: Record<string, unknown> = {}) {
  let g = 0;
  return [
    ev(goalId, ++g, "goal.created", {
      slug: goalId, title: goalId, request: "r", department: "engineering", lead: "athena",
      origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
      planSummary: "planned", goalDir: `d-${goalId}`, projectDir: null, ...over,
    }),
    ev(goalId, ++g, "plan.recorded", { summary: "s", needsWorkspace: "none", nodes: keys.map((k) => node(k.key, k.deps ?? [])) }),
    ev(goalId, ++g, "workspace.prepared", { taskDir: null, mode: null }),
  ];
}
const withGseq = (base: JournalEvent[], type: JournalEventType, payload: Record<string, unknown>, ts = 1000) =>
  [...base, ev(base[0].goalId, base[base.length - 1].gseq + 1, type, payload, ts)];

const CAPS: Caps = { maxConcurrent: 2, budgetAllowed: true, wallTimeMs: 60_000, replanCap: 2, plannerAvailable: true, maxAttempts: 2 };
const att = (n: string, a: number, deadlineTs = 999_999) =>
  ({ node: n, attempt: a, agent: "vulcan", deadlineTs, idempotencyKey: "k" });
const fin = (n: string, a: number, outcome: string, error?: string) =>
  ({ node: n, attempt: a, outcome, costCents: 0, turns: 0, ...(error ? { error } : {}) });

describe("decide", () => {
  it("starts ready nodes attempt 1; never exceeds maxConcurrent; round-robin across goals", () => {
    const g1 = reduce(goal("g1", [{ key: "a" }, { key: "b" }, { key: "c" }]));
    const g2 = reduce(goal("g2", [{ key: "x" }, { key: "y" }]));
    const cmds = decide([g1, g2], { ...CAPS, maxConcurrent: 3 }, 1000);
    const starts = cmds.filter((c) => c.cmd === "StartAttempt");
    expect(starts).toHaveLength(3);
    // fairness: g2 gets a slot before g1's second node
    expect(starts.map((s: { goalId: string; node: string }) => `${s.goalId}:${s.node}`))
      .toEqual(["g1:a", "g2:x", "g1:b"]);
    expect(starts.every((s: { attempt: number }) => s.attempt === 1)).toBe(true);
  });

  it("running attempts consume global slots", () => {
    let evs = goal("g1", [{ key: "a" }, { key: "b" }, { key: "c" }]);
    evs = withGseq(evs, "attempt.started", att("a", 1));
    const cmds = decide([reduce(evs)], CAPS, 1000);
    expect(cmds.filter((c) => c.cmd === "StartAttempt")).toHaveLength(1); // 2 cap - 1 running
  });

  it("no command for non-ready nodes (dep gating)", () => {
    const s = reduce(goal("g1", [{ key: "a" }, { key: "b", deps: ["a"] }]));
    const starts = decide([s], CAPS, 1000).filter((c) => c.cmd === "StartAttempt");
    expect(starts.map((c: { node: string }) => c.node)).toEqual(["a"]);
  });

  it("errored node with attempts left → retry with attempt+1", () => {
    let evs = goal("g1", [{ key: "a" }]);
    evs = withGseq(evs, "attempt.started", att("a", 1));
    evs = withGseq(evs, "attempt.finished", fin("a", 1, "error", "boom"));
    const cmds = decide([reduce(evs)], CAPS, 1000);
    expect(cmds).toContainEqual({ cmd: "StartAttempt", goalId: "g1", node: "a", attempt: 2 });
  });

  it("attempts exhausted → FailNode; then failed node → RequestReplan (planned goal)", () => {
    let evs = goal("g1", [{ key: "a" }]);
    evs = withGseq(evs, "attempt.started", att("a", 1));
    evs = withGseq(evs, "attempt.finished", fin("a", 1, "error", "boom"));
    evs = withGseq(evs, "attempt.started", att("a", 2));
    evs = withGseq(evs, "attempt.finished", fin("a", 2, "error", "boom"));
    const c1 = decide([reduce(evs)], CAPS, 1000);
    expect(c1).toContainEqual({ cmd: "FailNode", goalId: "g1", node: "a", error: "boom" });
    expect(c1.filter((c) => c.cmd === "StartAttempt")).toHaveLength(0);
    evs = withGseq(evs, "node.failed", { node: "a", error: "boom" });
    const c2 = decide([reduce(evs)], CAPS, 1000);
    expect(c2).toContainEqual({ cmd: "RequestReplan", goalId: "g1", node: "a", error: "boom" });
  });

  it("failed node on facade/mail goal, or replan cap hit → FailGoal", () => {
    let f = goal("g1", [{ key: "a" }], { planSummary: "playbook:research-report" });
    f = withGseq(f, "node.failed", { node: "a", error: "boom" });
    expect(decide([reduce(f)], CAPS, 1000)[0]).toMatchObject({ cmd: "FailGoal", error: "node a failed: boom" });

    let m = goal("g2", [{ key: "a" }], { planSummary: "mail:m1" });
    m = withGseq(m, "node.failed", { node: "a", error: "boom" });
    expect(decide([reduce(m)], CAPS, 1000)[0]).toMatchObject({ cmd: "FailGoal" });

    let capped = goal("g3", [{ key: "a" }, { key: "b" }]);
    capped = withGseq(capped, "node.failed", { node: "a", error: "boom" });
    capped = withGseq(capped, "replan.recorded", { kind: "replan", forNode: "a", replaced: [], added: [node("b2")], retargets: [], reason: "1" });
    capped = withGseq(capped, "node.failed", { node: "b", error: "boom2" });
    capped = withGseq(capped, "replan.recorded", { kind: "replan", forNode: "b", replaced: [], added: [node("b3")], retargets: [], reason: "2" });
    capped = withGseq(capped, "node.failed", { node: "b2", error: "boom3" });
    const c = decide([reduce(capped)], CAPS, 1000);
    expect(c[0]).toMatchObject({ cmd: "FailGoal", goalId: "g3" });
    expect((c[0] as { error: string }).error).toContain("re-plans exhausted: 2");
  });

  it("a replanned-but-still-failed graph deadlocks → FailGoal stuck", () => {
    let evs = goal("g1", [{ key: "a" }, { key: "b", deps: ["a"] }]);
    evs = withGseq(evs, "node.failed", { node: "a", error: "boom" });
    // lead patched by adding an unrelated node; "a" was NOT replaced and stays failed
    evs = withGseq(evs, "replan.recorded", { kind: "replan", forNode: "a", replaced: [], added: [node("c")], retargets: [], reason: "boom" });
    evs = withGseq(evs, "node.completed", { node: "c", artifactRef: "c.md", roundsUsed: 0 });
    const cmds = decide([reduce(evs)], CAPS, 1000);
    expect(cmds).toContainEqual({
      cmd: "FailGoal", goalId: "g1", error: "stuck: unfinished nodes depend on failed/skipped nodes",
    });
  });

  it("all nodes done → CompleteGoal", () => {
    let evs = goal("g1", [{ key: "a" }]);
    evs = withGseq(evs, "node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 0 });
    expect(decide([reduce(evs)], CAPS, 1000)).toEqual([{ cmd: "CompleteGoal", goalId: "g1" }]);
  });

  it("wall-time exceeded (from last resume event) → FailGoal", () => {
    const fresh = reduce(goal("g1", [{ key: "a" }]));
    expect(decide([fresh], CAPS, 1000 + 60_001)[0]).toMatchObject({ cmd: "FailGoal", error: "Goal wall-time budget exceeded" });
    // resumed goal gets a fresh window
    let evs = goal("g1", [{ key: "a" }]);
    evs = withGseq(evs, "goal.paused", { reason: "budget" });
    evs = withGseq(evs, "goal.resumed", { by: "budget-reset" }, 100_000);
    const resumed = decide([reduce(evs)], CAPS, 100_000 + 59_000);
    expect(resumed.filter((c) => c.cmd === "FailGoal")).toHaveLength(0);
    expect(resumed).toContainEqual({ cmd: "StartAttempt", goalId: "g1", node: "a", attempt: 1 });
  });

  it("budget denied → ParkForBudget instead of starts; running goals untouched", () => {
    const s = reduce(goal("g1", [{ key: "a" }]));
    const cmds = decide([s], { ...CAPS, budgetAllowed: false }, 1000);
    expect(cmds).toEqual([{ cmd: "ParkForBudget", goalId: "g1" }]);
  });

  it("paused goals get no commands at all", () => {
    let evs = goal("g1", [{ key: "a" }]);
    evs = withGseq(evs, "goal.paused", { reason: "user" });
    expect(decide([reduce(evs)], CAPS, 1000)).toEqual([]);
  });

  it("past-deadline running attempt → AbortAttempt(timeout), even while parked", () => {
    let evs = goal("g1", [{ key: "a" }, { key: "b" }]);
    evs = withGseq(evs, "attempt.started", att("a", 1, 5000));
    evs = withGseq(evs, "ask.parked", { node: "b", mailId: "m1" });
    const cmds = decide([reduce(evs)], CAPS, 6000);
    expect(cmds).toContainEqual({ cmd: "AbortAttempt", goalId: "g1", node: "a", attempt: 1, reason: "timeout" });
  });

  it("parked goal: sibling retry allowed, fresh starts and completion suppressed", () => {
    let evs = goal("g1", [{ key: "a" }, { key: "b" }]);
    evs = withGseq(evs, "ask.parked", { node: "a", mailId: "m1" });
    evs = withGseq(evs, "attempt.started", att("b", 1));
    evs = withGseq(evs, "attempt.finished", fin("b", 1, "error", "boom"));
    const cmds = decide([reduce(evs)], CAPS, 1000);
    expect(cmds).toContainEqual({ cmd: "StartAttempt", goalId: "g1", node: "b", attempt: 2 });
    // all-done while parked: no CompleteGoal
    let done = goal("g2", [{ key: "a" }]);
    done = withGseq(done, "ask.parked", { node: "a", mailId: "m2" });
    expect(decide([reduce(done)], CAPS, 1000)).toEqual([]);
  });

  it("workspace pending → PrepareWorkspace, nothing starts; workspace failed → FailGoal", () => {
    const pending = reduce(goal("g1", [{ key: "a" }]).slice(0, 2)); // no workspace.prepared
    expect(decide([pending], CAPS, 1000)).toEqual([{ cmd: "PrepareWorkspace", goalId: "g1" }]);
    let failed = goal("g2", [{ key: "a" }]).slice(0, 2);
    failed = withGseq(failed, "workspace.failed", { error: "no disk" });
    expect(decide([reduce(failed)], CAPS, 1000)[0]).toMatchObject({
      cmd: "FailGoal", goalId: "g2", error: "workspace setup failed: no disk",
    });
  });

  it("terminal goals produce nothing", () => {
    let evs = goal("g1", [{ key: "a" }]);
    evs = withGseq(evs, "node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 0 });
    evs = withGseq(evs, "goal.completed", {});
    expect(decide([reduce(evs)], CAPS, 1000)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/decide.test.ts`
Expected: FAIL — `src/engine/decide.ts` does not exist.

- [ ] **Step 3: Create `src/engine/decide.ts`**

```ts
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
    const retries: StartCandidate[] = [];
    const fresh: StartCandidate[] = [];
    for (const key of s.order) {
      const n = s.nodes.get(key)!;
      if (n.status !== "pending" || n.runningAttempt) continue;
      if (n.lastOutcome && n.lastOutcome !== "ok" && n.attempts < caps.maxAttempts) {
        retries.push({ goalId: s.goalId, node: key, attempt: n.attempts + 1 });
      } else if (n.attempts === 0 && !n.lastOutcome && nodeStatus(s, key) === "ready") {
        fresh.push({ goalId: s.goalId, node: key, attempt: 1 });
      }
    }

    // Parked goals: retries only (a failing sibling must still fail the goal — locked
    // decision); no fresh starts, no completion, no wall-time until resumed.
    if (s.phase === "awaiting-mail") {
      if (retries.length && caps.budgetAllowed) queues.push(retries);
      continue;
    }

    // 5. Wall-time — measured from the last resume event: a budget-parked goal resumed
    //    next morning gets a fresh window instead of instant failure.
    if (now > s.lastResumeTs + caps.wallTimeMs) {
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
    if (!anyRunning && all.some((n) => n.status === "pending")) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/decide.test.ts`
Expected: PASS (15 tests). If the round-robin order assertion fails, fix the merge loop (not the test) — interleaving is the spec'd fairness change.

- [ ] **Step 5: Typecheck + full suite, then commit**

Run: `npx tsc --noEmit && npx vitest run`

```bash
git add src/engine/decide.ts test/decide.test.ts
git commit -m "feat(engine): pure decide() scheduler — caps, retries, replan policy, round-robin fairness"
```

---

### Task 4: Projections — `src/engine/project.ts` + legacy freeze

**Files:**
- Create: `src/engine/project.ts`
- Modify: `src/engine/journal.ts` (wire `projectEvent` into `appendEvents` + `replayInto`)
- Modify: `src/store/db.ts` (legacy column migration; scope 3 queries; `legacy?: number` on `GoalRow`)
- Test: `test/project.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 journal, Task 2 `reduce`/`nodeStatus` (equivalence test), existing Store row methods (`insertGoal`, `insertNodes`, `replaceNode`, `updateNodeStatus`, `updateNodeDeps`, `setNodeArtifact`, `setNodeRounds`, `addNodeCost`, `setGoalProjectDir`, `parkGoalAwaiting`, `clearAwaiting`, `updateGoalStatus`, `bumpReplans`).
- Produces:
  - `projectEvent(store: Store, ev: JournalEvent): void` — called by `appendEvents`/`replayInto` inside the append transaction. After this task every append maintains `goals`/`task_nodes` automatically.
  - db.ts: `goals.legacy` column (0 = journal-backed, 1 = frozen pre-journal row); `unfinishedGoals()`, `pausedBudgetGoals()`, `awaitingMailGoals()` gain `AND legacy = 0`.

- [ ] **Step 1: Write the failing test**

```ts
// test/project.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { appendEvents, readJournal, type JournalEventType } from "../src/engine/journal.js";
import { reduce, nodeStatus } from "../src/engine/reduce.js";

const created = (over: Record<string, unknown> = {}) => ({
  type: "goal.created" as JournalEventType,
  payload: {
    slug: "x", title: "X", request: "do x", department: "engineering", lead: "athena",
    origin: { channel: "t", chatId: "1" }, chainDepth: 2, spawnedByMail: "m9",
    planSummary: "planned", goalDir: "2026-07-13-x", projectDir: "/p", ...over,
  },
});
const node = (key: string, dependsOn: string[] = []) =>
  ({ key, kind: "run", agent: "vulcan", critic: null, brief: "b", dependsOn, maxRounds: 1 });
const plan = (...keys: string[]) =>
  ({ type: "plan.recorded" as JournalEventType, payload: { summary: "s", needsWorkspace: "none", nodes: keys.map((k) => node(k)) } });

describe("projections", () => {
  it("goal.created + plan.recorded materialize goals/task_nodes rows (legacy=0)", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [created(), plan("a", "b")]);
    const g = store.getGoal("g1")!;
    expect(g).toMatchObject({
      slug: "x", title: "X", status: "running", department: "engineering", lead: "athena",
      plan_summary: "planned", chain_depth: 2, spawned_by_mail: "m9",
      goal_dir: "2026-07-13-x", project_dir: "/p",
    });
    expect(g.legacy ?? 0).toBe(0);
    const nodes = store.listNodes("g1");
    expect(nodes.map((n) => [n.node_key, n.status])).toEqual([["a", "ready"], ["b", "ready"]]);
  });

  it("full lifecycle keeps projected rows ≡ reduced state after EVERY event", () => {
    const store = new Store(":memory:");
    const steps: Array<{ type: JournalEventType; payload: Record<string, unknown> }> = [
      created({ spawnedByMail: null, chainDepth: 0, projectDir: null }),
      { type: "plan.recorded", payload: { summary: "s", needsWorkspace: "none", nodes: [node("a"), node("b", ["a"])] } },
      { type: "workspace.prepared", payload: { taskDir: "/ws/t", mode: "build" } },
      { type: "attempt.started", payload: { node: "a", attempt: 1, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:a:1" } },
      { type: "round.recorded", payload: { node: "a", attempt: 1, round: 1, role: "critic", verdict: { verdict: "approve", summary: "ok", reasons: [] }, feedback: "", artifactRef: "a-v1.md" } },
      { type: "attempt.finished", payload: { node: "a", attempt: 1, outcome: "ok", costCents: 25, turns: 4 } },
      { type: "node.completed", payload: { node: "a", artifactRef: "a.md", roundsUsed: 1 } },
      { type: "attempt.started", payload: { node: "b", attempt: 1, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:b:1" } },
      { type: "attempt.finished", payload: { node: "b", attempt: 1, outcome: "error", costCents: 5, turns: 1, error: "boom" } },
      { type: "attempt.started", payload: { node: "b", attempt: 2, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:b:2" } },
      { type: "attempt.finished", payload: { node: "b", attempt: 2, outcome: "error", costCents: 5, turns: 1, error: "boom" } },
      { type: "node.failed", payload: { node: "b", error: "boom" } },
      { type: "goal.failed", payload: { error: "node b failed: boom" } },
    ];
    for (const step of steps) {
      appendEvents(store, "g1", [step]);
      const state = reduce(readJournal(store, "g1"));
      const row = store.getGoal("g1")!;
      expect(row.status, step.type).toBe(state.phase === "awaiting-mail" ? "awaiting-mail" : state.phase);
      for (const key of state.order) {
        const nodeRow = store.listNodes("g1").find((n) => n.node_key === key)!;
        expect(nodeRow.status, `${step.type}/${key}`).toBe(nodeStatus(state, key));
        expect(nodeRow.cost_cents, `${step.type}/${key}`).toBe(state.nodes.get(key)!.costCents);
        expect(nodeRow.artifact, `${step.type}/${key}`).toBe(state.nodes.get(key)!.artifact);
      }
    }
    expect(store.getGoal("g1")!.error).toBe("node b failed: boom");
    expect(store.listNodes("g1").find((n) => n.node_key === "b")!.rounds_used).toBe(0);
    expect(store.listNodes("g1").find((n) => n.node_key === "a")!.rounds_used).toBe(1);
  });

  it("replan.recorded projects replace/add/retarget + bumps replans_used (replan kind only)", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [created(), plan("a", "b")]);
    appendEvents(store, "g1", [{ type: "node.failed", payload: { node: "a", error: "x" } }]);
    appendEvents(store, "g1", [{ type: "replan.recorded", payload: {
      kind: "replan", forNode: "a", replaced: [node("a")], added: [node("c")],
      retargets: [{ node: "b", dependsOn: ["c"] }], reason: "x",
    } }]);
    expect(store.getGoal("g1")!.replans_used).toBe(1);
    const rows = store.listNodes("g1");
    expect(rows.find((n) => n.node_key === "a")!.status).toBe("ready"); // replaced + no deps
    expect(JSON.parse(rows.find((n) => n.node_key === "b")!.depends_on)).toEqual(["c"]);
    expect(rows.some((n) => n.node_key === "c")).toBe(true);
    appendEvents(store, "g1", [{ type: "replan.recorded", payload: {
      kind: "resume", forNode: null, replaced: [], added: [node("resume_1")], retargets: [], reason: "ask",
    } }]);
    expect(store.getGoal("g1")!.replans_used).toBe(1); // resume never bumps
  });

  it("ask.parked/resumed + pause/resume + abandon project statuses and ask pointer", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [created(), plan("a", "b")]);
    appendEvents(store, "g1", [{ type: "ask.parked", payload: { node: "a", mailId: "m1" } }]);
    expect(store.getGoal("g1")).toMatchObject({ status: "awaiting-mail", awaiting_mail: "m1" });
    expect(store.listNodes("g1").find((n) => n.node_key === "a")!.status).toBe("done");
    appendEvents(store, "g1", [{ type: "ask.resumed", payload: { mailId: "m1", resumeNodeKey: "resume_1" } }]);
    expect(store.getGoal("g1")).toMatchObject({ status: "running", awaiting_mail: null });
    appendEvents(store, "g1", [{ type: "goal.paused", payload: { reason: "budget" } }]);
    expect(store.getGoal("g1")!.status).toBe("paused-budget");
    appendEvents(store, "g1", [{ type: "goal.resumed", payload: { by: "budget-reset" } }]);
    expect(store.getGoal("g1")!.status).toBe("running");
    appendEvents(store, "g1", [
      { type: "node.skipped", payload: { node: "b" } },
      { type: "goal.abandoned", payload: { by: "user" } },
    ]);
    expect(store.getGoal("g1")!.status).toBe("abandoned");
    expect(store.listNodes("g1").find((n) => n.node_key === "b")!.status).toBe("skipped");
  });

  it("goal.failed on a parked goal clears the dangling ask pointer", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [created(), plan("a", "b")]);
    appendEvents(store, "g1", [{ type: "ask.parked", payload: { node: "a", mailId: "m1" } }]);
    appendEvents(store, "g1", [{ type: "goal.failed", payload: { error: "sibling died" } }]);
    expect(store.getGoal("g1")).toMatchObject({ status: "failed", awaiting_mail: null });
  });

  it("workspace.prepared strips project_dir when stripped, sets it when taskDir", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [created(), plan("a")]);
    appendEvents(store, "g1", [{ type: "workspace.prepared", payload: { taskDir: null, mode: null, stripped: true } }]);
    expect(store.getGoal("g1")!.project_dir).toBeNull();
    appendEvents(store, "g2", [created({ slug: "y" }), plan("a")]);
    appendEvents(store, "g2", [{ type: "workspace.prepared", payload: { taskDir: "/ws/z", mode: "analyze" } }]);
    expect(store.getGoal("g2")!.project_dir).toBe("/ws/z");
  });

  it("legacy freeze: pre-migration rows get legacy=1 and drop out of scheduler queries", () => {
    const store = new Store(":memory:");
    // simulate an old row: insertGoal writes legacy default 0, flip it like the migration would
    store.insertGoal({
      id: "old1", slug: "old", title: "O", request: "o", department: "engineering", lead: "athena",
      origin_channel: "t", origin_chat_id: "1", status: "running", project_dir: null, goal_dir: null,
      plan_summary: "planned", replans_used: 0, chain_depth: 0, error: null,
    });
    store.freezeLegacyGoals();
    expect(store.unfinishedGoals()).toHaveLength(0);          // frozen: never scheduled
    expect(store.getGoal("old1")!.legacy).toBe(1);            // still readable
    appendEvents(store, "g1", [created(), plan("a")]);
    expect(store.unfinishedGoals().map((g) => g.id)).toEqual(["g1"]); // journal goals schedule
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/project.test.ts`
Expected: FAIL — `projectEvent` not wired (rows never materialize) and `freezeLegacyGoals` missing.

- [ ] **Step 3: Create `src/engine/project.ts`**

```ts
// src/engine/project.ts — materialized projections. goals/task_nodes are a read cache of
// the journal, maintained per event IN THE SAME TRANSACTION as the append (journal.ts
// calls this). Shapes are byte-compatible with the legacy engine so dto.ts, goals-view,
// Mission Control, moderator tools and /api/goals are untouched. Never write these
// tables from anywhere else for journal-backed goals.
import type { Store, NewTaskNode } from "../store/db.js";
import type {
  JournalEvent, NodeSpec,
  GoalCreatedPayload, PlanRecordedPayload, ReplanRecordedPayload,
  WorkspacePreparedPayload, AttemptStartedPayload, RoundRecordedPayload,
  AttemptFinishedPayload, NodeCompletedPayload,
} from "./journal.js";

const toRow = (n: NodeSpec): NewTaskNode => ({
  node_key: n.key, type: n.kind, agent: n.agent, critic: n.critic,
  brief: n.brief, depends_on: n.dependsOn, max_rounds: n.maxRounds,
});

/** Derived 'ready': pending nodes whose deps are all done (UI shape preserved). */
function refreshReady(store: Store, goalId: string): void {
  const nodes = store.listNodes(goalId);
  const done = new Set(nodes.filter((n) => n.status === "done").map((n) => n.node_key));
  for (const n of nodes) {
    if (n.status === "pending" && (JSON.parse(n.depends_on) as string[]).every((d) => done.has(d))) {
      store.updateNodeStatus(goalId, n.node_key, "ready");
    }
  }
}

export function projectEvent(store: Store, ev: JournalEvent): void {
  const goalId = ev.goalId;
  switch (ev.type) {
    case "goal.created": {
      const p = ev.payload as unknown as GoalCreatedPayload;
      store.insertGoal({
        id: goalId, slug: p.slug, title: p.title, request: p.request, department: p.department,
        lead: p.lead, origin_channel: p.origin.channel, origin_chat_id: p.origin.chatId,
        status: "running", project_dir: p.projectDir, goal_dir: p.goalDir,
        plan_summary: p.planSummary, replans_used: 0, chain_depth: p.chainDepth,
        spawned_by_mail: p.spawnedByMail, error: null,
      });
      return;
    }
    case "plan.recorded": {
      const p = ev.payload as unknown as PlanRecordedPayload;
      store.insertNodes(goalId, p.nodes.map(toRow));
      refreshReady(store, goalId);
      return;
    }
    case "replan.recorded": {
      const p = ev.payload as unknown as ReplanRecordedPayload;
      for (const n of p.replaced) store.replaceNode(goalId, n.key, toRow(n));
      if (p.added.length) store.insertNodes(goalId, p.added.map(toRow));
      for (const r of p.retargets) store.updateNodeDeps(goalId, r.node, r.dependsOn);
      if (p.kind === "replan") store.bumpReplans(goalId);
      refreshReady(store, goalId);
      return;
    }
    case "workspace.prepared": {
      const p = ev.payload as unknown as WorkspacePreparedPayload;
      if (p.taskDir) store.setGoalProjectDir(goalId, p.taskDir);
      else if (p.stripped) store.setGoalProjectDir(goalId, null);
      return;
    }
    case "workspace.failed":
      return; // goal.failed follows in the same command cycle
    case "attempt.started": {
      const p = ev.payload as unknown as AttemptStartedPayload;
      store.updateNodeStatus(goalId, p.node, "running");
      return;
    }
    case "round.recorded": {
      const p = ev.payload as unknown as RoundRecordedPayload;
      store.setNodeRounds(goalId, p.node, p.round);
      return;
    }
    case "attempt.finished": {
      const p = ev.payload as unknown as AttemptFinishedPayload;
      if (p.costCents) store.addNodeCost(goalId, p.node, p.costCents);
      if (p.outcome !== "ok") {
        // Retryable (or about to be node.failed) — surface as ready, not stuck-running.
        const row = store.listNodes(goalId).find((n) => n.node_key === p.node);
        if (row?.status === "running") store.updateNodeStatus(goalId, p.node, "ready", p.error ?? p.outcome);
      }
      return;
    }
    case "node.completed": {
      const p = ev.payload as unknown as NodeCompletedPayload;
      store.setNodeArtifact(goalId, p.node, p.artifactRef);
      if (p.roundsUsed) store.setNodeRounds(goalId, p.node, p.roundsUsed);
      store.updateNodeStatus(goalId, p.node, "done");
      refreshReady(store, goalId);
      return;
    }
    case "node.failed": {
      const p = ev.payload as { node: string; error?: string };
      store.updateNodeStatus(goalId, p.node, "failed", p.error);
      return;
    }
    case "node.skipped": {
      const p = ev.payload as { node: string };
      const row = store.listNodes(goalId).find((n) => n.node_key === p.node);
      if (row && (row.status === "pending" || row.status === "ready")) {
        store.updateNodeStatus(goalId, p.node, "skipped");
      }
      return;
    }
    case "ask.parked": {
      const p = ev.payload as { node: string | null; mailId: string };
      if (p.node) store.updateNodeStatus(goalId, p.node, "done");
      store.parkGoalAwaiting(goalId, p.mailId);
      return;
    }
    case "ask.resumed":
      store.clearAwaiting(goalId);
      store.updateGoalStatus(goalId, "running");
      return;
    case "goal.paused": {
      const p = ev.payload as { reason: "budget" | "user"; error?: string };
      store.updateGoalStatus(goalId, p.reason === "budget" ? "paused-budget" : "paused-user", p.error);
      return;
    }
    case "goal.resumed":
      store.updateGoalStatus(goalId, "running");
      return;
    case "goal.completed":
      store.updateGoalStatus(goalId, "done");
      return;
    case "goal.failed":
      store.clearAwaiting(goalId); // a parked goal failing must not leave a dangling ask
      store.updateGoalStatus(goalId, "failed", String((ev.payload as { error: string }).error));
      return;
    case "goal.abandoned":
      store.clearAwaiting(goalId);
      store.updateGoalStatus(goalId, "abandoned");
      return;
  }
}
```

- [ ] **Step 4: Wire projections into journal.ts**

In `src/engine/journal.ts`: add `import { projectEvent } from "./project.js";` and inside `appendEvents`' transaction body, after `out.push(...)`, project each event; same in `replayInto`:

```ts
        events.forEach((e, i) => {
          const seq = store.journalInsert(goalId, base + 1 + i, e.type, JSON.stringify(e.payload), now);
          const ev: JournalEvent = { seq, goalId, gseq: base + 1 + i, type: e.type, payload: e.payload, v: 1, ts: now };
          projectEvent(store, ev);
          out.push(ev);
        });
```

```ts
export function replayInto(store: Store, events: JournalEvent[]): void {
  for (const ev of events) {
    runTx(store, () => {
      store.journalInsert(ev.goalId, ev.gseq, ev.type, JSON.stringify(ev.payload), ev.ts);
      projectEvent(store, ev);
    });
  }
}
```

- [ ] **Step 5: db.ts — legacy column + scoped queries**

Constructor, next to the other goals ALTERs (db.ts:280-294):

```ts
    // Migration (journaled engine): freeze pre-journal goals. Runs exactly once — the
    // ALTER succeeds only the first time; rows existing at that moment are the legacy set.
    try {
      this.db.exec("ALTER TABLE goals ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0");
      this.db.exec("UPDATE goals SET legacy = 1");
    } catch { /* column exists — migration already ran */ }
```

Add to `GoalRow` interface: `legacy?: number;` (optional — existing literals stay valid).

Add a test-visible helper next to `unfinishedGoals` (the migration path above is unreachable from `:memory:` tests that insert rows AFTER construction):

```ts
  /** Test/ops helper mirroring the freeze migration: mark all current rows legacy. */
  freezeLegacyGoals(): void {
    this.db.exec("UPDATE goals SET legacy = 1");
  }
```

Scope the three scheduler queries (`unfinishedGoals` db.ts:555, `pausedBudgetGoals` db.ts:561, `awaitingMailGoals` db.ts:881) — add `AND legacy = 0` to each WHERE clause, e.g.:

```ts
  unfinishedGoals(): GoalRow[] {
    return this.db.prepare(
      "SELECT * FROM goals WHERE status IN ('planning','running','replanning') AND legacy = 0 ORDER BY created_at ASC",
    ).all() as unknown as GoalRow[];
  }
```

(`listGoals`, `goalsUpdatedSince`, `getGoal`, `getGoalBySlug` stay unscoped — legacy rows remain readable in UI/API.)

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/project.test.ts test/journal.test.ts test/goal-store.test.ts test/goal-scheduler.test.ts`
Expected: all PASS. The old engine's tests still pass because their goals go through `insertGoal` (legacy=0 default) — freezing only happens via the one-shot migration/`freezeLegacyGoals`.

- [ ] **Step 7: Typecheck + full suite, then commit**

Run: `npx tsc --noEmit && npx vitest run`

```bash
git add src/engine/project.ts src/engine/journal.ts src/store/db.ts test/project.test.ts
git commit -m "feat(engine): journal projections maintain goals/task_nodes in-transaction; legacy freeze migration"
```

---

### Task 5: Workers — `src/engine/workers.ts` (attempt runner + abort registry)

**Files:**
- Create: `src/engine/workers.ts`
- Test: `test/workers.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 `appendEvents`/`attemptClaimed`/`readJournal` + payload types; Task 2 `reduce`; `RunOptions.signal` (already exists — `src/agents/runner.ts:105`); `VaultWriter.writeGoalArtifact`/`readGoalArtifact`; `Store.listNodes`.
- Produces (engine.ts depends on these exact names):
  - `class SessionLimitError extends Error` (moves here from goals.ts; barrel re-export at cutover).
  - `interface Verdict { verdict: "approve" | "revise"; summary: string; reasons: string[] }`, `interface TestReport { passed: boolean; summary: string; failures: string[] }` (move here).
  - `ancestorArtifacts(nodes: TaskNodeRow[], key: string): TaskNodeRow[]` (moves here, verbatim).
  - `class AbortRegistry` — `key(goalId, node, attempt): string`, `register(key): AbortController`, `abort(key, reason: "timeout" | "budget" | "abandoned"): void`, `abortAll(reason): void`, `reason(key)`, `finish(key)`, `size(): number`.
  - `interface WorkerDeps { store; vault; run; model?; log?; onEvent?; resolvePack: (goal: GoalRow, spec: NodeSpec, attempt: number) => ResolvedPack | undefined; registry: AbortRegistry; nodeTimeoutMs: number }`
  - `runAttempt(goal: GoalRow, spec: NodeSpec, attempt: number, deps: WorkerDeps): Promise<{ claimed: boolean; outcome: AttemptOutcome | null; sessionLimit: boolean }>`

- [ ] **Step 1: Write the failing test**

```ts
// test/workers.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { appendEvents, readJournal, type NodeSpec, type JournalEventType } from "../src/engine/journal.js";
import { AbortRegistry, runAttempt, SessionLimitError, ancestorArtifacts, type WorkerDeps } from "../src/engine/workers.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";

const SPEC = (over: Partial<NodeSpec> = {}): NodeSpec =>
  ({ key: "design", kind: "run", agent: "athena", critic: null, brief: "design it", dependsOn: [], maxRounds: 3, ...over });

function harness(run: SpecialistRunFn, specs: NodeSpec[] = [SPEC()]) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "wk-vault-")), "AIOS");
  const goalDir = vault.goalDirName("build-x");
  appendEvents(store, "g1", [
    { type: "goal.created", payload: {
      slug: "build-x", title: "Build X", request: "build x", department: "engineering", lead: "athena",
      origin: { channel: "telegram", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
      planSummary: "planned", goalDir, projectDir: null } },
    { type: "plan.recorded", payload: { summary: "s", needsWorkspace: "none", nodes: specs } },
    { type: "workspace.prepared", payload: { taskDir: null, mode: null } },
  ]);
  const registry = new AbortRegistry();
  const deps: WorkerDeps = {
    store, vault, run, registry, nodeTimeoutMs: 900_000,
    resolvePack: () => undefined,
  };
  return { store, vault, deps, registry, goalDir, goal: () => store.getGoal("g1")! };
}

const journalTypes = (store: Store) => readJournal(store, "g1").map((e) => e.type);
const payloadOf = (store: Store, type: JournalEventType) =>
  readJournal(store, "g1").filter((e) => e.type === type).map((e) => e.payload);

describe("runAttempt — run nodes", () => {
  it("claims, runs with brief+context, writes artifact, journals ok + cost", async () => {
    const briefs: string[] = [];
    const { store, vault, deps, goalDir, goal } = harness(async (_r, brief) => {
      briefs.push(brief);
      return { text: "the design", costUsd: 0.05, numTurns: 2 };
    });
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res).toEqual({ claimed: true, outcome: "ok", sessionLimit: false });
    expect(briefs[0]).toContain("design it");
    expect(briefs[0]).toContain("# Task\nbuild x");
    expect(vault.readGoalArtifact(goalDir, "design.md")).toContain("the design");
    expect(journalTypes(store)).toContain("attempt.started");
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({ node: "design", attempt: 1, outcome: "ok", costCents: 5, turns: 2 });
    expect(payloadOf(store, "node.completed")[0]).toMatchObject({ node: "design", artifactRef: "design.md" });
    expect(payloadOf(store, "attempt.started")[0]).toMatchObject({ idempotencyKey: "g1:design:1" });
    // projections followed
    expect(store.listNodes("g1")[0]).toMatchObject({ status: "done", artifact: "design.md", cost_cents: 5 });
  });

  it("lost claim: pre-existing attempt.started for same node+attempt → run fn never called", async () => {
    let calls = 0;
    const { store, deps, goal } = harness(async () => { calls++; return { text: "x", costUsd: 0, numTurns: 1 }; });
    appendEvents(store, "g1", [{ type: "attempt.started", payload: { node: "design", attempt: 1, agent: "athena", deadlineTs: 9e12, idempotencyKey: "g1:design:1" } }]);
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.claimed).toBe(false);
    expect(calls).toBe(0);
  });

  it("run error → attempt.finished{error}, no node.completed, no throw", async () => {
    const { store, deps, goal } = harness(async () => { throw new Error("flake"); });
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.outcome).toBe("error");
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({ outcome: "error", error: "flake" });
    expect(journalTypes(store)).not.toContain("node.completed");
  });

  it("session-limit output → outcome error + sessionLimit flag, run not retried here", async () => {
    let calls = 0;
    const { deps, goal } = harness(async () => {
      calls++;
      return { text: "You've hit your session limit — resets at 3pm", costUsd: 0, numTurns: 1 };
    });
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.sessionLimit).toBe(true);
    expect(calls).toBe(1);
  });

  it("abort with timeout reason → outcome timeout; budget reason → aborted", async () => {
    for (const [reason, outcome] of [["timeout", "timeout"], ["budget", "aborted"]] as const) {
      const { deps, registry, goal, store } = harness((_r, _b, opts) =>
        new Promise((_res, rej) => opts.signal?.addEventListener("abort", () => rej(new Error("aborted by signal")))));
      const p = runAttempt(goal(), SPEC(), 1, deps);
      await new Promise((r) => setTimeout(r, 10));
      registry.abort(registry.key("g1", "design", 1), reason);
      const res = await p;
      expect(res.outcome, reason).toBe(outcome);
      expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({ outcome });
    }
  });
});

describe("runAttempt — loop nodes", () => {
  const LOOP = SPEC({ key: "impl", kind: "loop", agent: "vulcan", critic: "minos-eng", maxRounds: 3 });

  it("revise then approve: rounds journaled, artifacts per round, final artifact clean", async () => {
    let call = 0;
    const { store, vault, deps, goalDir, goal } = harness(async (role) => {
      call++;
      if (role === "minos-eng") {
        const verdict = call === 2
          ? { verdict: "revise", summary: "needs work", reasons: ["r1"] }
          : { verdict: "approve", summary: "good", reasons: [] };
        return { text: "review", structured: verdict, costUsd: 0.01, numTurns: 1 };
      }
      return { text: `v${call}`, costUsd: 0.01, numTurns: 1 };
    }, [LOOP]);
    await runAttempt(goal(), LOOP, 1, deps);
    const rounds = payloadOf(store, "round.recorded");
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({ node: "impl", round: 1, role: "critic" });
    expect(rounds[1]).toMatchObject({ round: 2 });
    expect(vault.readGoalArtifact(goalDir, "impl-v1.md")).toBeTruthy();
    expect(vault.readGoalArtifact(goalDir, "impl-review-2.md")).toContain("approve");
    expect(vault.readGoalArtifact(goalDir, "impl.md")).not.toContain("Loop cap reached");
    expect(store.listNodes("g1")[0].rounds_used).toBe(2);
  });

  it("cap without approval: soft-gate note appended (current behavior preserved)", async () => {
    const { vault, deps, goalDir, goal } = harness(async (role) =>
      role === "minos-eng"
        ? { text: "r", structured: { verdict: "revise", summary: "no", reasons: [] }, costUsd: 0, numTurns: 1 }
        : { text: "draft", costUsd: 0, numTurns: 1 }, [LOOP]);
    await runAttempt(goal(), LOOP, 1, deps);
    expect(vault.readGoalArtifact(goalDir, "impl.md")).toContain("Loop cap reached");
  });

  it("crash-resume: attempt 2 starts at round N+1 with the critic's last feedback", async () => {
    const briefs: string[] = [];
    const { store, deps, goal } = harness(async (role, brief) => {
      briefs.push(`${role}:${brief}`);
      if (role === "minos-eng") return { text: "r", structured: { verdict: "approve", summary: "ok", reasons: [] }, costUsd: 0, numTurns: 1 };
      return { text: "v2", costUsd: 0, numTurns: 1 };
    }, [LOOP]);
    // seed: attempt 1 completed round 1 (revise) then died (orphaned)
    appendEvents(store, "g1", [
      { type: "attempt.started", payload: { node: "impl", attempt: 1, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:impl:1" } },
      { type: "round.recorded", payload: { node: "impl", attempt: 1, round: 1, role: "critic",
        verdict: { verdict: "revise", summary: "needs tests", reasons: ["add tests"] },
        feedback: "needs tests\n- add tests", artifactRef: "impl-v1.md" } },
      { type: "attempt.finished", payload: { node: "impl", attempt: 1, outcome: "orphaned", costCents: 0, turns: 0 } },
    ]);
    await runAttempt(goal(), LOOP, 2, deps);
    const producerBrief = briefs.find((b) => b.startsWith("vulcan:"))!;
    expect(producerBrief).toContain("needs tests");           // resumed with feedback
    expect(producerBrief).toContain("round 1");                // labeled as prior round's feedback
    const rounds = payloadOf(store, "round.recorded");
    expect(rounds[rounds.length - 1]).toMatchObject({ round: 2, attempt: 2 }); // NOT round 1 again
  });
});

describe("runAttempt — verify nodes", () => {
  const VERIFY = SPEC({ key: "test", kind: "verify", agent: "argus", critic: "vulcan", maxRounds: 3 });

  it("failing report triggers fixer, passing stops; roles sequence preserved", async () => {
    let runnerCalls = 0;
    const roles: string[] = [];
    const { store, deps, goal } = harness(async (role) => {
      roles.push(role);
      if (role === "argus") {
        runnerCalls++;
        return { text: "report", structured: { passed: runnerCalls > 1, summary: "s", failures: runnerCalls > 1 ? [] : ["f1"] }, costUsd: 0.01, numTurns: 1 };
      }
      return { text: "fixed", costUsd: 0.01, numTurns: 1 };
    }, [VERIFY]);
    await runAttempt(goal(), VERIFY, 1, deps);
    expect(roles).toEqual(["argus", "vulcan", "argus"]);
    const rounds = payloadOf(store, "round.recorded");
    expect(rounds.map((r) => r.role)).toEqual(["runner", "fixer", "runner"]);
    expect(store.listNodes("g1")[0].rounds_used).toBe(2);
  });

  it("crash-resume after failing runner round: fixer for that round runs, then next runner round", async () => {
    const roles: string[] = [];
    const { store, deps, goal } = harness(async (role) => {
      roles.push(role);
      if (role === "argus") return { text: "r", structured: { passed: true, summary: "ok", failures: [] }, costUsd: 0, numTurns: 1 };
      return { text: "fixed", costUsd: 0, numTurns: 1 };
    }, [VERIFY]);
    appendEvents(store, "g1", [
      { type: "attempt.started", payload: { node: "test", attempt: 1, agent: "argus", deadlineTs: 9e12, idempotencyKey: "g1:test:1" } },
      { type: "round.recorded", payload: { node: "test", attempt: 1, round: 1, role: "runner",
        report: { passed: false, summary: "broke", failures: ["f1"] }, feedback: "broke\n- f1", artifactRef: "test-run-1.md" } },
      { type: "attempt.finished", payload: { node: "test", attempt: 1, outcome: "orphaned", costCents: 0, turns: 0 } },
    ]);
    await runAttempt(goal(), VERIFY, 2, deps);
    expect(roles).toEqual(["vulcan", "argus"]); // fixer first (round 1 pending fix), then runner round 2
  });
});

describe("ancestorArtifacts + parked-node guard", () => {
  it("ancestorArtifacts: transitive deps only, done+artifact only", () => {
    const { store } = harness(async () => ({ text: "", costUsd: 0, numTurns: 0 }),
      [SPEC({ key: "a" }), SPEC({ key: "b", dependsOn: ["a"] }), SPEC({ key: "sib", dependsOn: ["a"] }), SPEC({ key: "c", dependsOn: ["b"] })]);
    for (const k of ["a", "b", "sib"]) {
      appendEvents(store, "g1", [{ type: "node.completed", payload: { node: k, artifactRef: `${k}.md`, roundsUsed: 0 } }]);
    }
    const anc = ancestorArtifacts(store.listNodes("g1"), "c").map((n) => n.node_key);
    expect(anc.sort()).toEqual(["a", "b"]);
  });

  it("a node parked done via ask_mail mid-attempt does not get re-completed", async () => {
    const { store, deps, goal } = harness(async () => {
      // simulate the agent calling ask_mail mid-run: the node flips done via ask.parked
      appendEvents(store, "g1", [{ type: "ask.parked", payload: { node: "design", mailId: "mQ" } }]);
      return { text: "asked, stopping", costUsd: 0, numTurns: 1 };
    });
    await runAttempt(goal(), SPEC(), 1, deps);
    expect(journalTypes(store).filter((t) => t === "node.completed")).toHaveLength(0);
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({ outcome: "ok" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workers.test.ts`
Expected: FAIL — `src/engine/workers.ts` does not exist.

- [ ] **Step 3: Create `src/engine/workers.ts`**

Port of `runOnce`/`runAgent`/`contextBlock` from goals.ts:88-214, with journal claims, per-round events, resume, and abort. Copy the helper bodies EXACTLY as shown (they must stay byte-compatible with the old artifacts):

```ts
// src/engine/workers.ts — attempt runner + abort registry. A worker executes one
// StartAttempt command: claims it via attempt.started (a lost optimistic-gseq claim
// means another context owns it — drop silently), runs the node kind with per-round
// journal events, and closes with attempt.finished. Crash mid-loop resumes at round N
// with the critic's last feedback, not round 1.
import type { Store, GoalRow, TaskNodeRow } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { SpecialistRunFn } from "../agents/runner.js";
import type { ResolvedPack } from "../packs/resolve.js";
import type { AiosEvent } from "../events.js";
import {
  appendEvents, attemptClaimed, readJournal,
  type NodeSpec, type AttemptOutcome, type EventInput,
  type AttemptStartedPayload, type RoundRecordedPayload,
} from "./journal.js";
import { reduce } from "./reduce.js";

const ARTIFACT_CHAR_LIMIT = 12_000;

export class SessionLimitError extends Error {
  readonly name = "SessionLimitError";
}

const SESSION_LIMIT_PATTERNS = ["you've hit your session limit", "hit your session limit"] as const;
function isSessionLimitOutput(text: string): boolean {
  const lower = text.toLowerCase().trimStart();
  return SESSION_LIMIT_PATTERNS.some((p) => lower.includes(p));
}

export interface Verdict { verdict: "approve" | "revise"; summary: string; reasons: string[] }
export interface TestReport { passed: boolean; summary: string; failures: string[] }

function truncate(text: string, limit = ARTIFACT_CHAR_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n[...truncated]`;
}

/** Transitive dependency closure of `key`, restricted to done nodes with an artifact. */
export function ancestorArtifacts(nodes: TaskNodeRow[], key: string): TaskNodeRow[] {
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const seen = new Set<string>();
  const walk = (k: string) => {
    for (const dep of JSON.parse(byKey.get(k)?.depends_on ?? "[]") as string[]) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      walk(dep);
    }
  };
  walk(key);
  return nodes.filter((n) => seen.has(n.node_key) && n.status === "done" && n.artifact);
}

function contextBlock(goal: GoalRow, ancestors: TaskNodeRow[], vault: VaultWriter): string {
  const parts = [
    `# Task\n${goal.request}`,
    goal.project_dir ? `# Working directory\n${goal.project_dir}` : "",
  ];
  for (const a of ancestors) {
    const content = vault.readGoalArtifact(goal.goal_dir!, a.artifact!) ?? "";
    parts.push(`# Prior artifact: ${a.artifact} (by ${a.agent})\n${truncate(content)}`);
  }
  return parts.filter(Boolean).join("\n\n---\n\n");
}

/** One AbortController per in-flight attempt, keyed goalId:node:attempt. The engine's
 *  clock tick aborts past-deadline attempts; crossing the budget cap aborts everything. */
export class AbortRegistry {
  private controllers = new Map<string, AbortController>();
  private reasons = new Map<string, "timeout" | "budget" | "abandoned">();

  key(goalId: string, node: string, attempt: number): string {
    return `${goalId}:${node}:${attempt}`;
  }
  register(key: string): AbortController {
    const c = new AbortController();
    this.controllers.set(key, c);
    return c;
  }
  abort(key: string, reason: "timeout" | "budget" | "abandoned"): void {
    const c = this.controllers.get(key);
    if (!c) return;
    this.reasons.set(key, reason);
    c.abort();
  }
  abortAll(reason: "timeout" | "budget" | "abandoned"): void {
    for (const key of [...this.controllers.keys()]) this.abort(key, reason);
  }
  reason(key: string): "timeout" | "budget" | "abandoned" | undefined {
    return this.reasons.get(key);
  }
  finish(key: string): void {
    this.controllers.delete(key);
    this.reasons.delete(key);
  }
  size(): number { return this.controllers.size; }
}

export interface WorkerDeps {
  store: Store;
  vault: VaultWriter;
  run: SpecialistRunFn;
  model?: string;
  log?: (l: string) => void;
  onEvent?: (e: AiosEvent) => void;
  resolvePack: (goal: GoalRow, spec: NodeSpec, attempt: number) => ResolvedPack | undefined;
  registry: AbortRegistry;
  nodeTimeoutMs: number;
}

export interface AttemptResult {
  claimed: boolean;
  outcome: AttemptOutcome | null;
  sessionLimit: boolean;
}

export async function runAttempt(
  goal: GoalRow, spec: NodeSpec, attempt: number, deps: WorkerDeps,
): Promise<AttemptResult> {
  const { store, vault } = deps;
  const regKey = deps.registry.key(goal.id, spec.key, attempt);
  const deadlineTs = Date.now() + (spec.kind === "run" ? 1 : 2) * deps.nodeTimeoutMs;
  const startedPayload: AttemptStartedPayload = {
    node: spec.key, attempt, agent: spec.agent, deadlineTs,
    idempotencyKey: `${goal.id}:${spec.key}:${attempt}`,
  };
  const claimed = appendEvents(store, goal.id,
    [{ type: "attempt.started", payload: startedPayload as unknown as Record<string, unknown> }],
    { claimLost: attemptClaimed(spec.key, attempt) });
  if (!claimed) return { claimed: false, outcome: null, sessionLimit: false };
  deps.onEvent?.({ type: "node.status", goalId: goal.id, nodeKey: spec.key, status: "running", agent: spec.agent });

  const controller = deps.registry.register(regKey);
  let costCents = 0;
  let turns = 0;

  const runAgent = async (role: string, brief: string) => {
    const context = `goal:${goal.slug}/${spec.key}`;
    deps.onEvent?.({ type: "agent.start", agent: role, context });
    try {
      const res = await deps.run(role, brief, {
        cwd: goal.project_dir ?? process.cwd(),
        model: deps.model,
        signal: controller.signal,
        pack: deps.resolvePack(goal, spec, attempt),
        mailCtx: {
          origin: { channel: goal.origin_channel, chatId: goal.origin_chat_id },
          goalDepth: goal.chain_depth, goalId: goal.id, nodeKey: spec.key,
        },
      });
      if (isSessionLimitOutput(res.text)) {
        deps.onEvent?.({ type: "agent.end", agent: role, context, ok: false });
        throw new SessionLimitError("Agent hit session limit — re-run after quota resets");
      }
      deps.onEvent?.({ type: "agent.end", agent: role, context, ok: true, costUsd: res.costUsd, turns: res.numTurns });
      costCents += Math.round((res.costUsd ?? 0) * 100);
      turns += res.numTurns ?? 0;
      return res;
    } catch (err) {
      if (!(err instanceof SessionLimitError)) {
        deps.onEvent?.({ type: "agent.end", agent: role, context, ok: false });
      }
      throw err;
    }
  };

  const save = (file: string, content: string, role: string): void => {
    vault.writeGoalArtifact(goal.goal_dir!, file, content, { goal: goal.id, node: spec.key, role });
  };
  const recordRound = (payload: RoundRecordedPayload): void => {
    appendEvents(store, goal.id, [{ type: "round.recorded", payload: payload as unknown as Record<string, unknown> }]);
  };
  const finish = (outcome: AttemptOutcome, error?: string, final?: { artifactRef: string; roundsUsed: number }): void => {
    const events: EventInput[] = [{
      type: "attempt.finished",
      payload: { node: spec.key, attempt, outcome, costCents, turns, ...(error ? { error } : {}) },
    }];
    if (final) {
      // A node parked via ask_mail is already done — never re-complete it.
      const st = reduce(readJournal(store, goal.id)).nodes.get(spec.key);
      if (st?.status !== "done") {
        events.push({ type: "node.completed", payload: { node: spec.key, artifactRef: final.artifactRef, roundsUsed: final.roundsUsed } });
      }
    }
    appendEvents(store, goal.id, events);
  };
  /** Fresh fold — resume data (rounds, feedback, last artifact) survives crashes/retries. */
  const nodeState = () => reduce(readJournal(store, goal.id)).nodes.get(spec.key);

  try {
    const ctx = contextBlock(goal, ancestorArtifacts(store.listNodes(goal.id), spec.key), vault);
    switch (spec.kind) {
      case "run": {
        const brief = [spec.brief, ctx].filter(Boolean).join("\n\n");
        const res = await runAgent(spec.agent, brief);
        const file = `${spec.key}.md`;
        save(file, res.text, spec.agent);
        finish("ok", undefined, { artifactRef: file, roundsUsed: 0 });
        break;
      }
      case "loop": {
        const st = nodeState();
        let feedback = st?.lastFeedback ?? "";
        let lastOutput = st?.lastArtifactRef ? (vault.readGoalArtifact(goal.goal_dir!, st.lastArtifactRef) ?? "") : "";
        let approved = st?.lastVerdict?.verdict === "approve";
        let round = st?.currentRound ?? 0;
        while (!approved && round < spec.maxRounds) {
          round++;
          const producerBrief = [
            spec.brief, ctx,
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
          recordRound({ node: spec.key, attempt, round, role: "critic", verdict, feedback, artifactRef: `${spec.key}-v${round}.md` });
          if (verdict?.verdict === "approve") approved = true;
        }
        const note = approved ? "" : `\n\n> [!warning] Loop cap reached (${spec.maxRounds} rounds) without approval — proceeding with last version.\n`;
        const file = `${spec.key}.md`;
        save(file, lastOutput + note, spec.agent);
        finish("ok", undefined, { artifactRef: file, roundsUsed: round });
        break;
      }
      case "verify": {
        const st = nodeState();
        let report: TestReport | undefined = st?.lastReport ?? undefined;
        let round = st?.runnerRounds ?? 0;
        let fixedThrough = st?.fixerRounds ?? 0;
        while (round < spec.maxRounds && (round === 0 || (report && !report.passed))) {
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
        const summary = report
          ? `**Passed:** ${report.passed}\n\n${report.summary}${report.failures.length ? `\n\nFailures:\n${report.failures.map((f) => `- ${f}`).join("\n")}` : ""}`
          : "No structured test report produced.";
        const file = `${spec.key}.md`;
        save(file, summary, spec.agent);
        finish("ok", undefined, { artifactRef: file, roundsUsed: round });
        if (report && !report.passed) {
          deps.log?.(`node ${spec.key}: verification still failing after ${spec.maxRounds} rounds`);
        }
        break;
      }
    }
    return { claimed: true, outcome: "ok", sessionLimit: false };
  } catch (err) {
    if (err instanceof SessionLimitError) {
      finish("error", err.message);
      return { claimed: true, outcome: "error", sessionLimit: true };
    }
    const abortReason = deps.registry.reason(regKey);
    const outcome: AttemptOutcome =
      abortReason === "timeout" ? "timeout" : abortReason ? "aborted" : "error";
    finish(outcome, (err as Error).message);
    return { claimed: true, outcome, sessionLimit: false };
  } finally {
    deps.registry.finish(regKey);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workers.test.ts`
Expected: PASS (12 tests). The verify-loop control flow is the subtle part — the test's `roles` sequences are the contract; fix the loop, not the tests.

- [ ] **Step 5: Typecheck + full suite, then commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: green (old goals.ts untouched; its `SessionLimitError` etc. still exist separately until cutover).

```bash
git add src/engine/workers.ts test/workers.test.ts
git commit -m "feat(engine): journaled attempt runner — claims, per-round events, resume, abort registry"
```

---

### Task 6: Action Gate idempotency

**Files:**
- Modify: `src/store/db.ts` (actions column + index + lookup; `ActionRow` optional field)
- Modify: `src/kernel/gate.ts` (`propose` dedupe)
- Modify: `src/packs/server.ts` + `src/packs/resolve.ts` (thread `idempotencyKey` into pack proposals)
- Test: `test/gate-idempotency.test.ts` (create)

**Interfaces:**
- Consumes: `ActionGate.propose(input, origin)` (gate.ts:34), `proposeThroughCeiling` (packs/server.ts:31), `buildPackServer` deps (packs/server.ts:17-27).
- Produces:
  - db.ts: `actions.idempotency_key` nullable column + unique index (SQLite unique indexes treat NULLs as distinct — no partial index needed); `actionByIdempotencyKey(key: string): ActionRow | undefined`; `ActionRow` gains `idempotency_key?: string | null`.
  - gate.ts: `ActionInput` gains `idempotencyKey?: string`; `propose` returns the EXISTING row when the key already landed (no re-execution).
  - packs: `PackServerDeps` gains `idempotencyKey?: string`; `resolveDeptFor` (the maker in `src/packs/resolve.ts`) gains a trailing optional `idempotencyKey?: string` parameter passed through to `buildPackServer`. Task 7's engine passes `goalId:node:attempt`.

NOTE for implementer: check where `ActionInput` is declared (gate.ts or `src/kernel/executors.ts`) and the exact `resolveDeptFor`/`makeResolveDeptFor` signatures in `src/packs/resolve.ts` before editing — adapt mechanically, the contract above is what's fixed.

- [ ] **Step 1: Write the failing test**

Copy the gate harness shape from `test/gate.test.ts` (stub registry/policy/bus — reuse its builders verbatim), then:

```ts
// test/gate-idempotency.test.ts
import { describe, it, expect } from "vitest";
// … same harness imports/builders as test/gate.test.ts …

describe("gate idempotency", () => {
  it("same idempotencyKey → second propose returns the first row, executor runs once", async () => {
    let executions = 0;
    // register a trusted/autonomous executor type "note.add" whose execute() bumps `executions`
    const { gate, store } = harness(/* per test/gate.test.ts */);
    const a = await gate.propose({ type: "note.add", payload: { text: "x" }, preview: "p", idempotencyKey: "g1:task:1" }, { channel: "t", chatId: "1" });
    const b = await gate.propose({ type: "note.add", payload: { text: "x" }, preview: "p", idempotencyKey: "g1:task:1" }, { channel: "t", chatId: "1" });
    expect(b.id).toBe(a.id);
    expect(executions).toBe(1);
    expect(store.actionByIdempotencyKey("g1:task:1")!.id).toBe(a.id);
  });

  it("different keys and keyless proposals are independent", async () => {
    const { gate } = harness();
    const a = await gate.propose({ type: "note.add", payload: { text: "x" }, preview: "p", idempotencyKey: "g1:task:1" }, { channel: "t", chatId: "1" });
    const b = await gate.propose({ type: "note.add", payload: { text: "x" }, preview: "p", idempotencyKey: "g1:task:2" }, { channel: "t", chatId: "1" });
    const c = await gate.propose({ type: "note.add", payload: { text: "x" }, preview: "p" }, { channel: "t", chatId: "1" });
    const d = await gate.propose({ type: "note.add", payload: { text: "x" }, preview: "p" }, { channel: "t", chatId: "1" });
    expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(4); // NULL keys never collide
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/gate-idempotency.test.ts`
Expected: FAIL — `idempotencyKey` unknown / `actionByIdempotencyKey` missing.

- [ ] **Step 3: Implement**

db.ts constructor (next to the actions DDL):

```ts
    // Migration (journaled engine): idempotent gate proposals. A retried goal attempt
    // carries idempotencyKey = goalId:node:attempt# — the unique index makes a duplicate
    // proposal return the original row instead of double-executing an effect.
    try { this.db.exec("ALTER TABLE actions ADD COLUMN idempotency_key TEXT"); } catch { /* exists */ }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_idem ON actions(idempotency_key)");
```

db.ts methods (next to `getAction`):

```ts
  actionByIdempotencyKey(key: string): ActionRow | undefined {
    return this.db.prepare("SELECT * FROM actions WHERE idempotency_key = ?").get(key) as ActionRow | undefined;
  }
```

`ActionRow` gains `idempotency_key?: string | null;`. Extend `insertAction`'s column list + values with `idempotency_key` (`a.idempotency_key ?? null`).

gate.ts — `ActionInput` gains `idempotencyKey?: string`. At the top of `propose` (before schema parse side effects matter, right after the executor lookup):

```ts
    if (input.idempotencyKey) {
      const dup = store.actionByIdempotencyKey(input.idempotencyKey);
      if (dup) return dup; // retried attempt re-proposing the same effect — dedupe (spec §7)
    }
```

…and include `idempotency_key: input.idempotencyKey ?? null` in the `row` literal.

packs/server.ts — `PackServerDeps` gains `idempotencyKey?: string`; `proposeThroughCeiling` passes it:

```ts
    const row = await deps.gate.propose(
      { type: a.type, payload: a.payload, preview: a.preview, idempotencyKey: deps.idempotencyKey },
      deps.origin,
    );
```

(also update `proposeThroughCeiling`'s `Pick<...>` to include `"idempotencyKey"`.)

packs/resolve.ts — thread a trailing optional `idempotencyKey?: string` through `makeResolveDeptFor`'s returned function into the `buildPackServer({ ..., idempotencyKey })` call (both call sites at resolve.ts:58 and the tool-server builder path if it constructs pack servers — only the `buildPackServer` call needs it).

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/gate-idempotency.test.ts test/gate.test.ts test/actions.test.ts test/code-pack-resolve.test.ts`
Expected: PASS — the new param is optional everywhere; existing behavior unchanged without a key.

- [ ] **Step 5: Typecheck + full suite, then commit**

Run: `npx tsc --noEmit && npx vitest run`

```bash
git add src/store/db.ts src/kernel/gate.ts src/packs/server.ts src/packs/resolve.ts test/gate-idempotency.test.ts
git commit -m "feat(gate): idempotency_key dedupe — retried attempts cannot double-propose effects"
```

---

### Task 7: The engine — `src/engine/engine.ts` (full GoalEngine on journal internals)

Built ALONGSIDE the old goals.ts (which stays untouched and green). Tests import from `./engine.js` directly; Task 8 cuts over.

**Files:**
- Create: `src/engine/engine.ts`
- Test: `test/engine-core.test.ts`, `test/engine-mail.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 1-6 (journal/reduce/decide/project/workers/gate-threading); `compilePlaybook`/`toNewTaskNodes` (compile.ts); `isPrivateOrigin`, `slugify`, `assertInplaceTarget`/`resolveReal`, `indexMailThread`, `SpendGuard` — same imports the old goals.ts uses.
- Produces (public surface — identical signatures to old GoalEngine, plus noted additions):
  - `class GoalEngine`: `listPlaybooks()`, `createFromPlaybook(params)`, `startPlannedGoal(p)`, `planGoal(params)`, `pauseGoal/resumeGoal/abandonGoal(idOrSlug)`, `answerUserMail(mailId, text)`, `answerFromChat(text)`, `resumeUnfinished()`, `resumeBudgetPaused()`, `pump()` (alias of `tick()`), `tick()`, **new** `parkFromAsk(goalId, nodeKey | null, mailId)` (mailbox hook).
  - `interface Planner` — `plan`/`planFromMail` unchanged; **`replan(goal, failed, error): Promise<ReplanPatch>`** where `interface ReplanPatch { replaced: GraphNodeSpec[]; added: GraphNodeSpec[] }` (CONTRACT CHANGE: the planner validates and RETURNS the patch; the engine records it — journal is the truth).
  - `interface GoalOutcome`, `interface GoalEngineDeps` — same shape as goals.ts:227-251 plus `nodeTimeoutMs?: number; maxAttempts?: number;` and `resolveDeptFor` gains the trailing `idempotencyKey?: string` param (Task 6).
  - `const MAIL_PREFIX = "mail:"`, plus `stageRoles`/`isUnsandboxedWrite` MOVED to `src/engine/compile.ts` (engine imports them from there; old goals.ts keeps its own copies until cutover — duplication for one task is fine).

- [ ] **Step 1: Move `stageRoles` + `isUnsandboxedWrite` into compile.ts**

Copy both functions verbatim from goals.ts:19-36 into `src/engine/compile.ts` (add `import type { LoadedRegistry } from "../agents/registry/loader.js";` and extend the playbook import with `Stage`). Leave goals.ts untouched. Run `npx vitest run test/compile.test.ts` — green.

- [ ] **Step 2: Create `src/engine/engine.ts`**

```ts
// src/engine/engine.ts — the journaled GoalEngine. Public API preserved; internals are
// fold(journal) → decide() → dispatch commands → append events → re-fold. No in-memory
// scheduler state survives a crash because none is load-bearing: "running" is derived
// from dangling attempt.started events, and recovery (resumeUnfinished) is the same
// fold+decide path as normal operation.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Store, GoalRow, MailRow, NewTaskNode } from "../store/db.js";
import { isPrivateOrigin } from "../agents/direct.js";
import { slugify, type VaultWriter } from "../vault/writer.js";
import type { SpecialistRunFn } from "../agents/runner.js";
import type { ResolvedPack } from "../packs/resolve.js";
import type { AiosEvent } from "../events.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { Playbook } from "./playbook.js";
import { compilePlaybook, toNewTaskNodes, isUnsandboxedWrite, type GraphNodeSpec } from "./compile.js";
import { assertInplaceTarget, resolveReal } from "../code/paths.js";
import { indexMailThread } from "../memory/indexer.js";
import type { SpendGuard } from "./budget.js";
import {
  appendEvents, readJournal,
  type EventInput, type NodeSpec, type GoalCreatedPayload, type ReplanRecordedPayload,
} from "./journal.js";
import { reduce, type GoalState } from "./reduce.js";
import { decide, type Caps, type Command } from "./decide.js";
import { AbortRegistry, runAttempt } from "./workers.js";

const FACADE_PREFIX = "playbook:";
/** plan_summary marker for mail-spawned goals (single node, never re-planned). */
export const MAIL_PREFIX = "mail:";

export interface ReplanPatch { replaced: GraphNodeSpec[]; added: GraphNodeSpec[] }

export interface Planner {
  plan(engine: GoalEngine, params: { department: string; title: string; request: string; channel: string; chatId: string }): Promise<GoalRow>;
  planFromMail(engine: GoalEngine, params: { department: string; title: string; request: string; channel: string; chatId: string }, mail: MailRow): Promise<GoalRow>;
  /** Validate and RETURN the patch; the engine records it as replan.recorded. */
  replan(goal: GoalRow, failed: import("../store/db.js").TaskNodeRow, error: string): Promise<ReplanPatch>;
}

export interface GoalOutcome {
  goal: GoalRow; ok: boolean; error?: string; goalDirName: string; artifactFiles: string[];
}

export interface GoalEngineDeps {
  store: Store;
  vault: VaultWriter;
  run: SpecialistRunFn;
  model?: string;
  log?: (l: string) => void;
  onEvent?: (e: AiosEvent) => void;
  registry: LoadedRegistry;
  playbooks: Map<string, Playbook>;
  wallTimeMs: number;
  maxConcurrentNodes: number;
  spendGuard: SpendGuard;
  onComplete: (o: GoalOutcome) => Promise<void>;
  resolveDeptFor: (key: string, origin: { channel: string; chatId: string }, byAgent?: boolean,
                   sandbox?: { taskDir: string; mode: "build" | "analyze" },
                   idempotencyKey?: string) => ResolvedPack | undefined;
  prepareSandbox?: (goal: GoalRow, opts: { playbook?: Playbook }) => Promise<{ taskDir: string; mode: "build" | "analyze" } | undefined>;
  planner?: Planner;
  replanCap?: number;
  mailMaxDepth: number;
  mailDisabled?: boolean;
  primaryChat?: { channel: string; chatId: string };
  projectsRoot?: string;
  workspaceRoot?: string;
  pingBudgetPaused?: (text: string) => void;
  /** Per-attempt deadline base (run nodes; loop/verify get 2x). Default 15 min. */
  nodeTimeoutMs?: number;
  /** Visible-retry cap per node (spec §7). Default 2. */
  maxAttempts?: number;
}

const toSpec = (n: NewTaskNode): NodeSpec => ({
  key: n.node_key, kind: n.type, agent: n.agent, critic: n.critic,
  brief: n.brief, dependsOn: n.depends_on, maxRounds: n.max_rounds,
});
const graphToSpec = (g: GraphNodeSpec): NodeSpec => toSpec(toNewTaskNodes([g])[0]);

export class GoalEngine {
  private abortRegistry = new AbortRegistry();
  private inFlight = new Set<string>();
  private ticking = false;
  private tickAgain = false;

  constructor(private deps: GoalEngineDeps) {}

  // ---------- plumbing ----------

  private emit(e: AiosEvent): void { this.deps.onEvent?.(e); }

  /** Append + surface matching bus events (goal.status / node.status) for SSE/UI. */
  private journal(goalId: string, events: EventInput[], also?: () => void): boolean {
    const appended = appendEvents(this.deps.store, goalId, events, { also });
    if (!appended) return false;
    const agentOf = (node: string) =>
      this.deps.store.listNodes(goalId).find((n) => n.node_key === node)?.agent ?? "";
    for (const ev of appended) {
      const p = ev.payload as Record<string, unknown>;
      switch (ev.type) {
        case "goal.paused":
          this.emit({ type: "goal.status", goalId, status: p.reason === "budget" ? "paused-budget" : "paused-user", error: p.error as string | undefined });
          break;
        case "goal.resumed": case "ask.resumed":
          this.emit({ type: "goal.status", goalId, status: "running" }); break;
        case "ask.parked":
          this.emit({ type: "goal.status", goalId, status: "awaiting-mail" }); break;
        case "goal.completed":
          this.emit({ type: "goal.status", goalId, status: "done" }); break;
        case "goal.failed":
          this.emit({ type: "goal.status", goalId, status: "failed", error: String(p.error ?? "") }); break;
        case "goal.abandoned":
          this.emit({ type: "goal.status", goalId, status: "abandoned" }); break;
        case "node.completed":
          this.emit({ type: "node.status", goalId, nodeKey: String(p.node), status: "done", agent: agentOf(String(p.node)) }); break;
        case "node.failed":
          this.emit({ type: "node.status", goalId, nodeKey: String(p.node), status: "failed", agent: agentOf(String(p.node)), error: String(p.error ?? "") }); break;
        case "node.skipped":
          this.emit({ type: "node.status", goalId, nodeKey: String(p.node), status: "skipped", agent: agentOf(String(p.node)) }); break;
        default: break; // attempt.started emits node.status from the worker; the rest are internal
      }
    }
    return true;
  }

  private fold(goalId: string): GoalState {
    return reduce(readJournal(this.deps.store, goalId));
  }

  private caps(): Caps {
    return {
      maxConcurrent: this.deps.maxConcurrentNodes,
      budgetAllowed: this.deps.spendGuard.allow(),
      wallTimeMs: this.deps.wallTimeMs,
      replanCap: this.deps.replanCap ?? 2,
      plannerAvailable: !!this.deps.planner,
      maxAttempts: this.deps.maxAttempts ?? 2,
    };
  }

  // ---------- the loop ----------

  /** Legacy name kept — external callers (mailbox onQueued, moderator, tests) pump. */
  pump(): void { this.tick(); }

  tick(): void {
    if (this.ticking) { this.tickAgain = true; return; }
    this.ticking = true;
    try {
      let rounds = 0;
      do {
        this.tickAgain = false;
        this.sweepMail();
        this.enforceBudgetAbort();
        this.dispatch(decide(this.states(), this.caps(), Date.now()));
      } while (this.tickAgain && ++rounds < 10);
    } finally {
      this.ticking = false;
    }
  }

  private states(): GoalState[] {
    const rows = [...this.deps.store.unfinishedGoals(), ...this.deps.store.awaitingMailGoals()];
    return rows.map((g) => this.fold(g.id)).filter((s) => s.created !== null);
  }

  /** Spec §8: crossing the daily cap aborts everything in flight — attempts land as
   *  aborted, then decide() parks the goals. Never blows through the cap mid-node. */
  private enforceBudgetAbort(): void {
    if (this.abortRegistry.size() === 0 || this.deps.spendGuard.allow()) return;
    this.abortRegistry.abortAll("budget");
  }

  private dispatch(commands: Command[]): void {
    for (const c of commands) {
      switch (c.cmd) {
        case "StartAttempt": {
          const key = `run:${c.goalId}:${c.node}:${c.attempt}`;
          if (this.inFlight.has(key)) break;
          this.inFlight.add(key);
          void this.worker(c.goalId, c.node, c.attempt)
            .finally(() => { this.inFlight.delete(key); this.tick(); });
          break;
        }
        case "AbortAttempt":
          this.abortRegistry.abort(this.abortRegistry.key(c.goalId, c.node, c.attempt), "timeout");
          break;
        case "FailNode":
          this.journal(c.goalId, [{ type: "node.failed", payload: { node: c.node, error: c.error } }]);
          this.tickAgain = true;
          break;
        case "RequestReplan": {
          const key = `replan:${c.goalId}`;
          if (this.inFlight.has(key)) break;
          this.inFlight.add(key);
          void this.replan(c.goalId, c.node, c.error)
            .finally(() => { this.inFlight.delete(key); this.tick(); });
          break;
        }
        case "PrepareWorkspace": {
          const key = `ws:${c.goalId}`;
          if (this.inFlight.has(key)) break;
          this.inFlight.add(key);
          void this.prepareWorkspace(c.goalId)
            .finally(() => { this.inFlight.delete(key); this.tick(); });
          break;
        }
        case "ParkForBudget": {
          this.journal(c.goalId, [{ type: "goal.paused", payload: { reason: "budget" } }]);
          const date = new Date().toISOString().slice(0, 10);
          const kv = `budget:pinged:${date}`;
          if (!this.deps.store.kvGet(kv)) {
            this.deps.store.kvSet(kv, "1");
            this.deps.pingBudgetPaused?.("Daily budget reached — paused background goals; they resume tomorrow.");
          }
          break;
        }
        case "CompleteGoal":
          if (this.journal(c.goalId, [{ type: "goal.completed", payload: {} }])) {
            void this.complete(this.deps.store.getGoal(c.goalId)!, true);
          }
          break;
        case "FailGoal":
          this.failGoal(c.goalId, c.error);
          break;
      }
    }
  }

  private failGoal(goalId: string, error: string): void {
    const state = this.fold(goalId);
    if (state.phase !== "running" && state.phase !== "awaiting-mail") return; // already terminal
    for (const n of state.nodes.values()) {
      if (n.runningAttempt) {
        this.abortRegistry.abort(this.abortRegistry.key(goalId, n.spec.key, n.runningAttempt.attempt), "abandoned");
      }
    }
    const skips: EventInput[] = [...state.nodes.values()]
      .filter((n) => n.status === "pending" && !n.runningAttempt)
      .map((n) => ({ type: "node.skipped" as const, payload: { node: n.spec.key } }));
    this.journal(goalId, [...skips, { type: "goal.failed", payload: { error } }]);
    void this.complete(this.deps.store.getGoal(goalId)!, false, error);
  }

  private async worker(goalId: string, nodeKey: string, attempt: number): Promise<void> {
    const goal = this.deps.store.getGoal(goalId);
    if (!goal) return;
    const state = this.fold(goalId);
    const spec = state.nodes.get(nodeKey)?.spec;
    if (!spec || !state.created) return;
    const facade = state.created.planSummary.startsWith(FACADE_PREFIX);
    const origin = { channel: goal.origin_channel, chatId: goal.origin_chat_id };
    const sandbox = state.workspace?.taskDir && state.workspace.mode
      ? { taskDir: state.workspace.taskDir, mode: state.workspace.mode } : undefined;
    const idem = `${goalId}:${nodeKey}:${attempt}`;
    try {
      const res = await runAttempt(goal, spec, attempt, {
        store: this.deps.store, vault: this.deps.vault, run: this.deps.run,
        model: this.deps.model, log: this.deps.log, onEvent: this.deps.onEvent,
        resolvePack: () => facade
          ? this.deps.resolveDeptFor(state.created!.planSummary.slice(FACADE_PREFIX.length), origin, false, sandbox, idem)
          : this.deps.resolveDeptFor(spec.agent, origin, true, sandbox, idem),
        registry: this.abortRegistry,
        nodeTimeoutMs: this.deps.nodeTimeoutMs ?? 900_000,
      });
      if (res.sessionLimit && this.fold(goalId).phase === "running") {
        this.journal(goalId, [{ type: "goal.paused", payload: { reason: "user", error: "Agent hit session limit — re-run after quota resets" } }]);
      }
    } catch (err) {
      this.deps.log?.(`worker ${goalId}/${nodeKey}#${attempt}: ${(err as Error).message}`);
    }
  }

  private async replan(goalId: string, nodeKey: string, error: string): Promise<void> {
    const goal = this.deps.store.getGoal(goalId);
    const failedRow = this.deps.store.listNodes(goalId).find((n) => n.node_key === nodeKey);
    if (!goal || !failedRow) return;
    // Cosmetic projection touch only — the journal never records "replanning"; a crash
    // here re-decides and retries the replan (uncounted — accepted delta #1).
    this.deps.store.updateGoalStatus(goalId, "replanning");
    this.emit({ type: "goal.status", goalId, status: "replanning" });
    try {
      const patch = await this.deps.planner!.replan(goal, failedRow, error);
      const payload: ReplanRecordedPayload = {
        kind: "replan", forNode: nodeKey,
        replaced: patch.replaced.map(graphToSpec), added: patch.added.map(graphToSpec),
        retargets: [], reason: error,
      };
      this.journal(goalId, [{ type: "replan.recorded", payload: payload as unknown as Record<string, unknown> }]);
      this.deps.store.updateGoalStatus(goalId, "running");
      this.emit({ type: "goal.status", goalId, status: "running" });
    } catch (planErr) {
      this.deps.store.updateGoalStatus(goalId, "running"); // undo cosmetic before terminal event
      this.failGoal(goalId, `re-planning failed: ${(planErr as Error).message}`);
    }
  }

  /** Workspace eligibility (spec 2026-07-07-workspace-mail-goals) — port of the old
   *  mailWorkspaceEligible; fail-closed when the source mail row is missing. */
  private mailWorkspaceEligible(state: GoalState): boolean {
    const c = state.created!;
    if (!c.spawnedByMail) return true;
    if (c.planSummary.startsWith(MAIL_PREFIX)) return false;
    if (c.department !== "engineering") return false;
    return this.deps.store.getMail(c.spawnedByMail)?.from_agent === "user";
  }

  private async prepareWorkspace(goalId: string): Promise<void> {
    const state = this.fold(goalId);
    if (!state.created || !state.workspacePending) return;
    const goal = this.deps.store.getGoal(goalId)!;
    const eligible = this.mailWorkspaceEligible(state);
    try {
      if (!eligible) {
        // Hard-strip any planner-passed dir on ineligible mail-goals — the wall holds
        // regardless of planner behavior (spec 2026-07-07).
        this.journal(goalId, [{ type: "workspace.prepared", payload: { taskDir: null, mode: null, stripped: Boolean(goal.project_dir) } }]);
        return;
      }
      const pb = state.created.planSummary.startsWith(FACADE_PREFIX)
        ? this.deps.playbooks.get(state.created.planSummary.slice(FACADE_PREFIX.length))
        : undefined;
      const sandbox = await this.deps.prepareSandbox?.(goal, { playbook: pb });
      const effectiveDir = sandbox?.taskDir ?? goal.project_dir;
      if (effectiveDir) mkdirSync(effectiveDir, { recursive: true });
      this.journal(goalId, [{ type: "workspace.prepared", payload: { taskDir: sandbox?.taskDir ?? null, mode: sandbox?.mode ?? null } }]);
    } catch (err) {
      // A mail-goal whose sandbox setup failed must not advertise a workspace that never
      // existed (port of the old strip-on-failure).
      if (goal.spawned_by_mail && goal.project_dir) this.deps.store.setGoalProjectDir(goalId, null);
      this.journal(goalId, [{ type: "workspace.failed", payload: { error: (err as Error).message } }]);
      this.tickAgain = true; // decide() converts workspaceError into FailGoal
    }
  }

  // ---------- creation (public API preserved) ----------

  listPlaybooks(): Array<{ name: string; description: string; pillar?: string }> {
    return [...this.deps.playbooks.values()].map((p) => ({
      name: p.name, description: p.description, pillar: this.deps.registry.ownerOfPlaybook.get(p.name),
    }));
  }

  createFromPlaybook(params: {
    playbook: string; title: string; request: string; projectDir?: string;
    channel: string; chatId: string; inplace?: boolean;
  }): GoalRow {
    const pb = this.deps.playbooks.get(params.playbook);
    if (!pb) throw new Error(`Unknown playbook: ${params.playbook}. Available: ${[...this.deps.playbooks.keys()].join(", ")}`);
    if (pb.needsProjectDir && !params.projectDir) throw new Error(`Playbook ${pb.name} needs a project directory (project_dir).`);
    if (isUnsandboxedWrite(pb, this.deps.registry.ownerOfPlaybook, this.deps.registry)) {
      if (!params.inplace) throw new Error(`Refused: "${pb.name}" is an unsandboxed in-place coding path; run it via the code_task tool (mode:inplace).`);
      if (!params.projectDir) throw new Error("Refused: inplace requires a project_dir.");
      if (!this.deps.projectsRoot || !this.deps.workspaceRoot) throw new Error("Refused: inplace is not configured (no projectsRoot/workspaceRoot).");
      assertInplaceTarget(params.projectDir, {
        selfRoot: resolveReal(process.cwd()),
        workspaceRoot: this.deps.workspaceRoot,
        projectsRoot: this.deps.projectsRoot,
      });
    }
    const dept = this.deps.registry.ownerOfPlaybook.get(params.playbook) ?? "operations";
    const lead = this.deps.registry.departments.get(dept)?.lead ?? "hermes";
    return this.createGoal({
      title: params.title, request: params.request, department: dept, lead,
      origin: { channel: params.channel, chatId: params.chatId },
      projectDir: params.projectDir ?? null, planSummary: `${FACADE_PREFIX}${params.playbook}`,
      chainDepth: 0, spawnedByMail: null,
      nodes: toNewTaskNodes(compilePlaybook(pb)).map(toSpec),
    });
  }

  /** Used by the lead planner to persist a validated plan and start it. */
  startPlannedGoal(p: {
    title: string; request: string; department: string; lead: string;
    origin: { channel: string; chatId: string }; summary: string;
    nodes: NewTaskNode[]; projectDir?: string; needsWorkspace: string;
    spawnedByMail?: string; chainDepth?: number;
  }): GoalRow {
    return this.createGoal({
      title: p.title, request: p.request, department: p.department, lead: p.lead,
      origin: p.origin, projectDir: p.projectDir ?? null, planSummary: p.summary,
      chainDepth: p.chainDepth ?? 0, spawnedByMail: p.spawnedByMail ?? null,
      nodes: p.nodes.map(toSpec),
      also: p.spawnedByMail
        ? (goalId) => this.deps.store.markMailSpawned(p.spawnedByMail!, goalId)
        : undefined,
    });
  }

  /** Shared creation: goal.md, then goal.created + plan.recorded in ONE atomic append
   *  (with any mail-spawned flip inside the same transaction). */
  private createGoal(p: {
    title: string; request: string; department: string; lead: string;
    origin: { channel: string; chatId: string }; projectDir: string | null;
    planSummary: string; chainDepth: number; spawnedByMail: string | null;
    nodes: NodeSpec[]; also?: (goalId: string) => void;
  }): GoalRow {
    const id = randomUUID();
    const slug = slugify(p.title);
    const goalDir = this.deps.vault.goalDirName(slug);
    this.deps.vault.writeGoalArtifact(goalDir, "goal.md",
      `# ${p.title}\n\n- department: ${p.department}\n- lead: ${p.lead}\n- status: running\n\n## Request\n\n${p.request}\n\n## Plan\n\n${p.planSummary}`,
      { goal: id, department: p.department });
    const created: GoalCreatedPayload = {
      slug, title: p.title, request: p.request, department: p.department, lead: p.lead,
      origin: p.origin, chainDepth: p.chainDepth, spawnedByMail: p.spawnedByMail,
      planSummary: p.planSummary, goalDir, projectDir: p.projectDir,
    };
    this.journal(id, [
      { type: "goal.created", payload: created as unknown as Record<string, unknown> },
      { type: "plan.recorded", payload: { summary: p.planSummary, needsWorkspace: "auto", nodes: p.nodes } },
    ], p.also ? () => p.also!(id) : undefined);
    this.emit({ type: "goal.created", goalId: id, title: p.title, department: p.department });
    this.tick();
    return this.deps.store.getGoal(id)!;
  }

  async planGoal(params: { department: string; title: string; request: string; channel: string; chatId: string }): Promise<GoalRow> {
    if (!this.deps.planner) throw new Error("planner not configured");
    return this.deps.planner.plan(this, params);
  }
```

(continued in Step 3 — same file)

- [ ] **Step 3: engine.ts — lifecycle, mail integration, recovery (rest of the same file)**

```ts
  // ---------- pause / resume / abandon ----------

  private findGoal(idOrSlug: string): GoalRow | undefined {
    return this.deps.store.getGoal(idOrSlug) ?? this.deps.store.getGoalBySlug(idOrSlug);
  }

  pauseGoal(idOrSlug: string): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (g.legacy) return `Goal ${g.slug} is a frozen legacy goal — read-only.`;
    if (g.status !== "running" && g.status !== "replanning") return `Goal ${g.slug} is ${g.status} — nothing to pause.`;
    this.journal(g.id, [{ type: "goal.paused", payload: { reason: "user" } }]);
    return `Goal ${g.slug} paused (running nodes finish; nothing new starts). /resume ${g.slug} to continue.`;
  }

  resumeGoal(idOrSlug: string): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (g.legacy) return `Goal ${g.slug} is a frozen legacy goal — read-only.`;
    if (g.status !== "paused-user" && g.status !== "paused-budget") return `Goal ${g.slug} is ${g.status} — nothing to resume.`;
    this.journal(g.id, [{ type: "goal.resumed", payload: { by: "user" } }]);
    this.tick();
    return `Goal ${g.slug} resumed.`;
  }

  abandonGoal(idOrSlug: string): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (g.legacy) return `Goal ${g.slug} is a frozen legacy goal — mark it done by hand if it lingers.`;
    if (["done", "failed", "abandoned"].includes(g.status)) return `Goal ${g.slug} is already ${g.status}.`;
    const state = this.fold(g.id);
    for (const n of state.nodes.values()) {
      if (n.runningAttempt) this.abortRegistry.abort(this.abortRegistry.key(g.id, n.spec.key, n.runningAttempt.attempt), "abandoned");
    }
    const skips: EventInput[] = [...state.nodes.values()]
      .filter((n) => n.status === "pending" && !n.runningAttempt)
      .map((n) => ({ type: "node.skipped" as const, payload: { node: n.spec.key } }));
    this.journal(g.id, [...skips, { type: "goal.abandoned", payload: { by: "user" } }]);
    // A mail-spawned goal must still answer its request — otherwise the request stays
    // 'spawned' forever and a parked asker never resumes.
    if (g.spawned_by_mail) {
      const files = this.deps.store.listNodes(g.id).filter((n) => n.artifact).map((n) => n.artifact!);
      this.mailReport(this.deps.store.getGoal(g.id)!, false, "abandoned by user", files);
    }
    return `Goal ${g.slug} abandoned; unfinished nodes skipped.`;
  }

  resumeBudgetPaused(): number {
    if (!this.deps.spendGuard.allow()) return 0;
    const paused = this.deps.store.pausedBudgetGoals();
    for (const g of paused) this.journal(g.id, [{ type: "goal.resumed", payload: { by: "budget-reset" } }]);
    if (paused.length) this.tick();
    return paused.length;
  }

  // ---------- completion ----------

  private async complete(goal: GoalRow, ok: boolean, error?: string): Promise<void> {
    const fresh = this.deps.store.getGoal(goal.id)!;
    const files = this.deps.store.listNodes(goal.id).filter((n) => n.artifact).map((n) => n.artifact!);
    if (fresh.spawned_by_mail) {
      this.mailReport(fresh, ok, error, files); // report REPLACES the origin-chat ping (spec §5)
      return;
    }
    try {
      await this.deps.onComplete({ goal: fresh, ok, error, goalDirName: fresh.goal_dir ?? "", artifactFiles: files });
    } catch (err) {
      this.deps.log?.(`[${goal.slug}] onComplete failed: ${(err as Error).message}`);
    }
  }

  // ---------- mail integration (ports of goals.ts:436-619, journal-backed) ----------

  /** Convert queued request mail into goals (spec §4). FIFO; fail-soft per item. */
  private sweepMail(): void {
    if (this.deps.mailDisabled) return; // kill-switch: queue drains on re-enable
    for (const m of this.deps.store.queuedRequests()) {
      if (this.deps.store.getMail(m.id)?.status !== "queued") continue; // stale snapshot re-check
      if (m.chain_depth > this.deps.mailMaxDepth) {
        const reason = `downgraded: chain too deep (cap ${this.deps.mailMaxDepth})`;
        this.deps.store.downgradeMailToNote(m.id, reason);
        this.resumeFromAnswer(m.id, `Declined: ${reason}`);
        continue;
      }
      if (!this.deps.spendGuard.allow()) continue; // stays queued; keep scanning for downgrades
      const canonical = this.deps.registry.agentOf.get(m.to_agent);
      const def = canonical ? this.deps.registry.agents.get(canonical) : undefined;
      if (!canonical || !def) {
        this.deps.store.refuseMail(m.id, `unknown recipient "${m.to_agent}"`);
        this.resumeFromAnswer(m.id, `Refused: unknown recipient "${m.to_agent}"`);
        this.reindexMailThread(m);
        continue;
      }
      if (def.manifest.visibility === "private" &&
          !isPrivateOrigin(this.deps.primaryChat, m.origin_channel, m.origin_chat_id)) {
        const reason = `${canonical} is private — origin not the private chat`;
        this.deps.store.refuseMail(m.id, reason);
        this.resumeFromAnswer(m.id, `Refused: ${reason}`);
        this.reindexMailThread(m);
        continue;
      }
      const dept = def.department;
      if (this.deps.planner && this.deps.registry.departments.get(dept)?.lead === canonical) {
        // Lead mail → planned graph (async). Claim first so a re-entrant tick can't
        // spawn a second goal for the same mail.
        if (this.deps.store.claimMailPlanning(m.id)) void this.spawnGraphFromMail(m, dept);
      } else {
        this.spawnFromMail(m, canonical, dept);
      }
    }
  }

  private async spawnGraphFromMail(m: MailRow, department: string): Promise<void> {
    const title = (m.body.split("\n")[0] ?? "").slice(0, 80) || `mail from ${m.from_agent}`;
    try {
      const goal = await this.deps.planner!.planFromMail(this, {
        department, title, request: m.body, channel: m.origin_channel, chatId: m.origin_chat_id,
      }, m);
      // markMailSpawned already happened atomically inside startPlannedGoal's append.
      this.emit({ type: "mail.spawned", mailId: m.id, goalId: goal.id });
    } catch (err) {
      const reason = `planning failed: ${(err as Error).message}`;
      this.deps.store.refuseMail(m.id, reason);
      this.resumeFromAnswer(m.id, `Refused: ${reason}`);
      this.reindexMailThread(m);
      this.tick();
    }
  }

  private spawnFromMail(m: MailRow, canonical: string, department: string): void {
    const lead = this.deps.registry.departments.get(department)?.lead ?? "hermes";
    const title = (m.body.split("\n")[0] ?? "").slice(0, 80) || `mail from ${m.from_agent}`;
    const goal = this.createGoal({
      title, request: m.body, department, lead,
      origin: { channel: m.origin_channel, chatId: m.origin_chat_id },
      projectDir: null, planSummary: `${MAIL_PREFIX}${m.id}`,
      chainDepth: m.chain_depth, spawnedByMail: m.id,
      nodes: [{
        key: "task", kind: "run", agent: canonical, critic: null,
        brief: `Requested by ${m.from_agent} via mail ${m.id}. Your result is automatically reported back to them.`,
        dependsOn: [], maxRounds: 1,
      }],
      also: (goalId) => this.deps.store.markMailSpawned(m.id, goalId),
    });
    this.emit({ type: "mail.spawned", mailId: m.id, goalId: goal.id });
  }

  /** Recall re-indexing after a sweep-time refusal — best-effort, never breaks the sweep. */
  private reindexMailThread(m: MailRow): void {
    try { indexMailThread(this.deps.store, this.deps.registry, m.thread_id ?? m.id); }
    catch { /* best-effort */ }
  }

  /** The report REPLACES the origin-chat ping for mail-spawned goals (spec §5). */
  private mailReport(goal: GoalRow, ok: boolean, error: string | undefined, files: string[]): void {
    const src = this.deps.store.getMail(goal.spawned_by_mail!);
    if (!src) return;
    const refs = files.map((f) => `goals/${goal.goal_dir}/${f}`).join(", ");
    const ws = goal.project_dir ? `\nWorkspace: ${goal.project_dir}` : "";
    const body = ok
      ? `Done: ${goal.title}\nArtifacts: ${refs || "(none)"}${ws}`
      : `Failed: ${goal.title}\n${error ?? "unknown error"}${ws}`;
    const id = randomUUID();
    this.deps.store.insertMail({
      id, from_agent: src.to_agent, to_agent: src.from_agent, kind: "report", body,
      goal_id: goal.id, origin_channel: goal.origin_channel, origin_chat_id: goal.origin_chat_id,
      chain_depth: goal.chain_depth, status: "unread", error: null,
      thread_id: src.thread_id ?? src.id, in_reply_to: src.id,
    });
    this.emit({ type: "mail.sent", id, from: src.to_agent, to: src.from_agent, kind: "report" });
    this.resumeFromAnswer(src.id, body);
  }

  /** Mailbox hook: journal an ask_mail park. Called INSIDE the mailbox's transaction —
   *  appendEvents joins it, so the mail row and the park are atomic (delta #5). */
  parkFromAsk(goalId: string, nodeKey: string | null, mailId: string): void {
    this.journal(goalId, [{ type: "ask.parked", payload: { node: nodeKey, mailId } }]);
  }

  /** Owner answers a pending user-ask. Double-submit safe — answered-ness derives from
   *  mailAnsweringRequest; the request's status never changes. */
  answerUserMail(mailId: string, text: string): { ok: true } | { ok: false; reason: string } {
    const m = this.deps.store.getMail(mailId);
    if (!m || m.kind !== "request" || m.to_agent !== "user" || m.status !== "awaiting-human")
      return { ok: false, reason: "not a pending question" };
    if (this.deps.store.mailAnsweringRequest(m.id)) return { ok: false, reason: "already answered" };
    if (!text.trim()) return { ok: false, reason: "empty answer" };
    const id = randomUUID();
    this.deps.store.insertMail({
      id, from_agent: "user", to_agent: m.from_agent, kind: "report", body: text,
      goal_id: null, origin_channel: m.origin_channel, origin_chat_id: m.origin_chat_id,
      chain_depth: m.chain_depth, status: "unread", error: null,
      thread_id: m.thread_id ?? m.id, in_reply_to: m.id,
    });
    this.emit({ type: "mail.sent", id, from: "user", to: m.from_agent, kind: "report" });
    this.resumeFromAnswer(m.id, text);
    return { ok: true };
  }

  /** Primary-chat "@agent <answer>" intercept — fires ONLY on a pending user-ask. */
  answerFromChat(text: string): string | null {
    const m = /^@([\w-]+)\s+([\s\S]+)$/.exec(text.trim());
    if (!m) return null;
    const agent = this.deps.registry.agentOf.get(m[1].toLowerCase());
    if (!agent) return null;
    const pending = this.deps.store.pendingUserAsksFrom(agent);
    if (!pending.length) return null;
    const res = this.answerUserMail(pending[0].id, m[2]);
    return res.ok ? `Answer sent to ${agent} — resuming.` : null;
  }

  /** Un-park the goal waiting on `requestId`: ask.resumed + a continuation node via the
   *  replan.recorded mechanism (kind "resume" — never counts against the replan cap).
   *  The continuation depends on the asking node; dependents are repointed (M4 semantics). */
  private resumeFromAnswer(requestId: string, answerBody: string): void {
    const g = this.deps.store.goalAwaiting(requestId);
    if (!g) return;
    const req = this.deps.store.getMail(requestId);
    if (!req) return;
    const state = this.fold(g.id);
    if (!state.created) return; // legacy parked goal — frozen; deploy waits these out
    const n = [...state.nodes.keys()].filter((k) => k.startsWith("resume_")).length + 1;
    const key = `resume_${n}`;
    const asking = req.from_node ? state.nodes.get(req.from_node) : undefined;
    const brief = (asking ? `${asking.spec.brief}\n\n---\n\n` : "") +
      `Earlier you asked ${req.to_agent}: "${req.body}"\n\nThey answered:\n${answerBody}\n\n` +
      `Continue and complete the task with this answer.`;
    const retargets: Array<{ node: string; dependsOn: string[] }> = [];
    if (asking) {
      for (const other of state.nodes.values()) {
        if (other.spec.dependsOn.includes(asking.spec.key) &&
            !["done", "failed", "skipped"].includes(other.status)) {
          retargets.push({
            node: other.spec.key,
            dependsOn: other.spec.dependsOn.map((k) => (k === asking.spec.key ? key : k)),
          });
        }
      }
    }
    const payload: ReplanRecordedPayload = {
      kind: "resume", forNode: asking?.spec.key ?? null,
      replaced: [],
      added: [{ key, kind: "run", agent: req.from_agent, critic: null, brief,
                dependsOn: asking ? [asking.spec.key] : [], maxRounds: 1 }],
      retargets, reason: "ask-resume",
    };
    this.journal(g.id, [
      { type: "ask.resumed", payload: { mailId: requestId, resumeNodeKey: key } },
      { type: "replan.recorded", payload: payload as unknown as Record<string, unknown> },
    ]);
    this.tick();
  }

  // ---------- boot recovery = replay (spec §9) ----------

  resumeUnfinished(): number {
    // Mail-side recovery stays — mail is not event-sourced (claimMailPlanning survives as-is).
    this.deps.store.reconcilePlanningMail();
    // Parked goals whose answer landed while we were down.
    for (const g of this.deps.store.awaitingMailGoals()) {
      if (!g.awaiting_mail) continue;
      const answer = this.deps.store.mailAnsweringRequest(g.awaiting_mail);
      if (answer) { this.resumeFromAnswer(g.awaiting_mail, answer.body); continue; }
      const req = this.deps.store.getMail(g.awaiting_mail);
      if (req?.status === "refused") this.resumeFromAnswer(g.awaiting_mail, `Refused: ${req.error ?? "unknown"}`);
      else if (req?.kind === "note") this.resumeFromAnswer(g.awaiting_mail, `Declined: ${req.error ?? "chain too deep"}`);
    }
    // Journal goals: dangling attempt.started → attempt.finished{orphaned}; then the
    // normal fold→decide path takes over. No bespoke reset functions.
    const goals = this.deps.store.unfinishedGoals();
    for (const g of [...goals, ...this.deps.store.awaitingMailGoals()]) {
      const state = this.fold(g.id);
      if (!state.created) continue;
      const orphans: EventInput[] = [];
      for (const n of state.nodes.values()) {
        if (n.runningAttempt) {
          orphans.push({ type: "attempt.finished", payload: {
            node: n.spec.key, attempt: n.runningAttempt.attempt, outcome: "orphaned",
            costCents: 0, turns: 0, error: "daemon restarted mid-attempt",
          } });
        }
      }
      if (orphans.length) this.journal(g.id, orphans);
      if (g.status === "replanning" || g.status === "planning") {
        this.deps.store.updateGoalStatus(g.id, "running"); // cosmetic reset; fold re-decides
      }
    }
    const legacyStuck = this.deps.store.listGoals(200)
      .filter((g) => g.legacy === 1 && ["planning", "running", "replanning", "awaiting-mail"].includes(g.status));
    if (legacyStuck.length) {
      this.deps.log?.(`frozen legacy goals still unfinished: ${legacyStuck.map((g) => g.slug).join(", ")} — /abandon was expected pre-deploy`);
    }
    this.tick();
    return goals.length;
  }
}
```

- [ ] **Step 4: Write the failing core tests**

`test/engine-core.test.ts` — port of `test/goal-scheduler.test.ts` intents onto the new engine. Reuse that file's `fixtureRegistry()` and `PB` verbatim (copy them); the harness builds the NEW engine:

```ts
// test/engine-core.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { GoalEngine, type Planner } from "../src/engine/engine.js";
import { readJournal, appendEvents } from "../src/engine/journal.js";
import { SpendGuard } from "../src/engine/budget.js";
import type { Playbook } from "../src/engine/playbook.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";

// fixtureRegistry() and PB: copy verbatim from test/goal-scheduler.test.ts:14-34

function harness(over: {
  run?: SpecialistRunFn; maxConcurrentNodes?: number; capUsd?: number;
  todayFn?: () => string; planner?: Planner; replanCap?: number;
  wallTimeMs?: number; nodeTimeoutMs?: number;
} = {}) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "en-vault-")), "AIOS");
  const registry = fixtureRegistry();
  const completions: Array<{ ok: boolean }> = [];
  const engine = new GoalEngine({
    store, vault, registry,
    run: over.run ?? (async () => ({ text: "out", costUsd: 0.01, numTurns: 1 })),
    playbooks: new Map([[PB.name, PB]]),
    wallTimeMs: over.wallTimeMs ?? 60_000,
    maxConcurrentNodes: over.maxConcurrentNodes ?? 2,
    mailMaxDepth: 2,
    spendGuard: new SpendGuard({ store, capUsd: over.capUsd, todayFn: over.todayFn }),
    onComplete: async (o) => { completions.push({ ok: o.ok }); },
    resolveDeptFor: () => undefined,
    planner: over.planner,
    replanCap: over.replanCap,
    nodeTimeoutMs: over.nodeTimeoutMs,
  });
  return { store, vault, engine, completions };
}

/** Seed a planned (non-facade) goal through the public API — raw insertGoal rows have
 *  no journal and the new engine (correctly) ignores them. */
function plannedGoal(engine: GoalEngine, nodes: Array<{ key: string; agent?: string; deps?: string[] }>) {
  return engine.startPlannedGoal({
    title: "P", request: "do it", department: "engineering", lead: "athena",
    origin: { channel: "t", chatId: "1" }, summary: "planned", needsWorkspace: "none",
    nodes: nodes.map((n) => ({
      node_key: n.key, type: "run" as const, agent: n.agent ?? "odin", critic: null,
      brief: "b", depends_on: n.deps ?? [], max_rounds: 1,
    })),
  });
}

describe("engine core (ports of goal-scheduler intents)", () => {
  it("facade goal runs compiled chain to done, notifies", async () => {
    const { engine, store, completions } = harness();
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r it", channel: "telegram", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(store.listNodes(g.id).map((n) => n.status)).toEqual(["done", "done"]);
    expect(completions).toEqual([{ ok: true }]);
    // the journal is the truth: full lifecycle recorded
    const types = readJournal(store, g.id).map((e) => e.type);
    for (const t of ["goal.created", "plan.recorded", "workspace.prepared", "attempt.started", "attempt.finished", "node.completed", "goal.completed"]) {
      expect(types).toContain(t);
    }
  });

  it("independent nodes run in parallel up to maxConcurrentNodes (diamond)", async () => {
    let inFlight = 0, peak = 0;
    const run: SpecialistRunFn = async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { text: "out", costUsd: 0, numTurns: 1 };
    };
    const { engine, store } = harness({ run, maxConcurrentNodes: 2 });
    const g = plannedGoal(engine, [
      { key: "p1" }, { key: "p2", agent: "vulcan" }, { key: "join", agent: "athena", deps: ["p1", "p2"] },
    ]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(peak).toBe(2);
  });

  it("budget cap parks scheduling; resumeBudgetPaused resumes next day", async () => {
    let day = "2026-07-02";
    const { engine, store } = harness({ capUsd: 0.01, todayFn: () => day });
    store.budgetAdd("2026-07-02", 1);
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("paused-budget"));
    day = "2026-07-03";
    expect(engine.resumeBudgetPaused()).toBe(1);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
  });

  it("hard node failure: visible retry (attempt 2), then goal failed + rest skipped", async () => {
    let calls = 0;
    const run: SpecialistRunFn = async (role) => {
      if (role === "odin") { calls++; throw new Error("boom"); }
      return { text: "out", costUsd: 0, numTurns: 1 };
    };
    const { engine, store, completions } = harness({ run });
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(calls).toBe(2); // maxAttempts default 2 — every retry a journaled attempt
    const attempts = readJournal(store, g.id).filter((e) => e.type === "attempt.finished");
    expect(attempts.map((a) => a.payload.attempt)).toEqual([1, 2]);
    expect(store.listNodes(g.id).map((n) => n.status)).toEqual(["failed", "skipped"]);
    expect(completions).toEqual([{ ok: false }]);
  });

  it("createFromPlaybook gates: unknown playbook throws", () => {
    const { engine } = harness();
    expect(() => engine.createFromPlaybook({ playbook: "nope", title: "t", request: "r", channel: "t", chatId: "1" }))
      .toThrow(/Unknown playbook/);
  });

  it("pause/resume/abandon by slug; abandon skips unfinished", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const run: SpecialistRunFn = async () => { await held; return { text: "o", costUsd: 0, numTurns: 1 }; };
    const { engine, store } = harness({ run });
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await new Promise((r) => setTimeout(r, 25));
    expect(engine.pauseGoal(g.slug)).toContain("paused");
    expect(store.getGoal(g.id)!.status).toBe("paused-user");
    expect(engine.resumeGoal(g.slug)).toContain("resumed");
    expect(engine.abandonGoal(g.slug)).toContain("abandoned");
    release();
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("abandoned"));
    expect(store.listNodes(g.id).some((n) => n.status === "skipped")).toBe(true);
  });

  it("wall-time exceeded → goal failed, nodes skipped", async () => {
    const { engine, store } = harness({ wallTimeMs: -1000 });
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(store.getGoal(g.id)!.error).toMatch(/wall-time/i);
  });

  it("re-plan: planner returns a patch, engine records it, replacement runs, goal completes", async () => {
    let calls = 0, replans = 0;
    const run: SpecialistRunFn = async () => {
      calls++;
      if (calls <= 2) throw new Error("boom"); // attempt 1 + retry both fail
      return { text: "fixed", costUsd: 0, numTurns: 1 };
    };
    const planner: Planner = {
      plan: async () => { throw new Error("unused"); },
      planFromMail: async () => { throw new Error("unused"); },
      async replan(_goal, failed) {
        replans++;
        return { replaced: [{ key: failed.node_key, type: "run", agent: "odin", brief: "retry", deps: [] }], added: [] };
      },
    };
    const { engine, store, completions } = harness({ run, planner });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(replans).toBe(1);
    expect(store.getGoal(g.id)!.replans_used).toBe(1);
    expect(completions).toEqual([{ ok: true }]);
  });

  it("re-plan cap exhausted → goal fails without calling the planner", async () => {
    let called = false;
    const planner: Planner = {
      plan: async () => { throw new Error("unused"); },
      planFromMail: async () => { throw new Error("unused"); },
      replan: async () => { called = true; return { replaced: [], added: [] }; },
    };
    const { engine, store, completions } = harness({
      run: async () => { throw new Error("boom"); }, planner, replanCap: 0,
    });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(store.getGoal(g.id)!.error).toMatch(/re-plans exhausted: 0/);
    expect(called).toBe(false);
    expect(completions).toEqual([{ ok: false }]);
  });

  it("re-plan throws → goal fails 're-planning failed'", async () => {
    const planner: Planner = {
      plan: async () => { throw new Error("unused"); },
      planFromMail: async () => { throw new Error("unused"); },
      replan: async () => { throw new Error("lead returned no patch ops"); },
    };
    const { engine, store } = harness({ run: async () => { throw new Error("boom"); }, planner });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(store.getGoal(g.id)!.error).toMatch(/re-planning failed: lead returned no patch ops/);
  });

  it("session-limit output pauses the goal (paused-user), planner untouched", async () => {
    const run: SpecialistRunFn = async () => ({ text: "You've hit your session limit — resets at 3pm", costUsd: 0, numTurns: 1 });
    const { engine, store, completions } = harness({ run });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("paused-user"));
    expect(completions).toEqual([]);
  });

  it("per-node timeout: a hung attempt is aborted on tick and retried/failed visibly", async () => {
    const run: SpecialistRunFn = (_r, _b, opts) =>
      new Promise((_res, rej) => opts.signal?.addEventListener("abort", () => rej(new Error("hung"))));
    const { engine, store } = harness({ run, nodeTimeoutMs: 1 });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await new Promise((r) => setTimeout(r, 20));
    engine.tick(); // clock tick sweeps past-deadline attempts
    await vi.waitFor(() => {
      const outcomes = readJournal(store, g.id)
        .filter((e) => e.type === "attempt.finished").map((e) => e.payload.outcome);
      expect(outcomes).toContain("timeout");
    });
    engine.tick();
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed")); // both attempts time out
  });

  it("crossing the budget cap mid-attempt aborts in-flight work and parks the goal", async () => {
    let day = "2026-07-02";
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const run: SpecialistRunFn = (_r, _b, opts) => new Promise((res, rej) => {
      opts.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      void held.then(() => res({ text: "o", costUsd: 0, numTurns: 1 }));
    });
    const { engine, store } = harness({ run, capUsd: 0.5, todayFn: () => day });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await new Promise((r) => setTimeout(r, 20));
    store.budgetAdd(day, 100); // cap crossed while the attempt is in flight
    engine.tick();
    await vi.waitFor(() => {
      const outcomes = readJournal(store, g.id)
        .filter((e) => e.type === "attempt.finished").map((e) => e.payload.outcome);
      expect(outcomes).toContain("aborted");
    });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("paused-budget"));
    release();
  });

  it("boot recovery: dangling attempt orphaned, goal still terminates (replay, no resets)", async () => {
    // maxConcurrentNodes 0 → nothing schedules; we hand-seed a crash-window journal:
    // attempt.started with no attempt.finished (daemon died mid-attempt).
    const seeded = harness({ maxConcurrentNodes: 0 });
    const g = plannedGoal(seeded.engine, [{ key: "a" }]);
    appendEvents(seeded.store, g.id, [
      { type: "workspace.prepared", payload: { taskDir: null, mode: null } },
      { type: "attempt.started", payload: { node: "a", attempt: 1, agent: "odin", deadlineTs: 9e12, idempotencyKey: `${g.id}:a:1` } },
    ]);
    // "reboot": a fresh engine over the same store (same journal), now with worker slots.
    const rebooted = new GoalEngine({
      ...(seeded.engine as unknown as { deps: ConstructorParameters<typeof GoalEngine>[0] }).deps,
      maxConcurrentNodes: 2,
    });
    const n = rebooted.resumeUnfinished();
    expect(n).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => expect(seeded.store.getGoal(g.id)!.status).toBe("done"));
    const outcomes = readJournal(seeded.store, g.id)
      .filter((e) => e.type === "attempt.finished").map((e) => e.payload.outcome);
    expect(outcomes).toContain("orphaned");   // dangling attempt closed by recovery
    expect(outcomes).toContain("ok");         // retry (attempt 2) completed the node
  });
});
```

- [ ] **Step 5: Run core tests to verify failure, then green**

Run: `npx vitest run test/engine-core.test.ts`
Expected: FAIL first (missing file), then after implementation PASS (14 tests). Timing-sensitive tests (`timeout`, `budget abort`) may need `vi.waitFor` timeout bumps — prefer bumping over sleeps.

- [ ] **Step 6: Write + green the mail tests**

`test/engine-mail.test.ts` — ports of goal-scheduler's "mid-goal clarification" block + sweep semantics, seeded through the journal (never raw `insertGoal`):

```ts
// test/engine-mail.test.ts
import { describe, it, expect, vi } from "vitest";
// same harness/fixtureRegistry/PB/plannedGoal as test/engine-core.test.ts (copy them)

const queuedMail = (store: Store, over: Record<string, unknown> = {}) => {
  store.insertMail({
    id: "mQ", from_agent: "athena", to_agent: "vulcan", kind: "request", body: "which db?",
    goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
    chain_depth: 1, status: "queued", error: null, ...over,
  });
};

describe("engine mail integration", () => {
  it("sweep spawns a single-node goal from queued request; report mails back; mail marked spawned atomically", async () => {
    const { engine, store } = harness();
    queuedMail(store);
    engine.pump();
    await vi.waitFor(() => expect(store.getMail("mQ")!.status).toBe("spawned"));
    const goal = store.listGoals(10).find((g) => g.spawned_by_mail === "mQ")!;
    await vi.waitFor(() => expect(store.getGoal(goal.id)!.status).toBe("done"));
    const report = store.mailAnsweringRequest("mQ")!;
    expect(report).toMatchObject({ from_agent: "vulcan", to_agent: "athena", kind: "report" });
    expect(report.body).toContain("Done:");
  });

  it("unknown recipient → refused + parked asker resumes with the refusal", async () => {
    const { engine, store } = harness({ maxConcurrentNodes: 0 });
    const g = plannedGoal(engine, [{ key: "task", agent: "athena" }]);
    store.insertMail({ id: "mR", from_agent: "athena", to_agent: "ghost", kind: "request",
      body: "?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "queued", error: null });
    engine.parkFromAsk(g.id, "task", "mR");
    expect(store.getGoal(g.id)!.status).toBe("awaiting-mail");
    engine.pump(); // sweep refuses unknown recipient → resumeFromAnswer
    expect(store.getGoal(g.id)).toMatchObject({ status: "running", awaiting_mail: null });
    const resume = store.listNodes(g.id).find((n) => n.node_key.startsWith("resume_"))!;
    expect(resume.brief).toContain("Refused");
    expect(JSON.parse(resume.depends_on)).toEqual(["task"]); // joins the DAG at the asker
  });

  it("depth cap → downgraded to note + parked asker resumes with Declined", async () => {
    const { engine, store } = harness({ maxConcurrentNodes: 0 }); // mailMaxDepth 2
    const g = plannedGoal(engine, [{ key: "task", agent: "athena" }]);
    store.insertMail({ id: "mD", from_agent: "athena", to_agent: "vulcan", kind: "request",
      body: "?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 3, status: "queued", error: null });
    engine.parkFromAsk(g.id, "task", "mD");
    engine.pump();
    expect(store.getGoal(g.id)).toMatchObject({ status: "running", awaiting_mail: null });
    expect(store.listNodes(g.id).find((n) => n.node_key.startsWith("resume_"))!.brief).toContain("Declined");
    expect(store.getMail("mD")).toMatchObject({ kind: "note", status: "unread" });
  });

  it("answerUserMail resumes a user-parked goal; retargets dependents; goal completes", async () => {
    const { engine, store } = harness();
    const g = plannedGoal(engine, [{ key: "task", agent: "athena" }, { key: "after", deps: ["task"] }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done")); // baseline run…
    // …now a parked variant: fresh goal, park before scheduling
    const { engine: e2, store: s2 } = harness({ maxConcurrentNodes: 0 });
    const g2 = plannedGoal(e2, [{ key: "task", agent: "athena" }, { key: "after", deps: ["task"] }]);
    s2.insertMail({ id: "ask1", from_agent: "athena", to_agent: "user", kind: "request",
      body: "which db?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "awaiting-human", error: null, from_node: "task" });
    e2.parkFromAsk(g2.id, "task", "ask1");
    const res = e2.answerUserMail("ask1", "use sqlite");
    expect(res).toEqual({ ok: true });
    expect(s2.getGoal(g2.id)).toMatchObject({ status: "running", awaiting_mail: null });
    const after = s2.listNodes(g2.id).find((n) => n.node_key === "after")!;
    expect(JSON.parse(after.depends_on)).toEqual(["resume_1"]); // repointed downstream
    expect(e2.answerUserMail("ask1", "again").ok).toBe(false);  // double-submit safe
  });

  it("answerFromChat intercepts @agent replies only for pending asks", async () => {
    const { engine, store } = harness({ maxConcurrentNodes: 0 });
    const g = plannedGoal(engine, [{ key: "task", agent: "athena" }]);
    store.insertMail({ id: "ask2", from_agent: "athena", to_agent: "user", kind: "request",
      body: "?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "awaiting-human", error: null, from_node: "task" });
    engine.parkFromAsk(g.id, "task", "ask2");
    expect(engine.answerFromChat("@athena use postgres")).toContain("Answer sent");
    expect(engine.answerFromChat("@athena more text")).toBeNull(); // nothing pending now
    expect(engine.answerFromChat("bare message")).toBeNull();
  });

  it("boot reconcile resumes a parked goal whose answer landed while down; others stay parked", () => {
    const { engine, store } = harness({ maxConcurrentNodes: 0 });
    const g = plannedGoal(engine, [{ key: "task", agent: "athena" }]);
    store.insertMail({ id: "mQ2", from_agent: "athena", to_agent: "vulcan", kind: "request",
      body: "?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "spawned", error: null });
    engine.parkFromAsk(g.id, "task", "mQ2");
    store.insertMail({ id: "rep", from_agent: "vulcan", to_agent: "athena", kind: "report",
      body: "Done: sqlite", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "unread", error: null, thread_id: "mQ2", in_reply_to: "mQ2" });
    const g2 = plannedGoal(engine, [{ key: "task", agent: "athena" }]);
    engine.parkFromAsk(g2.id, "task", "mZ"); // no answer for this one
    engine.resumeUnfinished();
    expect(store.getGoal(g.id)!.status).toBe("running");
    expect(store.getGoal(g2.id)!.status).toBe("awaiting-mail");
  });

  it("abandoning a mail-spawned goal still reports back to the asker", async () => {
    const { engine, store } = harness({ maxConcurrentNodes: 0 });
    queuedMail(store);
    engine.pump();
    const goal = store.listGoals(10).find((g) => g.spawned_by_mail === "mQ")!;
    engine.abandonGoal(goal.id);
    const report = store.mailAnsweringRequest("mQ")!;
    expect(report.body).toContain("Failed:");
    expect(report.body).toContain("abandoned by user");
  });

  it("failing sibling on a parked goal fails the goal and clears the ask pointer", async () => {
    const run: SpecialistRunFn = async (role) => {
      if (role === "vulcan") throw new Error("sibling boom");
      return { text: "o", costUsd: 0, numTurns: 1 };
    };
    const { engine, store } = harness({ run });
    const g = plannedGoal(engine, [{ key: "ask", agent: "athena" }, { key: "sib", agent: "vulcan" }]);
    engine.parkFromAsk(g.id, "ask", "mAsk"); // parks while sib may still run
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(store.getGoal(g.id)!.awaiting_mail).toBeNull(); // no dangling ask pointer
  });
});
```

Run: `npx vitest run test/engine-mail.test.ts`
Expected: PASS (8 tests). NOTE: `plannedGoal` uses agents from `fixtureRegistry()` (athena/vulcan/odin) — the sweep tests rely on vulcan being a non-lead (athena is the lead).

- [ ] **Step 7: Typecheck + full suite, then commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: green — old engine untouched, all old tests still pass alongside the new ones.

```bash
git add src/engine/engine.ts src/engine/compile.ts test/engine-core.test.ts test/engine-mail.test.ts
git commit -m "feat(engine): journaled GoalEngine — fold/decide/dispatch loop, mail integration, replay recovery"
```

---

### Task 8: Cutover — goals.ts becomes a barrel; old engine deleted; wiring updated

**Files:**
- Rewrite: `src/engine/goals.ts` (787 lines → ~15-line barrel)
- Modify: `src/engine/plan.ts` (replan returns `ReplanPatch` instead of writing the store)
- Modify: `src/mail/mailbox.ts` (`onAskParked` hook replaces direct park writes)
- Modify: `src/config.ts` (`nodeTimeoutMs`), `src/index.ts` (wire hook + timeouts + 30s tick)
- Modify: `src/store/db.ts` (delete `resetRunningNodes`)
- Delete: `test/goal-scheduler.test.ts`, `test/goal-runner.test.ts` (superseded by engine-core/engine-mail/workers tests)
- Modify: `test/goal-planner.test.ts`, `test/goal-store.test.ts`, `test/mail-*.test.ts` fixtures as needed

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: import path `../engine/goals.js` keeps working everywhere (`index.ts`, `moderator/*`, `web/*`, tests) with identical exported names.

- [ ] **Step 1: Rewrite `src/engine/goals.ts` as the barrel**

```ts
// src/engine/goals.ts — public façade of the journaled engine. Import paths stay stable;
// internals live in journal.ts / reduce.ts / decide.ts / project.ts / workers.ts / engine.ts.
export {
  GoalEngine, MAIL_PREFIX,
  type Planner, type ReplanPatch, type GoalOutcome, type GoalEngineDeps,
} from "./engine.js";
export {
  SessionLimitError, ancestorArtifacts, AbortRegistry, runAttempt,
  type Verdict, type TestReport, type WorkerDeps,
} from "./workers.js";
export { stageRoles, isUnsandboxedWrite } from "./compile.js";
```

Before deleting the old body, run `grep -rn "from \"../engine/goals.js\"\|from \"./goals.js\"" src/ test/` and confirm every imported name appears in the barrel. Any import of `runNode`/`NodeRunDeps` (goal-runner.test.ts only, expected) is deleted with that test. Any other consumer of a now-missing export: re-export it from its new home rather than changing the consumer.

- [ ] **Step 2: plan.ts — replan returns the patch**

In `makePlanner`'s `replan` (plan.ts:291-340): keep everything through the whole-graph validation (`if (!v.ok) throw ...`), then REPLACE the persistence block (the `store.replaceNode`/`store.insertNodes` calls, plan.ts:333-338) with:

```ts
      const toGraph = (n: RawNode): GraphNodeSpec =>
        ({ key: n.key, type: n.type, agent: n.agent, critic: n.critic, brief: n.brief, deps: n.deps, maxRounds: n.maxRounds });
      await deps.postPreview(origin, `♻️ Re-planned "${goal.title}" after ${failed.node_key} failed:\n${renderPlanPreview(goal.title, "patched plan", [...current.values()].map(toGraph))}`);
      return { replaced: replaces.map(toGraph), added: adds.map(toGraph) };
```

Update the return type annotation (`Promise<ReplanPatch>` via the Planner import) and `test/goal-planner.test.ts`: where it previously asserted `store.replaceNode` effects (rows changed), assert the RETURNED patch instead (`expect(patch.replaced.map(n => n.key))...`). The abandon-op and done-node-immutability throws are unchanged — those assertions stay.

- [ ] **Step 3: mailbox hook**

`src/mail/mailbox.ts`: add to `MailboxDeps`:

```ts
  /** Journaled engine hook: records ask.parked (parks the goal + marks the asking node
   *  done) inside THIS mailbox transaction. Absent only in unit tests. */
  onAskParked?: (goalId: string, nodeKey: string | null, mailId: string) => void;
```

In BOTH park sites (mailbox.ts:102-103 and 129-132), replace the two store calls inside the transaction with:

```ts
        if (this.deps.onAskParked) this.deps.onAskParked(ctx.goalId!, ctx.nodeKey ?? null, id);
        else {
          this.deps.store.parkGoalAwaiting(ctx.goalId!, id);
          if (ctx.nodeKey) this.deps.store.updateNodeStatus(ctx.goalId!, ctx.nodeKey, "done");
        }
```

(The engine's `parkFromAsk` appends `ask.parked`; `appendEvents` joins the open transaction via `store.inTransaction`.)

- [ ] **Step 4: config + index wiring**

`src/config.ts`: add `nodeTimeoutMs: number;` to the config interface and `nodeTimeoutMs: Number(env.AIOS_NODE_TIMEOUT_MS ?? 15 * 60 * 1000),` beside `jobWallTimeMs` (config.ts:202) — follow the file's existing env pattern exactly.

`src/index.ts`:
1. GoalEngine deps (index.ts:263): add `nodeTimeoutMs: config.nodeTimeoutMs,`.
2. Mailbox deps (index.ts:88-95, the forward-ref closure pattern already used for `onQueued`): add `onAskParked: (g, n, m) => goals.parkFromAsk(g, n, m),`.
3. Clock tick, next to the retention timer wiring: 

```ts
  // Journaled engine heartbeat: sweeps attempt deadlines, budget-abort, and stalled decides.
  const engineTick = setInterval(() => goals.tick(), 30_000);
  engineTick.unref?.();
  stops.push(() => clearInterval(engineTick));
```

(NOTE: match the actual stop-registration mechanism used by the retention timer in index.ts — reuse it.)

- [ ] **Step 5: Delete dead code + superseded tests**

- `src/store/db.ts`: delete `resetRunningNodes` (db.ts:647-652). `grep -rn resetRunningNodes src/ test/` must come back empty afterwards (fix `test/goal-store.test.ts` if it exercises it — delete that case).
- Delete `test/goal-scheduler.test.ts` and `test/goal-runner.test.ts` (every intent lives in engine-core/engine-mail/workers tests — diff the `it()` titles to confirm before deleting; port any orphan intent you find into engine-core.test.ts first).
- Run `npx vitest run` and fix remaining fixture fallout mechanically. Expected fallout: mailbox tests that asserted direct park writes (they now pass `onAskParked` stubs or rely on the fallback), moderator/goal-tools tests that seeded raw `insertGoal` rows and expected the engine to schedule them — reseed those through `startPlannedGoal` (the engine only schedules journal-backed goals; that is the point).

- [ ] **Step 6: Typecheck + full suite, then commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: green. This is the cutover commit — everything after runs on the journal.

```bash
git add -A
git commit -m "feat(engine)!: cut over to journaled engine — goals.ts barrel, replan patch contract, ask-park hook, 30s tick"
```

---

### Task 9: Crash simulation — truncate the journal at every position

**Files:**
- Test: `test/crash-replay.test.ts` (create)

**Interfaces:**
- Consumes: `replayInto` (journal.ts), engine harness from `test/engine-core.test.ts` (copy the builders), `readJournal`.

- [ ] **Step 1: Write the test**

```ts
// test/crash-replay.test.ts
import { describe, it, expect, vi } from "vitest";
// copy harness/fixtureRegistry/PB from test/engine-core.test.ts
import { readJournal, replayInto } from "../src/engine/journal.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";

/** Deterministic multi-kind run fn: loop critic revises once then approves;
 *  verify runner fails once then passes; everything else echoes. */
function scriptedRun(): SpecialistRunFn {
  const counts = new Map<string, number>();
  return async (role) => {
    const n = (counts.get(role) ?? 0) + 1;
    counts.set(role, n);
    if (role === "minos") {
      const verdict = n === 1
        ? { verdict: "revise", summary: "needs work", reasons: ["r1"] }
        : { verdict: "approve", summary: "good", reasons: [] };
      return { text: "review", structured: verdict, costUsd: 0.01, numTurns: 1 };
    }
    if (role === "argus") {
      return { text: "report", structured: { passed: n > 1, summary: "s", failures: n > 1 ? [] : ["f1"] }, costUsd: 0.01, numTurns: 1 };
    }
    return { text: `${role}-out-${n}`, costUsd: 0.01, numTurns: 1 };
  };
}

// NOTE: fixtureRegistry must include a "minos" agent for the critic and an "argus" agent —
// extend the copied fixtureRegistry to write minos.yaml and argus.yaml alongside the others.

const GRAPH = [
  { node_key: "design", type: "run" as const, agent: "odin", critic: null, brief: "design", depends_on: [], max_rounds: 1 },
  { node_key: "impl", type: "loop" as const, agent: "vulcan", critic: "minos", brief: "build", depends_on: ["design"], max_rounds: 3 },
  { node_key: "check", type: "verify" as const, agent: "argus", critic: "vulcan", brief: "verify", depends_on: ["impl"], max_rounds: 3 },
];

describe("crash simulation: recover from every journal prefix", () => {
  it("goal terminates from any truncation point; done nodes never re-run", async () => {
    // 1. Golden run to completion.
    const golden = harness({ run: scriptedRun() });
    const g = golden.engine.startPlannedGoal({
      title: "C", request: "do c", department: "engineering", lead: "athena",
      origin: { channel: "t", chatId: "1" }, summary: "planned", needsWorkspace: "none", nodes: GRAPH,
    });
    await vi.waitFor(() => expect(golden.store.getGoal(g.id)!.status).toBe("done"), { timeout: 10_000 });
    const journal = readJournal(golden.store, g.id);
    expect(journal.length).toBeGreaterThan(10);

    // 2. For every prefix: replay → boot a fresh engine → must terminate.
    for (let k = 1; k < journal.length; k++) {
      const fresh = harness({ run: scriptedRun() });
      replayInto(fresh.store, journal.slice(0, k));
      const before = fresh.store.listNodes(g.id).filter((n) => n.status === "done").map((n) => n.node_key);
      fresh.engine.resumeUnfinished();
      await vi.waitFor(() => {
        const st = fresh.store.getGoal(g.id)!.status;
        expect(["done", "failed"], `prefix ${k} stuck at ${st}`).toContain(st);
      }, { timeout: 10_000 });
      // recovery must not re-run completed work: done nodes stay done
      for (const key of before) {
        expect(fresh.store.listNodes(g.id).find((n) => n.node_key === key)!.status, `prefix ${k}/${key}`).toBe("done");
      }
      // and the journal replays deterministically: no duplicate attempt claims
      const starts = readJournal(fresh.store, g.id).filter((e) => e.type === "attempt.started");
      const claims = starts.map((e) => `${e.payload.node}:${e.payload.attempt}`);
      expect(new Set(claims).size, `prefix ${k}`).toBe(claims.length);
    }
  }, 120_000);
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/crash-replay.test.ts`
Expected: PASS. Failures here are real recovery bugs — debug with the journal diff (`readJournal` before/after), don't loosen the assertions. Legitimate adjustment: a prefix cut mid-`goal.created`-batch (k=1) leaves `planned=false` — the engine correctly does nothing; if the goal row doesn't exist for k<1 events the loop naturally skips (goal.created is projected at k>=1).

- [ ] **Step 3: Full suite + commit**

Run: `npx tsc --noEmit && npx vitest run`

```bash
git add test/crash-replay.test.ts
git commit -m "test(engine): crash simulation — recovery from every journal truncation point"
```

---

### Task 10: Merge, deploy + live smoke

**Files:** none (operational).

- [ ] **Step 1: Merge to main (if in worktree)**

```bash
cd /Users/ihabbishara/projects/AIOS
git merge --ff-only journal-core
git worktree remove .worktrees/journal-core && git branch -d journal-core
npx vitest run && npx tsc --noEmit   # re-verify on the real checkout, no worktree double-scan
```

- [ ] **Step 2: Pre-deploy check — no in-flight goals on the old engine**

```bash
sqlite3 data/aios.sqlite "SELECT id, slug, status FROM goals WHERE status IN ('planning','running','replanning','awaiting-mail')"
```

Spec §13: deploy waits for in-flight goals to finish, or the user abandons them. If any rows: STOP and ask the user (abandon via chat/UI, or wait). The migration freezes whatever remains as `legacy=1`.

- [ ] **Step 3: Build + restart**

```bash
npm run build && launchctl kickstart -k gui/$(id -u)/com.ihab.aios
sleep 70   # web listens ~65s after start (slack delay)
tail -50 data/aios.log
```

Expected in the log: readiness line, no boot errors, no "frozen legacy goals still unfinished" (or only expected ones).

- [ ] **Step 4: Smoke — journal + legacy freeze + API shape**

```bash
sqlite3 data/aios.sqlite "SELECT count(*) FROM goal_journal"                       # exists (likely 0)
sqlite3 data/aios.sqlite "SELECT legacy, count(*) FROM goals GROUP BY legacy"      # old rows legacy=1
sqlite3 data/aios.sqlite "SELECT count(*) FROM pragma_index_list('actions') WHERE name='idx_actions_idem'"  # 1
source .env 2>/dev/null; curl -s -H "Authorization: Bearer $AIOS_UI_TOKEN" http://127.0.0.1:4280/api/goals | head -c 600
```

Expected: `/api/goals` serves the same shape as before (legacy goals visible).

- [ ] **Step 5: Live end-to-end — one real goal through the journal**

Via Telegram/Mission Control chat: `run the research-report playbook on <trivial topic>` (or any cheap playbook). Then:

```bash
sqlite3 data/aios.sqlite "SELECT gseq, type FROM goal_journal ORDER BY seq DESC LIMIT 20"
sqlite3 data/aios.sqlite "SELECT slug, status, legacy FROM goals ORDER BY created_at DESC LIMIT 3"
```

Expected: full event trail (`goal.created` → … → `goal.completed`), goal row `legacy=0`, artifacts in the vault, completion ping in chat. Then kill mid-goal once (`launchctl kickstart -k ...` while a node runs) and confirm the restart log shows orphaned-attempt recovery and the goal still terminates.

- [ ] **Step 6: Push**

```bash
git push origin main
```

---

## Self-review notes (already applied)

- **Spec coverage:** §3 journal → Task 1; §4 taxonomy → Tasks 1-2 (payload interfaces + reducer cases); §5 reducer + golden tests → Task 2; §6 decide + fairness → Task 3; §7 workers/timeouts/retry/idempotency → Tasks 5-6; §8 budget both enforcement points → Task 3 (`ParkForBudget`) + Task 7 (`enforceBudgetAbort`); §9 recovery=replay → Tasks 7 (resumeUnfinished) + 9 (truncation sim); §10 projections → Task 4; §11 mail → Tasks 7-8; §12 module layout → matches; §13 migration/freeze → Tasks 4 + 10; §14 testing matrix → Tasks 2/3/4/5/9; §15 loop-cap soft-gate preserved → Task 5 (warning-note port).
- **Spec deviation (deliberate):** `reconcilePlanningMail` survives — it guards MAIL rows stuck in 'planning' (mail is not event-sourced; `claimMailPlanning` survives per §11, so its recovery partner must too). `resetRunningNodes` and the parked-answer bespoke code ARE deleted/replaced as §5 promises. `RequestPlan` command from §6 is unnecessary — planning always precedes `goal.created` (same as the old engine); `FailNode`/`RequestReplan`/`AbortAttempt` are added instead.
- **Type consistency check:** `NodeSpec.kind` (journal) ↔ `NewTaskNode.type` (rows) via `toSpec`/`toRow` — the ONLY two conversion points. `Planner.replan` returns `ReplanPatch` of `GraphNodeSpec` (planner-side type) converted once via `graphToSpec`. `AttemptOutcome` shared by workers/reduce/decide from journal.ts.
- **Known ceilings:** whole-journal fold per tick per goal (journals are ≤ a few hundred events; snapshot later if profiling demands); an SDK call that ignores its AbortSignal keeps its worker promise alive past the timeout event (slot is freed logically — the attempt is finished{timeout} — but the process holds the dangling promise until it settles).
