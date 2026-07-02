# Phase 3a — Goal Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the linear JobManager/PlaybookExecutor with a unified GoalEngine: persisted task DAGs planned by department leads, parallel node execution, daily budget enforcement — playbooks compile to graphs with parity-pinned semantics.

**Architecture:** New `goals`/`task_nodes`/`budget_ledger` tables + a GoalEngine (`src/engine/goals.ts`) that schedules DAG nodes through the existing `SpecialistRunFn` capability kernel. Playbooks compile to linear graphs (`src/engine/compile.ts`); leads plan free-form graphs via structured output (`src/engine/plan.ts`), validated fail-closed. `code_task`/`run_playbook` become facades; the old executor, JobManager, and jobs/stages tables are deleted at the end.

**Tech Stack:** TypeScript, node:sqlite (no FTS5, no better-sqlite3), Claude Agent SDK `query()` via existing `makeRunSpecialist`, vitest, zod.

**Spec:** `docs/superpowers/specs/2026-07-02-phase3-goal-engine-design.md` (§1–8, §10–12). UI (§9) is plan 3b.

## Global Constraints

- No new npm dependencies. node:sqlite only. Subscription auth (CLAUDE_CODE_OAUTH_TOKEN) untouched.
- Money is integer cents in SQLite (`cost_cents`, `spent_cents`) — never float dollars in storage.
- Mythic agent names; aliases must keep working (canonicalize via `registry.agentOf`).
- `code_task` remains the ONLY entry for code playbooks; `run_playbook` refuses them (`CODE_PLAYBOOKS`).
- Inplace mode is facade-only; GRAPH_SCHEMA's `needsWorkspace` has no inplace value.
- Loop critics must carry `outputSchema: verdict`; verify runners must carry `outputSchema: test-report` (manifest field) — validation rules, pinned by tests.
- Private-visibility agents refuse non-private origins, fail-closed when `primaryChat` unset (reuse `isPrivateOrigin` from `src/agents/direct.js`).
- Node runs go through `specialistOptions`/`makeRunSpecialist` — never a parallel option-assembly path.
- Startup sweeps are startup-only (never intervals). Anchor/kv stamp-before-run patterns preserved.
- Suite baseline 742 pass + 1 skip; `npx tsc --noEmit`, `npm run build`, `cd ui && npm run build` clean after every task. Old-engine tests may be ported/deleted ONLY in Task 9 (they are the parity baseline until then).
- Worktree caveat: EnterWorktree branches from origin/main — rebase onto local main if local-only commits exist.
- Deploy after merge: `npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`.

## File Structure

- Create: `src/engine/compile.ts` — GraphSpec types + `compilePlaybook`.
- Create: `src/engine/plan.ts` — `validateGraph`, GRAPH/PATCH schemas, `makePlanner` (lead planning + re-planning).
- Create: `src/engine/budget.ts` — `SpendGuard` + ledger listener.
- Create: `src/engine/goals.ts` — `GoalEngine` (scheduler + node runner; absorbs executor round semantics).
- Modify: `src/store/db.ts` — goals/task_nodes/budget_ledger tables + CRUD; (Task 9) drop jobs/stages.
- Modify: `src/events.ts` — `goal.*`/`node.status` events, `via: "plan"`; (Task 9) drop `job.*`/`stage.*`.
- Modify: `src/agents/runner.ts` — `RunOptions.outputSchema` passthrough.
- Modify: `src/vault/writer.ts` — goal artifact methods (`goals/` root).
- Modify: `src/moderator/tools.ts`, `src/moderator/index.ts` (deps), `src/router.ts` — plan_goal/goal_status/facades, `/pause|/resume|/abandon`.
- Modify: `src/heartbeat/clock.ts` — optional `onTick` hook.
- Modify: `src/config.ts` — `dailyBudgetUsd`, `maxConcurrentNodes`.
- Modify: `src/index.ts`, `src/heartbeat/speculate.ts`, `src/web/server.ts`, `src/web/packs-view.ts` — wiring + compat.
- Delete (Task 9): `src/engine/jobs.ts`, `src/engine/executor.ts` (SessionLimitError & helpers move to goals.ts).
- Tests: `test/goal-store.test.ts`, `test/compile.test.ts`, `test/validate-graph.test.ts`, `test/spend-guard.test.ts`, `test/goal-runner.test.ts`, `test/goal-scheduler.test.ts`, `test/goal-planner.test.ts`, `test/goal-tools.test.ts`, `test/goal-endpoints.test.ts`; ports of `executor.test.ts` etc. in Task 9.

Shared test fixture (defined in Task 1, exported and reused): a registry with engineering (athena lead, vulcan run-agent, themis free-text critic, minos NOT in dept, argus `outputSchema: test-report`, odin) and finance (midas private lead) — built with `loadRegistry` over a tmp dir exactly like `test/org-view.test.ts`'s `fixtureRegistry`.

---

### Task 1: Store layer — goals, task_nodes, budget_ledger + event types

**Files:**
- Modify: `src/store/db.ts` (types near `JobRow`; tables in constructor `exec`; methods after `completedStages`)
- Modify: `src/events.ts:25` (union additions)
- Test: `test/goal-store.test.ts`

**Interfaces:**
- Produces (later tasks rely on these exact names):

```typescript
export type GoalStatus = "planning" | "running" | "paused-budget" | "paused-user" | "replanning" | "done" | "failed" | "abandoned";
export type NodeStatus = "pending" | "ready" | "running" | "done" | "failed" | "skipped";
export interface GoalRow {
  id: string; slug: string; title: string; request: string;
  department: string; lead: string; origin_channel: string; origin_chat_id: string;
  status: GoalStatus; project_dir: string | null; goal_dir: string | null;
  plan_summary: string; replans_used: number; error: string | null;
  created_at: string; updated_at: string;
}
export interface TaskNodeRow {
  goal_id: string; node_key: string; type: "run" | "loop" | "verify";
  agent: string; critic: string | null; brief: string;
  depends_on: string; // JSON array of node_keys
  max_rounds: number; status: NodeStatus; artifact: string | null;
  cost_cents: number; rounds_used: number; error: string | null;
  started_at: string | null; finished_at: string | null;
}
export interface NewTaskNode {
  node_key: string; type: "run" | "loop" | "verify"; agent: string;
  critic: string | null; brief: string; depends_on: string[]; max_rounds: number;
}
```

- Store methods: `insertGoal(g: Omit<GoalRow,"created_at"|"updated_at">)`, `getGoal(id): GoalRow|undefined`, `getGoalBySlug(slug): GoalRow|undefined` (newest first), `listGoals(limit=20): GoalRow[]`, `unfinishedGoals(): GoalRow[]` (status IN planning,running,replanning), `pausedBudgetGoals(): GoalRow[]`, `updateGoalStatus(id, status, error?)`, `setGoalProjectDir(id, dir)`, `setGoalDir(id, dir)`, `bumpReplans(id)`, `insertNodes(goalId, nodes: NewTaskNode[])`, `replaceNode(goalId, key, node: NewTaskNode)` (DELETE+INSERT, resets status pending), `listNodes(goalId): TaskNodeRow[]` (insertion order via rowid), `updateNodeStatus(goalId, key, status: NodeStatus, error?)` (stamps started_at on `running`, finished_at on done/failed/skipped), `addNodeCost(goalId, key, cents)`, `setNodeArtifact(goalId, key, file)`, `setNodeRounds(goalId, key, rounds)`, `skipUnfinishedNodes(goalId)` (pending/ready → skipped), `resetRunningNodes(): string[]` (running → pending, returns distinct goal_ids), `budgetAdd(date, cents)`, `budgetSpentCents(date): number`.
- Events union additions (types only; nothing emits them yet):

```typescript
  | { type: "goal.created"; goalId: string; title: string; department: string }
  | { type: "goal.status"; goalId: string; status: string; error?: string }
  | { type: "node.status"; goalId: string; nodeKey: string; status: string; agent: string; error?: string }
```

and `route.decision`'s `via` union gains `"plan"`.

- [ ] **Step 1: Write the failing test**

Create `test/goal-store.test.ts`:

```typescript
// test/goal-store.test.ts
import { describe, it, expect } from "vitest";
import { Store, type GoalRow } from "../src/store/db.js";

function goal(over: Partial<GoalRow> = {}): Omit<GoalRow, "created_at" | "updated_at"> {
  return {
    id: over.id ?? "g1", slug: over.slug ?? "build-x", title: "Build X", request: "build x please",
    department: "engineering", lead: "athena", origin_channel: "telegram", origin_chat_id: "42",
    status: over.status ?? "planning", project_dir: null, goal_dir: null,
    plan_summary: "", replans_used: 0, error: null, ...over,
  } as Omit<GoalRow, "created_at" | "updated_at">;
}

const NODES = [
  { node_key: "design", type: "run" as const, agent: "athena", critic: null, brief: "design it", depends_on: [], max_rounds: 1 },
  { node_key: "implement", type: "loop" as const, agent: "vulcan", critic: "minos", brief: "build it", depends_on: ["design"], max_rounds: 3 },
];

describe("goal store", () => {
  it("round-trips a goal with nodes", () => {
    const s = new Store(":memory:");
    s.insertGoal(goal());
    s.insertNodes("g1", NODES);
    const g = s.getGoal("g1")!;
    expect(g.status).toBe("planning");
    const nodes = s.listNodes("g1");
    expect(nodes.map((n) => n.node_key)).toEqual(["design", "implement"]);
    expect(JSON.parse(nodes[1].depends_on)).toEqual(["design"]);
    expect(nodes[1].max_rounds).toBe(3);
  });

  it("node status transitions stamp timestamps", () => {
    const s = new Store(":memory:");
    s.insertGoal(goal());
    s.insertNodes("g1", NODES);
    s.updateNodeStatus("g1", "design", "running");
    expect(s.listNodes("g1")[0].started_at).toBeTruthy();
    s.updateNodeStatus("g1", "design", "done");
    expect(s.listNodes("g1")[0].finished_at).toBeTruthy();
    s.updateNodeStatus("g1", "implement", "failed", "boom");
    expect(s.listNodes("g1")[1].error).toBe("boom");
  });

  it("cost, rounds, artifact accumulate", () => {
    const s = new Store(":memory:");
    s.insertGoal(goal());
    s.insertNodes("g1", NODES);
    s.addNodeCost("g1", "design", 120);
    s.addNodeCost("g1", "design", 30);
    s.setNodeRounds("g1", "implement", 2);
    s.setNodeArtifact("g1", "design", "design.md");
    const [d, i] = s.listNodes("g1");
    expect(d.cost_cents).toBe(150);
    expect(d.artifact).toBe("design.md");
    expect(i.rounds_used).toBe(2);
  });

  it("replaceNode swaps and resets to pending", () => {
    const s = new Store(":memory:");
    s.insertGoal(goal());
    s.insertNodes("g1", NODES);
    s.updateNodeStatus("g1", "implement", "failed", "boom");
    s.replaceNode("g1", "implement", { ...NODES[1], agent: "odin" });
    const n = s.listNodes("g1").find((x) => x.node_key === "implement")!;
    expect(n.agent).toBe("odin");
    expect(n.status).toBe("pending");
    expect(n.error).toBeNull();
  });

  it("skipUnfinishedNodes + resetRunningNodes", () => {
    const s = new Store(":memory:");
    s.insertGoal(goal());
    s.insertNodes("g1", NODES);
    s.updateNodeStatus("g1", "design", "running");
    expect(s.resetRunningNodes()).toEqual(["g1"]);
    expect(s.listNodes("g1")[0].status).toBe("pending");
    s.updateNodeStatus("g1", "design", "done");
    s.skipUnfinishedNodes("g1");
    expect(s.listNodes("g1").map((n) => n.status)).toEqual(["done", "skipped"]);
  });

  it("goal queries: bySlug newest-first, unfinished, paused-budget, bumpReplans", () => {
    const s = new Store(":memory:");
    s.insertGoal(goal({ id: "g1", status: "running" }));
    s.insertGoal(goal({ id: "g2", slug: "other", status: "paused-budget" }));
    expect(s.getGoalBySlug("build-x")!.id).toBe("g1");
    expect(s.unfinishedGoals().map((g) => g.id)).toEqual(["g1"]);
    expect(s.pausedBudgetGoals().map((g) => g.id)).toEqual(["g2"]);
    s.bumpReplans("g1");
    s.bumpReplans("g1");
    expect(s.getGoal("g1")!.replans_used).toBe(2);
  });

  it("budget ledger accumulates integer cents per date", () => {
    const s = new Store(":memory:");
    s.budgetAdd("2026-07-02", 150);
    s.budgetAdd("2026-07-02", 25);
    s.budgetAdd("2026-07-03", 10);
    expect(s.budgetSpentCents("2026-07-02")).toBe(175);
    expect(s.budgetSpentCents("2026-07-03")).toBe(10);
    expect(s.budgetSpentCents("2026-07-04")).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/goal-store.test.ts`
Expected: FAIL — `insertGoal is not a function` (and GoalRow type error under tsc).

- [ ] **Step 3: Implement**

In `src/store/db.ts`, after the `JobRow`/`StageStatus` block add the `GoalStatus`/`NodeStatus`/`GoalRow`/`TaskNodeRow`/`NewTaskNode` types exactly as in **Interfaces** above. In the constructor `exec` (after the `stages` table) add:

```sql
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        request TEXT NOT NULL,
        department TEXT NOT NULL,
        lead TEXT NOT NULL,
        origin_channel TEXT NOT NULL,
        origin_chat_id TEXT NOT NULL,
        status TEXT NOT NULL,
        project_dir TEXT,
        goal_dir TEXT,
        plan_summary TEXT NOT NULL DEFAULT '',
        replans_used INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_nodes (
        goal_id TEXT NOT NULL,
        node_key TEXT NOT NULL,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        critic TEXT,
        brief TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        max_rounds INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        artifact TEXT,
        cost_cents INTEGER NOT NULL DEFAULT 0,
        rounds_used INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE (goal_id, node_key)
      );
      CREATE TABLE IF NOT EXISTS budget_ledger (
        date TEXT PRIMARY KEY,
        spent_cents INTEGER NOT NULL DEFAULT 0
      );
```

Methods (after `completedStages`):

```typescript
  insertGoal(g: Omit<GoalRow, "created_at" | "updated_at">): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO goals (id, slug, title, request, department, lead, origin_channel, origin_chat_id,
                          status, project_dir, goal_dir, plan_summary, replans_used, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(g.id, g.slug, g.title, g.request, g.department, g.lead, g.origin_channel, g.origin_chat_id,
          g.status, g.project_dir, g.goal_dir, g.plan_summary, g.replans_used, g.error, now, now);
  }

  getGoal(id: string): GoalRow | undefined {
    return this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as GoalRow | undefined;
  }

  getGoalBySlug(slug: string): GoalRow | undefined {
    return this.db.prepare("SELECT * FROM goals WHERE slug = ? ORDER BY created_at DESC LIMIT 1")
      .get(slug) as GoalRow | undefined;
  }

  listGoals(limit = 20): GoalRow[] {
    return this.db.prepare("SELECT * FROM goals ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as GoalRow[];
  }

  unfinishedGoals(): GoalRow[] {
    return this.db.prepare(
      "SELECT * FROM goals WHERE status IN ('planning','running','replanning') ORDER BY created_at ASC",
    ).all() as unknown as GoalRow[];
  }

  pausedBudgetGoals(): GoalRow[] {
    return this.db.prepare("SELECT * FROM goals WHERE status = 'paused-budget' ORDER BY created_at ASC")
      .all() as unknown as GoalRow[];
  }

  updateGoalStatus(id: string, status: GoalStatus, error?: string): void {
    this.db.prepare("UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, error ?? null, new Date().toISOString(), id);
  }

  setGoalProjectDir(id: string, dir: string): void {
    this.db.prepare("UPDATE goals SET project_dir = ?, updated_at = ? WHERE id = ?")
      .run(dir, new Date().toISOString(), id);
  }

  setGoalDir(id: string, dir: string): void {
    this.db.prepare("UPDATE goals SET goal_dir = ?, updated_at = ? WHERE id = ?")
      .run(dir, new Date().toISOString(), id);
  }

  setGoalPlanSummary(id: string, summary: string): void {
    this.db.prepare("UPDATE goals SET plan_summary = ?, updated_at = ? WHERE id = ?")
      .run(summary, new Date().toISOString(), id);
  }

  bumpReplans(id: string): void {
    this.db.prepare("UPDATE goals SET replans_used = replans_used + 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  insertNodes(goalId: string, nodes: NewTaskNode[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO task_nodes (goal_id, node_key, type, agent, critic, brief, depends_on, max_rounds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const n of nodes) {
      stmt.run(goalId, n.node_key, n.type, n.agent, n.critic, n.brief, JSON.stringify(n.depends_on), n.max_rounds);
    }
  }

  replaceNode(goalId: string, key: string, node: NewTaskNode): void {
    this.db.prepare("DELETE FROM task_nodes WHERE goal_id = ? AND node_key = ?").run(goalId, key);
    this.insertNodes(goalId, [node]);
  }

  listNodes(goalId: string): TaskNodeRow[] {
    return this.db.prepare("SELECT * FROM task_nodes WHERE goal_id = ? ORDER BY rowid ASC")
      .all(goalId) as unknown as TaskNodeRow[];
  }

  updateNodeStatus(goalId: string, key: string, status: NodeStatus, error?: string): void {
    const now = new Date().toISOString();
    const stamps =
      status === "running" ? ", started_at = ?" :
      status === "done" || status === "failed" || status === "skipped" ? ", finished_at = ?" : "";
    const sql = `UPDATE task_nodes SET status = ?, error = ?${stamps} WHERE goal_id = ? AND node_key = ?`;
    const args: SQLInputValue[] = stamps ? [status, error ?? null, now, goalId, key] : [status, error ?? null, goalId, key];
    this.db.prepare(sql).run(...args);
  }

  addNodeCost(goalId: string, key: string, cents: number): void {
    this.db.prepare("UPDATE task_nodes SET cost_cents = cost_cents + ? WHERE goal_id = ? AND node_key = ?")
      .run(cents, goalId, key);
  }

  setNodeArtifact(goalId: string, key: string, file: string): void {
    this.db.prepare("UPDATE task_nodes SET artifact = ? WHERE goal_id = ? AND node_key = ?").run(file, goalId, key);
  }

  setNodeRounds(goalId: string, key: string, rounds: number): void {
    this.db.prepare("UPDATE task_nodes SET rounds_used = ? WHERE goal_id = ? AND node_key = ?").run(rounds, goalId, key);
  }

  skipUnfinishedNodes(goalId: string): void {
    this.db.prepare(
      "UPDATE task_nodes SET status = 'skipped', finished_at = ? WHERE goal_id = ? AND status IN ('pending','ready')",
    ).run(new Date().toISOString(), goalId);
  }

  /** Startup-only sweep: re-run nodes orphaned mid-flight by a daemon restart. */
  resetRunningNodes(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT goal_id FROM task_nodes WHERE status = 'running'")
      .all() as unknown as Array<{ goal_id: string }>;
    this.db.prepare("UPDATE task_nodes SET status = 'pending', started_at = NULL WHERE status = 'running'").run();
    return rows.map((r) => r.goal_id);
  }

  budgetAdd(date: string, cents: number): void {
    this.db.prepare(
      `INSERT INTO budget_ledger (date, spent_cents) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET spent_cents = spent_cents + excluded.spent_cents`,
    ).run(date, cents);
  }

  budgetSpentCents(date: string): number {
    const r = this.db.prepare("SELECT spent_cents FROM budget_ledger WHERE date = ?").get(date) as
      | { spent_cents: number } | undefined;
    return r?.spent_cents ?? 0;
  }
```

In `src/events.ts`, add the three new union members after `route.decision` and extend `via` with `"plan"` (exact lines in **Interfaces**).

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/goal-store.test.ts && npx tsc --noEmit`
Expected: 7 pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts src/events.ts test/goal-store.test.ts
git commit -m "feat(store): goals, task_nodes, budget_ledger tables + goal/node events"
```

---

### Task 2: Playbook → graph compiler

**Files:**
- Create: `src/engine/compile.ts`
- Test: `test/compile.test.ts`

**Interfaces:**
- Consumes: `Playbook`/`Stage` from `src/engine/playbook.js`; `NewTaskNode` from `src/store/db.js`.
- Produces:

```typescript
export interface GraphNodeSpec {
  key: string; type: "run" | "loop" | "verify"; agent: string;
  critic?: string; brief: string; deps: string[]; maxRounds?: number;
}
export function compilePlaybook(pb: Playbook): GraphNodeSpec[];
export function toNewTaskNodes(nodes: GraphNodeSpec[]): NewTaskNode[];
```

`maxRounds` defaults: run→1, loop→3, verify→2 (applied in `toNewTaskNodes` when unset).

- [ ] **Step 1: Write the failing test**

```typescript
// test/compile.test.ts
import { describe, it, expect } from "vitest";
import { compilePlaybook, toNewTaskNodes } from "../src/engine/compile.js";
import type { Playbook } from "../src/engine/playbook.js";

const PB: Playbook = {
  name: "code-build", description: "build", needsProjectDir: false,
  stages: [
    { type: "single", id: "research", role: "odin", brief: "research it" },
    { type: "loop", id: "implement", producer: "vulcan", critic: "minos", maxRounds: 3, brief: "build it" },
    { type: "verify", id: "test", runner: "argus", fixer: "vulcan", maxRounds: 2 },
  ],
};

describe("compilePlaybook", () => {
  it("maps stages to a linear node chain", () => {
    const nodes = compilePlaybook(PB);
    expect(nodes).toEqual([
      { key: "research", type: "run", agent: "odin", brief: "research it", deps: [], maxRounds: 1 },
      { key: "implement", type: "loop", agent: "vulcan", critic: "minos", brief: "build it", deps: ["research"], maxRounds: 3 },
      { key: "test", type: "verify", agent: "argus", critic: "vulcan", brief: "", deps: ["implement"], maxRounds: 2 },
    ]);
  });

  it("toNewTaskNodes fills defaults and serializes deps", () => {
    const rows = toNewTaskNodes([{ key: "a", type: "loop", agent: "vulcan", critic: "minos", brief: "x", deps: [] }]);
    expect(rows[0]).toEqual({ node_key: "a", type: "loop", agent: "vulcan", critic: "minos", brief: "x", depends_on: [], max_rounds: 3 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compile.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement `src/engine/compile.ts`**

```typescript
// src/engine/compile.ts — playbook YAML (SOP format, untouched on disk) → graph nodes.
import type { Playbook, Stage } from "./playbook.js";
import type { NewTaskNode } from "../store/db.js";

export interface GraphNodeSpec {
  key: string;
  type: "run" | "loop" | "verify";
  agent: string;
  critic?: string;
  brief: string;
  deps: string[];
  maxRounds?: number;
}

const DEFAULT_ROUNDS: Record<GraphNodeSpec["type"], number> = { run: 1, loop: 3, verify: 2 };

function stageToNode(stage: Stage, deps: string[]): GraphNodeSpec {
  switch (stage.type) {
    case "single":
      return { key: stage.id, type: "run", agent: stage.role, brief: stage.brief ?? "", deps, maxRounds: 1 };
    case "loop":
      return { key: stage.id, type: "loop", agent: stage.producer, critic: stage.critic, brief: stage.brief ?? "", deps, maxRounds: stage.maxRounds };
    case "verify":
      return { key: stage.id, type: "verify", agent: stage.runner, critic: stage.fixer, brief: stage.brief ?? "", deps, maxRounds: stage.maxRounds };
  }
}

/** Linear chain: stage N depends on stage N-1 — the degenerate DAG with identical semantics. */
export function compilePlaybook(pb: Playbook): GraphNodeSpec[] {
  const out: GraphNodeSpec[] = [];
  for (const [i, stage] of pb.stages.entries()) {
    out.push(stageToNode(stage, i === 0 ? [] : [pb.stages[i - 1].id]));
  }
  return out;
}

export function toNewTaskNodes(nodes: GraphNodeSpec[]): NewTaskNode[] {
  return nodes.map((n) => ({
    node_key: n.key, type: n.type, agent: n.agent, critic: n.critic ?? null,
    brief: n.brief, depends_on: n.deps, max_rounds: n.maxRounds ?? DEFAULT_ROUNDS[n.type],
  }));
}
```

- [ ] **Step 4: Run + typecheck** — `npx vitest run test/compile.test.ts && npx tsc --noEmit` → 2 pass, clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/compile.ts test/compile.test.ts
git commit -m "feat(engine): playbook-to-graph compiler"
```

---

### Task 3: Graph validation (fail-closed)

**Files:**
- Create: `src/engine/plan.ts` (validation half; planner half arrives in Task 7)
- Test: `test/validate-graph.test.ts`

**Interfaces:**
- Consumes: `GraphNodeSpec` (Task 2), `LoadedRegistry`, `isPrivateOrigin` from `src/agents/direct.js`.
- Produces:

```typescript
export interface ValidateCtx {
  registry: LoadedRegistry;
  department: string;
  origin: { channel: string; chatId: string };
  primaryChat?: { channel: string; chatId: string };
}
export type ValidateResult = { ok: true; order: string[] } | { ok: false; error: string };
export function validateGraph(nodes: GraphNodeSpec[], ctx: ValidateCtx): ValidateResult;
export const MAX_NODES = 12;
```

Rules (spec §4, exact): 1–12 nodes; keys match `/^[a-z][a-z0-9-]*$/` and unique; every dep references an existing key; Kahn topo-sort succeeds (order returned); every `agent`/`critic` canonicalizes (`registry.agentOf`) to an agent whose `department === ctx.department` (hermes/operations therefore excluded from other depts' plans by the same rule); `loop` → critic present with manifest `outputSchema === "verdict"`; `verify` → critic present AND agent manifest `outputSchema === "test-report"`; every referenced agent with `visibility === "private"` requires `isPrivateOrigin(ctx.primaryChat, origin.channel, origin.chatId)` (fail-closed: primaryChat unset → refuse).

- [ ] **Step 1: Write the failing test**

```typescript
// test/validate-graph.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { validateGraph } from "../src/engine/plan.js";
import type { GraphNodeSpec } from "../src/engine/compile.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "vg-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  const fin = join(agentsDir, "finance");
  mkdirSync(eng, { recursive: true });
  mkdirSync(fin, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  const agent = (name: string, extra = "") =>
    `name: ${name}\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n${extra}`;
  writeFileSync(join(eng, "athena.yaml"), agent("athena"));
  writeFileSync(join(eng, "vulcan.yaml"), agent("vulcan", "aliases: [developer]\n"));
  writeFileSync(join(eng, "argus.yaml"), agent("argus", "outputSchema: test-report\n"));
  writeFileSync(join(eng, "themis.yaml"), agent("themis")); // free-text reviewer — NOT a valid loop critic
  writeFileSync(join(fin, "department.yaml"),
    "department: finance\nmission: Money.\nlead: midas\nmemoDomain: money\nplaybooks: []\nprivateMemo: true\n");
  writeFileSync(join(fin, "midas.yaml"),
    "name: midas\ntitle: CFO\ndepartment: finance\ncharter: c.\npersona: p.\nprompt: x.\ntools: []\nvisibility: private\n");
  // verdict critic in engineering for loop tests
  writeFileSync(join(eng, "minos-eng.yaml"), agent("minos-eng", "outputSchema: verdict\n"));
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();
const PRIMARY = { channel: "telegram", chatId: "1" };
const ctx = (over = {}) => ({
  registry, department: "engineering",
  origin: { channel: "telegram", chatId: "1" }, primaryChat: PRIMARY, ...over,
});
const run = (key: string, deps: string[] = [], agent = "vulcan"): GraphNodeSpec =>
  ({ key, type: "run", agent, brief: "b", deps });

describe("validateGraph", () => {
  it("accepts a valid DAG and returns topological order", () => {
    const r = validateGraph([run("a"), run("b", ["a"]), run("c", ["a"])], ctx());
    expect(r).toEqual({ ok: true, order: ["a", "b", "c"] });
  });

  it("rejects cycles", () => {
    const r = validateGraph([run("a", ["b"]), run("b", ["a"])], ctx());
    expect(r.ok).toBe(false);
  });

  it("rejects unknown dep, dup key, bad key, node cap", () => {
    expect(validateGraph([run("a", ["nope"])], ctx()).ok).toBe(false);
    expect(validateGraph([run("a"), run("a")], ctx()).ok).toBe(false);
    expect(validateGraph([run("BadKey")], ctx()).ok).toBe(false);
    const many = Array.from({ length: 13 }, (_, i) => run(`n${i}`));
    expect(validateGraph(many, ctx()).ok).toBe(false);
  });

  it("rejects foreign-department agents; aliases canonicalize", () => {
    expect(validateGraph([run("a", [], "midas")], ctx()).ok).toBe(false);
    expect(validateGraph([run("a", [], "developer")], ctx()).ok).toBe(true);
  });

  it("loop needs a verdict critic; verify needs a test-report runner + fixer", () => {
    const loopOk: GraphNodeSpec = { key: "l", type: "loop", agent: "vulcan", critic: "minos-eng", brief: "b", deps: [] };
    const loopBad: GraphNodeSpec = { key: "l", type: "loop", agent: "vulcan", critic: "themis", brief: "b", deps: [] };
    const verifyOk: GraphNodeSpec = { key: "v", type: "verify", agent: "argus", critic: "vulcan", brief: "b", deps: [] };
    const verifyBadRunner: GraphNodeSpec = { key: "v", type: "verify", agent: "vulcan", critic: "vulcan", brief: "b", deps: [] };
    const verifyNoFixer: GraphNodeSpec = { key: "v", type: "verify", agent: "argus", brief: "b", deps: [] };
    expect(validateGraph([loopOk], ctx()).ok).toBe(true);
    expect(validateGraph([loopBad], ctx()).ok).toBe(false);
    expect(validateGraph([verifyOk], ctx()).ok).toBe(true);
    expect(validateGraph([verifyBadRunner], ctx()).ok).toBe(false);
    expect(validateGraph([verifyNoFixer], ctx()).ok).toBe(false);
  });

  it("private agents require a private origin, fail-closed", () => {
    const fin = ctx({ department: "finance" });
    expect(validateGraph([run("a", [], "midas")], fin).ok).toBe(true); // origin IS primary
    const finGroup = ctx({ department: "finance", origin: { channel: "telegram", chatId: "999" } });
    expect(validateGraph([run("a", [], "midas")], finGroup).ok).toBe(false);
    const noPrimary = ctx({ department: "finance", primaryChat: undefined });
    expect(validateGraph([run("a", [], "midas")], noPrimary).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run test/validate-graph.test.ts` → module not found.

- [ ] **Step 3: Implement `src/engine/plan.ts` (validation half)**

```typescript
// src/engine/plan.ts — graph validation (fail-closed) + lead planner (Task 7).
import type { LoadedRegistry } from "../agents/registry/loader.js";
import { isPrivateOrigin } from "../agents/direct.js";
import type { GraphNodeSpec } from "./compile.js";

export const MAX_NODES = 12;
const KEY_RE = /^[a-z][a-z0-9-]*$/;

export interface ValidateCtx {
  registry: LoadedRegistry;
  department: string;
  origin: { channel: string; chatId: string };
  primaryChat?: { channel: string; chatId: string };
}
export type ValidateResult = { ok: true; order: string[] } | { ok: false; error: string };

function agentCheck(name: string, role: "agent" | "critic", node: string, ctx: ValidateCtx): string | null {
  const canonical = ctx.registry.agentOf.get(name);
  const def = canonical ? ctx.registry.agents.get(canonical) : undefined;
  if (!def) return `node ${node}: unknown ${role} "${name}"`;
  if (def.department !== ctx.department) {
    return `node ${node}: ${role} "${name}" is in ${def.department}, not ${ctx.department} (single-department goals)`;
  }
  if (def.manifest.visibility === "private" &&
      !isPrivateOrigin(ctx.primaryChat, ctx.origin.channel, ctx.origin.chatId)) {
    return `node ${node}: ${role} "${name}" is private and this goal's origin is not the private chat`;
  }
  return null;
}

function schemaOf(name: string, reg: LoadedRegistry): string | undefined {
  const canonical = reg.agentOf.get(name);
  return canonical ? reg.agents.get(canonical)?.manifest.outputSchema : undefined;
}

export function validateGraph(nodes: GraphNodeSpec[], ctx: ValidateCtx): ValidateResult {
  if (nodes.length === 0) return { ok: false, error: "plan has no nodes" };
  if (nodes.length > MAX_NODES) return { ok: false, error: `plan has ${nodes.length} nodes (cap ${MAX_NODES})` };

  const keys = new Set<string>();
  for (const n of nodes) {
    if (!KEY_RE.test(n.key)) return { ok: false, error: `bad node key "${n.key}" (lowercase kebab)` };
    if (keys.has(n.key)) return { ok: false, error: `duplicate node key "${n.key}"` };
    keys.add(n.key);
  }
  for (const n of nodes) {
    for (const d of n.deps) if (!keys.has(d)) return { ok: false, error: `node ${n.key}: unknown dep "${d}"` };
    const err = agentCheck(n.agent, "agent", n.key, ctx) ??
      (n.critic ? agentCheck(n.critic, "critic", n.key, ctx) : null);
    if (err) return { ok: false, error: err };
    if (n.type === "loop") {
      if (!n.critic) return { ok: false, error: `node ${n.key}: loop needs a critic` };
      if (schemaOf(n.critic, ctx.registry) !== "verdict") {
        return { ok: false, error: `node ${n.key}: loop critic "${n.critic}" must carry outputSchema: verdict` };
      }
    }
    if (n.type === "verify") {
      if (!n.critic) return { ok: false, error: `node ${n.key}: verify needs a fixer (critic field)` };
      if (schemaOf(n.agent, ctx.registry) !== "test-report") {
        return { ok: false, error: `node ${n.key}: verify runner "${n.agent}" must carry outputSchema: test-report` };
      }
    }
  }

  // Kahn topological sort — preserves input order among ready nodes for stable output.
  const indegree = new Map(nodes.map((n) => [n.key, n.deps.length]));
  const order: string[] = [];
  while (order.length < nodes.length) {
    const next = nodes.find((n) => indegree.get(n.key) === 0 && !order.includes(n.key));
    if (!next) return { ok: false, error: "plan has a dependency cycle" };
    order.push(next.key);
    for (const n of nodes) if (n.deps.includes(next.key)) indegree.set(n.key, indegree.get(n.key)! - 1);
  }
  return { ok: true, order };
}
```

- [ ] **Step 4: Run + typecheck** — `npx vitest run test/validate-graph.test.ts && npx tsc --noEmit` → 6 pass, clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/plan.ts test/validate-graph.test.ts
git commit -m "feat(engine): fail-closed graph validation (dept membership, critics, privacy, cycles)"
```

---

### Task 4: SpendGuard + budget config

**Files:**
- Create: `src/engine/budget.ts`
- Modify: `src/config.ts` (two knobs)
- Test: `test/spend-guard.test.ts`

**Interfaces:**
- Consumes: `Store.budgetAdd/budgetSpentCents` (Task 1), `EventBus`.
- Produces:

```typescript
export interface SpendGuardDeps {
  store: Store;
  /** Dollars; undefined = unlimited (current behavior). */
  capUsd?: number;
  todayFn?: () => string; // injectable, defaults to local date via localParts
}
export class SpendGuard {
  constructor(deps: SpendGuardDeps);
  allow(): boolean;                    // true when no cap or under cap
  spentCents(today?: string): number;
  capCents(): number | null;
}
export function attachBudgetLedger(bus: EventBus, store: Store, todayFn?: () => string): () => void;
```

- Config: `dailyBudgetUsd?: number` from `AIOS_DAILY_BUDGET_USD` (unset/empty → undefined); `maxConcurrentNodes: number` from `AIOS_MAX_CONCURRENT_NODES ?? 2`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/spend-guard.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { SpendGuard, attachBudgetLedger } from "../src/engine/budget.js";

describe("SpendGuard", () => {
  it("no cap → always allow", () => {
    const store = new Store(":memory:");
    expect(new SpendGuard({ store }).allow()).toBe(true);
  });

  it("allows under cap, refuses at/over cap", () => {
    const store = new Store(":memory:");
    const g = new SpendGuard({ store, capUsd: 1, todayFn: () => "2026-07-02" });
    store.budgetAdd("2026-07-02", 99);
    expect(g.allow()).toBe(true);
    store.budgetAdd("2026-07-02", 1); // exactly 100 cents = $1
    expect(g.allow()).toBe(false);
    expect(g.capCents()).toBe(100);
  });

  it("ledger listener accumulates agent.end costUsd as integer cents", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    attachBudgetLedger(bus, store, () => "2026-07-02");
    bus.emit({ type: "agent.end", agent: "vulcan", context: "chat:web:ui", ok: true, costUsd: 0.123 });
    bus.emit({ type: "agent.end", agent: "vulcan", context: "chat:web:ui", ok: true }); // no cost — ignored
    bus.emit({ type: "agent.end", agent: "juno", context: "chat:t:1", ok: true, costUsd: 0.011 });
    expect(store.budgetSpentCents("2026-07-02")).toBe(13); // round(12.3) + round(1.1)
  });
});
```

- [ ] **Step 2: Run to verify fail** — module not found.

- [ ] **Step 3: Implement `src/engine/budget.ts`**

```typescript
// src/engine/budget.ts — daily global spend ledger + background-work gate (spec §6).
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import { localParts } from "../heartbeat/clock.js";

const today = () => localParts(new Date()).date;

export interface SpendGuardDeps {
  store: Store;
  capUsd?: number;
  todayFn?: () => string;
}

export class SpendGuard {
  constructor(private deps: SpendGuardDeps) {}

  capCents(): number | null {
    return this.deps.capUsd == null ? null : Math.round(this.deps.capUsd * 100);
  }

  spentCents(date = (this.deps.todayFn ?? today)()): number {
    return this.deps.store.budgetSpentCents(date);
  }

  /** Consulted before SCHEDULING background work (nodes, dream, speculate). Never kills mid-flight. */
  allow(): boolean {
    const cap = this.capCents();
    return cap == null || this.spentCents() < cap;
  }
}

/** Every agent run lands in the ledger (chat included — the ledger is the truth of spend);
 *  only enforcement distinguishes background from chat. Returns the unsubscribe fn. */
export function attachBudgetLedger(bus: EventBus, store: Store, todayFn = today): () => void {
  return bus.on((e) => {
    if (e.event.type !== "agent.end" || !e.event.costUsd) return;
    store.budgetAdd(todayFn(), Math.round(e.event.costUsd * 100));
  });
}
```

In `src/config.ts`: add to the Config interface `dailyBudgetUsd?: number;` and `maxConcurrentNodes: number;` and in the loader (next to `maxConcurrentJobs`):

```typescript
    dailyBudgetUsd: env.AIOS_DAILY_BUDGET_USD ? Number(env.AIOS_DAILY_BUDGET_USD) : undefined,
    maxConcurrentNodes: Number(env.AIOS_MAX_CONCURRENT_NODES ?? 2),
```

- [ ] **Step 4: Run + typecheck** — `npx vitest run test/spend-guard.test.ts && npx tsc --noEmit` → 3 pass, clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/budget.ts src/config.ts test/spend-guard.test.ts
git commit -m "feat(engine): SpendGuard daily budget ledger + config knobs"
```

---

### Task 5: Node runner — run/loop/verify semantics (parity port)

**Files:**
- Create: `src/engine/goals.ts` (node-runner half; scheduler half in Task 6)
- Modify: `src/vault/writer.ts` (goal artifact methods)
- Test: `test/goal-runner.test.ts`

This task PORTS `src/engine/executor.ts`'s `runStage`/`runAgent`/`contextBlock` semantics onto nodes. The old executor stays alive until Task 9 — its tests are the behavioral baseline.

**Interfaces:**
- Consumes: `SpecialistRunFn`, `Store` node methods (Task 1), `VaultWriter`, `ResolvedPack`.
- Produces (Task 6 builds on these):

```typescript
export class SessionLimitError extends Error {}           // moved here from executor.ts (re-exported there until Task 9)
export interface NodeRunDeps {
  store: Store; vault: VaultWriter; run: SpecialistRunFn;
  model?: string; log?: (l: string) => void;
  onEvent?: (e: AiosEvent) => void;
  resolvePack: (node: TaskNodeRow, goal: GoalRow) => ResolvedPack | undefined;
}
/** Runs one node to completion (all rounds). Throws on hard failure. */
export async function runNode(goal: GoalRow, node: TaskNodeRow, deps: NodeRunDeps): Promise<void>;
export function ancestorArtifacts(nodes: TaskNodeRow[], key: string): TaskNodeRow[]; // transitive deps, done, with artifact
```

- VaultWriter additions: `goalDirName(slug): string` (`<today>-<slug>`, goals root), `writeGoalArtifact(goalDirName, fileName, content, frontmatter?)`, `readGoalArtifact(goalDirName, fileName): string | undefined` — exact mirrors of the job trio with `"goals"` instead of `"jobs"` in the path (same `assertContained` traversal guards).

Semantics (byte-faithful port from executor.ts:191-273, adapted node-shaped):
- Context block: `# Task\n<goal.request>` + `# Working directory\n<goal.project_dir>` (when set) + one `# Prior artifact: <file> (by <agent>)` section per ancestor artifact (transitive deps only — parallel siblings are NOT included), each truncated at 12 000 chars.
- `run`: brief + context → agent → artifact `<key>.md`.
- `loop`: up to max_rounds of producer (with reviewer feedback + previous version) → critic (structured Verdict); approve breaks; artifacts `<key>-v<r>.md` / `<key>-review-<r>.md`; final `<key>.md` with cap-warning note when unapproved; `rounds_used` recorded.
- `verify`: up to max_rounds of runner (structured TestReport) → break when passed or no report; fixer between failing rounds; artifacts `<key>-run-<r>.md` / `<key>-fix-<r>.md`; final `<key>.md` summary; still-failing is surfaced-not-thrown.
- Agent telemetry: `agent.start`/`agent.end` with context `` `goal:${goal.slug}/${node.node_key}` ``, costUsd/turns on success; session-limit text converts to `SessionLimitError` (never retried).
- Retry-once: `runNode` retries the whole node once on non-SessionLimit errors (port of `runStageWithRetry`).
- Cost: every agent run's `costUsd` → `store.addNodeCost(goal.id, key, Math.round(costUsd*100))`.
- Node artifact recorded via `store.setNodeArtifact` (`<key>.md`).

- [ ] **Step 1: Write the failing test**

```typescript
// test/goal-runner.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type GoalRow } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { runNode, ancestorArtifacts, SessionLimitError } from "../src/engine/goals.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";

function harness(run: SpecialistRunFn) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "gr-vault-")));
  store.insertGoal({
    id: "g1", slug: "build-x", title: "Build X", request: "build x",
    department: "engineering", lead: "athena", origin_channel: "telegram", origin_chat_id: "1",
    status: "running", project_dir: null, goal_dir: vault.goalDirName("build-x"),
    plan_summary: "", replans_used: 0, error: null,
  });
  store.setGoalDir("g1", vault.goalDirName("build-x"));
  const events: string[] = [];
  const deps = {
    store, vault, run,
    onEvent: (e: { type: string }) => events.push(e.type),
    resolvePack: () => undefined,
  };
  return { store, vault, deps, events, goal: () => store.getGoal("g1")! };
}

const NODE = (over: Record<string, unknown> = {}) => ({
  goal_id: "g1", node_key: "design", type: "run" as const, agent: "athena", critic: null,
  brief: "design it", depends_on: "[]", max_rounds: 1, status: "ready" as const,
  artifact: null, cost_cents: 0, rounds_used: 0, error: null, started_at: null, finished_at: null, ...over,
});

describe("runNode", () => {
  it("run node: brief+context to agent, artifact written, cost recorded", async () => {
    const briefs: string[] = [];
    const { store, vault, deps, goal } = harness(async (_r, brief) => {
      briefs.push(brief);
      return { text: "the design", costUsd: 0.05, numTurns: 2 };
    });
    store.insertNodes("g1", [{ node_key: "design", type: "run", agent: "athena", critic: null, brief: "design it", depends_on: [], max_rounds: 1 }]);
    await runNode(goal(), store.listNodes("g1")[0], deps);
    expect(briefs[0]).toContain("design it");
    expect(briefs[0]).toContain("# Task\nbuild x");
    expect(vault.readGoalArtifact(goal().goal_dir!, "design.md")).toContain("the design");
    const n = store.listNodes("g1")[0];
    expect(n.cost_cents).toBe(5);
    expect(n.artifact).toBe("design.md");
  });

  it("loop node: revise then approve, artifacts per round, rounds_used set", async () => {
    let call = 0;
    const { store, deps, goal, vault } = harness(async (role) => {
      call++;
      if (role === "minos-eng") {
        const verdict = call === 2
          ? { verdict: "revise", summary: "needs work", reasons: ["r1"] }
          : { verdict: "approve", summary: "good", reasons: [] };
        return { text: "review", structured: verdict, costUsd: 0.01, numTurns: 1 };
      }
      return { text: `v${call}`, costUsd: 0.01, numTurns: 1 };
    });
    store.insertNodes("g1", [{ node_key: "impl", type: "loop", agent: "vulcan", critic: "minos-eng", brief: "build", depends_on: [], max_rounds: 3 }]);
    await runNode(goal(), store.listNodes("g1")[0], deps);
    const n = store.listNodes("g1")[0];
    expect(n.rounds_used).toBe(2);
    expect(vault.readGoalArtifact(goal().goal_dir!, "impl-v1.md")).toBeTruthy();
    expect(vault.readGoalArtifact(goal().goal_dir!, "impl-review-2.md")).toContain("approve");
    expect(vault.readGoalArtifact(goal().goal_dir!, "impl.md")).not.toContain("Loop cap reached");
  });

  it("verify node: failing report triggers fixer, passing stops", async () => {
    let runnerCalls = 0;
    const roles: string[] = [];
    const { store, deps, goal } = harness(async (role) => {
      roles.push(role);
      if (role === "argus") {
        runnerCalls++;
        return {
          text: "report",
          structured: { passed: runnerCalls > 1, summary: "s", failures: runnerCalls > 1 ? [] : ["f1"] },
          costUsd: 0.01, numTurns: 1,
        };
      }
      return { text: "fixed", costUsd: 0.01, numTurns: 1 };
    });
    store.insertNodes("g1", [{ node_key: "test", type: "verify", agent: "argus", critic: "vulcan", brief: "test it", depends_on: [], max_rounds: 3 }]);
    await runNode(goal(), store.listNodes("g1")[0], deps);
    expect(roles).toEqual(["argus", "vulcan", "argus"]);
  });

  it("session-limit output becomes SessionLimitError, not retried", async () => {
    let calls = 0;
    const { store, deps, goal } = harness(async () => {
      calls++;
      return { text: "You've hit your session limit — resets at 3pm", costUsd: 0, numTurns: 1 };
    });
    store.insertNodes("g1", [{ node_key: "design", type: "run", agent: "athena", critic: null, brief: "b", depends_on: [], max_rounds: 1 }]);
    await expect(runNode(goal(), store.listNodes("g1")[0], deps)).rejects.toBeInstanceOf(SessionLimitError);
    expect(calls).toBe(1);
  });

  it("non-limit failure retries once", async () => {
    let calls = 0;
    const { store, deps, goal } = harness(async () => {
      calls++;
      if (calls === 1) throw new Error("flake");
      return { text: "ok", costUsd: 0.01, numTurns: 1 };
    });
    store.insertNodes("g1", [{ node_key: "design", type: "run", agent: "athena", critic: null, brief: "b", depends_on: [], max_rounds: 1 }]);
    await runNode(goal(), store.listNodes("g1")[0], deps);
    expect(calls).toBe(2);
  });

  it("ancestorArtifacts: transitive deps only, done+artifact only", () => {
    const { store } = harness(async () => ({ text: "", costUsd: 0, numTurns: 0 }));
    store.insertNodes("g1", [
      { node_key: "a", type: "run", agent: "x", critic: null, brief: "", depends_on: [], max_rounds: 1 },
      { node_key: "b", type: "run", agent: "x", critic: null, brief: "", depends_on: ["a"], max_rounds: 1 },
      { node_key: "sib", type: "run", agent: "x", critic: null, brief: "", depends_on: ["a"], max_rounds: 1 },
      { node_key: "c", type: "run", agent: "x", critic: null, brief: "", depends_on: ["b"], max_rounds: 1 },
    ]);
    store.updateNodeStatus("g1", "a", "done"); store.setNodeArtifact("g1", "a", "a.md");
    store.updateNodeStatus("g1", "b", "done"); store.setNodeArtifact("g1", "b", "b.md");
    store.updateNodeStatus("g1", "sib", "done"); store.setNodeArtifact("g1", "sib", "sib.md");
    const anc = ancestorArtifacts(store.listNodes("g1"), "c").map((n) => n.node_key);
    expect(anc.sort()).toEqual(["a", "b"]); // sibling excluded
  });
});
```

- [ ] **Step 2: Run to verify fail** — module/exports not found.

- [ ] **Step 3: Implement**

In `src/vault/writer.ts`, next to the job trio, add (mirror the bodies of `jobDirName`/`jobDir`/`writeJobArtifact`/`readJobArtifact` with `"goals"` as the root segment):

```typescript
  goalDirName(slug: string): string { return `${today()}-${slug}`; }

  private goalDir(goalDirName: string): string {
    const dir = join(this.root, "goals", goalDirName);
    this.assertContained(resolve(dir), goalDirName);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeGoalArtifact(goalDirName: string, fileName: string, content: string,
                    frontmatter: Record<string, string | number | boolean> = {}): string {
    const dir = this.goalDir(goalDirName);
    const fm = Object.entries({ created: new Date().toISOString(), ...frontmatter })
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
    const path = join(dir, fileName);
    this.assertContained(resolve(path), fileName);
    writeFileSync(path, `---\n${fm}\n---\n\n${content}\n`);
    return path;
  }

  readGoalArtifact(goalDirName: string, fileName: string): string | undefined {
    const path = join(this.root, "goals", goalDirName, fileName);
    this.assertContained(resolve(path), fileName);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }
```

Create `src/engine/goals.ts` (node-runner half — the file grows the scheduler in Task 6):

```typescript
// src/engine/goals.ts — the unified GoalEngine: node runner (this half) + scheduler (Task 6).
import type { Store, GoalRow, TaskNodeRow } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { SpecialistRunFn } from "../agents/runner.js";
import type { ResolvedPack } from "../packs/resolve.js";
import type { AiosEvent } from "../events.js";

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

export interface NodeRunDeps {
  store: Store;
  vault: VaultWriter;
  run: SpecialistRunFn;
  model?: string;
  log?: (l: string) => void;
  onEvent?: (e: AiosEvent) => void;
  resolvePack: (node: TaskNodeRow, goal: GoalRow) => ResolvedPack | undefined;
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

async function runAgent(
  goal: GoalRow, node: TaskNodeRow, role: string, brief: string, deps: NodeRunDeps,
) {
  const context = `goal:${goal.slug}/${node.node_key}`;
  deps.onEvent?.({ type: "agent.start", agent: role, context });
  try {
    const res = await deps.run(role, brief, {
      cwd: goal.project_dir ?? process.cwd(),
      model: deps.model,
      pack: deps.resolvePack(node, goal),
    });
    if (isSessionLimitOutput(res.text)) {
      deps.onEvent?.({ type: "agent.end", agent: role, context, ok: false });
      throw new SessionLimitError("Agent hit session limit — re-run after quota resets");
    }
    deps.onEvent?.({ type: "agent.end", agent: role, context, ok: true, costUsd: res.costUsd, turns: res.numTurns });
    if (res.costUsd) deps.store.addNodeCost(goal.id, node.node_key, Math.round(res.costUsd * 100));
    return res;
  } catch (err) {
    if (!(err instanceof SessionLimitError)) {
      deps.onEvent?.({ type: "agent.end", agent: role, context, ok: false });
    }
    throw err;
  }
}

function save(goal: GoalRow, node: TaskNodeRow, deps: NodeRunDeps, role: string, file: string, content: string): void {
  deps.vault.writeGoalArtifact(goal.goal_dir!, file, content, { goal: goal.id, node: node.node_key, role });
}

function finalArtifact(goal: GoalRow, node: TaskNodeRow, deps: NodeRunDeps, role: string, content: string): void {
  const file = `${node.node_key}.md`;
  save(goal, node, deps, role, file, content);
  deps.store.setNodeArtifact(goal.id, node.node_key, file);
}

async function runOnce(goal: GoalRow, node: TaskNodeRow, deps: NodeRunDeps): Promise<void> {
  const { store, vault } = deps;
  const ctx = contextBlock(goal, ancestorArtifacts(store.listNodes(goal.id), node.node_key), vault);
  const mkdirCwd = () => goal.project_dir; // cwd creation handled by makeRunSpecialist path via runner cwd; project dirs are pre-created at goal start (Task 6)
  void mkdirCwd;

  switch (node.type) {
    case "run": {
      const brief = [node.brief, ctx].filter(Boolean).join("\n\n");
      const res = await runAgent(goal, node, node.agent, brief, deps);
      finalArtifact(goal, node, deps, node.agent, res.text);
      return;
    }
    case "loop": {
      let feedback = "";
      let lastOutput = "";
      let approved = false;
      let rounds = 0;
      for (let round = 1; round <= node.max_rounds; round++) {
        rounds = round;
        const producerBrief = [
          node.brief, ctx,
          feedback ? `# Reviewer feedback (round ${round - 1}) — address every point\n${feedback}` : "",
          lastOutput ? `# Your previous version\n${truncate(lastOutput)}` : "",
        ].filter(Boolean).join("\n\n");
        const produced = await runAgent(goal, node, node.agent, producerBrief, deps);
        lastOutput = produced.text;
        save(goal, node, deps, node.agent, `${node.node_key}-v${round}.md`, produced.text);

        const criticBrief = [
          `Review the following ${node.agent} output against the original task.`,
          ctx,
          `# Output under review (round ${round})\n${truncate(produced.text)}`,
        ].join("\n\n");
        const review = await runAgent(goal, node, node.critic!, criticBrief, deps);
        const verdict = review.structured as Verdict | undefined;
        save(goal, node, deps, node.critic!, `${node.node_key}-review-${round}.md`,
          verdict ? `**Verdict:** ${verdict.verdict}\n\n${verdict.summary}\n\n${verdict.reasons.map((r) => `- ${r}`).join("\n")}` : review.text);

        if (verdict?.verdict === "approve") { approved = true; break; }
        feedback = verdict ? [verdict.summary, ...verdict.reasons].join("\n- ") : review.text;
      }
      deps.store.setNodeRounds(goal.id, node.node_key, rounds);
      const note = approved ? "" : `\n\n> [!warning] Loop cap reached (${node.max_rounds} rounds) without approval — proceeding with last version.\n`;
      finalArtifact(goal, node, deps, node.agent, lastOutput + note);
      return;
    }
    case "verify": {
      let report: TestReport | undefined;
      let rounds = 0;
      for (let round = 1; round <= node.max_rounds; round++) {
        rounds = round;
        const runnerBrief = [node.brief, ctx, "Run the verification now."].filter(Boolean).join("\n\n");
        const res = await runAgent(goal, node, node.agent, runnerBrief, deps);
        report = res.structured as TestReport | undefined;
        save(goal, node, deps, node.agent, `${node.node_key}-run-${round}.md`,
          report ? `**Passed:** ${report.passed}\n\n${report.summary}\n\n${report.failures.map((f) => `- ${f}`).join("\n")}` : res.text);

        if (!report || report.passed) break;
        if (round === node.max_rounds) break;

        const fixBrief = [
          ctx,
          `# Failing verification (round ${round}) — fix these\n${report.summary}\n${report.failures.map((f) => `- ${f}`).join("\n")}`,
        ].join("\n\n");
        const fix = await runAgent(goal, node, node.critic!, fixBrief, deps);
        save(goal, node, deps, node.critic!, `${node.node_key}-fix-${round}.md`, fix.text);
      }
      deps.store.setNodeRounds(goal.id, node.node_key, rounds);
      const summary = report
        ? `**Passed:** ${report.passed}\n\n${report.summary}${report.failures.length ? `\n\nFailures:\n${report.failures.map((f) => `- ${f}`).join("\n")}` : ""}`
        : "No structured test report produced.";
      finalArtifact(goal, node, deps, node.agent, summary);
      if (report && !report.passed) {
        deps.log?.(`node ${node.node_key}: verification still failing after ${node.max_rounds} rounds`);
      }
      return;
    }
  }
}

/** Runs one node to completion. Retries once on non-quota errors (port of runStageWithRetry). */
export async function runNode(goal: GoalRow, node: TaskNodeRow, deps: NodeRunDeps): Promise<void> {
  try {
    await runOnce(goal, node, deps);
  } catch (err) {
    if (err instanceof SessionLimitError) throw err;
    deps.log?.(`node ${node.node_key}: failed (${(err as Error).message}), retrying once`);
    await runOnce(goal, node, deps);
  }
}
```

- [ ] **Step 4: Run + typecheck** — `npx vitest run test/goal-runner.test.ts && npx tsc --noEmit` → 6 pass, clean. Also run `npx vitest run test/executor.test.ts` — old baseline still green (untouched).

- [ ] **Step 5: Commit**

```bash
git add src/engine/goals.ts src/vault/writer.ts test/goal-runner.test.ts
git commit -m "feat(engine): node runner — run/loop/verify semantics ported from executor"
```

---

### Task 6: GoalEngine scheduler — pump, parallelism, budget, lifecycle

**Files:**
- Modify: `src/engine/goals.ts` (append scheduler)
- Modify: `src/heartbeat/clock.ts` (optional `onTick` hook)
- Test: `test/goal-scheduler.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5; `compilePlaybook`/`toNewTaskNodes`; `validateGraph`; `SpendGuard`; `isUnsandboxedWrite`+`assertInplaceTarget` (imported from `src/engine/jobs.js` until Task 9 moves `isUnsandboxedWrite` into goals.ts); `slugify` from vault writer.
- Produces:

```typescript
export interface GoalOutcome { goal: GoalRow; ok: boolean; error?: string; goalDirName: string; artifactFiles: string[] }
export interface GoalEngineDeps extends Omit<NodeRunDeps, "resolvePack"> {
  registry: LoadedRegistry;
  playbooks: Map<string, Playbook>;
  wallTimeMs: number;
  maxConcurrentNodes: number;
  spendGuard: SpendGuard;
  onComplete: (o: GoalOutcome) => Promise<void>;
  /** Same resolver family as JobManager: playbook path (byAgent=false, sandbox) and agent path (byAgent=true, sandbox). */
  resolveDeptFor: (key: string, origin: {channel: string; chatId: string}, byAgent?: boolean,
                   sandbox?: { taskDir: string; mode: "build" | "analyze" }) => ResolvedPack | undefined;
  prepareSandbox?: (goal: GoalRow, opts: { playbook?: Playbook }) => Promise<{ taskDir: string; mode: "build" | "analyze" } | undefined>;
  planner?: Planner;            // Task 7; optional so facade-only tests run without it
  replanCap?: number;           // default 2
  primaryChat?: { channel: string; chatId: string };
  projectsRoot?: string; workspaceRoot?: string;
  pingBudgetPaused?: (text: string) => void;  // one Telegram ping per day (index wires sendVia)
}
export class GoalEngine {
  constructor(deps: GoalEngineDeps);
  listPlaybooks(): Array<{ name: string; description: string; pillar?: string }>;
  createFromPlaybook(params: { playbook: string; title: string; request: string; projectDir?: string;
                               channel: string; chatId: string; inplace?: boolean }): GoalRow;  // JobManager.createJob-compatible
  planGoal(params: { department: string; title: string; request: string;
                     channel: string; chatId: string }): Promise<GoalRow>;   // Task 7 fills planner; throws if planner absent
  pauseGoal(idOrSlug: string): string;    // returns human message
  resumeGoal(idOrSlug: string): string;
  abandonGoal(idOrSlug: string): string;
  resumeUnfinished(): number;             // startup: resetRunningNodes + re-pump unfinished goals
  resumeBudgetPaused(): number;           // clock tick: paused-budget → running when guard allows
}
```

Scheduler rules (spec §5–6):
- `pump()` scans `unfinishedGoals()` with status `running`; for each, nodes whose deps are all `done` and status `pending` → mark `ready`. While `runningNodes < maxConcurrentNodes` and `spendGuard.allow()`: take the oldest ready node (FIFO across goals by goal `created_at`, then node insertion order) → `running` (+`node.status` events at every transition) → `runNode` async; on settle decrement + re-pump.
- Budget: when `spendGuard.allow()` is false and a `running` goal has schedulable work → goal `paused-budget`, ping once per day (kv `budget:pinged:<date>`).
- Node success → `done`; hard failure → `failed` + goal handling: facade goal (no planner or `lead === ""`… discriminator: goals created by `createFromPlaybook` store `plan_summary: "playbook:<name>"`) → goal `failed`, skipUnfinishedNodes, onComplete(!ok). Lead-planned → `replanning` + planner.replan (Task 7); replans exhausted → `failed`.
- SessionLimitError → node `failed`, goal `paused-user` (quota won't heal by re-planning), onComplete not called (user resumes later).
- Wall time: per-goal deadline `created_at + wallTimeMs` checked before scheduling each node; exceeded → goal `failed` ("Goal wall-time budget exceeded").
- All nodes done → goal `done`, onComplete with artifact list (final `<key>.md` files in topo order).
- `resumeUnfinished()` (startup-only): `store.resetRunningNodes()`, then pump. `resumeBudgetPaused()`: if `spendGuard.allow()`, flip `paused-budget` → `running`, pump.
- Goal creation (both paths): insertGoal (status `running` for facade; `planning`→`running` for planned), `goal.created` event, goal.md artifact (mirror job.md), workspace via `prepareSandbox` when provided (facade: same engineering-only logic as today, moved to index wiring; failure → goal `failed` + onComplete), `setGoalProjectDir`, mkdir of project_dir.
- `createFromPlaybook` ports JobManager.createJob's checks verbatim: unknown playbook, needsProjectDir, unsandboxed-write inplace gate (`isUnsandboxedWrite` + `assertInplaceTarget` + projectsRoot/workspaceRoot presence).
- Pack resolution per node: facade goals → `resolveDeptFor(playbookName, origin, false, sandbox)`; planned goals → `resolveDeptFor(node.agent, origin, true, sandbox)`.
- Clock: `ClockDeps` gains optional `onTick?: () => void` invoked at the end of every `tick()` inside the try (wired to `resumeBudgetPaused` in Task 9).

- [ ] **Step 1: Write the failing test**

```typescript
// test/goal-scheduler.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { GoalEngine } from "../src/engine/goals.js";
import { SpendGuard } from "../src/engine/budget.js";
import type { Playbook } from "../src/engine/playbook.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "gs-"));
  const eng = join(root, "agents", "engineering");
  mkdirSync(eng, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  for (const n of ["athena", "vulcan", "odin"]) {
    writeFileSync(join(eng, `${n}.yaml`),
      `name: ${n}\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n`);
  }
  return loadRegistry(join(root, "agents"), join(root, "playbooks"));
}

const PB: Playbook = {
  name: "research-report", description: "r", needsProjectDir: false,
  stages: [
    { type: "single", id: "gather", role: "odin", brief: "gather" },
    { type: "single", id: "write", role: "athena", brief: "write" },
  ],
};

function harness(over: Record<string, unknown> = {}) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "gs-vault-")));
  const registry = fixtureRegistry();
  const completions: Array<{ ok: boolean }> = [];
  let resolveRun: (() => void) | null = null;
  const gate = { promise: Promise.resolve() };
  const engine = new GoalEngine({
    store, vault, registry,
    run: (over.run as never) ?? (async () => ({ text: "out", costUsd: 0.01, numTurns: 1 })),
    playbooks: new Map([[PB.name, PB]]),
    wallTimeMs: 60_000, maxConcurrentNodes: (over.maxConcurrentNodes as number) ?? 2,
    spendGuard: (over.spendGuard as SpendGuard) ?? new SpendGuard({ store }),
    onComplete: async (o) => { completions.push({ ok: o.ok }); },
    resolveDeptFor: () => undefined,
    ...over,
  });
  return { store, vault, engine, completions, registry, resolveRun, gate };
}

const flush = () => new Promise((r) => setTimeout(r, 25));

describe("GoalEngine scheduler", () => {
  it("facade goal runs compiled chain to done, notifies", async () => {
    const { engine, store, completions } = harness();
    const g = engine.createFromPlaybook({
      playbook: "research-report", title: "R", request: "r it", channel: "telegram", chatId: "1",
    });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(store.listNodes(g.id).map((n) => n.status)).toEqual(["done", "done"]);
    expect(completions).toEqual([{ ok: true }]);
  });

  it("independent nodes run in parallel up to maxConcurrentNodes", async () => {
    let inFlight = 0, peak = 0;
    const run = async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { text: "out", costUsd: 0, numTurns: 1 };
    };
    const { engine, store } = harness({ run, maxConcurrentNodes: 2 });
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    // hand-add two parallel roots to the same goal before it schedules: replace graph with a diamond
    store.skipUnfinishedNodes(g.id); // clear compiled chain
    store.insertNodes(g.id, [
      { node_key: "p1", type: "run", agent: "odin", critic: null, brief: "b", depends_on: [], max_rounds: 1 },
      { node_key: "p2", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: [], max_rounds: 1 },
      { node_key: "join", type: "run", agent: "athena", critic: null, brief: "b", depends_on: ["p1", "p2"], max_rounds: 1 },
    ]);
    engine.pump();
    await vi.waitFor(() => expect(store.listNodes(g.id).filter((n) => n.status === "done").length).toBe(3));
    expect(peak).toBe(2);
  });

  it("budget cap pauses scheduling; resumeBudgetPaused resumes", async () => {
    const store0 = new Store(":memory:");
    void store0;
    const { engine, store } = harness({
      spendGuard: undefined, // replaced below
    });
    // capUsd tiny + pre-spent: guard refuses immediately
    const guard = new SpendGuard({ store, capUsd: 0.01, todayFn: () => "2026-07-02" });
    store.budgetAdd("2026-07-02", 1); // at cap
    (engine as unknown as { deps: { spendGuard: SpendGuard } }).deps.spendGuard = guard;
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await flush();
    expect(store.getGoal(g.id)!.status).toBe("paused-budget");
    // next day: guard allows again
    (engine as unknown as { deps: { spendGuard: SpendGuard } }).deps.spendGuard =
      new SpendGuard({ store, capUsd: 0.01, todayFn: () => "2026-07-03" });
    expect(engine.resumeBudgetPaused()).toBe(1);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
  });

  it("facade node hard-failure fails the goal and skips the rest", async () => {
    const run = async (role: string) => {
      if (role === "odin") throw new Error("boom");
      return { text: "out", costUsd: 0, numTurns: 1 };
    };
    const { engine, store, completions } = harness({ run });
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(store.listNodes(g.id).map((n) => n.status)).toEqual(["failed", "skipped"]);
    expect(completions).toEqual([{ ok: false }]);
  });

  it("createFromPlaybook ports the job gates (unknown playbook, needsProjectDir)", () => {
    const { engine } = harness();
    expect(() => engine.createFromPlaybook({ playbook: "nope", title: "t", request: "r", channel: "t", chatId: "1" }))
      .toThrow(/Unknown playbook/);
  });

  it("pause/resume/abandon by slug; abandon skips unfinished", async () => {
    let release: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const run = async () => { await held; return { text: "o", costUsd: 0, numTurns: 1 }; };
    const { engine, store } = harness({ run });
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await flush();
    expect(engine.pauseGoal(g.slug)).toContain("paused");
    expect(store.getGoal(g.id)!.status).toBe("paused-user");
    expect(engine.resumeGoal(g.slug)).toContain("resumed");
    expect(engine.abandonGoal(g.slug)).toContain("abandoned");
    release!();
    await flush();
    expect(store.getGoal(g.id)!.status).toBe("abandoned");
    expect(store.listNodes(g.id).some((n) => n.status === "skipped")).toBe(true);
  });

  it("resumeUnfinished resets orphaned running nodes and re-pumps", async () => {
    const { engine, store } = harness();
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    // simulate a crash mid-run on a fresh goal
    store.insertGoal({ id: "g9", slug: "crashy", title: "C", request: "c", department: "engineering",
      lead: "athena", origin_channel: "t", origin_chat_id: "1", status: "running", project_dir: null,
      goal_dir: null, plan_summary: "playbook:research-report", replans_used: 0, error: null });
    store.insertNodes("g9", [{ node_key: "a", type: "run", agent: "odin", critic: null, brief: "b", depends_on: [], max_rounds: 1 }]);
    store.updateNodeStatus("g9", "a", "running");
    const n = engine.resumeUnfinished();
    expect(n).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => expect(store.getGoal("g9")!.status).toBe("done"));
  });
});
```

Note for the implementer: the budget test reaches into `deps` — make `deps` a plain (non-readonly) private field so tests can swap the guard; alternatively expose `setSpendGuard(g)` — pick the private-field route to keep the public surface clean, and adjust the test to match your access pattern if needed (`(engine as any).deps.spendGuard = guard` is acceptable in tests).

- [ ] **Step 2: Run to verify fail** — `GoalEngine` not exported.

- [ ] **Step 3: Implement the scheduler half of `src/engine/goals.ts`**

Append (imports merged at top: `randomUUID` from node:crypto, `mkdirSync` from node:fs, `slugify` from `../vault/writer.js`, `compilePlaybook`, `toNewTaskNodes` from `./compile.js`, `isUnsandboxedWrite` from `./jobs.js`, `assertInplaceTarget`, `resolveReal` from `../code/paths.js`, `SpendGuard` type from `./budget.js`, `LoadedRegistry`, `Playbook`, `GoalStatus`):

```typescript
export interface GoalOutcome {
  goal: GoalRow; ok: boolean; error?: string; goalDirName: string; artifactFiles: string[];
}

export interface GoalEngineDeps extends Omit<NodeRunDeps, "resolvePack"> {
  registry: LoadedRegistry;
  playbooks: Map<string, Playbook>;
  wallTimeMs: number;
  maxConcurrentNodes: number;
  spendGuard: SpendGuard;
  onComplete: (o: GoalOutcome) => Promise<void>;
  resolveDeptFor: (key: string, origin: { channel: string; chatId: string }, byAgent?: boolean,
                   sandbox?: { taskDir: string; mode: "build" | "analyze" }) => ResolvedPack | undefined;
  prepareSandbox?: (goal: GoalRow, opts: { playbook?: Playbook }) => Promise<{ taskDir: string; mode: "build" | "analyze" } | undefined>;
  planner?: Planner;   // Task 7 — declare `export interface Planner` there; until then declare locally as `unknown` placeholder type import
  replanCap?: number;
  primaryChat?: { channel: string; chatId: string };
  projectsRoot?: string;
  workspaceRoot?: string;
  pingBudgetPaused?: (text: string) => void;
}

const FACADE_PREFIX = "playbook:";

export class GoalEngine {
  private runningNodes = 0;
  private sandboxes = new Map<string, { taskDir: string; mode: "build" | "analyze" }>();

  constructor(private deps: GoalEngineDeps) {}

  listPlaybooks(): Array<{ name: string; description: string; pillar?: string }> {
    return [...this.deps.playbooks.values()].map((p) => ({
      name: p.name, description: p.description, pillar: this.deps.registry.ownerOfPlaybook.get(p.name),
    }));
  }

  private emit(e: AiosEvent): void { this.deps.onEvent?.(e); }
  private setGoalStatus(id: string, status: GoalStatus, error?: string): void {
    this.deps.store.updateGoalStatus(id, status, error);
    this.emit({ type: "goal.status", goalId: id, status, error });
  }
  private setNodeStatus(goal: GoalRow, key: string, status: NodeStatus, agent: string, error?: string): void {
    this.deps.store.updateNodeStatus(goal.id, key, status, error);
    this.emit({ type: "node.status", goalId: goal.id, nodeKey: key, status, agent, error });
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
    const goal = this.insertGoal({
      title: params.title, request: params.request, department: dept, lead,
      origin: { channel: params.channel, chatId: params.chatId },
      projectDir: params.projectDir, planSummary: `${FACADE_PREFIX}${params.playbook}`,
    });
    this.deps.store.insertNodes(goal.id, toNewTaskNodes(compilePlaybook(pb)));
    void this.startGoal(goal, pb);
    return goal;
  }

  private insertGoal(p: {
    title: string; request: string; department: string; lead: string;
    origin: { channel: string; chatId: string }; projectDir?: string; planSummary: string;
  }): GoalRow {
    const id = randomUUID();
    const slug = slugify(p.title);
    this.deps.store.insertGoal({
      id, slug, title: p.title, request: p.request, department: p.department, lead: p.lead,
      origin_channel: p.origin.channel, origin_chat_id: p.origin.chatId,
      status: "running", project_dir: p.projectDir ?? null, goal_dir: null,
      plan_summary: p.planSummary, replans_used: 0, error: null,
    });
    const goal = this.deps.store.getGoal(id)!;
    this.emit({ type: "goal.created", goalId: id, title: p.title, department: p.department });
    return goal;
  }

  /** Workspace + goal.md, then pump. Errors fail the goal (port of the prepareSandbox path). */
  private async startGoal(goal: GoalRow, pb?: Playbook): Promise<void> {
    const { store, vault } = this.deps;
    const goalDirName = vault.goalDirName(goal.slug);
    store.setGoalDir(goal.id, goalDirName);
    goal.goal_dir = goalDirName;
    vault.writeGoalArtifact(goalDirName, "goal.md",
      `# ${goal.title}\n\n- department: ${goal.department}\n- lead: ${goal.lead}\n- status: running\n\n## Request\n\n${goal.request}\n\n## Plan\n\n${goal.plan_summary}`,
      { goal: goal.id, department: goal.department });
    try {
      const sandbox = await this.deps.prepareSandbox?.(goal, { playbook: pb });
      if (sandbox) {
        store.setGoalProjectDir(goal.id, sandbox.taskDir);
        goal.project_dir = sandbox.taskDir;
        this.sandboxes.set(goal.id, sandbox);
      }
      if (goal.project_dir) mkdirSync(goal.project_dir, { recursive: true });
    } catch (err) {
      const msg = `workspace setup failed: ${(err as Error).message}`;
      this.setGoalStatus(goal.id, "failed", msg);
      store.skipUnfinishedNodes(goal.id);
      await this.complete(goal, false, msg);
      return;
    }
    this.pump();
  }

  /** Core scheduler. Synchronous scan; async node runs re-enter via .finally(). */
  pump(): void {
    if (this.runningNodes >= this.deps.maxConcurrentNodes) return;
    for (const goal of this.deps.store.unfinishedGoals()) {
      if (goal.status !== "running") continue;
      const nodes = this.deps.store.listNodes(goal.id);
      if (Date.now() > new Date(goal.created_at).getTime() + this.deps.wallTimeMs) {
        this.setGoalStatus(goal.id, "failed", "Goal wall-time budget exceeded");
        this.deps.store.skipUnfinishedNodes(goal.id);
        void this.complete(goal, false, "Goal wall-time budget exceeded");
        continue;
      }
      const done = new Set(nodes.filter((n) => n.status === "done").map((n) => n.node_key));
      for (const n of nodes) {
        if (n.status === "pending" && (JSON.parse(n.depends_on) as string[]).every((d) => done.has(d))) {
          this.setNodeStatus(goal, n.node_key, "ready", n.agent);
          n.status = "ready";
        }
      }
      for (const n of nodes.filter((x) => x.status === "ready")) {
        if (this.runningNodes >= this.deps.maxConcurrentNodes) return;
        if (!this.deps.spendGuard.allow()) { this.pauseForBudget(goal); break; }
        this.launch(goal, n);
      }
      // all terminal?
      const fresh = this.deps.store.listNodes(goal.id);
      if (fresh.every((n) => n.status === "done")) {
        this.setGoalStatus(goal.id, "done");
        void this.complete(this.deps.store.getGoal(goal.id)!, true);
      }
    }
  }

  private pauseForBudget(goal: GoalRow): void {
    this.setGoalStatus(goal.id, "paused-budget");
    const date = new Date().toISOString().slice(0, 10);
    const key = `budget:pinged:${date}`;
    if (!this.deps.store.kvGet(key)) {
      this.deps.store.kvSet(key, "1");
      this.deps.pingBudgetPaused?.(`Daily budget reached — paused background goals; they resume tomorrow.`);
    }
  }

  private launch(goal: GoalRow, node: TaskNodeRow): void {
    this.runningNodes++;
    this.setNodeStatus(goal, node.node_key, "running", node.agent);
    const facade = goal.plan_summary.startsWith(FACADE_PREFIX);
    const sandbox = this.sandboxes.get(goal.id);
    const origin = { channel: goal.origin_channel, chatId: goal.origin_chat_id };
    const resolvePack = () => facade
      ? this.deps.resolveDeptFor(goal.plan_summary.slice(FACADE_PREFIX.length), origin, false, sandbox)
      : this.deps.resolveDeptFor(node.agent, origin, true, sandbox);
    runNode(this.deps.store.getGoal(goal.id)!, node, { ...this.deps, resolvePack })
      .then(() => this.setNodeStatus(goal, node.node_key, "done", node.agent))
      .catch(async (err: Error) => {
        this.setNodeStatus(goal, node.node_key, "failed", node.agent, err.message);
        await this.onNodeFailure(this.deps.store.getGoal(goal.id)!, node, err);
      })
      .finally(() => { this.runningNodes--; this.pump(); });
  }

  private async onNodeFailure(goal: GoalRow, node: TaskNodeRow, err: Error): Promise<void> {
    if (err instanceof SessionLimitError) {
      this.setGoalStatus(goal.id, "paused-user", err.message);
      return;
    }
    const facade = goal.plan_summary.startsWith(FACADE_PREFIX);
    const cap = this.deps.replanCap ?? 2;
    if (facade || !this.deps.planner || goal.replans_used >= cap) {
      const msg = `node ${node.node_key} failed: ${err.message}${!facade && goal.replans_used >= cap ? ` (re-plans exhausted: ${cap})` : ""}`;
      this.setGoalStatus(goal.id, "failed", msg);
      this.deps.store.skipUnfinishedNodes(goal.id);
      await this.complete(goal, false, msg);
      return;
    }
    // lead-planned: re-plan (Task 7 provides Planner.replan)
    this.setGoalStatus(goal.id, "replanning");
    this.deps.store.bumpReplans(goal.id);
    try {
      await this.deps.planner.replan(this.deps.store.getGoal(goal.id)!, node, err.message);
      this.setGoalStatus(goal.id, "running");
      this.pump();
    } catch (planErr) {
      const msg = `re-planning failed: ${(planErr as Error).message}`;
      this.setGoalStatus(goal.id, "failed", msg);
      this.deps.store.skipUnfinishedNodes(goal.id);
      await this.complete(goal, false, msg);
    }
  }

  private async complete(goal: GoalRow, ok: boolean, error?: string): Promise<void> {
    const fresh = this.deps.store.getGoal(goal.id)!;
    const files = this.deps.store.listNodes(goal.id).filter((n) => n.artifact).map((n) => n.artifact!);
    try {
      await this.deps.onComplete({ goal: fresh, ok, error, goalDirName: fresh.goal_dir ?? "", artifactFiles: files });
    } catch (err) {
      this.deps.log?.(`[${goal.slug}] onComplete failed: ${(err as Error).message}`);
    }
  }

  private findGoal(idOrSlug: string): GoalRow | undefined {
    return this.deps.store.getGoal(idOrSlug) ?? this.deps.store.getGoalBySlug(idOrSlug);
  }

  pauseGoal(idOrSlug: string): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (g.status !== "running" && g.status !== "replanning") return `Goal ${g.slug} is ${g.status} — nothing to pause.`;
    this.setGoalStatus(g.id, "paused-user");
    return `Goal ${g.slug} paused (running nodes finish; nothing new starts). /resume ${g.slug} to continue.`;
  }

  resumeGoal(idOrSlug: string): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (g.status !== "paused-user" && g.status !== "paused-budget") return `Goal ${g.slug} is ${g.status} — nothing to resume.`;
    this.setGoalStatus(g.id, "running");
    this.pump();
    return `Goal ${g.slug} resumed.`;
  }

  abandonGoal(idOrSlug: string): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (["done", "failed", "abandoned"].includes(g.status)) return `Goal ${g.slug} is already ${g.status}.`;
    this.setGoalStatus(g.id, "abandoned");
    this.deps.store.skipUnfinishedNodes(g.id);
    return `Goal ${g.slug} abandoned; unfinished nodes skipped.`;
  }

  /** Startup only — reset orphaned running nodes (they re-run) and pump unfinished goals. */
  resumeUnfinished(): number {
    this.deps.store.resetRunningNodes();
    const goals = this.deps.store.unfinishedGoals();
    for (const g of goals) if (g.status === "replanning" || g.status === "planning") this.setGoalStatus(g.id, "running");
    this.pump();
    return goals.length;
  }

  resumeBudgetPaused(): number {
    if (!this.deps.spendGuard.allow()) return 0;
    const paused = this.deps.store.pausedBudgetGoals();
    for (const g of paused) this.setGoalStatus(g.id, "running");
    if (paused.length) this.pump();
    return paused.length;
  }

  async planGoal(params: { department: string; title: string; request: string; channel: string; chatId: string }): Promise<GoalRow> {
    if (!this.deps.planner) throw new Error("planner not configured");
    return this.deps.planner.plan(this, params);   // Task 7 implements; engine exposes insertGoalPlanned below
  }

  /** Used by the Planner (Task 7) to persist a validated plan and start it. */
  startPlannedGoal(p: {
    title: string; request: string; department: string; lead: string;
    origin: { channel: string; chatId: string }; summary: string;
    nodes: import("../store/db.js").NewTaskNode[]; projectDir?: string; needsWorkspace: string;
  }): GoalRow {
    const goal = this.insertGoal({
      title: p.title, request: p.request, department: p.department, lead: p.lead,
      origin: p.origin, projectDir: p.projectDir, planSummary: p.summary,
    });
    this.deps.store.insertNodes(goal.id, p.nodes);
    void this.startGoal(goal);
    return goal;
  }
}
```

In `src/heartbeat/clock.ts`: add `onTick?: () => void;` to `ClockDeps` and, at the end of `tick()`'s try block (after the reminder loop): `this.deps.onTick?.();`.

For the transitional `Planner` type reference, declare at the top of goals.ts:

```typescript
export interface Planner {
  plan(engine: GoalEngine, params: { department: string; title: string; request: string; channel: string; chatId: string }): Promise<GoalRow>;
  replan(goal: GoalRow, failed: TaskNodeRow, error: string): Promise<void>;
}
```

- [ ] **Step 4: Run + typecheck** — `npx vitest run test/goal-scheduler.test.ts test/goal-runner.test.ts && npx tsc --noEmit` → all pass, clean. Full suite still green: `npx vitest run` (old engine untouched).

- [ ] **Step 5: Commit**

```bash
git add src/engine/goals.ts src/heartbeat/clock.ts test/goal-scheduler.test.ts
git commit -m "feat(engine): GoalEngine scheduler — parallel nodes, budget pause, lifecycle, restart resume"
```

---

### Task 7: Lead planner — plan, preview, re-plan

**Files:**
- Modify: `src/engine/plan.ts` (planner half)
- Modify: `src/agents/runner.ts` (RunOptions.outputSchema passthrough)
- Test: `test/goal-planner.test.ts`

**Interfaces:**
- Consumes: `validateGraph` (Task 3), `GoalEngine.startPlannedGoal` + `Planner` interface (Task 6), `SpecialistRunFn`, `toNewTaskNodes`.
- Produces:

```typescript
export const GRAPH_SCHEMA: Record<string, unknown>;   // json-schema for structured output
export const PATCH_SCHEMA: Record<string, unknown>;
export interface PlannerDeps {
  registry: LoadedRegistry;
  store: Store;
  run: SpecialistRunFn;
  resolveDeptFor: (key: string, origin: {channel: string; chatId: string}, byAgent?: boolean) => ResolvedPack | undefined;
  primaryChat?: { channel: string; chatId: string };
  projectsRoot: string;
  model?: string;
  /** Posts the plan preview to the origin chat (index wires sendVia). */
  postPreview: (origin: {channel: string; chatId: string}, text: string) => Promise<void>;
  log?: (l: string) => void;
}
export function makePlanner(deps: PlannerDeps): Planner;
export function renderPlanPreview(title: string, summary: string, nodes: GraphNodeSpec[]): string;
```

Behavior (spec §4):
- `plan(engine, params)`: department must exist with a `lead` (else throw with a helpful message — hermes surfaces it). Planning brief = title + request + roster block (each dept agent: `name — title — first charter sentence — outputSchema tag`) + node-type rules (run/loop/verify semantics, verdict/test-report constraints, ≤12 nodes, deps by key, `needsWorkspace` choices greenfield|worktree|analyze|none, projectDir must be under projectsRoot when analyze/worktree). Run the LEAD via `deps.run(lead, brief, { cwd: projectsRoot, model, pack: resolveDeptFor(lead, origin, true), outputSchema: GRAPH_SCHEMA })`. Parse `res.structured` as `{ summary, needsWorkspace, projectDir?, nodes }`; map to `GraphNodeSpec[]` (schema field `deps` matches). `validateGraph` with the goal origin; invalid → ONE retry with the validation error appended to the brief; still invalid → throw `planning failed: <error>` (hermes relays; nothing ran). Valid → `postPreview(origin, renderPlanPreview(...))` → `engine.startPlannedGoal({...})` with `projectDir` only when needsWorkspace is `worktree`/`analyze` (validated under projectsRoot) — `greenfield`/`none` pass undefined (facade-style prepareSandbox handles engineering greenfield; non-code planned goals run without a workspace).
- `replan(goal, failedNode, error)`: brief = graph state JSON (key/type/agent/status/error per node) + failing node error + last artifact tail (≤2000 chars via `vault`? NO — keep planner store-only: include `failedNode.error` and the node's artifact filename; artifact content is not re-read in v1) + patch instructions. Structured output `PATCH_SCHEMA`: `{ ops: [{ op: "replace", key, node } | { op: "add", nodes } | { op: "abandon", reason }] }`. Apply ops to a copy of the graph → `validateGraph` (same ctx, ONE retry) → persist: `replace` → `store.replaceNode`, `add` → `store.insertNodes`; `abandon` → throw `lead recommends abandoning: <reason>` (engine fails the goal with it).
- `route.decision` emission for the plan dispatch happens in Task 8's tool (moderator side), not here.

GRAPH_SCHEMA (exact):

```typescript
export const GRAPH_SCHEMA = {
  type: "object",
  required: ["summary", "needsWorkspace", "nodes"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    needsWorkspace: { enum: ["greenfield", "worktree", "analyze", "none"] },
    projectDir: { type: "string" },
    nodes: {
      type: "array", minItems: 1, maxItems: 12,
      items: {
        type: "object",
        required: ["key", "type", "agent", "brief", "deps"],
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          type: { enum: ["run", "loop", "verify"] },
          agent: { type: "string" },
          critic: { type: "string" },
          brief: { type: "string" },
          deps: { type: "array", items: { type: "string" } },
          maxRounds: { type: "integer", minimum: 1, maximum: 5 },
        },
      },
    },
  },
} as const;

export const PATCH_SCHEMA = {
  type: "object",
  required: ["ops"],
  additionalProperties: false,
  properties: {
    ops: {
      type: "array", minItems: 1, maxItems: 6,
      items: {
        type: "object",
        required: ["op"],
        additionalProperties: true,
        properties: { op: { enum: ["replace", "add", "abandon"] } },
      },
    },
  },
} as const;
```

Runner change: `RunOptions` gains `outputSchema?: Record<string, unknown>`; in `makeRunSpecialist`, the outputFormat line becomes:

```typescript
          ...((role.outputSchema ?? opts.outputSchema)
            ? { outputFormat: { type: "json_schema" as const, schema: (role.outputSchema ?? opts.outputSchema) as Record<string, unknown> } }
            : {}),
```

(role schema wins — a verdict critic can never be overridden into a planner.)

- [ ] **Step 1: Write the failing test**

```typescript
// test/goal-planner.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { GoalEngine } from "../src/engine/goals.js";
import { SpendGuard } from "../src/engine/budget.js";
import { makePlanner, renderPlanPreview } from "../src/engine/plan.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "gp-"));
  const eng = join(root, "agents", "engineering");
  mkdirSync(eng, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  for (const [n, extra] of [["athena", ""], ["vulcan", ""], ["odin", ""], ["minos-eng", "outputSchema: verdict\n"]] as const) {
    writeFileSync(join(eng, `${n}.yaml`),
      `name: ${n}\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n${extra}`);
  }
  return loadRegistry(join(root, "agents"), join(root, "playbooks"));
}

const GOOD_PLAN = {
  summary: "two-step plan",
  needsWorkspace: "none",
  nodes: [
    { key: "research", type: "run", agent: "odin", brief: "look", deps: [] },
    { key: "build", type: "loop", agent: "vulcan", critic: "minos-eng", brief: "make", deps: ["research"] },
  ],
};

function harness(planOutputs: unknown[]) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "gp-vault-")));
  const registry = fixtureRegistry();
  const previews: string[] = [];
  let planCalls = 0;
  const run: SpecialistRunFn = async (role) => {
    if (role === "athena" && planCalls < planOutputs.length) {
      return { text: "plan", structured: planOutputs[planCalls++], costUsd: 0.02, numTurns: 1 };
    }
    return { text: "node out", costUsd: 0.01, numTurns: 1 };
  };
  const planner = makePlanner({
    registry, store, run,
    resolveDeptFor: () => undefined,
    primaryChat: { channel: "telegram", chatId: "1" },
    projectsRoot: "/tmp/projects",
    postPreview: async (_o, text) => { previews.push(text); },
  });
  const engine = new GoalEngine({
    store, vault, registry, run,
    playbooks: new Map(), wallTimeMs: 60_000, maxConcurrentNodes: 2,
    spendGuard: new SpendGuard({ store }),
    onComplete: async () => {},
    resolveDeptFor: () => undefined,
    planner,
  });
  return { store, engine, previews, planCallsRef: () => planCalls };
}

describe("lead planner", () => {
  it("plans, previews, starts, and the graph runs to done", async () => {
    const { engine, store, previews } = harness([GOOD_PLAN]);
    const g = await engine.planGoal({ department: "engineering", title: "Do X", request: "do x", channel: "telegram", chatId: "1" });
    expect(previews[0]).toContain("research");
    expect(previews[0]).toContain("vulcan");
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(store.listNodes(g.id)).toHaveLength(2);
  });

  it("invalid plan retries once with the error, then succeeds", async () => {
    const bad = { ...GOOD_PLAN, nodes: [{ key: "a", type: "run", agent: "midas", brief: "x", deps: [] }] };
    const { engine, planCallsRef } = harness([bad, GOOD_PLAN]);
    await engine.planGoal({ department: "engineering", title: "Do X", request: "do x", channel: "telegram", chatId: "1" });
    expect(planCallsRef()).toBe(2);
  });

  it("invalid twice → throws planning failed, nothing persisted", async () => {
    const bad = { ...GOOD_PLAN, nodes: [{ key: "a", type: "run", agent: "nobody", brief: "x", deps: [] }] };
    const { engine, store } = harness([bad, bad]);
    await expect(engine.planGoal({ department: "engineering", title: "Do X", request: "x", channel: "telegram", chatId: "1" }))
      .rejects.toThrow(/planning failed/);
    expect(store.listGoals()).toHaveLength(0);
  });

  it("unknown department throws a helpful error", async () => {
    const { engine } = harness([]);
    await expect(engine.planGoal({ department: "nope", title: "t", request: "r", channel: "t", chatId: "1" }))
      .rejects.toThrow(/unknown department/i);
  });

  it("renderPlanPreview lists nodes with agents and deps", () => {
    const out = renderPlanPreview("Do X", "two-step",
      GOOD_PLAN.nodes.map((n) => ({ ...n, type: n.type as "run" | "loop", deps: n.deps })));
    expect(out).toContain("Do X");
    expect(out).toContain("build (loop) — vulcan ⇄ minos-eng — after: research");
  });
});
```

- [ ] **Step 2: Run to verify fail** — `makePlanner` not exported.

- [ ] **Step 3: Implement**

Runner change per **Interfaces** (RunOptions + outputFormat line). Append to `src/engine/plan.ts` (imports: `Store`, `SpecialistRunFn`, `ResolvedPack`, `GoalEngine`, `Planner`, `GoalRow`, `TaskNodeRow` types, `toNewTaskNodes`, `resolve` from node:path):

```typescript
export function renderPlanPreview(title: string, summary: string, nodes: GraphNodeSpec[]): string {
  const lines = nodes.map((n) => {
    const pair = n.critic ? `${n.agent} ⇄ ${n.critic}` : n.agent;
    const after = n.deps.length ? ` — after: ${n.deps.join(", ")}` : "";
    return `- ${n.key} (${n.type}) — ${pair}${after}`;
  });
  return `📋 Plan for "${title}" — ${summary}\n${lines.join("\n")}\nStarting now. /pause or /abandon <goal> anytime.`;
}

interface RawPlan {
  summary: string;
  needsWorkspace: "greenfield" | "worktree" | "analyze" | "none";
  projectDir?: string;
  nodes: Array<{ key: string; type: "run" | "loop" | "verify"; agent: string; critic?: string; brief: string; deps: string[]; maxRounds?: number }>;
}

function rosterBlock(registry: LoadedRegistry, department: string): string {
  return [...registry.agents.values()]
    .filter((a) => a.department === department)
    .map((a) => {
      const schema = a.manifest.outputSchema ? ` [outputSchema: ${a.manifest.outputSchema}]` : "";
      return `- ${a.manifest.name} — ${a.manifest.title} — ${a.manifest.charter.trim().split(/(?<=\.)\s/)[0]}${schema}`;
    })
    .join("\n");
}

function planningBrief(dept: string, title: string, request: string, roster: string, retryError?: string): string {
  return [
    `You are the ${dept} department lead. Decompose the goal below into a task graph for YOUR department's agents.`,
    `# Goal: ${title}\n${request}`,
    `# Your agents\n${roster}`,
    `# Node types
- run: one agent, one brief, one artifact.
- loop: producer + critic rounds; the critic MUST be an agent tagged [outputSchema: verdict].
- verify: runner + fixer rounds; the runner MUST be an agent tagged [outputSchema: test-report]; put the fixer in "critic".
# Rules
- 1-12 nodes. Keys: lowercase-kebab. "deps" lists node keys that must finish first; independent nodes run in parallel.
- Only agents from the roster above.
- Each brief must stand alone: the agent sees the goal request + prior artifacts of its deps, nothing else.
- needsWorkspace: "worktree" (edit an existing repo safely) | "analyze" (read-only repo) | "greenfield" (new scratch dir) | "none". projectDir required for worktree/analyze.`,
    retryError ? `# Your previous plan was INVALID — fix this and return a corrected plan\n${retryError}` : "",
  ].filter(Boolean).join("\n\n");
}

export interface PlannerDeps {
  registry: LoadedRegistry;
  store: Store;
  run: SpecialistRunFn;
  resolveDeptFor: (key: string, origin: { channel: string; chatId: string }, byAgent?: boolean) => ResolvedPack | undefined;
  primaryChat?: { channel: string; chatId: string };
  projectsRoot: string;
  model?: string;
  postPreview: (origin: { channel: string; chatId: string }, text: string) => Promise<void>;
  log?: (l: string) => void;
}

export function makePlanner(deps: PlannerDeps): import("./goals.js").Planner {
  const runLead = async (lead: string, brief: string, origin: { channel: string; chatId: string }, schema: Record<string, unknown>) =>
    deps.run(lead, brief, {
      cwd: deps.projectsRoot, model: deps.model,
      pack: deps.resolveDeptFor(lead, origin, true),
      outputSchema: schema,
    });

  const validateOrExplain = (nodes: RawPlan["nodes"], department: string, origin: { channel: string; chatId: string }) => {
    const specs: GraphNodeSpec[] = nodes.map((n) => ({
      key: n.key, type: n.type, agent: n.agent, critic: n.critic, brief: n.brief, deps: n.deps, maxRounds: n.maxRounds,
    }));
    const v = validateGraph(specs, { registry: deps.registry, department, origin, primaryChat: deps.primaryChat });
    return { specs, v };
  };

  return {
    async plan(engine, params) {
      const dept = deps.registry.departments.get(params.department);
      if (!dept?.lead) throw new Error(`unknown department or no lead: "${params.department}" — use hand_off or run_playbook instead`);
      const origin = { channel: params.channel, chatId: params.chatId };
      const roster = rosterBlock(deps.registry, params.department);

      let raw: RawPlan | undefined;
      let error = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        const res = await runLead(dept.lead, planningBrief(params.department, params.title, params.request, roster, attempt === 2 ? error : undefined), origin, GRAPH_SCHEMA);
        const candidate = res.structured as RawPlan | undefined;
        if (!candidate?.nodes) { error = "no structured plan returned"; continue; }
        const { v } = validateOrExplain(candidate.nodes, params.department, origin);
        if (v.ok) { raw = candidate; break; }
        error = v.error;
      }
      if (!raw) throw new Error(`planning failed: ${error}`);

      const { specs } = validateOrExplain(raw.nodes, params.department, origin);
      let projectDir: string | undefined;
      if (raw.needsWorkspace === "worktree" || raw.needsWorkspace === "analyze") {
        if (!raw.projectDir || !resolve(raw.projectDir).startsWith(resolve(deps.projectsRoot))) {
          throw new Error(`planning failed: needsWorkspace ${raw.needsWorkspace} requires projectDir under ${deps.projectsRoot}`);
        }
        projectDir = resolve(raw.projectDir);
      }
      await deps.postPreview(origin, renderPlanPreview(params.title, raw.summary, specs));
      return engine.startPlannedGoal({
        title: params.title, request: params.request, department: params.department, lead: dept.lead,
        origin, summary: raw.summary, nodes: toNewTaskNodes(specs), projectDir, needsWorkspace: raw.needsWorkspace,
      });
    },

    async replan(goal, failed, errorMsg) {
      const origin = { channel: goal.origin_channel, chatId: goal.origin_chat_id };
      const nodes = deps.store.listNodes(goal.id);
      const state = nodes.map((n) => ({
        key: n.node_key, type: n.type, agent: n.agent, critic: n.critic ?? undefined,
        status: n.status, deps: JSON.parse(n.depends_on) as string[], error: n.error ?? undefined,
      }));
      const roster = rosterBlock(deps.registry, goal.department);
      const brief = [
        `You are the ${goal.department} lead. A node in your plan failed — patch the plan.`,
        `# Goal: ${goal.title}\n${goal.request}`,
        `# Current graph\n${JSON.stringify(state, null, 2)}`,
        `# Failed node: ${failed.node_key}\n${errorMsg}`,
        `# Your agents\n${roster}`,
        `# Patch ops (return {"ops":[...]})
- {"op":"replace","key":"<node_key>","node":{key,type,agent,critic?,brief,deps,maxRounds?}} — swap the failed node (key may stay the same).
- {"op":"add","nodes":[{...}]} — add new nodes (done nodes are immutable).
- {"op":"abandon","reason":"..."} — when the goal cannot be salvaged.
Same rules as planning: roster agents only, verdict/test-report critics, ≤12 total nodes, no cycles.`,
      ].join("\n\n");

      const res = await runLead(goal.lead, brief, origin, PATCH_SCHEMA);
      const patch = res.structured as { ops: Array<Record<string, unknown>> } | undefined;
      if (!patch?.ops?.length) throw new Error("lead returned no patch ops");

      // Build the would-be graph, validate whole, then persist.
      type RawNode = RawPlan["nodes"][number];
      const current = new Map(state.map((s) => [s.key, { key: s.key, type: s.type, agent: s.agent, critic: s.critic, brief: nodes.find((n) => n.node_key === s.key)!.brief, deps: s.deps } as RawNode]));
      const replaces: RawNode[] = [];
      const adds: RawNode[] = [];
      for (const op of patch.ops) {
        if (op.op === "abandon") throw new Error(`lead recommends abandoning: ${String(op.reason ?? "no reason")}`);
        if (op.op === "replace") { const n = op.node as RawNode; current.set(String(op.key), n); replaces.push(n); }
        if (op.op === "add") { for (const n of (op.nodes as RawNode[]) ?? []) { current.set(n.key, n); adds.push(n); } }
      }
      const { v, specs } = validateOrExplain([...current.values()], goal.department, origin);
      if (!v.ok) throw new Error(`patch invalid: ${v.error}`);
      void specs;

      for (const n of replaces) {
        deps.store.replaceNode(goal.id, n.key, toNewTaskNodes([{ key: n.key, type: n.type, agent: n.agent, critic: n.critic, brief: n.brief, deps: n.deps, maxRounds: n.maxRounds }])[0]);
      }
      if (adds.length) {
        deps.store.insertNodes(goal.id, toNewTaskNodes(adds.map((n) => ({ key: n.key, type: n.type, agent: n.agent, critic: n.critic, brief: n.brief, deps: n.deps, maxRounds: n.maxRounds }))));
      }
      await deps.postPreview(origin, `♻️ Re-planned "${goal.title}" after ${failed.node_key} failed:\n${renderPlanPreview(goal.title, "patched plan", [...current.values()].map((n) => ({ key: n.key, type: n.type, agent: n.agent, critic: n.critic, brief: n.brief, deps: n.deps })))}`);
    },
  };
}
```

- [ ] **Step 4: Run + typecheck** — `npx vitest run test/goal-planner.test.ts && npx tsc --noEmit` → 5 pass, clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/plan.ts src/agents/runner.ts test/goal-planner.test.ts
git commit -m "feat(engine): lead planner — structured plans, validation retry, re-plan patches"
```

---

### Task 8: Moderator tools + router intercepts

**Files:**
- Modify: `src/moderator/tools.ts` (deps type + plan_goal tool + facades already call `deps.jobs.createJob` — the dep becomes GoalEngine with a compatible method name, see below)
- Modify: `src/moderator/index.ts` (ModeratorDeps.jobs type)
- Modify: `src/router.ts` (`/pause`, `/resume`, `/abandon` intercepts + route.decision via "plan" emitted from plan_goal handler in tools.ts)
- Test: `test/goal-tools.test.ts`

**Interfaces:**
- Consumes: `GoalEngine` (Task 6).
- Produces: `ModeratorToolsDeps.jobs: GoalEngine` (renamed field `goals` — update `Moderator` and `buildModeratorServer` accordingly); new tool `plan_goal(department, title, request)`; `goal_status(goal_id?)` replacing `job_status` (old tool name REMOVED — hermes prompt roster is generated, no alias needed at the SDK tool level; the moderator prompt text in `src/moderator/prompt.ts` gets its `job_status` mention updated); router intercepts return deterministic strings.

Changes:
1. `ModeratorToolsDeps`: `jobs: JobManager` → `goals: GoalEngine`; add `emitRoute: (to: string, via: "plan", reason: string) => void` (index wires `bus.emit` with origin) — simpler: tools already have no bus; give deps `bus?: EventBus` and emit directly with `deps.origin`.
2. `run_playbook` handler: `deps.jobs.createJob({...})` → `deps.goals.createFromPlaybook({...})`; message text: `Goal started: ${goal.id} (${goal.slug}, playbook ${params.playbook}). You will be notified on completion.` Same CODE_PLAYBOOKS refusal + projectsRoot check.
3. `code_task` handler: same swap, keep try/catch Refused wrapper.
4. `job_status` → `goal_status`:

```typescript
  const goalStatus = tool(
    "goal_status",
    "Get status of a goal by id or slug, or list recent goals when none given.",
    { goal_id: z.string().optional() },
    async (args) => {
      if (args.goal_id) {
        const g = deps.store.getGoal(args.goal_id) ?? deps.store.getGoalBySlug(args.goal_id);
        if (!g) return text(`No goal ${args.goal_id}`);
        const nodes = deps.store.listNodes(g.id)
          .map((n) => `  ${n.node_key} [${n.status}] ${n.agent}${n.error ? ` — ${n.error}` : ""}`).join("\n");
        return text(`${g.id} (${g.slug}) [${g.status}] ${g.title}\n${nodes}`);
      }
      const goals = deps.store.listGoals(10).map((g) => `${g.created_at} ${g.slug} [${g.status}] ${g.title}`);
      return text(goals.join("\n") || "No goals yet.");
    },
  );
```

5. New `plan_goal`:

```typescript
  const planGoal = tool(
    "plan_goal",
    "Hand a department-sized goal to that department's lead. The lead decomposes it into a task graph " +
      "(parallel where possible), posts the plan, and execution starts immediately. Use for goals that " +
      "need multiple agents/steps; use hand_off for one-sitting tasks and code_task for code playbooks. " +
      "Departments: " + deps.departments.join(", "),
    {
      department: z.string().describe("Owning department, e.g. engineering"),
      title: z.string().describe("Short goal title"),
      request: z.string().describe("Full goal description with all context the lead needs"),
    },
    async (args) => {
      deps.bus?.emit({
        type: "route.decision", to: args.department, via: "plan",
        reason: `goal handed to ${args.department} lead`, channel: deps.origin.channel, chatId: deps.origin.chatId,
      });
      try {
        const goal = await deps.goals.planGoal({
          department: args.department, title: args.title, request: args.request,
          channel: deps.origin.channel, chatId: deps.origin.chatId,
        });
        return text(`Goal started: ${goal.id} (${goal.slug}) — the ${args.department} lead planned it; plan posted to chat. You will be notified on completion.`);
      } catch (err) {
        return text(`Refused: ${(err as Error).message}`);
      }
    },
  );
```

`ModeratorToolsDeps` gains `departments: string[]` and `bus?: EventBus`. Register `goalStatus` + `planGoal` in `createSdkMcpServer` tools (replacing `jobStatus`).

6. Router (`src/router.ts`): next to the `/approve|/reject` intercept, add (goals dep threaded into `MessageRouter` deps as `goals?: GoalEngine`):

```typescript
    const goalCmd = /^\/(pause|resume|abandon)\s+(\S+)\s*$/i.exec(msg.text.trim());
    if (goalCmd && this.deps.goals) {
      const [, verb, ref] = goalCmd;
      const replyText =
        verb.toLowerCase() === "pause" ? this.deps.goals.pauseGoal(ref)
        : verb.toLowerCase() === "resume" ? this.deps.goals.resumeGoal(ref)
        : this.deps.goals.abandonGoal(ref);
      bus?.emit({ type: "chat.out", channel: msg.channel, chatId: msg.chatId, text: replyText.slice(0, 300) });
      return textOnly(replyText);
    }
```

7. `src/moderator/prompt.ts`: update the tool-roster text (search for `job_status`/`run_playbook` mentions) to name `goal_status` and `plan_goal` ("for department-sized goals, hand to the lead with plan_goal").

- [ ] **Step 1: Write the failing test**

```typescript
// test/goal-tools.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

// Router intercept test — pure regex/dispatch, mirrors route-decision.test.ts harness style.
import { MessageRouter } from "../src/router.js";

function fakeGoals() {
  const calls: string[] = [];
  return {
    calls,
    pauseGoal: (r: string) => { calls.push(`pause:${r}`); return `Goal ${r} paused.`; },
    resumeGoal: (r: string) => { calls.push(`resume:${r}`); return `Goal ${r} resumed.`; },
    abandonGoal: (r: string) => { calls.push(`abandon:${r}`); return `Goal ${r} abandoned; unfinished nodes skipped.`; },
  };
}

describe("router goal intercepts", () => {
  it("/pause /resume /abandon dispatch deterministically without an agent turn", async () => {
    const goals = fakeGoals();
    const router = new MessageRouter({
      moderator: { handle: async () => { throw new Error("moderator must not run"); } },
      directChats: { handle: async () => { throw new Error("direct must not run"); }, canonical: () => undefined },
      chatBindings: new Map(),
      goals,
    } as never);
    const r1 = await router.handle({ channel: "telegram", chatId: "1", text: "/pause build-x", sender: {} });
    expect(r1?.text).toContain("paused");
    await router.handle({ channel: "telegram", chatId: "1", text: "/abandon build-x", sender: {} });
    expect(goals.calls).toEqual(["pause:build-x", "abandon:build-x"]);
  });
});
```

(Adjust the constructor arg shape to the real `MessageRouter` deps — mirror how `test/route-decision.test.ts` builds its router harness; the assertion set is what matters: intercepts run, moderator does not.)

- [ ] **Step 2: Run to verify fail** — intercept missing, moderator throws.

- [ ] **Step 3: Implement** all seven changes above.

- [ ] **Step 4: Run + typecheck** — `npx vitest run test/goal-tools.test.ts test/route-decision.test.ts && npx tsc --noEmit`. NOTE: `npx tsc --noEmit` will now FAIL in `src/index.ts` (Moderator still constructed with `jobs:`) — acceptable ONLY if Task 9 lands in the same session; otherwise stub index wiring here. Preferred: do the minimal index.ts rename in THIS task (construct GoalEngine instead of JobManager — see Task 9 Step 1 for the exact block) so every commit is green. Decide by suite state: the commit gate is `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/moderator/tools.ts src/moderator/index.ts src/moderator/prompt.ts src/router.ts src/index.ts test/goal-tools.test.ts
git commit -m "feat(moderator): plan_goal + goal_status tools, /pause /resume /abandon intercepts"
```

---

### Task 9: Wiring, migration, old-engine deletion

**Files:**
- Modify: `src/index.ts`, `src/heartbeat/speculate.ts`, `src/web/server.ts`, `src/web/packs-view.ts`, `src/events.ts`, `src/store/db.ts`
- Delete: `src/engine/jobs.ts`, `src/engine/executor.ts`
- Test: port/delete old engine tests (see Step 4)

**Interfaces:**
- Consumes: everything above.
- Produces: a daemon whose only work engine is GoalEngine.

- [ ] **Step 1: index.ts wiring**

Replace the JobManager block with:

```typescript
  const spendGuard = new SpendGuard({ store, capUsd: config.dailyBudgetUsd });
  attachBudgetLedger(bus, store);

  const onGoalComplete = async (outcome: GoalOutcome): Promise<void> => {
    const { goal } = outcome;
    const channel = channels.get(goal.origin_channel);
    const notice = outcome.ok
      ? `[GOAL-COMPLETE] Goal "${goal.title}" (${goal.id}) finished. Artifacts in vault under goals/${outcome.goalDirName}/: ${outcome.artifactFiles.join(", ")}. Read the key artifacts with vault_read and report the outcome to the user.`
      : `[GOAL-FAILED] Goal "${goal.title}" (${goal.id}) failed: ${outcome.error}. Partial artifacts under goals/${outcome.goalDirName}/. Tell the user what happened and suggest next steps.`;
    const report = await moderator.handle(goal.origin_channel, goal.origin_chat_id, notice);
    await channel?.send(goal.origin_chat_id, report);
    bus.emit({ type: "chat.out", channel: goal.origin_channel, chatId: goal.origin_chat_id, text: report.slice(0, 300) });
  };

  const prepareGoalSandbox = async (goal: GoalRow, opts: { playbook?: Playbook }) => {
    // Facade code goals keep today's engineering-only allocation; planned engineering
    // goals get greenfield/worktree per project_dir presence (analyze read-only).
    const isEng = goal.department === "engineering";
    if (!isEng) return undefined;
    const pbName = goal.plan_summary.startsWith("playbook:") ? goal.plan_summary.slice("playbook:".length) : undefined;
    if (pbName === "code-inplace") return undefined; // inplace edits the real checkout — no sandbox
    const mode: "build" | "analyze" = pbName === "code-analyze" ? "analyze" : "build";
    const wsMode = mode === "analyze" ? "analyze" : (goal.project_dir ? "worktree" : "greenfield");
    const { taskDir } = allocateWorkspace(
      { mode: wsMode, source: goal.project_dir ?? undefined, slug: goal.slug },
      { workspaceRoot: config.workspaceRoot, readRoots: config.codeReadRoots, now: localParts(new Date()).date, id: randomUUID().slice(0, 8) },
    );
    return { taskDir, mode };
  };

  const goals = new GoalEngine({
    store, vault, run: runSpecialist, registry,
    playbooks: registry.playbooks,
    wallTimeMs: config.jobWallTimeMs,
    maxConcurrentNodes: config.maxConcurrentNodes,
    model: config.specialistModel,
    spendGuard,
    onComplete: onGoalComplete,
    onEvent: (e) => bus.emit(e),
    log,
    resolveDeptFor,
    prepareSandbox: prepareGoalSandbox,
    planner: makePlanner({
      registry, store, run: runSpecialist, resolveDeptFor,
      primaryChat: config.primaryChat, projectsRoot: config.projectsRoot,
      model: config.specialistModel,
      postPreview: async (origin, text) => {
        await channels.get(origin.channel)?.send(origin.chatId, text);
        bus.emit({ type: "chat.out", channel: origin.channel, chatId: origin.chatId, text: text.slice(0, 300) });
      },
      log,
    }),
    primaryChat: config.primaryChat,
    projectsRoot: config.projectsRoot,
    workspaceRoot: config.workspaceRoot,
    pingBudgetPaused: (text) => {
      if (config.primaryChat) void channels.get(config.primaryChat.channel)?.send(config.primaryChat.chatId, text);
    },
  });
```

Moderator deps: `jobs: jobs` → `goals`. DirectChats/handOff unchanged. Router deps gain `goals`. Clock deps gain `onTick: () => goals.resumeBudgetPaused()`. Bottom of boot: `jobs.resumeUnfinished()` → `goals.resumeUnfinished()`. Dream/speculate anchors: wrap the anchor bodies with `if (!spendGuard.allow()) { log("budget: skipping <name>"); return; }`.

- [ ] **Step 2: speculate + packs-view + web server**

- `src/heartbeat/speculate.ts`: deps `jobs.createJob` → `goals.createFromPlaybook` (identical param object; rename dep field to `goals`). Same for `speculate-email.ts` if it creates jobs (grep `createJob`).
- `src/web/packs-view.ts`: `store.listJobs(...)` recentJobs section → `store.listGoals(...)` filtered `g.department === dept`, mapped `{ id, title, playbook: g.plan_summary, status, created_at, projectDir: g.project_dir }`; `PackWorkspaceView` unchanged (workspaces scan the filesystem).
- `src/web/server.ts`: `/api/jobs` + `/api/jobs/<id>` become a compat adapter over goals until 3b removes the board:

```typescript
        if (path === "/api/jobs" && req.method === "GET") {
          const rows = store.listGoals(Number(url.searchParams.get("limit") ?? 50));
          return json(res, 200, rows.map((g) => ({
            id: g.id, slug: g.slug, title: g.title, playbook: g.plan_summary, request: g.request,
            project_dir: g.project_dir, channel: g.origin_channel, chat_id: g.origin_chat_id,
            status: g.status, error: g.error, created_at: g.created_at, updated_at: g.updated_at,
            stages: store.listNodes(g.id).map((n) => ({
              stage_id: n.node_key, status: n.status, started_at: n.started_at ?? "", finished_at: n.finished_at,
            })),
          })));
        }
```

  (`/api/jobs/<id>` mirrors it for one goal, artifacts via `vault.listNotes(\`goals/${g.goal_dir}\`)` + `readGoalArtifact`, `vaultDir: \`goals/${g.goal_dir}\``.) `/api/state` `playbooks: jobs.listPlaybooks()` → `goals.listPlaybooks()`. `WebDeps.jobs: JobManager` → `goals: GoalEngine`. `/api/packs/<pillar>/run` → `goals.createFromPlaybook`.

- [ ] **Step 3: Delete the old engine**

- Move `isUnsandboxedWrite` + `stageRoles` from `src/engine/jobs.ts` into `src/engine/goals.ts` (exported, same signatures — update the Task 6 import to local). Grep for remaining importers of `engine/jobs.js` / `engine/executor.js` (`grep -rn "engine/jobs\|engine/executor" src test`) and repoint or delete.
- Delete `src/engine/jobs.ts`, `src/engine/executor.ts`.
- `src/events.ts`: remove `job.created`, `job.status`, `stage.start`, `stage.finish` members. Fix compile fallout: `src/heartbeat/triage.ts` (job.status/stage rules → goal.status/node.status defaults with the same verdicts), `src/web/org-view.ts` (nothing — it reads agent.* only), `ui` is 3b (EventFeed references job./stage. types via string keys only — the `COLOR`/`describe` maps compile fine against the union? They switch on `v.type` — TS will flag removed cases in `describe`; update `ui/src/views/EventFeed.tsx` + `Board.tsx` + `Packs.tsx` `lastEvt` filters to `goal.`/`node.` prefixes — minimal text-level swaps, board data keeps flowing via the compat endpoint).
- `src/store/db.ts`: drop the `jobs`/`stages` CREATE TABLE blocks and `insertJob/updateJobStatus/setJobDir/setProjectDir/getJob/listJobs/unfinishedJobs/stageStart/stageFinish/completedStages/listStages` + `JobRow`/`JobStatus`/`StageStatus` types. Add to the constructor migration section: `this.db.exec("DROP TABLE IF EXISTS jobs; DROP TABLE IF EXISTS stages;")` (existing DBs shed the dead tables).
- `src/web/permissions-view.ts`/others: grep `JobRow` for stragglers.

- [ ] **Step 4: Port/delete old tests**

For each old-engine test file, the parity has already been re-pinned by Tasks 5–6 — now retire the originals:
- `test/executor.test.ts` → DELETE (semantics pinned in `test/goal-runner.test.ts`). Before deleting, diff its assertion list against goal-runner's; port any behavior not yet covered (e.g. artifact rehydration on resume — add a goal-runner test where a done node's artifact feeds a later node after restart, using `resumeUnfinished`).
- `test/createjob-inplace.test.ts`, `test/code-jobs-sandbox.test.ts`, `test/unsandboxed-write.test.ts` → PORT: same assertions against `goals.createFromPlaybook` / `prepareGoalSandbox` (inplace gate messages are identical strings).
- `test/executor-context.test.ts` → PORT context-block assertions to goal-runner (ancestor artifacts).
- `test/pack-e2e.test.ts`, `test/pack-runner.test.ts`, `test/code-integration.test.ts`, `test/packs-run-endpoint.test.ts`, `test/pack-server.test.ts` etc. → mechanical: construct GoalEngine instead of JobManager, assert on goals/nodes instead of jobs/stages.
- `test/job-dir.test.ts` → PORT to goal_dir naming.
- `test/route-decision.test.ts`, `test/hand-off.test.ts` → unchanged (no job engine involvement) — verify green.
- `test/playbook-critics.test.ts` (invariant) → keep; ADD an assertion that `validateGraph` rejects a non-verdict loop critic (the invariant now lives in two layers: playbook YAML lint + graph validation).

- [ ] **Step 5: Full verification**

Run: `npx vitest run && npx tsc --noEmit && npm run build && (cd ui && npx tsc --noEmit && npm run build)`
Expected: suite ≥ baseline (742 + new − retired), zero failures; all builds clean. Privacy pins (`money-privacy`, `lifeops-privacy`, `bunq-recall-exclusion`, `email-recall-exclusion`), capability pins (`registry-live-tree`, `code-runner-clamp`), critic invariant (`playbook-critics`) all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(engine)!: GoalEngine replaces JobManager/PlaybookExecutor — jobs/stages retired"
```

---

### Task 10: Web endpoints — /api/goals, /api/budget

**Files:**
- Create: `src/web/goals-view.ts`
- Modify: `src/web/server.ts`
- Test: `test/goal-endpoints.test.ts`

**Interfaces:**
- Consumes: Store goal/node methods, `SpendGuard`, `VaultWriter.readGoalArtifact`.
- Produces (3b consumes):

```typescript
export interface GoalNodeView {
  key: string; type: string; agent: string; critic: string | null;
  deps: string[]; status: string; costCents: number; rounds: number;
  artifact: string | null; error: string | null; startedAt: string | null; finishedAt: string | null;
}
export interface GoalView {
  id: string; slug: string; title: string; department: string; lead: string;
  status: string; planSummary: string; replansUsed: number; error: string | null;
  createdAt: string; updatedAt: string; projectDir: string | null; goalDir: string | null;
  nodes: GoalNodeView[];
}
export function buildGoalsView(store: Store, limit?: number): GoalView[];
export function buildGoalDetail(store: Store, vault: VaultWriter, idOrSlug: string):
  (GoalView & { artifacts: Array<{ file: string; content: string }> }) | null;
export function buildBudgetView(guard: SpendGuard): { date: string; spentCents: number; capCents: number | null };
```

Endpoints (inside the token branch, before `/api/permissions`): `GET /api/goals` → `buildGoalsView(store)`; `GET /api/goals/<id-or-slug>` → detail or 404; `POST /api/goals/<id>/pause|resume|abandon` → `{ message }` from the engine method (WebDeps carries `goals`); `GET /api/budget` → `buildBudgetView(spendGuard)` (WebDeps carries `spendGuard`).

- [ ] **Step 1: Write the failing test**

```typescript
// test/goal-endpoints.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { SpendGuard } from "../src/engine/budget.js";
import { buildGoalsView, buildGoalDetail, buildBudgetView } from "../src/web/goals-view.js";

function seeded() {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "ge-")));
  store.insertGoal({
    id: "g1", slug: "build-x", title: "Build X", request: "r", department: "engineering", lead: "athena",
    origin_channel: "t", origin_chat_id: "1", status: "running", project_dir: null,
    goal_dir: "2026-07-02-build-x", plan_summary: "s", replans_used: 1, error: null,
  });
  store.insertNodes("g1", [
    { node_key: "a", type: "run", agent: "odin", critic: null, brief: "b", depends_on: [], max_rounds: 1 },
    { node_key: "b", type: "loop", agent: "vulcan", critic: "minos-eng", brief: "b", depends_on: ["a"], max_rounds: 3 },
  ]);
  store.updateNodeStatus("g1", "a", "done");
  store.setNodeArtifact("g1", "a", "a.md");
  vault.writeGoalArtifact("2026-07-02-build-x", "a.md", "artifact body");
  return { store, vault };
}

describe("goals view builders", () => {
  it("buildGoalsView lists goals with parsed node deps", () => {
    const { store } = seeded();
    const [g] = buildGoalsView(store);
    expect(g.slug).toBe("build-x");
    expect(g.nodes[1].deps).toEqual(["a"]);
    expect(g.nodes[0].status).toBe("done");
  });

  it("buildGoalDetail resolves by slug and includes artifacts; null for unknown", () => {
    const { store, vault } = seeded();
    const d = buildGoalDetail(store, vault, "build-x")!;
    expect(d.artifacts).toEqual([{ file: "a.md", content: expect.stringContaining("artifact body") }]);
    expect(buildGoalDetail(store, vault, "nope")).toBeNull();
  });

  it("buildBudgetView reports spend and cap", () => {
    const { store } = seeded();
    store.budgetAdd("2026-07-02", 42);
    const v = buildBudgetView(new SpendGuard({ store, capUsd: 5, todayFn: () => "2026-07-02" }));
    expect(v).toEqual({ date: "2026-07-02", spentCents: 42, capCents: 500 });
  });
});
```

- [ ] **Step 2: Run to verify fail** — module not found.

- [ ] **Step 3: Implement `src/web/goals-view.ts`**

```typescript
// src/web/goals-view.ts — pure builders behind /api/goals and /api/budget.
import type { Store, GoalRow, TaskNodeRow } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { SpendGuard } from "../engine/budget.js";

export interface GoalNodeView {
  key: string; type: string; agent: string; critic: string | null;
  deps: string[]; status: string; costCents: number; rounds: number;
  artifact: string | null; error: string | null; startedAt: string | null; finishedAt: string | null;
}
export interface GoalView {
  id: string; slug: string; title: string; department: string; lead: string;
  status: string; planSummary: string; replansUsed: number; error: string | null;
  createdAt: string; updatedAt: string; projectDir: string | null; goalDir: string | null;
  nodes: GoalNodeView[];
}

function nodeView(n: TaskNodeRow): GoalNodeView {
  return {
    key: n.node_key, type: n.type, agent: n.agent, critic: n.critic,
    deps: JSON.parse(n.depends_on) as string[], status: n.status,
    costCents: n.cost_cents, rounds: n.rounds_used, artifact: n.artifact,
    error: n.error, startedAt: n.started_at, finishedAt: n.finished_at,
  };
}

function goalView(g: GoalRow, store: Store): GoalView {
  return {
    id: g.id, slug: g.slug, title: g.title, department: g.department, lead: g.lead,
    status: g.status, planSummary: g.plan_summary, replansUsed: g.replans_used, error: g.error,
    createdAt: g.created_at, updatedAt: g.updated_at, projectDir: g.project_dir, goalDir: g.goal_dir,
    nodes: store.listNodes(g.id).map(nodeView),
  };
}

export function buildGoalsView(store: Store, limit = 50): GoalView[] {
  return store.listGoals(limit).map((g) => goalView(g, store));
}

export function buildGoalDetail(store: Store, vault: VaultWriter, idOrSlug: string) {
  const g = store.getGoal(idOrSlug) ?? store.getGoalBySlug(idOrSlug);
  if (!g) return null;
  const artifacts = !g.goal_dir ? [] : store.listNodes(g.id)
    .filter((n) => n.artifact)
    .map((n) => ({ file: n.artifact!, content: vault.readGoalArtifact(g.goal_dir!, n.artifact!) ?? "" }));
  return { ...goalView(g, store), artifacts };
}

export function buildBudgetView(guard: SpendGuard) {
  const date = new Date().toISOString().slice(0, 10);
  return { date, spentCents: guard.spentCents(date), capCents: guard.capCents() };
}
```

NOTE: `buildBudgetView` uses the guard's injectable today only for spend; keep the test's `todayFn` alignment by passing `guard.spentCents(date)` with the local date — if the test date mismatches, read the date from a `todayFn` param defaulting to the ISO slice (adjust to `buildBudgetView(guard, todayFn?)` and pass `() => "2026-07-02"` in the test).

Wire the four endpoints in `server.ts` per **Interfaces** (WebDeps gains `goals: GoalEngine; spendGuard: SpendGuard`; POST body ignored; pause/resume/abandon return `{ message: engineMethod(id) }`).

- [ ] **Step 4: Run + typecheck** — `npx vitest run test/goal-endpoints.test.ts && npx tsc --noEmit` → 3 pass, clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/goals-view.ts src/web/server.ts test/goal-endpoints.test.ts
git commit -m "feat(web): /api/goals, /api/goals/<id>, goal controls, /api/budget"
```

---

### Task 11: Full verification, merge, deploy, live smoke

- [ ] **Step 1:** `npx vitest run` — zero failures; note final count vs 742+1 baseline (new tests added, old engine tests ported/retired).
- [ ] **Step 2:** `npx tsc --noEmit && npm run build && (cd ui && npx tsc --noEmit && npm run build)` — clean.
- [ ] **Step 3:** Invariant sweep — explicitly run: `npx vitest run test/playbook-critics.test.ts test/registry-live-tree.test.ts test/code-runner-clamp.test.ts test/money-privacy.test.ts test/lifeops-privacy.test.ts test/bunq-recall-exclusion.test.ts test/email-recall-exclusion.test.ts test/hand-off.test.ts test/route-decision.test.ts` — all green.
- [ ] **Step 4:** Follow superpowers:finishing-a-development-branch → FF merge to main → deploy: `npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`.
- [ ] **Step 5:** Live smoke (token from `.env`):

```bash
TOKEN=$(grep '^AIOS_UI_TOKEN=' .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/budget
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/goals | head -c 300
# Telegram: ask hermes "plan a goal for engineering: <small real goal>" → plan preview posts,
# nodes visible via: curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/goals | python3 -m json.tool | head -60
# /pause <slug> then /resume <slug> from the chat — deterministic replies.
```

- [ ] **Step 6:** Update project memory with outcome + follow-ups for 3b.

---

## Self-Review (done at plan time)

- **Spec coverage:** §1 node model (T2/T5), §2 tables (T1), §3 compiler+parity (T2/T5, retirement T9), §4 planner/validation/preview/replan (T3/T7), §5 scheduler/events/restart (T6), §6 budget (T4/T6/T9 dream-speculate gating), §7 facades+intercepts (T8/T9), §8 privacy (T3 validation + T7 origin threading + T11 pin sweep), §10 migration (T9), §11 error handling (T6/T7), §12 testing (throughout + T11). §9 UI = plan 3b.
- **Placeholder scan:** none — every step carries code or exact instructions; Task 8 Step 4 names its green-commit condition explicitly; Task 9 porting lists name file-by-file dispositions.
- **Type consistency:** `GoalRow/TaskNodeRow/NewTaskNode` (T1) used verbatim in T5–T10; `GraphNodeSpec.deps` (T2) vs schema field `deps` (T7) aligned; `Planner` interface declared in goals.ts (T6) and implemented by `makePlanner` (T7); `createFromPlaybook` param shape = old `createJob` (T6/T8/T9 callers).
- **Known judgment calls:** facade goals discriminated via `plan_summary: "playbook:<name>"` (no schema column — YAGNI); planner never re-reads artifact content on replan (v1); EventFeed/Board string-map updates folded into T9 to keep tsc green (cosmetic UI work stays 3b).
