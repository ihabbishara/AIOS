# Phase 3b — Mission Control Goals UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the board tab with a goals tab — DAG canvas (hand-rolled SVG edges + HUD node boxes), node side panel, goal pause/resume/abandon controls, budget bar in the app header, org-card deep-links to running nodes — and delete the `/api/jobs` transitional compat layer.

**Architecture:** Backend is already live from 3a (`/api/goals`, `/api/goals/<id>`, `POST pause|resume|abandon`, `/api/budget`, `goal.*`/`node.status` SSE events). 3b adds one backend field (`brief` on `GoalNodeView`), deletes the `/api/jobs` compat block, and builds the React side: a pure DAG-layout module (unit-tested from the root suite), a `Goals.tsx` view, and App/Org wiring. Node boxes are absolutely-positioned HTML buttons (reusing `.hud` styling) over an SVG layer that draws bezier edges — hand-rolled, no libraries.

**Tech Stack:** TypeScript, React 19, Tailwind v4 theme tokens (`ui/src/index.css`), vitest (root suite only — ui has no test framework and gets none), existing `usePoll`/`useEvents` hooks.

**Spec:** `docs/superpowers/specs/2026-07-02-phase3-goal-engine-design.md` §9.

## Global Constraints

- No new npm dependencies — root **or** ui. Canvas is hand-rolled SVG + HTML. No zoom/drag/Gantt (spec §13 out of scope).
- Money crosses the API as integer cents (`costCents`, `spentCents`, `capCents`); divide by 100 only at render time.
- Budget dates: render `budget.date` verbatim. NEVER derive a date from `toISOString()`/`new Date()` in the UI — the ledger stamps LOCAL dates.
- Status unions are exact and copied verbatim: goals `"planning" | "running" | "paused-budget" | "paused-user" | "replanning" | "done" | "failed" | "abandoned"`, nodes `"pending" | "ready" | "running" | "done" | "failed" | "skipped"`.
- Node status colors (spec §9): pending dim, ready cyan, running amber sweep, done phosphor, failed alert, skipped struck-through.
- User decisions (2026-07-03): **org stays the default/home tab**; goals takes the board's nav slot. **AIOS_DAILY_BUDGET_USD stays unset** after smoke — budget bar is verified via a temporary env override that MUST be reverted.
- Don't rename agents, touch alias duplication, StructuredOutput allows (`src/agents/runner.ts`, `src/agents/guards/index.ts`), or privacy walls.
- Gates after every task: `npx vitest run` (baseline 771 pass + 1 skip, only grows), `npx tsc --noEmit`, `npm run build`, `cd ui && npx tsc --noEmit && npm run build` — all clean.
- Run vitest from the worktree root only. A worktree under `.claude/worktrees` makes a repo-root `npx vitest run` double-collect the suite (2× counts) — don't be fooled.
- EnterWorktree branches from **origin/main**: commit + push this plan doc to main BEFORE creating the worktree (or rebase the worktree onto local main).
- Deploy after merge: `npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`. Mission Control at `http://localhost:4280`, token via `grep '^AIOS_UI_TOKEN=' .env`.

## File Structure

- Modify: `src/web/goals-view.ts` — add `brief` to `GoalNodeView` + `nodeView()`.
- Modify: `src/web/server.ts` — delete the `/api/jobs` transitional compat block (`goalAsJob` + two handlers).
- Modify: `test/goal-endpoints.test.ts` — pin `brief`.
- Create: `ui/src/views/dag-layout.ts` — pure topological layout (no React, no DOM — importable by root vitest).
- Create: `test/dag-layout.test.ts` — layout unit tests (root suite).
- Create: `ui/src/views/Goals.tsx` — goals list (status buckets), goal detail (header controls + DAG canvas + node side panel).
- Modify: `ui/src/api.ts` — add goal/budget types + endpoints; later delete `StageInfo`/`JobInfo`/`JobDetail` + `api.jobs`/`api.job`.
- Modify: `ui/src/App.tsx` — `board` → `goals` tab, budget bar in header, deep-link state.
- Modify: `ui/src/views/Org.tsx` — agent-card task line deep-links to the running node.
- Delete: `ui/src/views/Board.tsx`, `ui/src/views/JobDetail.tsx`.

Deliberate simplification (note for reviewers): spec §9 says the goal header shows "replan history". The data model records only `replans_used` (no per-replan rows) — the header shows `replans: N` and the Telemetry rail already surfaces `goal.status: replanning` transitions. Building a history table is out of 3b scope.

---

### Task 1: Backend — `brief` on GoalNodeView, delete `/api/jobs` compat

**Files:**
- Modify: `src/web/goals-view.ts:7-26`
- Modify: `src/web/server.ts:157-184` (compat block)
- Test: `test/goal-endpoints.test.ts`

**Interfaces:**
- Consumes: `TaskNodeRow.brief` (exists in `src/store/db.ts`).
- Produces: `GoalNodeView.brief: string` — Task 3's UI types mirror this exactly. `/api/jobs*` now falls through to the server's `404 {"error":"not found"}` fallback (`src/web/server.ts:490`).

- [ ] **Step 1: Write the failing test**

Add to the `describe("goals view builders")` block in `test/goal-endpoints.test.ts`:

```typescript
  it("node views carry the brief for the UI side panel", () => {
    const { store } = seeded();
    const [g] = buildGoalsView(store);
    expect(g.nodes[0].brief).toBe("b");
    expect(g.nodes[1].brief).toBe("b");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/goal-endpoints.test.ts`
Expected: FAIL — `brief` is `undefined` (property missing from view).

- [ ] **Step 3: Add `brief` to the view builder**

In `src/web/goals-view.ts`, change the interface and `nodeView`:

```typescript
export interface GoalNodeView {
  key: string; type: string; agent: string; critic: string | null;
  brief: string;
  deps: string[]; status: string; costCents: number; rounds: number;
  artifact: string | null; error: string | null; startedAt: string | null; finishedAt: string | null;
}
```

```typescript
function nodeView(n: TaskNodeRow): GoalNodeView {
  return {
    key: n.node_key, type: n.type, agent: n.agent, critic: n.critic,
    brief: n.brief,
    deps: JSON.parse(n.depends_on) as string[], status: n.status,
    costCents: n.cost_cents, rounds: n.rounds_used, artifact: n.artifact,
    error: n.error, startedAt: n.started_at, finishedAt: n.finished_at,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/goal-endpoints.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Delete the `/api/jobs` compat block in `src/web/server.ts`**

Remove this entire block (starts at the comment near line 157, through the closing brace of the `jobMatch` handler — `goalAsJob` const, the `/api/jobs` list handler, and the `jobMatch` detail handler):

```typescript
        // Transitional compat: the board UI reads /api/jobs until plan 3b lands the goals tab.
        const goalAsJob = (g: import("../store/db.js").GoalRow) => ({
          id: g.id, slug: g.slug, title: g.title, playbook: g.plan_summary, request: g.request,
          project_dir: g.project_dir, job_dir: g.goal_dir, channel: g.origin_channel, chat_id: g.origin_chat_id,
          status: g.status, error: g.error, created_at: g.created_at, updated_at: g.updated_at,
          stages: store.listNodes(g.id).map((n) => ({
            stage_id: n.node_key, status: n.status, started_at: n.started_at ?? "", finished_at: n.finished_at,
          })),
        });

        if (path === "/api/jobs" && req.method === "GET") {
          const rows = store.listGoals(Number(url.searchParams.get("limit") ?? 50));
          return json(res, 200, rows.map(goalAsJob));
        }

        const jobMatch = /^\/api\/jobs\/([0-9a-f-]+)$/.exec(path);
        if (jobMatch && req.method === "GET") {
          const goal = store.getGoal(jobMatch[1]);
          if (!goal) return json(res, 404, { error: "no such goal" });
          const dir = goal.goal_dir ?? "";
          const files = !dir ? [] : vault.listNotes(`goals/${dir}`).map((rel) => {
            const file = rel.split("/").pop()!;
            return { file, content: vault.readGoalArtifact(dir, file) ?? "" };
          });
          return json(res, 200, { ...goalAsJob(goal), artifacts: files, vaultDir: `goals/${dir}` });
        }
```

Unmatched `/api/jobs*` requests now hit the existing `return json(res, 404, { error: "not found" })` fallback at the bottom of the handler. The board UI still calls `/api/jobs` until Task 4 — a 404 there blanks the board tab in a dev build, which is expected and temporary inside this branch.

- [ ] **Step 6: Full gates**

Run: `npx vitest run && npx tsc --noEmit && npm run build && (cd ui && npx tsc --noEmit && npm run build)`
Expected: suite ≥ 772 pass + 1 skip, everything clean. (UI still compiles — Board/JobDetail talk to `api.jobs` via types, which haven't changed.)

- [ ] **Step 7: Commit**

```bash
git add src/web/goals-view.ts src/web/server.ts test/goal-endpoints.test.ts
git commit -m "feat(web): expose node briefs in goal views; drop /api/jobs compat layer"
```

---

### Task 2: Pure DAG layout module

**Files:**
- Create: `ui/src/views/dag-layout.ts`
- Test: `test/dag-layout.test.ts` (root suite — the module is dependency-free TS, so root vitest and root tsc both digest it)

**Interfaces:**
- Produces (Task 3 imports these exact names from `./dag-layout.js`):
  - `layoutDag(nodes: DagNodeIn[]): DagLayout`
  - `DagNodeIn { key: string; deps: string[] }`
  - `DagBox { key: string; layer: number; row: number; x: number; y: number }`
  - `DagEdge { from: string; to: string; path: string }` (`path` is an SVG `M … C …` bezier)
  - `DagLayout { boxes: DagBox[]; edges: DagEdge[]; width: number; height: number }`
  - constants `BOX_W = 168`, `BOX_H = 64`, `GAP_X = 72`, `GAP_Y = 20`, `PAD = 12`

- [ ] **Step 1: Write the failing tests**

Create `test/dag-layout.test.ts`:

```typescript
// test/dag-layout.test.ts — pure layout math for the goals DAG canvas.
import { describe, it, expect } from "vitest";
import { layoutDag, BOX_W, BOX_H, GAP_X, GAP_Y, PAD } from "../ui/src/views/dag-layout.js";

describe("layoutDag", () => {
  it("lays a linear chain into consecutive layers, one row each", () => {
    const l = layoutDag([
      { key: "a", deps: [] },
      { key: "b", deps: ["a"] },
      { key: "c", deps: ["b"] },
    ]);
    expect(l.boxes.map((b) => [b.key, b.layer, b.row])).toEqual([["a", 0, 0], ["b", 1, 0], ["c", 2, 0]]);
    expect(l.edges).toHaveLength(2);
    expect(l.height).toBe(PAD * 2 + BOX_H);
  });

  it("lays a diamond: parallel nodes share a layer with distinct rows", () => {
    const l = layoutDag([
      { key: "a", deps: [] },
      { key: "b", deps: ["a"] },
      { key: "c", deps: ["a"] },
      { key: "d", deps: ["b", "c"] },
    ]);
    const at = (k: string) => l.boxes.find((b) => b.key === k)!;
    expect([at("a").layer, at("b").layer, at("c").layer, at("d").layer]).toEqual([0, 1, 1, 2]);
    expect([at("b").row, at("c").row]).toEqual([0, 1]);
    expect(l.edges).toHaveLength(4);
    expect(l.width).toBe(PAD * 2 + 3 * BOX_W + 2 * GAP_X);
    expect(l.height).toBe(PAD * 2 + 2 * BOX_H + GAP_Y);
  });

  it("positions boxes on the layer/row grid", () => {
    const l = layoutDag([{ key: "a", deps: [] }, { key: "b", deps: ["a"] }]);
    const b = l.boxes.find((x) => x.key === "b")!;
    expect(b.x).toBe(PAD + BOX_W + GAP_X);
    expect(b.y).toBe(PAD);
  });

  it("emits SVG bezier paths from dep box to node box", () => {
    const l = layoutDag([{ key: "a", deps: [] }, { key: "b", deps: ["a"] }]);
    expect(l.edges[0].from).toBe("a");
    expect(l.edges[0].to).toBe("b");
    expect(l.edges[0].path).toMatch(/^M [\d.]+ [\d.]+ C /);
  });

  it("ignores unknown deps (no edge, layer 0)", () => {
    const l = layoutDag([{ key: "a", deps: ["ghost"] }]);
    expect(l.boxes[0].layer).toBe(0);
    expect(l.edges).toHaveLength(0);
  });

  it("terminates on a (theoretically impossible) cycle", () => {
    const l = layoutDag([{ key: "a", deps: ["b"] }, { key: "b", deps: ["a"] }]);
    expect(l.boxes).toHaveLength(2);
    expect(l.boxes.every((b) => Number.isFinite(b.layer))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/dag-layout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the layout module**

Create `ui/src/views/dag-layout.ts`:

```typescript
// ui/src/views/dag-layout.ts — pure topological layout for goal DAGs (≤12 nodes; spec §9).
// No React/DOM imports: the root test suite exercises this file directly.
export interface DagNodeIn { key: string; deps: string[] }
export interface DagBox { key: string; layer: number; row: number; x: number; y: number }
export interface DagEdge { from: string; to: string; path: string }
export interface DagLayout { boxes: DagBox[]; edges: DagEdge[]; width: number; height: number }

export const BOX_W = 168;
export const BOX_H = 64;
export const GAP_X = 72;
export const GAP_Y = 20;
export const PAD = 12;

/** Layer = longest dependency path from a root; row = arrival order within the layer. */
export function layoutDag(nodes: DagNodeIn[]): DagLayout {
  const known = new Map(nodes.map((n) => [n.key, n]));
  const memo = new Map<string, number>();
  const layerOf = (key: string, trail: Set<string>): number => {
    if (memo.has(key)) return memo.get(key)!;
    if (trail.has(key)) return 0; // defensive: validateGraph rejects cycles upstream
    trail.add(key);
    const deps = (known.get(key)?.deps ?? []).filter((d) => known.has(d));
    const layer = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => layerOf(d, trail)));
    trail.delete(key);
    memo.set(key, layer);
    return layer;
  };

  const rowCounter = new Map<number, number>();
  const boxes: DagBox[] = nodes.map((n) => {
    const layer = layerOf(n.key, new Set());
    const row = rowCounter.get(layer) ?? 0;
    rowCounter.set(layer, row + 1);
    return { key: n.key, layer, row, x: PAD + layer * (BOX_W + GAP_X), y: PAD + row * (BOX_H + GAP_Y) };
  });

  const byKey = new Map(boxes.map((b) => [b.key, b]));
  const edges: DagEdge[] = [];
  for (const n of nodes) {
    for (const d of n.deps) {
      const from = byKey.get(d);
      const to = byKey.get(n.key);
      if (!from || !to) continue;
      const x1 = from.x + BOX_W, y1 = from.y + BOX_H / 2;
      const x2 = to.x, y2 = to.y + BOX_H / 2;
      const bend = Math.max((x2 - x1) / 2, GAP_X / 2);
      edges.push({ from: d, to: n.key, path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` });
    }
  }

  const layers = Math.max(0, ...boxes.map((b) => b.layer)) + 1;
  const rows = Math.max(1, ...rowCounter.values());
  return {
    boxes, edges,
    width: PAD * 2 + layers * BOX_W + (layers - 1) * GAP_X,
    height: PAD * 2 + rows * BOX_H + (rows - 1) * GAP_Y,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/dag-layout.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Full gates** (root tsc must digest the cross-project import; ui tsc must accept the new file)

Run: `npx vitest run && npx tsc --noEmit && (cd ui && npx tsc --noEmit && npm run build)`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/views/dag-layout.ts test/dag-layout.test.ts
git commit -m "feat(ui): pure DAG layout module for goals canvas"
```

---

### Task 3: Goal types in `api.ts` + `Goals.tsx` view

**Files:**
- Modify: `ui/src/api.ts` (additive only — job types/endpoints survive until Task 4)
- Create: `ui/src/views/Goals.tsx`

**Interfaces:**
- Consumes: `layoutDag`/`BOX_W`/`BOX_H` from `./dag-layout.js` (Task 2); `GoalNodeView.brief` (Task 1); `usePoll` from `../hooks.js`; `.hud`/`.hud-amber`/`.hud-cyan`/`.hud-alert`/`.running-sweep`/`.live-dot`/`.label`/`.boot` classes from `ui/src/index.css`.
- Produces (Task 4 relies on): `Goals({ events, target, onConsumeTarget })` component and `GoalTarget { slug: string; nodeKey: string | null }` type exported from `./views/Goals.js`; `api.goals()`, `api.goal(idOrSlug)`, `api.goalAction(idOrSlug, verb)`, `api.budget()` and types `GoalView`, `GoalNodeView`, `GoalDetail`, `BudgetInfo` from `./api.js`.

- [ ] **Step 1: Add goal/budget types + endpoints to `ui/src/api.ts`**

Insert after the `PackView` interface (types mirror `src/web/goals-view.ts` exactly):

```typescript
export interface GoalNodeView {
  key: string; type: string; agent: string; critic: string | null;
  brief: string;
  deps: string[]; status: string; costCents: number; rounds: number;
  artifact: string | null; error: string | null; startedAt: string | null; finishedAt: string | null;
}

export interface GoalView {
  id: string; slug: string; title: string; department: string; lead: string;
  status: string; planSummary: string; replansUsed: number; error: string | null;
  createdAt: string; updatedAt: string; projectDir: string | null; goalDir: string | null;
  nodes: GoalNodeView[];
}

export interface GoalDetail extends GoalView {
  artifacts: Array<{ file: string; content: string }>;
}

export interface BudgetInfo { date: string; spentCents: number; capCents: number | null }
```

Insert into the `api` object after the `agent:` entry:

```typescript
  goals: () => request<GoalView[]>("/api/goals"),
  goal: (idOrSlug: string) => request<GoalDetail>(`/api/goals/${encodeURIComponent(idOrSlug)}`),
  goalAction: (idOrSlug: string, verb: "pause" | "resume" | "abandon") =>
    request<{ message: string }>(`/api/goals/${encodeURIComponent(idOrSlug)}/${verb}`, { method: "POST" }),
  budget: () => request<BudgetInfo>("/api/budget"),
```

- [ ] **Step 2: Create `ui/src/views/Goals.tsx`**

Complete file:

```tsx
// ui/src/views/Goals.tsx — goals tab: status buckets → goal detail with DAG canvas + node side panel.
import { useEffect, useMemo, useState } from "react";
import { api, type GoalView, type GoalNodeView, type StoredEvent } from "../api.js";
import { usePoll } from "../hooks.js";
import { layoutDag, BOX_W, BOX_H } from "./dag-layout.js";

/** Deep-link payload from org agent cards: which goal to open, which node to select. */
export interface GoalTarget { slug: string; nodeKey: string | null }

const BUCKETS: Array<{ title: string; accent: string; match: string[] }> = [
  { title: "Active", accent: "text-amber glow-amber", match: ["planning", "running", "replanning"] },
  { title: "Paused", accent: "text-cyan", match: ["paused-budget", "paused-user"] },
  { title: "Completed", accent: "text-phosphor glow-green", match: ["done"] },
  { title: "Failed", accent: "text-alert", match: ["failed", "abandoned"] },
];

// Spec §9 status palette: pending dim, ready cyan, running amber sweep, done phosphor, failed alert, skipped struck.
const STRIP: Record<string, string> = {
  pending: "bg-panel-2", ready: "bg-cyan", running: "bg-amber live-dot",
  done: "bg-phosphor", failed: "bg-alert", skipped: "bg-dim",
};
const NODE_BOX: Record<string, string> = {
  pending: "hud opacity-40", ready: "hud hud-cyan", running: "hud hud-amber running-sweep",
  done: "hud", failed: "hud hud-alert", skipped: "hud opacity-40",
};
const NODE_TEXT: Record<string, string> = {
  pending: "text-dim", ready: "text-cyan", running: "text-amber",
  done: "text-phosphor", failed: "text-alert", skipped: "text-dim",
};
const GOAL_STATUS_TEXT: Record<string, string> = {
  planning: "text-cyan", running: "text-amber", replanning: "text-amber",
  "paused-budget": "text-cyan", "paused-user": "text-cyan",
  done: "text-phosphor", failed: "text-alert", abandoned: "text-dim",
};

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const ts = (iso: string | null) => (iso ? iso.slice(5, 16).replace("T", " ") : "…");

export function Goals({ events, target, onConsumeTarget }: {
  events: StoredEvent[]; target: GoalTarget | null; onConsumeTarget: () => void;
}) {
  const lastEvt = useMemo(
    () => events.filter((e) => e.event.type.startsWith("goal.") || e.event.type.startsWith("node.")).at(-1)?.id,
    [events],
  );
  const { data: goals } = usePoll(() => api.goals(), [lastEvt]);
  const [selected, setSelected] = useState<string | null>(null);
  const [initialNode, setInitialNode] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setSelected(target.slug);
    setInitialNode(target.nodeKey);
    onConsumeTarget();
  }, [target, onConsumeTarget]);

  if (selected) {
    return (
      <GoalDetailView idOrSlug={selected} events={events} initialNode={initialNode}
        onBack={() => { setSelected(null); setInitialNode(null); }} />
    );
  }

  const inBucket = (match: string[]) => (goals ?? []).filter((g) => match.includes(g.status));

  return (
    <div className="grid grid-cols-4 gap-4 h-full min-h-0">
      {BUCKETS.map(({ title, accent, match }, i) => (
        <section key={title} className="boot flex flex-col min-h-0" style={{ animationDelay: `${i * 80}ms` }}>
          <div className="flex items-baseline gap-2 mb-3">
            <span className={`font-display uppercase tracking-[0.2em] text-[11px] ${accent}`}>{title}</span>
            <span className="text-dim text-[11px]">{inBucket(match).length}</span>
          </div>
          <div className="flex flex-col gap-3 overflow-auto pr-1">
            {inBucket(match).map((g) => <GoalCard key={g.id} goal={g} onClick={() => setSelected(g.id)} />)}
            {inBucket(match).length === 0 && (
              <div className="border border-dashed border-line text-dim text-[11px] p-4 text-center">empty</div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function GoalCard({ goal, onClick }: { goal: GoalView; onClick: () => void }) {
  const hudClass =
    goal.status === "running" || goal.status === "replanning" ? "hud hud-amber running-sweep" :
    goal.status === "failed" ? "hud hud-alert" :
    goal.status.startsWith("paused") ? "hud hud-cyan" : "hud";
  const doneNodes = goal.nodes.filter((n) => n.status === "done").length;
  return (
    <button onClick={onClick} className={`${hudClass} p-3 text-left hover:bg-panel-2 transition-colors`}>
      <div className="text-bright text-[13px] leading-snug">{goal.title}</div>
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[10px] text-cyan">{goal.department} · {goal.lead}</span>
        <span className="text-[10px] text-dim ml-auto">{ts(goal.createdAt)}</span>
      </div>
      {goal.nodes.length > 0 && (
        <div className="flex gap-1 mt-2">
          {goal.nodes.map((n) => (
            <span key={n.key} title={`${n.key}: ${n.status}`} className={`h-1 flex-1 ${STRIP[n.status] ?? "bg-panel-2"}`} />
          ))}
        </div>
      )}
      {(goal.status === "running" || goal.status === "replanning") && (
        <div className="text-[10px] text-amber mt-1">{doneNodes}/{goal.nodes.length} nodes</div>
      )}
      {goal.error && <div className="text-[10px] text-alert mt-1 line-clamp-2">{goal.error}</div>}
    </button>
  );
}

function GoalDetailView({ idOrSlug, events, initialNode, onBack }: {
  idOrSlug: string; events: StoredEvent[]; initialNode: string | null; onBack: () => void;
}) {
  const lastEvt = useMemo(
    () => events.filter((e) => e.event.type.startsWith("goal.") || e.event.type.startsWith("node.")).at(-1)?.id,
    [events],
  );
  const { data: goal, error, reload } = usePoll(() => api.goal(idOrSlug), [idOrSlug, lastEvt]);
  const [selectedNode, setSelectedNode] = useState<string | null>(initialNode);
  const [msg, setMsg] = useState<string | null>(null);
  const [armAbandon, setArmAbandon] = useState(false);

  if (error) {
    return (
      <div className="text-alert text-[12px]">
        error: {error} <button className="text-dim underline" onClick={onBack}>back</button>
      </div>
    );
  }
  if (!goal) return <div className="text-dim">loading…</div>;

  const node = goal.nodes.find((n) => n.key === selectedNode) ?? null;
  const artifact = node?.artifact ? goal.artifacts.find((a) => a.file === node.artifact) ?? null : null;
  const totalCents = goal.nodes.reduce((s, n) => s + n.costCents, 0);

  const act = (verb: "pause" | "resume" | "abandon") => {
    setArmAbandon(false);
    api.goalAction(goal.id, verb)
      .then((r) => { setMsg(r.message); reload(); })
      .catch((e) => setMsg((e as Error).message));
  };

  const canPause = goal.status === "running" || goal.status === "replanning";
  const canResume = goal.status.startsWith("paused");
  const canAbandon = !["done", "failed", "abandoned"].includes(goal.status);

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={onBack} className="text-[11px] text-dim border border-line px-2 py-1 hover:text-fg hover:border-fg">← goals</button>
        <span className="font-display text-bright tracking-wider text-lg">{goal.title}</span>
        <span className={`text-[11px] uppercase tracking-widest ${GOAL_STATUS_TEXT[goal.status] ?? "text-dim"}`}>{goal.status}</span>
        <span className="text-[11px] text-dim">{goal.department} · lead: <span className="text-cyan">{goal.lead}</span></span>
        <span className="text-[11px] text-dim">replans: {goal.replansUsed}</span>
        <span className="text-[11px] text-dim">total: {usd(totalCents)}</span>
        <div className="ml-auto flex gap-2">
          {canPause && <CtlButton label="pause" onClick={() => act("pause")} />}
          {canResume && <CtlButton label="resume" onClick={() => act("resume")} />}
          {canAbandon && (armAbandon
            ? <CtlButton label="confirm abandon?" alert onClick={() => act("abandon")} />
            : <CtlButton label="abandon" alert onClick={() => setArmAbandon(true)} />)}
        </div>
      </div>
      {msg && <div className="text-[11px] text-cyan">{msg}</div>}
      {goal.error && <div className="text-[11px] text-alert">{goal.error}</div>}
      <div className="text-[11px] text-dim">{goal.planSummary}</div>

      <div className="flex gap-4 flex-1 min-h-0">
        <div className="flex-1 min-w-0 overflow-auto">
          <DagCanvas nodes={goal.nodes} selected={selectedNode} onSelect={setSelectedNode} />
        </div>
        {node && <NodePanel node={node} artifact={artifact} onClose={() => setSelectedNode(null)} />}
      </div>
    </div>
  );
}

function CtlButton({ label, alert, onClick }: { label: string; alert?: boolean; onClick: () => void }) {
  const color = alert ? "border-alert text-alert hover:bg-alert" : "border-phosphor text-phosphor hover:bg-phosphor";
  return (
    <button onClick={onClick}
      className={`border px-3 py-1 font-display uppercase tracking-[0.2em] text-[10px] hover:text-void transition-colors ${color}`}>
      {label}
    </button>
  );
}

function DagCanvas({ nodes, selected, onSelect }: {
  nodes: GoalNodeView[]; selected: string | null; onSelect: (key: string) => void;
}) {
  const layout = useMemo(() => layoutDag(nodes.map((n) => ({ key: n.key, deps: n.deps }))), [nodes]);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  return (
    <div className="relative" style={{ width: layout.width, height: layout.height }}>
      <svg className="absolute inset-0 pointer-events-none" width={layout.width} height={layout.height}>
        {layout.edges.map((e) => (
          <path key={`${e.from}→${e.to}`} d={e.path} fill="none" stroke="var(--color-line)" strokeWidth="1.5" />
        ))}
      </svg>
      {layout.boxes.map((b) => {
        const n = byKey.get(b.key)!;
        return (
          <button key={b.key} onClick={() => onSelect(b.key)}
            className={`absolute p-2 text-left overflow-hidden ${NODE_BOX[n.status] ?? "hud"} ${selected === b.key ? "outline outline-1 outline-bright" : ""}`}
            style={{ left: b.x, top: b.y, width: BOX_W, height: BOX_H }}>
            <div className={`text-[11px] truncate font-display tracking-wider ${n.status === "skipped" ? "line-through text-dim" : "text-bright"}`}>
              {n.key}
            </div>
            <div className="text-[10px] text-dim truncate">{n.agent}{n.critic ? ` ⇄ ${n.critic}` : ""}</div>
            <div className={`text-[9px] uppercase tracking-widest ${NODE_TEXT[n.status] ?? "text-dim"}`}>
              {n.type} · {n.status}{n.costCents > 0 ? ` · ${usd(n.costCents)}` : ""}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function NodePanel({ node, artifact, onClose }: {
  node: GoalNodeView; artifact: { file: string; content: string } | null; onClose: () => void;
}) {
  return (
    <aside className="w-80 shrink-0 hud p-4 overflow-auto flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="font-display text-bright tracking-wider">{node.key}</span>
        <span className={`text-[10px] uppercase tracking-widest ${NODE_TEXT[node.status] ?? "text-dim"}`}>
          {node.type} · {node.status}
        </span>
        <button onClick={onClose} className="ml-auto text-dim hover:text-fg text-[11px]">✕</button>
      </div>
      <div className="text-[11px] text-dim">
        agent: <span className="text-cyan">{node.agent}</span>
        {node.critic && <> · critic: <span className="text-violet">{node.critic}</span></>}
      </div>
      <div className="text-[11px] text-dim">
        cost: <span className="text-fg">{usd(node.costCents)}</span> · rounds: <span className="text-fg">{node.rounds}</span>
      </div>
      {(node.startedAt || node.finishedAt) && (
        <div className="text-[10px] text-dim">{ts(node.startedAt)} → {ts(node.finishedAt)}</div>
      )}
      {node.error && <div className="text-[11px] text-alert whitespace-pre-wrap">{node.error}</div>}
      <div>
        <div className="label mb-1">Brief</div>
        <p className="text-[11px] text-fg leading-relaxed whitespace-pre-wrap">{node.brief}</p>
      </div>
      {artifact && (
        <div className="min-h-0">
          <div className="label mb-1">Artifact · {artifact.file}</div>
          <pre className="text-[10px] text-fg whitespace-pre-wrap bg-void border border-line p-2 max-h-64 overflow-auto">
            {artifact.content.slice(0, 8000)}
          </pre>
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 3: Gates** (Goals.tsx is not imported yet — this task only has to compile)

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean. Also `npx vitest run` from repo root: unchanged counts.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts ui/src/views/Goals.tsx
git commit -m "feat(ui): goals view - DAG canvas, node side panel, goal controls"
```

---

### Task 4: Wire goals tab, budget bar, org deep-links; delete board

**Files:**
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/views/Org.tsx`
- Modify: `ui/src/api.ts` (deletions)
- Delete: `ui/src/views/Board.tsx`, `ui/src/views/JobDetail.tsx`

**Interfaces:**
- Consumes: `Goals`/`GoalTarget` (Task 3), `api.budget()`/`BudgetInfo` (Task 3), agent context format `goal:<slug>/<nodeKey>` (set by `src/engine/goals.ts:100`, surfaced verbatim as `OrgAgentCard.currentTask` by `src/web/org-view.ts:82`).
- Produces: `Org` gains prop `onOpenGoal: (slug: string, nodeKey: string | null) => void`.

- [ ] **Step 1: Delete the board**

```bash
git rm ui/src/views/Board.tsx ui/src/views/JobDetail.tsx
```

In `ui/src/api.ts` delete: the `StageInfo`, `JobInfo`, and `JobDetail` interfaces, and the `jobs:` and `job:` entries from the `api` object. (`PackJobView` in Packs stays — it reads `/api/packs`.)

- [ ] **Step 2: Rewire `ui/src/App.tsx`**

Replace the imports of `Board` with `Goals`, extend the react import, add the api types import:

```tsx
import { useMemo, useState } from "react";
import { api, setToken, getToken, type BudgetInfo } from "./api.js";
import { useEvents, usePoll } from "./hooks.js";
import { Goals, type GoalTarget } from "./views/Goals.js";
```

(keep the other view imports; drop the `Board` line entirely.)

Replace the TABS line — `goals` takes board's slot, org stays first/home:

```tsx
const TABS = ["org", "chat", "routing", "goals", "approvals", "trust", "permissions", "departments", "config", "costs"] as const;
```

Inside `App()`, add deep-link state + budget poll after the existing `usePoll` line:

```tsx
  const [goalTarget, setGoalTarget] = useState<GoalTarget | null>(null);
  const openGoal = (slug: string, nodeKey: string | null) => { setGoalTarget({ slug, nodeKey }); setTab("goals"); };
  // Budget refreshes when costs land (agent.end) or goals transition (pause-budget etc.).
  const lastCostEvt = useMemo(
    () => events.filter((e) => e.event.type === "agent.end" || e.event.type.startsWith("goal.")).at(-1)?.id,
    [events],
  );
  const { data: budget } = usePoll(() => api.budget(), [lastCostEvt]);
```

In the header, the active-agent chips strip `goal:` contexts too — change the replace regex:

```tsx
              ▸ {agent} <span className="text-dim">{ctx.replace(/^(job|chat|goal):/, "")}</span>
```

Add the budget bar between the agents `<div>` and the LINK `<div>`:

```tsx
        <BudgetBar budget={budget} />
```

Swap the board view for goals in `<main>` and pass the new Org prop:

```tsx
          <div className={tab === "org" ? "h-full" : "hidden"}><Org events={events} onOpenChat={openChat} onOpenGoal={openGoal} /></div>
```

```tsx
          <div className={tab === "goals" ? "h-full" : "hidden"}>
            <Goals events={events} target={goalTarget} onConsumeTarget={() => setGoalTarget(null)} />
          </div>
```

(delete the old `board` div; remove the now-unused `Board` reference.)

Add the component at the bottom of the file (next to `TokenGate`):

```tsx
function BudgetBar({ budget }: { budget: BudgetInfo | undefined }) {
  // Spec §9: hidden entirely when no cap is configured.
  if (!budget || budget.capCents == null) return null;
  const pct = budget.capCents > 0 ? Math.min(100, (budget.spentCents / budget.capCents) * 100) : 100;
  const hot = pct >= 80;
  return (
    <div className="flex items-center gap-2" title={`daily budget · ${budget.date}`}>
      <div className="w-24 h-1.5 bg-panel-2 border border-line">
        <div className={`h-full ${hot ? "bg-alert" : "bg-phosphor"}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-[10px] ${hot ? "text-alert" : "text-dim"}`}>
        ${(budget.spentCents / 100).toFixed(2)} / ${(budget.capCents / 100).toFixed(2)}
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Deep-link from org agent cards (`ui/src/views/Org.tsx`)**

Change the `Org` signature:

```tsx
export function Org({ events, onOpenChat, onOpenGoal }: {
  events: StoredEvent[]; onOpenChat: (name: string) => void; onOpenGoal: (slug: string, nodeKey: string | null) => void;
}) {
```

Replace the `currentTask` line inside the agent card button (card stays a `<button>`; the task line becomes a clickable `<span>` with `stopPropagation` when the context is a goal node — nested `<button>` would be invalid HTML):

```tsx
                {a.currentTask && a.currentTask.startsWith("goal:") ? (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      const [slug, nodeKey] = a.currentTask!.slice("goal:".length).split("/");
                      onOpenGoal(slug, nodeKey ?? null);
                    }}
                    className="block text-[10px] text-amber mt-1 truncate underline decoration-dotted cursor-pointer hover:text-bright"
                  >
                    ▸ {a.currentTask.slice("goal:".length)}
                  </span>
                ) : a.currentTask && (
                  <div className="text-[10px] text-amber mt-1 truncate">▸ {a.currentTask.replace(/^(job|chat):/, "")}</div>
                )}
```

- [ ] **Step 4: Full gates**

Run: `npx vitest run && npx tsc --noEmit && npm run build && (cd ui && npx tsc --noEmit && npm run build)`
Expected: suite ≥ 778 pass + 1 skip, everything clean. `grep -rn "api/jobs\|JobInfo\|StageInfo" ui/src src/web` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add -A ui/src
git commit -m "feat(ui): goals tab replaces board; budget bar; org deep-links to running nodes"
```

---

### Task 5: Review, merge, deploy, live smoke

**Files:** none new — verification + integration.

- [ ] **Step 1: Whole-branch review**

Dispatch the review subagent over the whole branch diff (`git diff main...HEAD`) per superpowers:requesting-code-review. Fix findings, re-run gates, commit fixes.

- [ ] **Step 2: Merge + push** (per superpowers:finishing-a-development-branch — FF merge to main, push, remove worktree)

```bash
git checkout main && git merge --ff-only <branch> && git push
```

- [ ] **Step 3: Deploy**

```bash
npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios
```

- [ ] **Step 4: API smoke**

```bash
TOKEN=$(grep '^AIOS_UI_TOKEN=' .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/jobs        # expect {"error":"not found"}
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/goals | head -c 300   # expect goal list incl. 3a smoke goal, nodes carry "brief"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/budget      # expect {"date":"...","spentCents":N,"capCents":null}
```

- [ ] **Step 5: Browser smoke (browser-harness, new_tab)** — verify on the done 3a goal:
  - goals tab shows the goal under Completed; card node-strip phosphor.
  - open detail: DAG boxes laid in columns, bezier edges, done nodes phosphor.
  - click a node: side panel shows brief, artifact preview, cost, rounds.
  - header shows status/department/lead/replans/total; no budget bar (cap unset).
  - abandon button requires the second "confirm abandon?" click (don't confirm on the done goal — buttons should be absent there; check on a fresh goal below).

- [ ] **Step 6: Budget bar smoke (temporary override — MUST revert)**

```bash
echo 'AIOS_DAILY_BUDGET_USD=5' >> .env && launchctl kickstart -k gui/$(id -u)/com.ihab.aios
```

Reload UI → budget bar visible in header showing `$X.XX / $5.00`. Then revert (user decision: cap stays unset):

```bash
sed -i '' '/^AIOS_DAILY_BUDGET_USD=/d' .env && launchctl kickstart -k gui/$(id -u)/com.ihab.aios
```

Reload UI → bar hidden again.

- [ ] **Step 7: Live goal smoke (~$1)** — via Telegram or chat tab, ask hermes for a small research goal (same shape as the 3a e2e). Verify: running node amber-sweeps on the canvas; org tab shows the agent's `▸ goal:<slug>/<node>` task line underlined; clicking it lands on the goals tab with that node selected; pause → status `paused-user` + cyan card in Paused bucket; resume → completes; costs appear on nodes.

- [ ] **Step 8: Update memory** — record 3b shipped + verified in `aios-project.md` (what was smoke-verified vs not).

---

## Self-Review (done at plan time)

- **Spec §9 coverage:** API ✓ (3a, minus `brief` → Task 1), `/api/jobs`+board removal ✓ (Tasks 1, 4), DAG canvas with topo columns/bezier/status colors ✓ (Tasks 2–3), node side panel (brief/artifact/cost/rounds/error) ✓ (Task 3), goal header controls ✓ (Task 3), replan history → shown as `replans: N` count (documented simplification — no per-replan rows exist in the data model), budget bar hidden-when-null + ≥80% alert ✓ (Task 4), org deep-links ✓ (Task 4), SSE reuse via existing `useEvents` + `usePoll` re-fetch pattern ✓.
- **Placeholder scan:** every code step carries complete code; no TBDs.
- **Type consistency:** `GoalNodeView.brief` (Task 1) mirrors ui type (Task 3); `layoutDag`/`BOX_W`/`BOX_H`/`GoalTarget`/`api.goalAction` names match across Tasks 2–4; `onOpenGoal(slug, nodeKey)` signature identical in App and Org.
