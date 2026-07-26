# Verify-Stage Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a transient network outage from failing a goal, and make the engine report the error that actually happened.

**Architecture:** The Claude Agent SDK reports connection failures as ordinary *text* rather than by throwing, so the only detection point is a string check on the agent's returned output — the same seam `isSessionLimitOutput` already uses. On detection, `runAgent` retries the call in place twice with backoff (absorbing micro-blips), then throws a typed `ApiUnreachableError`. The engine catches it beside the existing `SessionLimitError` branch and pauses the goal instead of failing it, with the verbatim SDK error as the reason. The attempt is journaled but explicitly not counted toward `maxAttempts`, so repeated outages can never exhaust a node. A heartbeat tick resumes api-paused goals automatically.

**Tech Stack:** TypeScript, Node 23 (`node:sqlite`), vitest, Claude Agent SDK. No new dependencies.

## Global Constraints

- **No new npm dependencies.** Backoff uses `setTimeout`; there is no retry library.
- **Trunk-based on `main`.** Commit after each task. `git add` **explicit paths only** — a parallel session shares this checkout, and `agents/_retired/` must stay untracked.
- Tests live in the root `test/` directory and run under vitest. Builders and validators carry tests; routes in `src/web/server.ts` stay thin and untested.
- Baseline before any change: **191 test files, 1445 passing, 2 skipped.** Read the vitest "Tests" summary line, not the exit code.
- Both typecheck roots must stay clean: `npx tsc --noEmit` at the repo root **and** in `ui2/`.
- The engine is journal-sourced. `reduce()` is a pure fold over the event log — every state change must come from a journaled event so crash-replay reproduces it.
- Deploy is `npm run build && launchctl kickstart -k gui/501/com.ihab.aios`. If `ui2/` is touched, run `cd ui2 && npm run build` **first, then `cd` back** — the Bash working directory persists between commands.

---

### Task 1: Detect an unreachable API

**Files:**
- Modify: `src/engine/workers.ts:19-27` (beside `SessionLimitError` / `SESSION_LIMIT_PATTERNS`)
- Test: `test/workers.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `export class ApiUnreachableError extends Error` and `export function isApiUnreachableOutput(text: string): boolean`. Tasks 2 and 3 use both.

**Why the predicate is narrow:** agents in this codebase legitimately write *about* connection failures — a goal debugging network code can print "connection refused" inside a valid report. Matching that would pause a healthy goal. The real SDK output is the entire agent response and looks exactly like this (observed twice, 175 bytes each):

```
API Error: Unable to connect to API (ConnectionRefused)
```

So the predicate requires the output to **start with** `api error:` *and* contain `unable to connect`.

- [ ] **Step 1: Write the failing test**

Add to `test/workers.test.ts` (top level, after the existing `describe` blocks):

```typescript
describe("isApiUnreachableOutput", () => {
  it("matches the SDK's connection-failure output", () => {
    expect(isApiUnreachableOutput("API Error: Unable to connect to API (ConnectionRefused)")).toBe(true);
    expect(isApiUnreachableOutput("\n  API Error: Unable to connect to API (ConnectionRefused)\n")).toBe(true);
  });

  it("does NOT match an agent writing about connection failures in a real report", () => {
    // This is the false positive that would pause a healthy goal.
    expect(isApiUnreachableOutput(
      "The test suite fails because the client gets ConnectionRefused; we were unable to connect to the API in CI.",
    )).toBe(false);
    expect(isApiUnreachableOutput("Root cause: unable to connect to API when DNS is cold.")).toBe(false);
  });

  it("does not match ordinary agent prose or a session limit", () => {
    expect(isApiUnreachableOutput("Verification passed. 12 tests, 0 failures.")).toBe(false);
    expect(isApiUnreachableOutput("You've hit your session limit")).toBe(false);
  });
});
```

Add `isApiUnreachableOutput` to the existing import from `../src/engine/workers.js` at the top of the file:

```typescript
import { AbortRegistry, runAttempt, ancestorArtifacts, isApiUnreachableOutput, type WorkerDeps } from "../src/engine/workers.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workers.test.ts`
Expected: FAIL — `isApiUnreachableOutput is not a function` (or a tsc/import error).

- [ ] **Step 3: Write minimal implementation**

In `src/engine/workers.ts`, directly below the existing `isSessionLimitOutput` (line 27):

```typescript
export class ApiUnreachableError extends Error {
  readonly name = "ApiUnreachableError";
}

/** The SDK reports connection failures as TEXT, not by throwing, so output is the only signal.
 *  Anchored deliberately: agents legitimately write about "connection refused" inside real
 *  reports, and matching that would pause a healthy goal. The SDK's own output is the whole
 *  response and starts with the error envelope. */
export function isApiUnreachableOutput(text: string): boolean {
  const lower = text.toLowerCase().trimStart();
  return lower.startsWith("api error:") && lower.includes("unable to connect");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workers.test.ts`
Expected: PASS, all 3 new tests green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/workers.ts test/workers.test.ts
git commit -m "feat(engine): detect an unreachable API in agent output"
```

---

### Task 2: Retry in place before giving up

**Files:**
- Modify: `src/engine/workers.ts:96-106` (`WorkerDeps`), `src/engine/workers.ts:134-163` (`runAgent`)
- Test: `test/workers.test.ts`

**Interfaces:**
- Consumes: `isApiUnreachableOutput`, `ApiUnreachableError` (Task 1).
- Produces: `WorkerDeps.sleep?: (ms: number) => Promise<void>` — an injected delay so tests never actually wait. Task 3 relies on `runAgent` throwing `ApiUnreachableError` after retries are exhausted.

**Note on cost accounting:** leave `costCents` / `turns` accumulation exactly where it is (only on the success path). A connection failure costs approximately nothing, and moving the accounting would silently change `SessionLimitError`'s behavior too.

- [ ] **Step 1: Write the failing test**

Add to `test/workers.test.ts`:

```typescript
describe("runAgent — unreachable API", () => {
  const DOWN = "API Error: Unable to connect to API (ConnectionRefused)";

  it("retries in place and succeeds when the blip passes", async () => {
    const slept: number[] = [];
    let calls = 0;
    const { deps, goal, store } = harness(async () => {
      calls++;
      return calls < 3 ? { text: DOWN } : { text: "the design", costUsd: 0.05, numTurns: 2 };
    });
    deps.sleep = async (ms) => { slept.push(ms); };

    const res = await runAttempt(goal(), SPEC(), 1, deps);

    expect(calls).toBe(3);                       // 1 initial + 2 retries
    expect(slept).toEqual([5_000, 15_000]);      // backoff actually applied, in order
    expect(res.outcome).toBe("ok");
    expect(res.apiUnreachable).toBe(false);
    expect(journalTypes(store)).toContain("node.completed");
  });

  it("gives up after the retries and reports apiUnreachable with the verbatim error", async () => {
    const slept: number[] = [];
    let calls = 0;
    const { deps, goal, store } = harness(async () => { calls++; return { text: DOWN }; });
    deps.sleep = async (ms) => { slept.push(ms); };

    const res = await runAttempt(goal(), SPEC(), 1, deps);

    expect(calls).toBe(3);                       // never more than 1 initial + 2 retries
    expect(slept).toEqual([5_000, 15_000]);
    expect(res.apiUnreachable).toBe(true);
    expect(res.outcome).toBe("error");
    const finished = payloadOf(store, "attempt.finished")[0] as { error?: string };
    expect(finished.error).toContain("Unable to connect to API");   // the REAL error, not a paraphrase
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workers.test.ts -t "unreachable API"`
Expected: FAIL — `deps.sleep` is not a known property, and `res.apiUnreachable` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/workers.ts`, add to the `WorkerDeps` interface (after `nodeTimeoutMs: number;`):

```typescript
  /** Injected so tests never actually wait. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
```

Add to the `AttemptResult` interface (after `sessionLimit: boolean;`):

```typescript
  /** The API was unreachable after retries — the engine pauses instead of failing (spec §2). */
  apiUnreachable: boolean;
```

Add near the top of the file, beside the other constants:

```typescript
/** Backoff before each in-place retry of an unreachable API call. */
const API_RETRY_BACKOFF_MS = [5_000, 15_000] as const;
```

Replace the body of `runAgent` (currently `src/engine/workers.ts:134-163`) with:

```typescript
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const runAgent = async (role: string, brief: string) => {
    const context = `goal:${goal.slug}/${spec.key}`;
    deps.onEvent?.({ type: "agent.start", agent: role, context });
    try {
      for (let tryIdx = 0; ; tryIdx++) {
        const res = await deps.run(role, brief, {
          cwd: goal.project_dir ?? process.cwd(),
          signal: controller.signal,
          origin: { channel: goal.origin_channel, chatId: goal.origin_chat_id },
          workspace: deps.workspace,
          idempotencyKey: `${goal.id}:${spec.key}:${attempt}`,
          mailCtx: {
            origin: { channel: goal.origin_channel, chatId: goal.origin_chat_id },
            goalDepth: goal.chain_depth, goalId: goal.id, nodeKey: spec.key,
          },
        });
        // A transient outage must not be charged to the agent. Retry in place for micro-blips;
        // a sustained outage becomes ApiUnreachableError and the engine pauses the goal.
        if (isApiUnreachableOutput(res.text)) {
          if (tryIdx < API_RETRY_BACKOFF_MS.length) {
            await sleep(API_RETRY_BACKOFF_MS[tryIdx]);
            continue;
          }
          deps.onEvent?.({ type: "agent.end", agent: role, context, ok: false });
          throw new ApiUnreachableError(res.text.trim());
        }
        if (isSessionLimitOutput(res.text)) {
          deps.onEvent?.({ type: "agent.end", agent: role, context, ok: false });
          throw new SessionLimitError("Agent hit session limit — re-run after quota resets");
        }
        deps.onEvent?.({ type: "agent.end", agent: role, context, ok: true, costUsd: res.costUsd, turns: res.numTurns });
        costCents += Math.round((res.costUsd ?? 0) * 100);
        turns += res.numTurns ?? 0;
        return res;
      }
    } catch (err) {
      if (!(err instanceof SessionLimitError) && !(err instanceof ApiUnreachableError)) {
        deps.onEvent?.({ type: "agent.end", agent: role, context, ok: false });
      }
      throw err;
    }
  };
```

Now handle the new error in the `catch` at the end of `runAttempt`. Replace the `SessionLimitError` branch (currently `src/engine/workers.ts:310-314`) with:

```typescript
  } catch (err) {
    if (err instanceof SessionLimitError) {
      finish("error", err.message);
      return { claimed: true, outcome: "error", sessionLimit: true, apiUnreachable: false };
    }
    if (err instanceof ApiUnreachableError) {
      finish("error", err.message);
      return { claimed: true, outcome: "error", sessionLimit: false, apiUnreachable: true };
    }
```

Add `apiUnreachable: false` to the **three** other `AttemptResult` returns in this file: the early `!claimed` return (line 127), the `no structured report` return (line 288), and the final success return (line 309), plus the generic error return at the end of the `catch`.

- [ ] **Step 4: Fix the one existing assertion that breaks**

`test/workers.test.ts:46` uses `toEqual` on the whole result, so a new field breaks it. Change:

```typescript
    expect(res).toEqual({ claimed: true, outcome: "ok", sessionLimit: false, apiUnreachable: false });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/workers.test.ts`
Expected: PASS, including the previously-failing assertion at line 46.

- [ ] **Step 6: Commit**

```bash
git add src/engine/workers.ts test/workers.test.ts
git commit -m "feat(engine): retry an unreachable API in place before giving up"
```

---

### Task 3: Pause the goal instead of failing it

**Files:**
- Modify: `src/engine/journal.ts` (add `pausedStatus` helper near `AttemptOutcome`, line ~28)
- Modify: `src/store/db.ts:7` (`GoalStatus` union)
- Modify: `src/engine/reduce.ts:13` (phase union), `src/engine/reduce.ts:249`
- Modify: `src/engine/project.ts:133-136`
- Modify: `src/engine/engine.ts:100-101`, `src/engine/engine.ts:264-266`, `src/engine/engine.ts:442`
- Test: `test/reduce.test.ts`, `test/project.test.ts`, `test/engine-core.test.ts`

**Interfaces:**
- Consumes: `AttemptResult.apiUnreachable` (Task 2).
- Produces: `export function pausedStatus(reason: string): "paused-budget" | "paused-user" | "paused-api"` from `src/engine/journal.ts`. Task 5 uses the `"paused-api"` status.

**Why a distinct status rather than reusing `paused-user`:** the status string is what the UI buckets and what the user reads. Labelling an infrastructure pause as user-initiated is the same provenance loss this cycle exists to remove.

**Why a shared helper:** the ternary `reason === "budget" ? … : …` currently exists in three places (`engine.ts:101`, `project.ts:135`, `reduce.ts:249`). Adding a third reason to each independently is how they drift out of sync.

- [ ] **Step 1: Write the failing test**

Add to `test/reduce.test.ts`, beside the existing `paused-budget` test (~line 134):

```typescript
  it("goal.paused with reason api folds to paused-api", () => {
    const p = reduce([
      ...baseEvents(),
      { type: "goal.paused", payload: { reason: "api", error: "API Error: Unable to connect to API" } },
    ] as never);
    expect(p.phase).toBe("paused-api");
  });
```

(Use whatever the file's existing helper for base events is — mirror the neighbouring `paused-budget` test exactly.)

Add to `test/project.test.ts`, beside the existing pause test (~line 97):

```typescript
  it("goal.paused reason api projects status paused-api with the real error", () => {
    applyEvent(store, "g1", { type: "goal.paused", payload: { reason: "api", error: "API Error: Unable to connect to API (ConnectionRefused)" } } as never);
    expect(store.getGoal("g1")!.status).toBe("paused-api");
    expect(store.getGoal("g1")!.error).toContain("Unable to connect");
  });
```

(Mirror the neighbouring test's call style — the helper may be named differently in that file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/reduce.test.ts test/project.test.ts`
Expected: FAIL — phase/status is `paused-user`, not `paused-api`.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/journal.ts`, after the `AttemptOutcome` type (line 28):

```typescript
/** One mapping from pause reason to goal status. Previously duplicated as a ternary in
 *  engine.ts, project.ts and reduce.ts — a third reason would have drifted between them. */
export function pausedStatus(reason: string): "paused-budget" | "paused-user" | "paused-api" {
  return reason === "budget" ? "paused-budget" : reason === "api" ? "paused-api" : "paused-user";
}
```

In `src/store/db.ts:7`, add `"paused-api"` to the union:

```typescript
export type GoalStatus = "planning" | "running" | "paused-budget" | "paused-user" | "paused-api" | "replanning" | "done" | "failed" | "abandoned" | "awaiting-mail";
```

In `src/engine/reduce.ts:13`, add `"paused-api"` to the phase union. Then replace line 249:

```typescript
      case "goal.paused":
        state.phase = pausedStatus((p as { reason: string }).reason);
        break;
```

Import it: add `pausedStatus` to the existing import from `./journal.js` in `reduce.ts`.

In `src/engine/project.ts:133-136`:

```typescript
    case "goal.paused": {
      const p = ev.payload as { reason: "budget" | "user" | "api"; error?: string };
      store.updateGoalStatus(goalId, pausedStatus(p.reason), p.error);
      return;
    }
```

Import `pausedStatus` from `./journal.js` there too.

In `src/engine/engine.ts:100-101`:

```typescript
        case "goal.paused":
          this.emit({ type: "goal.status", goalId, status: pausedStatus(p.reason as string), error: p.error as string | undefined });
          break;
```

In `src/engine/engine.ts:264-266`, add the api branch beside the session-limit one:

```typescript
      if (res.sessionLimit && this.fold(goalId).phase === "running") {
        this.journal(goalId, [{ type: "goal.paused", payload: { reason: "user", error: "Agent hit session limit — re-run after quota resets" } }]);
      }
      if (res.apiUnreachable && this.fold(goalId).phase === "running") {
        // Infrastructure, not the agent. Pause with the verbatim error; the heartbeat resumes it.
        const lastError = this.deps.store.listNodes(goalId).find((n) => n.node_key === nodeKey)?.error;
        this.journal(goalId, [{ type: "goal.paused", payload: { reason: "api", error: lastError ?? "API unreachable" } }]);
      }
```

In `src/engine/engine.ts:442`, let a human resume an api-paused goal too:

```typescript
    if (g.status !== "paused-user" && g.status !== "paused-budget" && g.status !== "paused-api") return `Goal ${g.slug} is ${g.status} — nothing to resume.`;
```

- [ ] **Step 4: Add the engine-level test**

Add to `test/engine-core.test.ts`, mirroring the existing `paused-budget` test at line ~111:

```typescript
  it("an unreachable API pauses the goal instead of failing it", async () => {
    const { engine, store } = harness({
      run: async () => ({ text: "API Error: Unable to connect to API (ConnectionRefused)" }),
      sleep: async () => {},
    });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("paused-api"));
    expect(store.getGoal(g.id)!.error).toContain("Unable to connect");
  });
```

If the `harness` in that file does not forward a `sleep` option into `WorkerDeps`, thread it through — the engine test must not wait 20 real seconds.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/reduce.test.ts test/project.test.ts test/engine-core.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/journal.ts src/engine/reduce.ts src/engine/project.ts src/engine/engine.ts src/store/db.ts test/reduce.test.ts test/project.test.ts test/engine-core.test.ts
git commit -m "feat(engine): pause on an unreachable API instead of failing the goal"
```

---

### Task 4: Do not count an unreachable attempt

**Files:**
- Modify: `src/engine/journal.ts:78-80` (`AttemptFinishedPayload`)
- Modify: `src/engine/workers.ts:171-184` (`finish`) and the `ApiUnreachableError` catch branch
- Modify: `src/engine/reduce.ts:167`
- Test: `test/reduce.test.ts`

**Interfaces:**
- Consumes: the `ApiUnreachableError` branch from Tasks 2–3.
- Produces: `AttemptFinishedPayload.uncounted?: boolean`.

**Why this is load-bearing:** `maxAttempts` defaults to 2 (`engine.ts:138`). If an unreachable attempt counts, two separate outages exhaust the node and kill the goal — which defeats the entire feature. A paused goal is skipped by `decide()` entirely (`decide.ts:40` requires phase `running`/`awaiting-mail`), so an uncounted attempt cannot busy-retry while paused; on resume the node retries with its budget intact.

- [ ] **Step 1: Write the failing test**

Add to `test/reduce.test.ts`:

```typescript
  it("an uncounted attempt.finished does not consume the node's attempt budget", () => {
    const p = reduce([
      ...baseEvents(),
      { type: "attempt.started", payload: { node: "a", attempt: 1, agent: "athena", deadlineTs: 0, idempotencyKey: "k" } },
      { type: "attempt.finished", payload: { node: "a", attempt: 1, outcome: "error", costCents: 0, turns: 0, error: "API Error: Unable to connect to API", uncounted: true } },
    ] as never);
    const n = p.nodes.get("a")!;
    expect(n.attempts).toBe(0);        // budget intact — a second outage must not kill the goal
    expect(n.lastOutcome).toBe("error");
  });
```

(Mirror the file's existing base-event helper and node key.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/reduce.test.ts -t "uncounted"`
Expected: FAIL — `expected 1 to be 0`.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/journal.ts:78-80`:

```typescript
export interface AttemptFinishedPayload {
  node: string; attempt: number; outcome: AttemptOutcome; costCents: number; turns: number; error?: string;
  /** Infrastructure failure (API unreachable) — journaled for the record, but it must not
   *  consume the node's attempt budget or two outages would exhaust it. */
  uncounted?: boolean;
}
```

In `src/engine/reduce.ts:167`, guard the increment:

```typescript
        if (!fp.uncounted) n.attempts += 1;
```

In `src/engine/workers.ts`, give `finish` an optional flag. Change its signature and the event payload:

```typescript
  const finish = (outcome: AttemptOutcome, error?: string, final?: { artifactRef: string; roundsUsed: number }, uncounted?: boolean): void => {
    const events: EventInput[] = [{
      type: "attempt.finished",
      payload: { node: spec.key, attempt, outcome, costCents, turns, ...(error ? { error } : {}), ...(uncounted ? { uncounted: true } : {}) },
    }];
```

And in the `ApiUnreachableError` catch branch from Task 2:

```typescript
    if (err instanceof ApiUnreachableError) {
      finish("error", err.message, undefined, true);
      return { claimed: true, outcome: "error", sessionLimit: false, apiUnreachable: true };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/reduce.test.ts test/workers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/journal.ts src/engine/reduce.ts src/engine/workers.ts test/reduce.test.ts
git commit -m "fix(engine): an unreachable-API attempt must not consume the attempt budget"
```

---

### Task 5: Resume api-paused goals automatically

**Files:**
- Modify: `src/store/db.ts:705-708` (add `pausedApiGoals()` beside `pausedBudgetGoals()`)
- Modify: `src/engine/engine.ts:509-515` (add `resumeApiPaused()` beside `resumeBudgetPaused()`)
- Modify: `src/index.ts:745` (`onTick`)
- Modify: `src/web/attention-view.ts:65-66`
- Modify: `ui2/src/lib/goal-buckets.ts:16`, `ui2/src/components/ui.tsx:87`, `ui2/src/views/Goals.tsx:171`
- Test: `test/goal-store.test.ts`, `test/engine-core.test.ts`, `test/attention-view.test.ts`

**Interfaces:**
- Consumes: the `"paused-api"` status (Task 3).
- Produces: `Store.pausedApiGoals(): GoalRow[]` and `GoalEngine.resumeApiPaused(): number`.

- [ ] **Step 1: Write the failing test**

Add to `test/engine-core.test.ts`:

```typescript
  it("resumeApiPaused un-pauses api-paused goals and leaves other pauses alone", async () => {
    const { engine, store } = harness({
      run: async () => ({ text: "API Error: Unable to connect to API (ConnectionRefused)" }),
      sleep: async () => {},
    });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("paused-api"));

    expect(engine.resumeApiPaused()).toBe(1);
    expect(store.getGoal(g.id)!.status).not.toBe("paused-api");
  });
```

Add to `test/goal-store.test.ts`, mirroring the existing paused-budget query test (~line 82):

```typescript
  it("pausedApiGoals returns only api-paused, non-legacy goals", () => {
    const s = new Store(":memory:");
    s.insertGoal(goal({ id: "ga", slug: "api-down", status: "paused-api" }));
    s.insertGoal(goal({ id: "gb", slug: "other", status: "paused-budget" }));
    expect(s.pausedApiGoals().map((g) => g.id)).toEqual(["ga"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/engine-core.test.ts test/goal-store.test.ts`
Expected: FAIL — `resumeApiPaused` / `pausedApiGoals` are not functions.

- [ ] **Step 3: Write minimal implementation**

In `src/store/db.ts`, directly after `pausedBudgetGoals()`:

```typescript
  pausedApiGoals(): GoalRow[] {
    return this.db.prepare("SELECT * FROM goals WHERE status = 'paused-api' AND legacy = 0 ORDER BY created_at ASC")
      .all() as unknown as GoalRow[];
  }
```

In `src/engine/engine.ts`, directly after `resumeBudgetPaused()`:

```typescript
  /** The API came back — resume goals parked by an outage. Mirrors resumeBudgetPaused. */
  resumeApiPaused(): number {
    const paused = this.deps.store.pausedApiGoals();
    for (const g of paused) this.journal(g.id, [{ type: "goal.resumed", payload: { by: "api-recovered" } }]);
    if (paused.length) this.tick();
    return paused.length;
  }
```

In `src/index.ts:745`:

```typescript
    onTick: () => { goals.resumeBudgetPaused(); goals.resumeApiPaused(); },
```

In `src/web/attention-view.ts:65-66`, surface api-paused goals like the others:

```typescript
  const pausedUser = store.listGoals(200).filter((g) => g.status === "paused-user" && g.legacy !== 1);
  for (const g of [...failed, ...store.pausedBudgetGoals(), ...store.pausedApiGoals(), ...pausedUser]) {
```

In `ui2/src/lib/goal-buckets.ts:16`:

```typescript
  if (status === "paused-budget" || status === "paused-user" || status === "paused-api" || status === "awaiting-mail") return "waiting";
```

In `ui2/src/components/ui.tsx:87`, add `"paused-api"` to the accent-tone list.

In `ui2/src/views/Goals.tsx:171`:

```typescript
          {["paused-user", "paused-budget", "paused-api"].includes(goal.status) && <Button variant="primary" onClick={() => verb("resume")}>Resume</Button>}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/engine-core.test.ts test/goal-store.test.ts test/attention-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts src/engine/engine.ts src/index.ts src/web/attention-view.ts ui2/src/lib/goal-buckets.ts ui2/src/components/ui.tsx ui2/src/views/Goals.tsx test/engine-core.test.ts test/goal-store.test.ts
git commit -m "feat(engine): resume api-paused goals when connectivity returns"
```

---

### Task 6: Keep the evidence in the no-report error

**Files:**
- Modify: `src/engine/workers.ts:281-289`
- Test: `test/workers.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed downstream.

**Why:** an agent returning prose instead of a `TestReport` is a real failure and must still fail. But the node error `no structured report` threw away the agent's actual output, and reading it required opening the vault. That cost an hour of misdiagnosis on goal `cab8495e`.

- [ ] **Step 1: Write the failing test**

Add to `test/workers.test.ts`:

```typescript
  it("a no-report verify keeps a snippet of what the agent actually said", async () => {
    const { store, deps, goal } = harness(
      async () => ({ text: "I could not find the test command, so I stopped." }),
      [SPEC({ key: "verify", kind: "verify", agent: "argus", critic: "vulcan", maxRounds: 2 })],
    );
    await runAttempt(goal(), SPEC({ key: "verify", kind: "verify", agent: "argus", critic: "vulcan", maxRounds: 2 }), 1, deps);
    const finished = payloadOf(store, "attempt.finished")[0] as { error?: string };
    expect(finished.error).toContain("no structured report");
    expect(finished.error).toContain("could not find the test command");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workers.test.ts -t "no-report verify keeps"`
Expected: FAIL — error is exactly `no structured report`.

- [ ] **Step 3: Write minimal implementation**

Replace `src/engine/workers.ts:281-289`. The verify loop already holds the last runner result; capture its text as it goes. Add `let lastText = "";` immediately before the `while (round < spec.maxRounds …)` loop, and inside the loop after `const res = await runAgent(spec.agent, runnerBrief);` add `lastText = res.text;`. Then:

```typescript
        if (!report) {
          // No parseable TestReport = the verification never ran — a failed attempt,
          // never a silent pass (spec §3). Carry what the agent DID say: reading this
          // error should not require opening the vault.
          const snippet = lastText.trim().replace(/\s+/g, " ").slice(0, 200);
          save(`${spec.key}.md`, "No structured test report produced.", spec.agent);
          appendEvents(store, goal.id, [{ type: "attempt.finished", payload: {
            node: spec.key, attempt, outcome: "error", costCents, turns,
            error: snippet ? `no structured report (last output: "${snippet}")` : "no structured report",
          } }]);
          return { claimed: true, outcome: "error", sessionLimit: false, apiUnreachable: false };
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/workers.ts test/workers.test.ts
git commit -m "fix(engine): keep the agent's output in the no-structured-report error"
```

---

### Task 7: Name the nodes a failure skipped

**Files:**
- Modify: `src/index.ts` (`onGoalComplete`, the `[GOAL-FAILED]` notice)
- Test: none (this is notice-text assembly in the thin daemon wiring; verified live in Task 8)

**Interfaces:**
- Consumes: `outcome.goal` (`GoalRow`) and the store, both already in scope in `onGoalComplete`.
- Produces: nothing consumed downstream.

**Why:** `FailGoal` already journals `node.skipped` for every pending node, so the information exists — it simply never reaches a human. On goal `cab8495e` the review node never ran and noticing that required a sqlite query.

- [ ] **Step 1: Implement**

In `src/index.ts`, inside `onGoalComplete`, after the existing `branchLine` block and before `const notice = …`:

```typescript
    // FailGoal skips every pending node. That already lands in the journal but never reached a
    // human — on cab8495e the review node silently never ran.
    const skipped = outcome.ok ? [] : store.listNodes(goal.id).filter((n) => n.status === "skipped");
    const skippedLine = skipped.length
      ? ` Skipped by the failure: ${skipped.map((n) => `${n.node_key} (${n.agent})`).join(", ")} — these quality gates did NOT run, say so.`
      : "";
```

Then append `${skippedLine}` to the `[GOAL-FAILED]` branch of the `notice` template, directly after `${branchLine}`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no output.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(daemon): a failed goal names the nodes its failure skipped"
```

---

### Task 8: Full verification and deploy

**Files:** none modified.

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: the "Tests" summary line shows **more** than the 1445 baseline (the new tests) and **zero failures**. Read the summary line, not the exit code.

- [ ] **Step 2: Both typecheck roots**

```bash
npx tsc --noEmit
cd ui2 && npx tsc --noEmit && cd ..
```

Expected: both clean.

- [ ] **Step 3: Build ui2 first, then the backend**

ui2 was touched in Task 5, so it must be rebuilt before the backend, and the working directory must be restored:

```bash
(cd ui2 && npm run build)
npm run build
```

Expected: `✓ built in …` from vite, then a silent `tsc`.

- [ ] **Step 4: Deploy and confirm the daemon is up**

```bash
launchctl kickstart -k gui/501/com.ihab.aios
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4280/
```

Expected: `200`.

- [ ] **Step 5: Live-verify the pause path**

The honest check is a real outage, which cannot be scheduled. Verify the reachable half instead: confirm no goal is stuck in `paused-api` from the deploy, and that the new status round-trips through the API.

```bash
sqlite3 -header data/aios.sqlite "select id, slug, status, substr(error,1,80) from goals where status like 'paused%';"
```

Expected: no unexpected `paused-api` rows. If one appears, the predicate is matching healthy output — revisit Task 1 before going further.

- [ ] **Step 6: Commit any fixes and push**

```bash
git push origin main
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Classify an unreachable API (anchored predicate, `ApiUnreachableError`) | Task 1 |
| §2 In-place retry with injected backoff | Task 2 |
| §2 Pause via the `SessionLimitError` seam, reason `api`, verbatim error | Task 3 |
| §2 Attempt must not count toward `maxAttempts` | Task 4 |
| §2 `resumeApiPaused()` on the heartbeat tick | Task 5 |
| §3 Pause reason carries the verbatim error | Task 3 (Step 3, `lastError`) |
| §3 No-report error gains an output snippet | Task 6 |
| §4 `[GOAL-FAILED]` names skipped nodes | Task 7 |
| Testing: predicate false-positive guard | Task 1 (Step 1, second test) |
| Testing: backoff assertion so silent retry-stop fails | Task 2 (`expect(slept).toEqual([5_000, 15_000])`) |
| Testing: attempt not counted | Task 4 |
| Testing: resume leaves other pauses alone | Task 5 |
| Testing: suite + both tsc roots clean | Task 8 |

**Deviation from the spec, deliberate and noted:** the spec suggested reusing the `decide.ts:85` `reviewRetry` cap-bypass to avoid counting the attempt. Task 4 instead adds an `uncounted` flag to `AttemptFinishedPayload` and guards the increment in `reduce.ts`. This is simpler (two lines rather than threading a resume-time flag), keeps `reviewRetry` meaning only what its name says, and is journal-replay safe. The spec's actual requirement — an unreachable attempt must not consume the budget — is met either way.

**Type consistency:** `isApiUnreachableOutput` and `ApiUnreachableError` are named identically in Tasks 1, 2 and 4. `AttemptResult.apiUnreachable` is introduced in Task 2 and consumed in Task 3. `pausedStatus` is introduced in Task 3 and its `"paused-api"` output is consumed in Task 5. `AttemptFinishedPayload.uncounted` is introduced in Task 4 and written by `finish(…, uncounted)` in the same task.

**Known ceiling:** `SessionLimitError` still consumes an attempt — the same latent flaw, deliberately out of scope per the spec's Non-goals, recorded so the inconsistency is findable rather than looking accidental.
