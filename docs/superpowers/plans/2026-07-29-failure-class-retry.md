# Failure-Class Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session-limit hit pauses the goal as `paused-session` (attempt uncounted) with a 30-min auto-probe, and an `error_max_turns` retry runs at 2× the role's turn cap.

**Architecture:** Session class: extend the shared `pausedStatus` map (one place, both journal writers), add `pausedSessionGoals()` + `resumeSessionPaused()` (time-gated by `updated_at`, injectable clock), flip the workers SessionLimitError branch to uncounted. Max-turns class: `RunOptions.maxTurnsFactor` threads workers → makeRunSpecialist → ResolveCtx → `roleQueryOptions`, which multiplies `role.maxTurns`; workers sets factor 2 when the prior attempt's `lastError` contains `error_max_turns`.

**Tech Stack:** TypeScript, node:sqlite Store, vitest, React (ui2). No new dependencies.

## Global Constraints

- Trunk-based: commit to main with explicit `git add <paths>` only — parallel session shares the checkout; `agents/_retired/` stays untracked.
- Suite baseline 195 files / 1523 pass + 2 skip; both roots `npx tsc --noEmit` clean.
- The timeout/abort/api-unreachable branches in `workers.ts` stay byte-identical (pinned by ⑯) — only the SessionLimitError branch changes.
- Never edit existing test fixtures to force a pass; updating an assertion that pins the OLD behavior being deliberately changed (paused-user → paused-session) is the RED step, not fixture-editing.
- New RED tests assert concrete properties (vacuous-import trap).
- Deploy: ui2 build first if touched, then `npm run build && launchctl kickstart -k gui/501/com.ihab.aios`.

---

### Task 1: `paused-session` through both journal writers + store query

**Files:**
- Modify: `src/engine/journal.ts:32-34` (pausedStatus), `src/store/db.ts:7` (GoalStatus) + after `pausedApiGoals` (~:710), `src/engine/project.ts:135` (payload type)
- Create: `test/session-pause.test.ts`

**Interfaces:**
- Produces: `pausedStatus("session") === "paused-session"`; `GoalStatus` includes `"paused-session"`; `store.pausedSessionGoals(): GoalRow[]`. Task 2's engine code and Task 4's attention-view consume all three.

- [ ] **Step 1: Write the failing test** — create `test/session-pause.test.ts`:

```ts
// test/session-pause.test.ts — goal.paused{reason:"session"} lands paused-session in BOTH
// writers (fold + projection) and is queryable (failure-class spec §A3). Two-writer pin.
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { appendEvents, readJournal } from "../src/engine/journal.js";
import { reduce } from "../src/engine/reduce.js";

function pausedSessionStore() {
  const store = new Store(":memory:");
  appendEvents(store, "g1", [
    { type: "goal.created", payload: {
      slug: "build-x", title: "Build X", request: "r", department: "engineering", lead: "athena",
      origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
      planSummary: "planned", goalDir: "d", projectDir: null } },
    { type: "plan.recorded", payload: { summary: "s", needsWorkspace: "none", nodes: [
      { key: "impl", kind: "loop", agent: "clio", critic: "minos", brief: "b", dependsOn: [], maxRounds: 2 },
    ] } },
    { type: "workspace.prepared", payload: { taskDir: null, mode: null } },
    { type: "goal.paused", payload: { reason: "session", error: "Agent hit session limit — re-run after quota resets" } },
  ]);
  return store;
}

describe("paused-session — two-writer pin", () => {
  it("fold phase, projected status, and the store query all agree", () => {
    const store = pausedSessionStore();
    expect(reduce(readJournal(store, "g1")).phase).toBe("paused-session");
    expect(store.getGoal("g1")!.status).toBe("paused-session");
    expect(store.pausedSessionGoals().map((g) => g.id)).toEqual(["g1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/session-pause.test.ts`
Expected: FAIL — `expected 'paused-user' to be 'paused-session'` (unknown reasons fall through to paused-user today) or `store.pausedSessionGoals is not a function`.

- [ ] **Step 3: Minimal implementation** — three edits:

`src/engine/journal.ts` (replace the pausedStatus function):

```ts
export function pausedStatus(reason: string): "paused-budget" | "paused-user" | "paused-api" | "paused-session" {
  return reason === "budget" ? "paused-budget"
    : reason === "api" ? "paused-api"
    : reason === "session" ? "paused-session"
    : "paused-user";
}
```

`src/store/db.ts:7` — add to the GoalStatus union:

```ts
export type GoalStatus = "planning" | "running" | "paused-budget" | "paused-user" | "paused-api" | "paused-session" | "replanning" | "done" | "failed" | "abandoned" | "awaiting-mail";
```

`src/store/db.ts` — after `pausedApiGoals()` (~line 713):

```ts
  pausedSessionGoals(): GoalRow[] {
    return this.db.prepare("SELECT * FROM goals WHERE status = 'paused-session' AND legacy = 0 ORDER BY created_at ASC")
      .all() as unknown as GoalRow[];
  }
```

`src/engine/project.ts:135` — widen the payload type:

```ts
      const p = ev.payload as { reason: "budget" | "user" | "api" | "session"; error?: string };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/session-pause.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/engine/journal.ts src/store/db.ts src/engine/project.ts test/session-pause.test.ts
git commit -m "feat(engine): paused-session status through both journal writers"
```

---

### Task 2: Session-limit → uncounted attempt + session pause + 30-min probe

**Files:**
- Modify: `src/engine/workers.ts:443-446`, `src/engine/engine.ts:271` + after `resumeApiPaused` (~:550), `src/index.ts:753`
- Test: `test/workers.test.ts` (extend existing session-limit test), `test/engine-core.test.ts` (update :243 test + add probe test)

**Interfaces:**
- Consumes: Task 1's `pausedStatus("session")`, `pausedSessionGoals()`.
- Produces: `engine.resumeSessionPaused(now?: () => number): number` — heartbeat calls it with no args; tests inject `now`.

- [ ] **Step 1: Extend the workers test (RED)** — in `test/workers.test.ts`, the existing test at :76 (`"session-limit output → outcome error + sessionLimit flag, run not retried here"`) gains an uncounted assertion. Replace the test body's expectations:

```ts
  it("session-limit output → outcome error + sessionLimit flag, uncounted, run not retried here", async () => {
    let calls = 0;
    const { store, deps, goal } = harness(async () => {
      calls++;
      return { text: "You've hit your session limit — resets at 3pm", costUsd: 0, numTurns: 1 };
    });
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.sessionLimit).toBe(true);
    expect(calls).toBe(1);
    // ⑰ §A1: quota exhaustion is infra, not the agent — the attempt must not count.
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({ outcome: "error", uncounted: true });
  });
```

- [ ] **Step 2: Update + add engine tests (RED)** — in `test/engine-core.test.ts`, replace the :243 test and add the probe test after it:

```ts
  it("session-limit output pauses the goal (paused-session), planner untouched", async () => {
    const run: SpecialistRunFn = async () => ({ text: "You've hit your session limit — resets at 3pm", costUsd: 0, numTurns: 1 });
    const { engine, store, completions } = harness({ run });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("paused-session"));
    expect(completions).toEqual([]);
  });

  it("resumeSessionPaused probes only after 30 min; a reset quota lets the goal finish", async () => {
    let limited = true;
    const { engine, store } = harness({
      run: async () => (limited
        ? { text: "You've hit your session limit — resets at 3pm", costUsd: 0, numTurns: 1 }
        : { text: "out", costUsd: 0.01, numTurns: 1 }),
    });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("paused-session"));

    expect(engine.resumeSessionPaused()).toBe(0); // just paused — the 30-min gate holds
    limited = false;
    expect(engine.resumeSessionPaused(() => Date.now() + 31 * 60_000)).toBe(1);
    // the limited attempt was never counted, so the node still has budget to finish
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/workers.test.ts test/engine-core.test.ts`
Expected: FAIL — workers: `uncounted: true` missing from the payload; engine: status is `paused-user`, and `engine.resumeSessionPaused is not a function`.

- [ ] **Step 4: Implement** — three files:

`src/engine/workers.ts` — the SessionLimitError branch (line 443) becomes uncounted (fourth arg; the ApiUnreachable branch below it is the model and stays untouched):

```ts
    if (err instanceof SessionLimitError) {
      finish("error", err.message, undefined, true);
      return { claimed: true, outcome: "error", sessionLimit: true, apiUnreachable: false };
    }
```

`src/engine/engine.ts:271` — the pause takes the new reason (message verbatim):

```ts
        this.journal(goalId, [{ type: "goal.paused", payload: { reason: "session", error: "Agent hit session limit — re-run after quota resets" } }]);
```

`src/engine/engine.ts` — after `resumeApiPaused` (~line 550), plus a module const near the top of the class file (outside the class, next to other consts):

```ts
/** Minimum age of a session pause before the heartbeat probes it (failure-class spec §A4). */
const SESSION_PROBE_MIN_AGE_MS = 30 * 60_000;
```

```ts
  /** Session quota may have reset — probe goals parked on the limit, at most every 30 min.
   *  A still-limited probe re-pauses uncounted, so the loop costs one spawn per window. */
  resumeSessionPaused(now: () => number = Date.now): number {
    const cutoff = now() - SESSION_PROBE_MIN_AGE_MS;
    const due = this.deps.store.pausedSessionGoals()
      .filter((g) => new Date(g.updated_at).getTime() <= cutoff);
    for (const g of due) this.journal(g.id, [{ type: "goal.resumed", payload: { by: "session-probe" } }]);
    if (due.length) this.tick();
    return due.length;
  }
```

`src/index.ts:753` — add the probe to the heartbeat tick:

```ts
    onTick: () => { goals.resumeBudgetPaused(); goals.resumeApiPaused(); goals.resumeSessionPaused(); },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/workers.test.ts test/engine-core.test.ts test/session-pause.test.ts`
Expected: PASS all.

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/engine/workers.ts src/engine/engine.ts src/index.ts test/workers.test.ts test/engine-core.test.ts
git commit -m "feat(engine): session-limit pauses uncounted with a 30-min auto-probe"
```

---

### Task 3: `maxTurnsFactor` — 2× cap on an error_max_turns retry

**Files:**
- Modify: `src/agents/runner.ts` (RunOptions ~:80, roleQueryOptions :39+:48, makeRunSpecialist resolveAgent ctx ~:140), `src/agents/resolve.ts` (ResolveCtx ~:43, roleQueryOptions call :214), `src/engine/workers.ts` (factor compute + runAgent opts)
- Create: `test/turns-factor.test.ts`
- Test: `test/workers.test.ts` (three factor cases)

**Interfaces:**
- Consumes: `nodeState().lastError` (workers), the SpecialistError message shape `Specialist <role> failed: error_max_turns` (runner:202 formats it).
- Produces: `RunOptions.maxTurnsFactor?: number`; `roleQueryOptions(role, { cwd, model?, maxTurnsFactor? })` multiplies `role.maxTurns`.

- [ ] **Step 1: Runner unit test (RED)** — create `test/turns-factor.test.ts`:

```ts
// test/turns-factor.test.ts — maxTurnsFactor multiplies the manifest cap (failure-class spec §B1).
import { describe, it, expect } from "vitest";
import { roleQueryOptions } from "../src/agents/runner.js";
import type { RoleDef } from "../src/agents/roles/index.js";

const ROLE: RoleDef = {
  name: "t", description: "d", systemPrompt: "p",
  allowedTools: ["Read"], permissionMode: "dontAsk", maxTurns: 30,
};

describe("roleQueryOptions.maxTurnsFactor", () => {
  it("multiplies role.maxTurns; absent factor leaves the cap alone", () => {
    expect(roleQueryOptions(ROLE, { cwd: "/tmp" }).maxTurns).toBe(30);
    expect(roleQueryOptions(ROLE, { cwd: "/tmp", maxTurnsFactor: 2 }).maxTurns).toBe(60);
  });
});
```

- [ ] **Step 2: Workers tests (RED)** — append to `test/workers.test.ts` (inside the `runAttempt — run nodes` describe):

```ts
  it("retry after error_max_turns passes maxTurnsFactor 2 to the run", async () => {
    const factors: Array<number | undefined> = [];
    const { store, deps, goal } = harness(async (_r, _b, opts) => {
      factors.push(opts.maxTurnsFactor);
      return { text: "done now", costUsd: 0, numTurns: 1 };
    });
    appendEvents(store, "g1", [
      { type: "attempt.started", payload: { node: "design", attempt: 1, agent: "athena", deadlineTs: 9e12, idempotencyKey: "g1:design:1" } },
      { type: "attempt.finished", payload: { node: "design", attempt: 1, outcome: "error", costCents: 0, turns: 0, error: "Specialist athena failed: error_max_turns" } },
    ]);
    await runAttempt(goal(), SPEC(), 2, deps);
    expect(factors).toEqual([2]);
  });

  it("attempt 1, and retries after non-turn errors, pass no factor", async () => {
    const factors: Array<number | undefined> = [];
    const mk = () => harness(async (_r, _b, opts) => {
      factors.push(opts.maxTurnsFactor);
      return { text: "ok", costUsd: 0, numTurns: 1 };
    });
    const a = mk();
    await runAttempt(a.goal(), SPEC(), 1, a.deps);
    const b = mk();
    appendEvents(b.store, "g1", [
      { type: "attempt.started", payload: { node: "design", attempt: 1, agent: "athena", deadlineTs: 9e12, idempotencyKey: "g1:design:1" } },
      { type: "attempt.finished", payload: { node: "design", attempt: 1, outcome: "error", costCents: 0, turns: 0, error: "boom" } },
    ]);
    await runAttempt(b.goal(), SPEC(), 2, b.deps);
    expect(factors).toEqual([undefined, undefined]);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/turns-factor.test.ts test/workers.test.ts`
Expected: FAIL — turns-factor: `maxTurnsFactor` not a known option (60 ≠ 30); workers: `factors` equals `[undefined]` where `[2]` expected.

- [ ] **Step 4: Implement** — three files:

`src/agents/runner.ts` — RunOptions gains the field (after `outputSchema`, ~:94):

```ts
  /** Multiplies role.maxTurns for this run (error_max_turns retry class — failure-class
   *  spec §B). Only ever ≥ 1; the manifest cap stays private to the runner. */
  maxTurnsFactor?: number;
```

`roleQueryOptions` signature (:39) and the maxTurns line (:48):

```ts
export function roleQueryOptions(role: RoleDef, opts: { cwd: string; model?: string; maxTurnsFactor?: number }): Options {
```

```ts
    maxTurns: Math.ceil(role.maxTurns * (opts.maxTurnsFactor ?? 1)),
```

`makeRunSpecialist` — thread it into the resolve ctx (~:140):

```ts
    const resolved = deps.resolveAgent(roleName, opts.origin ?? DEFAULT_ORIGIN, {
      cwd: opts.cwd, workspace: opts.workspace,
      idempotencyKey: opts.idempotencyKey, model: opts.model,
      maxTurnsFactor: opts.maxTurnsFactor,
      onDeny: (tool, reason) => collect(tool, reason, "guard"),
    });
```

`src/agents/resolve.ts` — ResolveCtx gains (after `model`):

```ts
  /** Multiplies role.maxTurns (error_max_turns retry class — failure-class spec §B). */
  maxTurnsFactor?: number;
```

and the roleQueryOptions call (:214):

```ts
    const base = roleQueryOptions(def.role, { cwd: ctx.cwd ?? deps.config.projectsRoot, model, maxTurnsFactor: ctx.maxTurnsFactor });
```

`src/engine/workers.ts` — after the `nodeState` helper definition (~:255), before `finishOrPark`:

```ts
  /** error_max_turns retry class (failure-class spec §B): the same brief with the same cap
   *  would burn this attempt identically, so the retry runs at 2× the role's turn cap. */
  const maxTurnsFactor =
    attempt > 1 && (nodeState()?.lastError ?? "").includes("error_max_turns") ? 2 : undefined;
```

and in `runAgent`'s `deps.run` opts (after the `outputSchema` spread):

```ts
          ...(outputSchema ? { outputSchema } : {}),
          ...(maxTurnsFactor ? { maxTurnsFactor } : {}),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/turns-factor.test.ts test/workers.test.ts`
Expected: PASS all.

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/agents/runner.ts src/agents/resolve.ts src/engine/workers.ts test/turns-factor.test.ts test/workers.test.ts
git commit -m "feat(agents): an error_max_turns retry runs at twice the turn cap"
```

---

### Task 4: Surface `paused-session` (attention queue + ui2)

**Files:**
- Modify: `src/web/attention-view.ts:82` (paused spread), `ui2/src/views/Goals.tsx:176`, `ui2/src/components/ui.tsx:87` (toneOfStatus)
- Test: `test/attention-view.test.ts` (extend the paused-goals test)

**Interfaces:**
- Consumes: Task 1's `pausedSessionGoals()`.

- [ ] **Step 1: Extend the attention test (RED)** — in `test/attention-view.test.ts`, replace the `"surfaces paused-budget and paused-user goals regardless of age"` test:

```ts
  it("surfaces paused-budget, paused-user and paused-session goals regardless of age", () => {
    const store = new Store(":memory:");
    store.insertGoal(goal("gb"));
    store.updateGoalStatus("gb", "paused-budget");
    store.insertGoal(goal("gu"));
    store.updateGoalStatus("gu", "paused-user");
    store.insertGoal(goal("gs"));
    store.updateGoalStatus("gs", "paused-session");
    const future = () => new Date(Date.now() + 72 * 3_600_000);
    const items = buildAttentionView(store, undefined, future);
    expect(items.map((i) => i.ref.status).sort()).toEqual(["paused-budget", "paused-session", "paused-user"]);
    expect(items.every((i) => i.actions.includes("resume"))).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/attention-view.test.ts`
Expected: FAIL — only two statuses returned; `paused-session` missing.

- [ ] **Step 3: Implement** — `src/web/attention-view.ts:82`:

```ts
  for (const g of [...failed, ...store.pausedBudgetGoals(), ...store.pausedApiGoals(), ...store.pausedSessionGoals(), ...pausedUser]) {
```

`ui2/src/views/Goals.tsx:176`:

```tsx
          {["paused-user", "paused-budget", "paused-api", "paused-session"].includes(goal.status) && <Button variant="primary" onClick={() => verb("resume")}>Resume</Button>}
```

`ui2/src/components/ui.tsx:87` — add to the accent list:

```ts
  if (["awaiting-human", "awaiting-mail", "paused-user", "paused-budget", "paused-api", "paused-session", "proposed", "unread"].includes(status)) return "accent";
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/attention-view.test.ts` → PASS.
Run: `(cd ui2 && npx tsc --noEmit && npm run build)` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/attention-view.ts ui2/src/views/Goals.tsx ui2/src/components/ui.tsx test/attention-view.test.ts
git commit -m "feat(web): surface paused-session goals with a resume verb"
```

---

### Task 5: Full verification + deploy

- [ ] **Step 1: Full suite + both typechecks**

Run: `npx vitest run` → ≥ 1527 passed + 2 skipped, 197 files (195 + session-pause + turns-factor).
Run: `npx tsc --noEmit` and `(cd ui2 && npx tsc --noEmit)` → clean.

- [ ] **Step 2: Deploy + sanity**

```bash
(cd ui2 && npm run build)
npm run build && launchctl kickstart -k gui/501/com.ihab.aios
```

Then: `TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)`; `curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4280/api/health | head -c 300` — daemon up.

- [ ] **Step 3: Push**

```bash
git push
```
