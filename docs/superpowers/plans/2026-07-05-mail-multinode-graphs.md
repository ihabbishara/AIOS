# Mail-spawned Multi-node Graphs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let mail to a department **lead** spawn a real planned multi-node graph (via the existing lead planner), while mail to a specialist keeps today's single-node path.

**Architecture:** `GoalEngine.sweepMail` routes a queued request to the graph path when the recipient is its department's lead. The graph path claims the mail (`status='planning'`), runs the planner async (no chat preview, no workspace), then flips the mail to `spawned`. Report-back and workspace-block move off the `plan_summary` `mail:` prefix onto a new `goals.spawned_by_mail` column, so both single-node and graph mail-goals share one link. A boot reconcile makes the async claim crash-safe.

**Tech Stack:** TypeScript (strict), `node:sqlite` (synchronous, no FTS5), vitest. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-04-mail-multinode-graphs-design.md`

## Global Constraints

- Subscription auth only (`CLAUDE_CODE_OAUTH_TOKEN`); never `ANTHROPIC_API_KEY`. (No new auth code in this plan.)
- `node:sqlite` only — no `better-sqlite3`, no FTS5. Migrations are idempotent `try { ALTER TABLE … } catch {}`.
- No new npm dependencies.
- Integer cents for money (N/A here).
- Runaway bound is **chain-depth cap only** (`AIOS_MAIL_MAX_DEPTH`, default 2). Add **no** new quota or budget cap.
- Mail-graphs get **no code workspace**: `needsWorkspace` forced to `none`; code still enters only via `code_task`.
- Mail-unread semantics stay `status='unread'` (untouched here).
- Single-node specialist-mail behavior must stay observably identical (regression anchor).
- Test baseline before this work: **825 pass + 1 skip**. `npx tsc --noEmit`, backend build, and `cd ui && npm run build` must be clean at merge.
- Run the full suite with `npx vitest run`. Typecheck with `npx tsc --noEmit`.

---

### Task 1: Store layer — `spawned_by_mail` column, `planning` mail status, claim + reconcile

**Files:**
- Modify: `src/store/db.ts` (GoalRow type ~L13-31; MailStatus ~L33; migrations ~L249-254; `insertGoal` ~L471-481; add methods near `resetRunningNodes` ~L581 / `markMailSpawned` ~L664)
- Test: `test/goal-store.test.ts`, `test/mail-store.test.ts`

**Interfaces:**
- Produces:
  - `GoalRow.spawned_by_mail: string | null`
  - `MailStatus` includes `"planning"`
  - `Store.insertGoal(g: Omit<GoalRow, "created_at" | "updated_at" | "spawned_by_mail"> & { spawned_by_mail?: string | null }): void`
  - `Store.claimMailPlanning(id: string): boolean` — atomic `queued → planning`, returns whether it claimed
  - `Store.reconcilePlanningMail(): void` — boot reconcile of `planning` mail

- [ ] **Step 1: Write the failing store tests**

In `test/goal-store.test.ts`, add inside the existing `describe`:

```typescript
  it("insertGoal round-trips spawned_by_mail (defaults null when omitted)", () => {
    const s = new Store(":memory:");
    s.insertGoal({
      id: "g1", slug: "x", title: "X", request: "r", department: "engineering", lead: "athena",
      origin_channel: "t", origin_chat_id: "1", status: "running", project_dir: null, goal_dir: null,
      plan_summary: "", replans_used: 0, chain_depth: 0, error: null,
    });
    expect(s.getGoal("g1")!.spawned_by_mail).toBeNull();
    s.insertGoal({
      id: "g2", slug: "y", title: "Y", request: "r", department: "engineering", lead: "athena",
      origin_channel: "t", origin_chat_id: "1", status: "running", project_dir: null, goal_dir: null,
      plan_summary: "graph", replans_used: 0, chain_depth: 1, error: null, spawned_by_mail: "m9",
    });
    expect(s.getGoal("g2")!.spawned_by_mail).toBe("m9");
  });
```

In `test/mail-store.test.ts`, add a new `describe` (reuse that file's existing mail-insert helper style; a minimal inline insert is shown so this test stands alone):

```typescript
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

describe("mail planning claim + reconcile", () => {
  const insertReq = (s: Store, id: string, status: "queued" | "planning" = "queued") =>
    s.insertMail({
      id, from_agent: "vulcan", to_agent: "athena", kind: "request", body: "do it",
      goal_id: null, origin_channel: "t", origin_chat_id: "1", chain_depth: 1, status, error: null,
    });

  it("claimMailPlanning claims a queued mail exactly once", () => {
    const s = new Store(":memory:");
    insertReq(s, "m1");
    expect(s.claimMailPlanning("m1")).toBe(true);
    expect(s.getMail("m1")!.status).toBe("planning");
    expect(s.claimMailPlanning("m1")).toBe(false); // already claimed
  });

  it("reconcilePlanningMail: goal exists → spawned; none → queued", () => {
    const s = new Store(":memory:");
    insertReq(s, "ma", "planning");
    insertReq(s, "mb", "planning");
    s.insertGoal({
      id: "ga", slug: "ga", title: "G", request: "r", department: "engineering", lead: "athena",
      origin_channel: "t", origin_chat_id: "1", status: "running", project_dir: null, goal_dir: null,
      plan_summary: "graph", replans_used: 0, chain_depth: 1, error: null, spawned_by_mail: "ma",
    });
    s.reconcilePlanningMail();
    expect(s.getMail("ma")).toMatchObject({ status: "spawned", goal_id: "ga" });
    expect(s.getMail("mb")!.status).toBe("queued");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/goal-store.test.ts test/mail-store.test.ts`
Expected: FAIL — `spawned_by_mail` not on the row / `claimMailPlanning` and `reconcilePlanningMail` are not functions.

- [ ] **Step 3: Add the column to `GoalRow`**

In `src/store/db.ts`, in the `GoalRow` interface, after the `chain_depth` field:

```typescript
  chain_depth: number;
  /** Source mail id when this goal was spawned by mail (single-node or graph); null otherwise. */
  spawned_by_mail: string | null;
  error: string | null;
```

- [ ] **Step 4: Add `"planning"` to `MailStatus`**

```typescript
export type MailStatus = "queued" | "planning" | "spawned" | "refused" | "unread" | "read";
```

- [ ] **Step 5: Add the idempotent migration**

In `src/store/db.ts`, next to the existing `chain_depth` migration (~L249-254):

```typescript
    // Migration (mail-graphs): link a goal back to the mail that spawned it.
    try {
      this.db.exec("ALTER TABLE goals ADD COLUMN spawned_by_mail TEXT");
    } catch {
      /* column already exists */
    }
```

- [ ] **Step 6: Widen `insertGoal` to accept + persist `spawned_by_mail`**

Replace the existing `insertGoal` method:

```typescript
  insertGoal(g: Omit<GoalRow, "created_at" | "updated_at" | "spawned_by_mail"> & { spawned_by_mail?: string | null }): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO goals (id, slug, title, request, department, lead, origin_channel, origin_chat_id,
                          status, project_dir, goal_dir, plan_summary, replans_used, chain_depth, spawned_by_mail, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(g.id, g.slug, g.title, g.request, g.department, g.lead, g.origin_channel, g.origin_chat_id,
          g.status, g.project_dir, g.goal_dir, g.plan_summary, g.replans_used, g.chain_depth,
          g.spawned_by_mail ?? null, g.error, now, now);
  }
```

- [ ] **Step 7: Add `claimMailPlanning` and `reconcilePlanningMail`**

In `src/store/db.ts`, near `markMailSpawned` (~L664):

```typescript
  /** Atomically claim a queued request for async planning. Returns false if it was not queued. */
  claimMailPlanning(id: string): boolean {
    const info = this.db.prepare("UPDATE mail SET status = 'planning' WHERE id = ? AND status = 'queued'").run(id);
    return info.changes > 0;
  }

  /** Boot recovery for the async graph path: a 'planning' mail whose goal already committed is
   *  marked spawned; otherwise it is requeued to be re-planned. */
  reconcilePlanningMail(): void {
    const rows = this.db.prepare("SELECT id FROM mail WHERE status = 'planning'").all() as Array<{ id: string }>;
    for (const { id } of rows) {
      const g = this.db.prepare("SELECT id FROM goals WHERE spawned_by_mail = ? LIMIT 1").get(id) as { id: string } | undefined;
      if (g) this.db.prepare("UPDATE mail SET status = 'spawned', goal_id = ? WHERE id = ?").run(g.id, id);
      else this.db.prepare("UPDATE mail SET status = 'queued' WHERE id = ?").run(id);
    }
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/goal-store.test.ts test/mail-store.test.ts`
Expected: PASS.

- [ ] **Step 9: Full suite + typecheck (no regressions from the type change)**

Run: `npx tsc --noEmit && npx vitest run`
Expected: `tsc` clean; suite green (existing `insertGoal` call sites still compile because `spawned_by_mail` is optional in the input).

- [ ] **Step 10: Commit**

```bash
git add src/store/db.ts test/goal-store.test.ts test/mail-store.test.ts
git commit -m "feat(store): spawned_by_mail column + planning mail status (claim/reconcile)"
```

---

### Task 2: Move report-back + workspace-block off the `mail:` prefix onto the column

**Files:**
- Modify: `src/engine/goals.ts` — `insertGoal` wrapper (~L306-322), `startGoal` sandbox gate (~L336), `spawnFromMail` (~L438-457), `mailReport` (~L461), `complete` (~L528), `startPlannedGoal` (~L592-604)
- Modify: `src/web/goals-view.ts` — `buildGoalDetail.spawnedBy` (~L51-56), remove now-unused `MAIL_PREFIX` import
- Test: `test/mail-sweep.test.ts` (assert single-node stamps the column), `test/goal-endpoints.test.ts` or `test/mail-endpoints.test.ts` (spawnedBy still resolves)

This task changes **mechanism only** — single-node mail behavior stays observably identical. After it, report-back and the sandbox block key on `spawned_by_mail`; the `mail:` prefix survives solely as the "fixed single node, don't re-plan" marker.

**Interfaces:**
- Consumes: `Store.insertGoal(..., spawned_by_mail?)` (Task 1)
- Produces:
  - `GoalEngine.startPlannedGoal(p: { …; spawnedByMail?: string; chainDepth?: number }): GoalRow`
  - private `insertGoal(p: { …; chainDepth?: number; spawnedByMail?: string })` stamps the column

- [ ] **Step 1: Write the failing test (single-node stamps the column)**

In `test/mail-sweep.test.ts`, add inside `describe("mail sweep")`:

```typescript
  it("single-node mail-goal stamps spawned_by_mail (report-back keys on it)", async () => {
    const { store, engine } = harness(okRun);
    store.insertMail(reqMail()); // to_agent vulcan = specialist → single node
    engine.pump();
    await flush();
    const goal = store.getGoal(store.getMail("m1")!.goal_id!)!;
    expect(goal.spawned_by_mail).toBe("m1");
    expect(goal.plan_summary).toBe(`${MAIL_PREFIX}m1`); // prefix still present (re-plan marker)
    // report still went back to the sender
    expect(store.unreadMailFor("athena")[0]).toMatchObject({ kind: "report", from_agent: "vulcan" });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/mail-sweep.test.ts -t "stamps spawned_by_mail"`
Expected: FAIL — `goal.spawned_by_mail` is `null` (spawnFromMail does not stamp it yet).

- [ ] **Step 3: Stamp the column in the `insertGoal` wrapper**

In `src/engine/goals.ts`, extend the private `insertGoal` param and the store call:

```typescript
  private insertGoal(p: {
    title: string; request: string; department: string; lead: string;
    origin: { channel: string; chatId: string }; projectDir?: string; planSummary: string;
    chainDepth?: number; spawnedByMail?: string;
  }): GoalRow {
    const id = randomUUID();
    const slug = slugify(p.title);
    this.deps.store.insertGoal({
      id, slug, title: p.title, request: p.request, department: p.department, lead: p.lead,
      origin_channel: p.origin.channel, origin_chat_id: p.origin.chatId,
      status: "running", project_dir: p.projectDir ?? null, goal_dir: null,
      plan_summary: p.planSummary, replans_used: 0, chain_depth: p.chainDepth ?? 0,
      spawned_by_mail: p.spawnedByMail ?? null, error: null,
    });
    const goal = this.deps.store.getGoal(id)!;
    this.emit({ type: "goal.created", goalId: id, title: p.title, department: p.department });
    return goal;
  }
```

- [ ] **Step 4: Stamp it in `spawnFromMail`**

In `spawnFromMail`, the `insertGoal` call gains `spawnedByMail`:

```typescript
      goal = this.insertGoal({
        title, request: m.body, department, lead,
        origin: { channel: m.origin_channel, chatId: m.origin_chat_id },
        planSummary: `${MAIL_PREFIX}${m.id}`, chainDepth: m.chain_depth, spawnedByMail: m.id,
      });
```

- [ ] **Step 5: Switch the sandbox gate + report-back + mailReport lookup onto the column**

In `startGoal`, change the sandbox gate:

```typescript
      const sandbox = goal.spawned_by_mail
        ? undefined
        : await this.deps.prepareSandbox?.(goal, { playbook: pb });
```

In `complete`, change the report-back branch:

```typescript
    if (fresh.spawned_by_mail) {
      this.mailReport(fresh, ok, error, files);
      return;
    }
```

In `mailReport`, change the source-mail lookup:

```typescript
    const src = this.deps.store.getMail(goal.spawned_by_mail!);
```

- [ ] **Step 6: Thread `spawnedByMail` + `chainDepth` through `startPlannedGoal`**

Replace `startPlannedGoal`:

```typescript
  startPlannedGoal(p: {
    title: string; request: string; department: string; lead: string;
    origin: { channel: string; chatId: string }; summary: string;
    nodes: import("../store/db.js").NewTaskNode[]; projectDir?: string; needsWorkspace: string;
    spawnedByMail?: string; chainDepth?: number;
  }): GoalRow {
    const goal = this.insertGoal({
      title: p.title, request: p.request, department: p.department, lead: p.lead,
      origin: p.origin, projectDir: p.projectDir, planSummary: p.summary,
      chainDepth: p.chainDepth, spawnedByMail: p.spawnedByMail,
    });
    this.deps.store.insertNodes(goal.id, p.nodes);
    void this.startGoal(goal);
    return goal;
  }
```

- [ ] **Step 7: Update `buildGoalDetail.spawnedBy` to read the column**

In `src/web/goals-view.ts`, replace the `spawnedBy` block:

```typescript
  const spawnedBy = g.spawned_by_mail
    ? (() => {
        const m = store.getMail(g.spawned_by_mail!);
        return m ? { mailId: m.id, from: m.from_agent } : null;
      })()
    : null;
```

Then remove `MAIL_PREFIX` from the import at the top of the file if it is no longer referenced (it is only used in this block). Check with:

Run: `grep -n MAIL_PREFIX src/web/goals-view.ts`
Expected after edit: no matches → delete `MAIL_PREFIX` from the `from "../engine/goals.js"` import.

- [ ] **Step 8: Run the targeted + endpoint tests**

Run: `npx vitest run test/mail-sweep.test.ts test/goal-endpoints.test.ts test/mail-endpoints.test.ts`
Expected: PASS — single-node tests unchanged in behavior, new column assertion green, `spawnedBy` still resolves.

- [ ] **Step 9: Full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 10: Commit**

```bash
git add src/engine/goals.ts src/web/goals-view.ts test/mail-sweep.test.ts
git commit -m "refactor(mail): report-back + workspace-block key on spawned_by_mail, not plan_summary prefix"
```

---

### Task 3: Planner — `planFromMail` (no preview, no workspace)

**Files:**
- Modify: `src/engine/goals.ts` — `Planner` interface (~L41-44), add `planFromMail`
- Modify: `src/engine/plan.ts` — extract shared `buildValidatedPlan`; add `planFromMail` to the returned planner (~L182-230)
- Test: `test/goal-planner.test.ts`

**Interfaces:**
- Consumes: `GoalEngine.startPlannedGoal(..., spawnedByMail?, chainDepth?)` (Task 2), `MailRow` (from `../store/db.js`)
- Produces: `Planner.planFromMail(engine: GoalEngine, params: { department: string; title: string; request: string; channel: string; chatId: string }, mail: MailRow): Promise<GoalRow>`

- [ ] **Step 1: Write the failing test**

In `test/goal-planner.test.ts`, add a `describe`:

```typescript
import type { MailRow } from "../src/store/db.js";

describe("planFromMail", () => {
  const mail = (over: Partial<MailRow> = {}): MailRow => ({
    id: "m1", from_agent: "odin", to_agent: "athena", kind: "request", body: "do x",
    goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1,
    status: "planning", error: null, created_at: "", read_at: null, ...over,
  });

  it("plans a graph with no preview and no workspace, stamped to the mail", async () => {
    const { engine, store, previews } = harness([GOOD_PLAN]);
    const g = await engine["deps"].planner!.planFromMail(engine, {
      department: "engineering", title: "Do X", request: "do x", channel: "telegram", chatId: "1",
    }, mail());
    expect(previews).toEqual([]);          // no chat preview for mail-origin
    expect(g.spawned_by_mail).toBe("m1");
    expect(g.project_dir).toBeNull();      // no workspace
    expect(g.chain_depth).toBe(1);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(store.listNodes(g.id)).toHaveLength(2);
  });

  it("planner failure propagates (caller refuses the mail)", async () => {
    const bad = { ...GOOD_PLAN, nodes: [{ key: "a", type: "run", agent: "nobody", brief: "x", deps: [] }] };
    const { engine } = harness([bad, bad]);
    await expect(engine["deps"].planner!.planFromMail(engine, {
      department: "engineering", title: "t", request: "r", channel: "t", chatId: "1",
    }, mail())).rejects.toThrow(/planning failed/);
  });
});
```

Note: `engine["deps"].planner` reaches the planner the harness wired via `makePlanner`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/goal-planner.test.ts -t "planFromMail"`
Expected: FAIL — `planner.planFromMail is not a function`.

- [ ] **Step 3: Add `planFromMail` to the `Planner` interface**

In `src/engine/goals.ts`, the `Planner` interface (`MailRow` is already imported at the top of the file):

```typescript
export interface Planner {
  plan(engine: GoalEngine, params: { department: string; title: string; request: string; channel: string; chatId: string }): Promise<GoalRow>;
  planFromMail(engine: GoalEngine, params: { department: string; title: string; request: string; channel: string; chatId: string }, mail: MailRow): Promise<GoalRow>;
  replan(goal: GoalRow, failed: TaskNodeRow, error: string): Promise<void>;
}
```

- [ ] **Step 4: Extract `buildValidatedPlan` and add `planFromMail` in `makePlanner`**

In `src/engine/plan.ts`, add a shared helper just before the `return {` of `makePlanner` (alongside `validateOrExplain`):

```typescript
  const buildValidatedPlan = async (params: { department: string; title: string; request: string; channel: string; chatId: string }) => {
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
    return { dept, raw, specs, origin };
  };
```

Replace the existing `async plan(engine, params)` body to use the helper (behavior unchanged):

```typescript
    async plan(engine, params) {
      const { dept, raw, specs, origin } = await buildValidatedPlan(params);
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
```

Add `planFromMail` right after `plan`:

```typescript
    async planFromMail(engine, params, mail) {
      // Mail-origin: no chat preview (no human waiting) and no workspace (code only via code_task, §2/§5).
      const { dept, raw, specs, origin } = await buildValidatedPlan(params);
      return engine.startPlannedGoal({
        title: params.title, request: params.request, department: params.department, lead: dept.lead,
        origin, summary: raw.summary, nodes: toNewTaskNodes(specs),
        projectDir: undefined, needsWorkspace: "none",
        spawnedByMail: mail.id, chainDepth: mail.chain_depth,
      });
    },
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run test/goal-planner.test.ts`
Expected: PASS (existing planner tests + new `planFromMail` tests).

- [ ] **Step 6: Full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/engine/goals.ts src/engine/plan.ts test/goal-planner.test.ts
git commit -m "feat(planner): planFromMail — plan a graph with no preview, no workspace"
```

---

### Task 4: `sweepMail` routing — lead → graph, claim + spawn + boot reconcile

**Files:**
- Modify: `src/engine/goals.ts` — `sweepMail` (~L414-436), add `spawnGraphFromMail`, `resumeUnfinished` (~L570-576)
- Modify: `src/index.ts` — no code change needed (`resumeUnfinished` already runs at boot ~L618; it will call reconcile). Verify only.
- Test: `test/mail-sweep.test.ts`

**Interfaces:**
- Consumes: `Store.claimMailPlanning`, `Store.reconcilePlanningMail` (Task 1); `Planner.planFromMail` (Task 3)
- Produces: routing behavior; no new exported symbols.

- [ ] **Step 1: Extend the mail-sweep harness to accept a planner + add a graph stub**

In `test/mail-sweep.test.ts`, update imports and the `harness` signature:

```typescript
import { GoalEngine, MAIL_PREFIX, type Planner } from "../src/engine/goals.js";
```

Change `harness` to take an optional planner and pass it through:

```typescript
function harness(run: SpecialistRunFn, capUsd?: number, planner?: Planner) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "ms-vault-")), "AIOS");
  if (capUsd !== undefined) store.budgetAdd(new Date().toISOString().slice(0, 10), Math.round(capUsd * 100));
  const onComplete = vi.fn(async () => {});
  const prepareSandbox = vi.fn(async () => ({ taskDir: "/tmp/should-not-be-used", mode: "build" as const }));
  const engine = new GoalEngine({
    store, vault, run, registry,
    playbooks: new Map(), wallTimeMs: 60_000, maxConcurrentNodes: 2,
    spendGuard: new SpendGuard({ store, capUsd }),
    onComplete,
    resolveDeptFor: () => undefined,
    prepareSandbox,
    primaryChat: PRIMARY,
    mailMaxDepth: 2,
    planner,
  });
  return { store, vault, engine, onComplete, prepareSandbox };
}
```

Add a stub graph planner near the top-level test helpers (after `okRun`):

```typescript
import type { GoalRow, MailRow } from "../src/store/db.js";

// A two-node graph, mirroring production: startPlannedGoal with the mail's provenance, no workspace.
const graphPlanner = (): Planner => ({
  plan: async () => { throw new Error("unused"); },
  replan: async () => {},
  planFromMail: async (engine, params, mail): Promise<GoalRow> => engine.startPlannedGoal({
    title: params.title, request: params.request, department: params.department, lead: "athena",
    origin: { channel: params.channel, chatId: params.chatId }, summary: "graph plan",
    nodes: [
      { node_key: "n1", type: "run", agent: "athena", critic: null, brief: "b", depends_on: [], max_rounds: 1 },
      { node_key: "n2", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: ["n1"], max_rounds: 1 },
    ],
    needsWorkspace: "none", spawnedByMail: mail.id, chainDepth: mail.chain_depth,
  }),
});
```

- [ ] **Step 2: Write the failing routing tests**

Add inside `describe("mail sweep")`:

```typescript
  it("mail to a dept lead spawns a planned graph and reports back once (no workspace)", async () => {
    const { store, engine, onComplete, prepareSandbox } = harness(okRun, undefined, graphPlanner());
    store.insertMail(reqMail({ from_agent: "vulcan", to_agent: "athena" })); // recipient = engineering lead
    engine.pump();
    await flush();
    const m = store.getMail("m1")!;
    expect(m.status).toBe("spawned");
    const goal = store.getGoal(m.goal_id!)!;
    expect(goal.spawned_by_mail).toBe("m1");
    expect(goal.chain_depth).toBe(1);
    expect(goal.project_dir).toBeNull();
    expect(prepareSandbox).not.toHaveBeenCalled();      // engine gate blocks sandbox on spawned_by_mail
    expect(store.listNodes(goal.id)).toHaveLength(2);
    expect(store.getGoal(goal.id)!.status).toBe("done");
    const reports = store.unreadMailFor("vulcan").filter((x) => x.kind === "report");
    expect(reports).toHaveLength(1);                     // exactly one report at the end, not per node
    expect(onComplete).not.toHaveBeenCalled();           // no origin-chat ping
  });

  it("planner failure refuses the lead-mail; the queue keeps draining", async () => {
    const failPlanner: Planner = {
      plan: async () => { throw new Error("unused"); }, replan: async () => {},
      planFromMail: async () => { throw new Error("no plan"); },
    };
    const { store, engine } = harness(okRun, undefined, failPlanner);
    store.insertMail(reqMail({ id: "m1", from_agent: "vulcan", to_agent: "athena" })); // lead → graph (fails)
    store.insertMail(reqMail({ id: "m2", from_agent: "athena", to_agent: "vulcan" })); // specialist → single node
    engine.pump();
    await flush();
    expect(store.getMail("m1")!.status).toBe("refused");
    expect(store.getMail("m1")!.error).toContain("no plan");
    expect(store.getMail("m2")!.status).toBe("spawned");
  });

  it("a lead-mail graph is re-plannable (spawned_by_mail does not block re-plan)", async () => {
    let replans = 0;
    const store2Ref: { store?: Store } = {};
    const rePlanner: Planner = {
      plan: async () => { throw new Error("unused"); },
      async replan(goal, failed) {
        replans++;
        store2Ref.store!.replaceNode(goal.id, failed.node_key,
          { node_key: failed.node_key, type: "run", agent: "athena", critic: null, brief: "retry", depends_on: [], max_rounds: 1 });
      },
      planFromMail: async (engine, params, mail): Promise<GoalRow> => engine.startPlannedGoal({
        title: params.title, request: params.request, department: params.department, lead: "athena",
        origin: { channel: params.channel, chatId: params.chatId }, summary: "graph plan",
        nodes: [{ node_key: "n1", type: "run", agent: "athena", critic: null, brief: "b", depends_on: [], max_rounds: 1 }],
        needsWorkspace: "none", spawnedByMail: mail.id, chainDepth: mail.chain_depth,
      }),
    };
    let calls = 0;
    const flaky: SpecialistRunFn = async () => {
      calls++;
      if (calls <= 2) throw new Error("boom"); // 2 throws (runOnce + retry) => node fails => onNodeFailure
      return { text: "ok", costUsd: 0, numTurns: 1 };
    };
    const { store, engine } = harness(flaky, undefined, rePlanner);
    store2Ref.store = store;
    store.insertMail(reqMail({ from_agent: "vulcan", to_agent: "athena" }));
    engine.pump();
    await vi.waitFor(() => expect(store.getGoal(store.getMail("m1")!.goal_id!)!.status).toBe("done"));
    expect(replans).toBe(1);
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/mail-sweep.test.ts -t "dept lead"`
Expected: FAIL — routing not implemented; a lead-mail currently takes the single-node path (one node, not a graph).

- [ ] **Step 4: Add the routing branch in `sweepMail`**

In `src/engine/goals.ts`, replace the spawn tail of `sweepMail` (the last two lines that call `spawnFromMail` + `startGoal`):

```typescript
      const dept = def.department;
      if (this.deps.planner && this.deps.registry.departments.get(dept)?.lead === canonical) {
        // Mail to a department lead → planned multi-node graph (async). Claim first so a re-entrant
        // pump pass cannot spawn a second goal for the same mail.
        if (this.deps.store.claimMailPlanning(m.id)) void this.spawnGraphFromMail(m, dept);
      } else {
        const goal = this.spawnFromMail(m, canonical, dept);
        void this.startGoal(goal);
      }
```

- [ ] **Step 5: Add `spawnGraphFromMail`**

In `src/engine/goals.ts`, add after `spawnFromMail`:

```typescript
  /** The lead-mail graph path (spec §3). Async: the planner runs LLM calls. On success the mail is
   *  flipped to spawned; on planner failure it is refused (sender-visible), and the pump continues. */
  private async spawnGraphFromMail(m: MailRow, department: string): Promise<void> {
    const title = (m.body.split("\n")[0] ?? "").slice(0, 80) || `mail from ${m.from_agent}`;
    try {
      const goal = await this.deps.planner!.planFromMail(this, {
        department, title, request: m.body, channel: m.origin_channel, chatId: m.origin_chat_id,
      }, m);
      this.deps.store.markMailSpawned(m.id, goal.id);
      this.emit({ type: "mail.spawned", mailId: m.id, goalId: goal.id });
    } catch (err) {
      this.deps.store.refuseMail(m.id, `planning failed: ${(err as Error).message}`);
      this.pump();
    }
  }
```

- [ ] **Step 6: Reconcile `planning` mail at boot in `resumeUnfinished`**

In `src/engine/goals.ts`, add the reconcile as the first line of `resumeUnfinished`:

```typescript
  resumeUnfinished(): number {
    this.deps.store.reconcilePlanningMail();
    this.deps.store.resetRunningNodes();
    const goals = this.deps.store.unfinishedGoals();
    for (const g of goals) if (g.status === "replanning" || g.status === "planning") this.setGoalStatus(g.id, "running");
    this.pump();
    return goals.length;
  }
```

Note the two `"planning"` meanings are distinct: the mail status (reconciled by `reconcilePlanningMail`) and the *goal* status (reset by the existing loop). They do not interact.

- [ ] **Step 7: Run the routing tests to verify they pass**

Run: `npx vitest run test/mail-sweep.test.ts`
Expected: PASS (all routing tests + all existing single-node tests unchanged).

- [ ] **Step 8: Full suite + typecheck + UI build**

Run: `npx tsc --noEmit && npx vitest run && (cd ui && npx tsc --noEmit && npm run build)`
Expected: suite green (≥ 825 + new tests), `tsc` clean, UI build clean.

- [ ] **Step 9: Commit**

```bash
git add src/engine/goals.ts test/mail-sweep.test.ts
git commit -m "feat(mail): route lead-mail to a planned multi-node graph; boot reconcile of planning claims"
```

---

## Self-Review

**Spec coverage:**
- §1 routing (lead vs specialist) → Task 4 Step 4.
- §2 data model (column, `planning` status, claim, reconcile) → Task 1.
- §3 graph spawn (claim → async plan → mark-spawned / refuse) → Task 3 (`planFromMail`) + Task 4 (`spawnGraphFromMail`, claim, boot reconcile).
- §4 report-back on the column, once at the end → Task 2 (`complete`/`mailReport`) + Task 4 test asserts a single report.
- §5 re-plan (graph re-plannable, single-node not) → free from the existing `onNodeFailure` guard; Task 4 re-plan test guards it. Workspace block on the column → Task 2 Step 5; forced-none at plan time → Task 3.
- §6 error handling table → Task 4 (refuse on planner throw; reconcile on crash) + Task 1 (reconcile method).
- §7 tests 1-7 → distributed across Tasks 1-4 (see each task's tests).

**Placeholder scan:** none — every step carries full code or an exact command.

**Type consistency:** `spawned_by_mail` (snake_case, DB row) vs `spawnedByMail` (camelCase, engine/planner param) used consistently; `planFromMail(engine, params, mail)` signature identical in the interface (Task 3 Step 3), the impl (Task 3 Step 4), and the stub (Task 4 Step 1). `claimMailPlanning`/`reconcilePlanningMail` names identical across Task 1 (def) and Task 4 (call).

## Execution Handoff

Plan complete. Two execution options:
1. **Subagent-Driven (recommended)** — a fresh subagent per task, two-stage review between tasks.
2. **Inline Execution** — execute here with checkpoints.
