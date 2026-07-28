# False-Success Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `run` node must fail its attempt when the agent reports it could not do the work, instead of recording articulate prose as a completed deliverable.

**Architecture:** The worker injects a `WORK_REPORT_SCHEMA` on every `run`-node agent call, using the per-call `opts.outputSchema` seam the runner already supports. An explicit `completed: false` fails the attempt with the blockers as the error; anything else (including a missing or foreign-shaped report) keeps today's behaviour. The saved artifact stays `res.text`, byte-identical to today. The blockers ride back into the retry brief via the existing `NodeState.lastError`, so no new journal event or payload field is introduced.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, `@anthropic-ai/claude-agent-sdk`, node:sqlite.

## Global Constraints

- **No new npm dependencies.** Nothing in this plan needs one.
- **Commit explicitly named paths only** — `git add <path> <path>`, never `git add -A` or `git add .`. A parallel session shares this checkout, and `agents/_retired/` must stay untracked.
- **Trunk-based:** land on `main`. No feature branch.
- **Read the "Tests" summary line** from vitest, not the exit code.
- **Do not widen `isApiErrorOutput`** past `startsWith("api error:")` (`src/engine/workers.ts:42`) — a test pins this.
- **Do not edit any agent YAML.** The schema is injected per call, so no manifest changes and no `scripts/gen-org-golden.ts` regeneration are needed. If you find yourself editing `agents/**`, you have gone off-plan.
- **`AIOS` self-edits are forbidden in place** — `assertInplaceTarget` exists for a reason. This plan is edited by hand in the real repo by the human-driven session, which is the normal path; do not route it through a goal.
- Spec: `docs/superpowers/specs/2026-07-28-false-success-gate-design.md`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/agents/roles/index.ts` | Owns the shared structured-output schemas (`VERDICT_SCHEMA`, `TEST_REPORT_SCHEMA`) | **Modify** — add `WORK_REPORT_SCHEMA` beside them (append after line 56) |
| `src/engine/workers.ts` | Attempt runner; owns the node-kind contracts (`Verdict`, `TestReport`) and the `run` case | **Modify** — add `WorkReport` + `BLOCKED_PREFIX`, give `runAgent` a schema parameter, gate the `run` case |
| `test/workers.test.ts` | Worker behaviour tests (26 today) | **Modify** — add one `describe` block of 8 tests |

Deliberately **not** touched: `src/agents/registry/loader.ts` (`SCHEMA_BY_NAME` is for manifest-declared schemas; this one is per-call), `src/engine/reduce.ts`, `src/engine/journal.ts`, `src/engine/decide.ts`, `src/engine/plan.ts`, and every file under `agents/`.

---

## Task 1: The contract and the plumbing

**Files:**
- Modify: `src/agents/roles/index.ts:56` (append after `TEST_REPORT_SCHEMA`)
- Modify: `src/engine/workers.ts:47` (add `WorkReport` beside `TestReport`), `src/engine/workers.ts:162` (`runAgent` signature) and `:167-179` (the `deps.run` call)
- Test: `test/workers.test.ts`

**Interfaces:**
- Consumes: `RunOptions.outputSchema?: Record<string, unknown>` (`src/agents/runner.ts:79`) — already exists, already honoured at `runner.ts:142`.
- Produces: `WORK_REPORT_SCHEMA` (exported const, `src/agents/roles/index.ts`); `interface WorkReport { completed: boolean; summary: string; blockers: string[] }` (exported, `src/engine/workers.ts`); `runAgent(role: string, brief: string, outputSchema?: Record<string, unknown>)` (local to `runAttempt`).

- [ ] **Step 1: Write the failing test**

Append to `test/workers.test.ts` (end of file):

```ts
describe("run nodes demand a work report", () => {
  it("passes WORK_REPORT_SCHEMA to the agent on a run node", async () => {
    let seen: unknown;
    const { deps, goal } = harness(async (_r, _b, opts) => {
      seen = (opts as { outputSchema?: unknown }).outputSchema;
      return { text: "the design", costUsd: 0.01, numTurns: 1 };
    });
    await runAttempt(goal(), SPEC(), 1, deps);
    expect(seen).toBe(WORK_REPORT_SCHEMA);
  });
});
```

Add the imports at the top of the file — `WORK_REPORT_SCHEMA` comes from the roles module, not the worker:

```ts
import { WORK_REPORT_SCHEMA } from "../src/agents/roles/index.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/workers.test.ts -t "passes WORK_REPORT_SCHEMA"`
Expected: FAIL — the import does not resolve (`WORK_REPORT_SCHEMA` is not exported from `src/agents/roles/index.ts`).

- [ ] **Step 3: Add the schema**

Append to `src/agents/roles/index.ts`, directly after `TEST_REPORT_SCHEMA` (which ends at line 56). The `description` fields ARE the instruction to the model — no system prompt is modified anywhere:

```ts
/** Injected per call by the run-node worker (never via a manifest): a run node has no other
 *  way to tell "I produced the deliverable" from "I explained why I could not". Two agents
 *  in goal c03a3bda reported, articulately, that they had applied no fixes — and both nodes
 *  were journaled outcome:ok and consumed downstream. */
export const WORK_REPORT_SCHEMA = {
  type: "object",
  properties: {
    completed: { type: "boolean", description:
      "true only if you actually produced the work this task asked for. false if you refused, were blocked, ran out of information, or produced only a placeholder or a description of what you would have done." },
    summary: { type: "string", description:
      "One or two sentences on what you produced, or on why you could not." },
    blockers: { type: "array", items: { type: "string" }, description:
      "Empty when completed is true. Otherwise one entry per concrete thing that stopped you." },
  },
  required: ["completed", "summary", "blockers"],
  additionalProperties: false,
} as const;
```

- [ ] **Step 4: Add the `WorkReport` interface**

In `src/engine/workers.ts`, extend the existing contract line (currently line 46-47):

```ts
export interface Verdict { verdict: "approve" | "revise"; summary: string; reasons: string[] }
export interface TestReport { passed: boolean; summary: string; failures: string[] }
export interface WorkReport { completed: boolean; summary: string; blockers: string[] }
```

- [ ] **Step 5: Thread the schema through `runAgent`**

In `src/engine/workers.ts`, change the `runAgent` signature (line 162) and add the option to the `deps.run` call (line 167). Everything else in the retry loop is untouched:

```ts
  const runAgent = async (role: string, brief: string, outputSchema?: Record<string, unknown>) => {
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
          ...(outputSchema ? { outputSchema } : {}),
          mailCtx: {
```

- [ ] **Step 6: Pass it from the run case**

In `src/engine/workers.ts`, `case "run"` (line 246) — one argument added, nothing else in the case changes yet:

```ts
        const res = await runAgent(spec.agent, brief, WORK_REPORT_SCHEMA);
```

Add the import at the top of `src/engine/workers.ts` (the file imports no roles module today):

```ts
import { WORK_REPORT_SCHEMA } from "../agents/roles/index.js";
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run test/workers.test.ts -t "passes WORK_REPORT_SCHEMA"`
Expected: PASS (1 passed).

- [ ] **Step 8: Run the whole worker suite and the typechecker**

Run: `npx vitest run test/workers.test.ts && npx tsc --noEmit`
Expected: 27 passed, 0 failed; `tsc` silent. The schema is now sent but nothing reads it, so every existing test must still pass unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/agents/roles/index.ts src/engine/workers.ts test/workers.test.ts
git commit -m "feat(engine): send a work-report schema on every run node

The schema is injected per call rather than declared in any agent
manifest — a work report is a property of being run as a run node,
not of the agent. Nothing reads it yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: The gate

**Files:**
- Modify: `src/engine/workers.ts` — add `BLOCKED_PREFIX` near the other module constants (beside `ARTIFACT_CHAR_LIMIT`, line 17), and the gate inside `case "run"` (after the empty-output guard, line 253)
- Test: `test/workers.test.ts`

**Interfaces:**
- Consumes: `WorkReport`, `WORK_REPORT_SCHEMA` from Task 1; the existing `finish(outcome, error?, final?)` closure (`src/engine/workers.ts:~215`) and `save(file, text, agent)`.
- Produces: `export const BLOCKED_PREFIX = "did not complete: "` — Task 3 reads it back off `NodeState.lastError`, and the tests import it rather than retyping the literal.

- [ ] **Step 1: Write the failing tests**

Add these five tests inside the `describe("run nodes demand a work report", ...)` block created in Task 1:

```ts
  it("completed:false fails the attempt with the blockers, and never completes the node", async () => {
    // Goal c03a3bda, verbatim: clio reported "I could not apply any fixes — the target files do
    // not exist" and the engine journaled outcome:ok + node.completed. Twice.
    const { store, deps, goal } = harness(async () => ({
      text: "I could not apply any fixes — the target files do not exist and I have exhausted the tool budget locating them.",
      structured: { completed: false, summary: "blocked", blockers: ["deck-full.md does not exist", "Bash is not in my allowlist"] },
      costUsd: 0.15, numTurns: 10,
    }));
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.outcome).toBe("error");
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({
      outcome: "error",
      error: "did not complete: deck-full.md does not exist; Bash is not in my allowlist",
    });
    expect(journalTypes(store)).not.toContain("node.completed");
  });

  it("completed:false with no blockers falls back to the summary, then to a fixed string", async () => {
    const { store, deps, goal } = harness(async () => ({
      text: "I can't do this — the premise is wrong.",
      structured: { completed: false, summary: "the premise is wrong", blockers: [] },
      costUsd: 0.1, numTurns: 6,
    }));
    await runAttempt(goal(), SPEC(), 1, deps);
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({
      error: "did not complete: the premise is wrong",
    });

    const bare = harness(async () => ({
      text: "nope", structured: { completed: false }, costUsd: 0.1, numTurns: 1,
    }));
    await runAttempt(bare.goal(), SPEC(), 1, bare.deps);
    expect(payloadOf(bare.store, "attempt.finished")[0]).toMatchObject({
      error: "did not complete: no reason given",
    });
  });

  it("completed:true saves res.text byte-identically — the report never reaches the artifact", async () => {
    const { store, vault, deps, goalDir, goal } = harness(async () => ({
      text: "# The design\n\nThree layers.",
      structured: { completed: true, summary: "wrote the design", blockers: [] },
      costUsd: 0.05, numTurns: 2,
    }));
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.outcome).toBe("ok");
    const ref = (payloadOf(store, "node.completed")[0] as { artifactRef: string }).artifactRef;
    const saved = vault.readGoalArtifact(goalDir, ref)!;
    expect(saved).toContain("# The design\n\nThree layers.");
    expect(saved).not.toContain("wrote the design");
  });

  it("no structured report completes the node (lenient) and logs which node did so", async () => {
    const lines: string[] = [];
    const { store, deps, goal } = harness(async () => ({ text: "the design", costUsd: 0.05, numTurns: 2 }));
    deps.log = (l) => lines.push(l);
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.outcome).toBe("ok");
    expect(journalTypes(store)).toContain("node.completed");
    expect(lines.join("\n")).toContain("design: no work report (agent athena)");
  });

  it("a foreign structured shape completes the node — the test is === false, not falsy", async () => {
    // argus carries outputSchema: test-report and minos carries verdict (runner.ts:142 lets the
    // manifest win), so a run node using either returns an object with no `completed` key. Under
    // `!rep.completed` that would error a node whose work was fine — strictly worse than the hole.
    const { store, deps, goal } = harness(async () => ({
      text: "reviewed it",
      structured: { verdict: "approve", summary: "looks right", reasons: [] },
      costUsd: 0.05, numTurns: 2,
    }));
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.outcome).toBe("ok");
    expect(journalTypes(store)).toContain("node.completed");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/workers.test.ts -t "work report"`
Expected: FAIL — 3 of the 6 fail. `completed:false fails the attempt` fails with `outcome: "ok"`; the two fallback assertions fail the same way. The lenient, byte-identical and foreign-shape tests already pass (today's behaviour) and must stay passing.

- [ ] **Step 3: Add the constant**

In `src/engine/workers.ts`, beside `ARTIFACT_CHAR_LIMIT` (line 17):

```ts
/** Prefix on the attempt error a `completed:false` work report produces. Exported because the
 *  retry brief reads it back off NodeState.lastError — a string contract between this file and
 *  itself, so both directions are pinned by tests. */
export const BLOCKED_PREFIX = "did not complete: ";
```

- [ ] **Step 4: Write the gate**

In `src/engine/workers.ts`, `case "run"`, immediately after the existing empty-output guard and before `const file = ...`:

```ts
        // `=== false` and NOT `!completed`: an agent carrying its own manifest schema returns a
        // TestReport/Verdict here (runner.ts:142 lets role.outputSchema win), where `completed`
        // is undefined — a truthiness test would error a node whose work was fine.
        const rep = res.structured as Partial<WorkReport> | undefined;
        if (rep?.completed === false) {
          finish("error", `${BLOCKED_PREFIX}${rep.blockers?.join("; ") || rep.summary || "no reason given"}`);
          return { claimed: true, outcome: "error", sessionLimit: false, apiUnreachable: false };
        }
        // ponytail: lenient — a missing report keeps today's rule rather than erroring like
        // verify does (workers.ts:341). The gate now sits in front of EVERY run node, and making
        // the fleet depend on a tool call landing after an 80-turn write risks the ⑬ harm of
        // infrastructure flakiness killing goals. Flip to strict once these log lines go quiet.
        if (!rep) deps.log?.(`${spec.key}: no work report (agent ${spec.agent})`);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/workers.test.ts -t "work report"`
Expected: PASS (6 passed).

- [ ] **Step 6: Run the whole worker suite**

Run: `npx vitest run test/workers.test.ts && npx tsc --noEmit`
Expected: 32 passed, 0 failed; `tsc` silent. In particular `blank output fails the attempt` and the `isApiErrorOutput` block must be untouched and green.

- [ ] **Step 7: Commit**

```bash
git add src/engine/workers.ts test/workers.test.ts
git commit -m "fix(engine): an agent reporting it could not work no longer completes the node

A run node completed on any non-empty text, so two agents in goal
c03a3bda that said, articulately, that they had applied no fixes were
journaled outcome:ok — and the next node consumed the first as fact.

Only an explicit completed:false fails an attempt. A missing or
foreign-shaped report keeps today's behaviour, so an agent carrying its
own manifest schema cannot be failed for lacking a key it never had.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Blockers reach the retry

**Files:**
- Modify: `src/engine/workers.ts` — the brief assembly at the top of `case "run"` (line 245)
- Test: `test/workers.test.ts`

**Interfaces:**
- Consumes: `BLOCKED_PREFIX` (Task 2); the existing `nodeState()` closure (`src/engine/workers.ts:239`), which folds the journal fresh and exposes `NodeState.lastError` (`src/engine/reduce.ts:170`).
- Produces: nothing new. No journal event, no payload field, no reducer change.

- [ ] **Step 1: Write the failing tests**

Add to the same `describe` block:

```ts
  it("a retry after completed:false carries the blockers into the brief", async () => {
    const briefs: string[] = [];
    const { store, deps, goal } = harness(async (_r, brief) => {
      briefs.push(brief);
      return { text: "done now", structured: { completed: true, summary: "ok", blockers: [] }, costUsd: 0.05, numTurns: 2 };
    });
    appendEvents(store, "g1", [{ type: "attempt.finished", payload: {
      node: "design", attempt: 1, outcome: "error", costCents: 15, turns: 10,
      error: "did not complete: deck-full.md does not exist; Bash is not in my allowlist",
    } }]);

    const res = await runAttempt(goal(), SPEC(), 2, deps);
    expect(res.outcome).toBe("ok");
    expect(briefs[0]).toContain("previous attempt reported it could not complete");
    expect(briefs[0]).toContain("deck-full.md does not exist; Bash is not in my allowlist");
    expect(briefs[0]).not.toContain("did not complete:"); // the prefix is ours, not the agent's
  });

  it("a retry after an unrelated error carries nothing extra", async () => {
    // lastError also holds timeouts and wall-clock messages. "Goal wall-time budget exceeded" is
    // always the last symptom, never a cause — feeding it to an agent as a blocker is misdirection.
    for (const priorError of ["timeout", "Goal wall-time budget exceeded", "Specialist clio failed: error_max_turns"]) {
      const briefs: string[] = [];
      const { store, deps, goal } = harness(async (_r, brief) => {
        briefs.push(brief);
        return { text: "done", structured: { completed: true, summary: "ok", blockers: [] }, costUsd: 0.01, numTurns: 1 };
      });
      appendEvents(store, "g1", [{ type: "attempt.finished", payload: {
        node: "design", attempt: 1, outcome: "error", costCents: 0, turns: 0, error: priorError,
      } }]);

      await runAttempt(goal(), SPEC(), 2, deps);
      expect(briefs[0]).not.toContain("previous attempt");
      expect(briefs[0]).not.toContain(priorError);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/workers.test.ts -t "retry after"`
Expected: FAIL — the first test fails on `expect(briefs[0]).toContain("previous attempt reported it could not complete")`; the second already passes (nothing is added today) and must stay passing.

- [ ] **Step 3: Assemble the brief from the prior blockers**

In `src/engine/workers.ts`, replace the first line of `case "run"` (line 245):

```ts
        // A deterministic refusal ("the source file does not exist") re-fails identically if the
        // retry brief is byte-identical, burning the second attempt for nothing. The prefix test
        // is what keeps this honest: lastError also holds timeouts and wall-clock messages, and
        // only errors this file wrote are read back.
        const priorError = nodeState()?.lastError;
        const priorBlockers = priorError?.startsWith(BLOCKED_PREFIX) ? priorError.slice(BLOCKED_PREFIX.length) : "";
        const brief = [
          spec.brief, ctx,
          priorBlockers && `# Your previous attempt reported it could not complete\n${priorBlockers}\n\nResolve these, or report completed:false again with what is still missing.`,
        ].filter(Boolean).join("\n\n");
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/workers.test.ts -t "retry after"`
Expected: PASS (2 passed).

- [ ] **Step 5: Run the full suite and both typecheckers**

Run: `npx vitest run && npx tsc --noEmit`
Expected: read the **Tests** summary line — 191 files, **1475 passed + 2 skipped**. That is the 1467 passing today plus the 8 tests these three tasks add (1 + 5 + 2). Any failure at all is a regression; a passed count below 1475 means a test was overwritten rather than appended. `tsc` silent.

Then the ui2 root: `(cd ui2 && npx tsc --noEmit)` — expected silent. (Nothing in this plan touches ui2; this is the standing two-root check.)

- [ ] **Step 6: Commit**

```bash
git add src/engine/workers.ts test/workers.test.ts
git commit -m "feat(engine): a blocked run node tells its retry what blocked it

Retrying a deterministic refusal with a byte-identical brief re-fails
identically and burns the second attempt. The blockers ride back on
NodeState.lastError, which the reducer already keeps across attempts —
no new event, no payload field. Only errors carrying this file's own
prefix are read back, so a timeout or a wall-clock message never
reaches an agent brief dressed up as a blocker.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Deploy and verify live

**Files:** none — this task builds, deploys, and observes.

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: a live-verified daemon, and the answer to the one open empirical question — whether real agents emit the report at all (the §2 leniency exists precisely because that is unknown).

- [ ] **Step 1: Build and deploy**

```bash
npm run build && launchctl kickstart -k gui/501/com.ihab.aios
```

Expected: build silent, `kickstart` prints nothing on success. (ui2 is untouched, so no `(cd ui2 && npm run build)` is needed.)

- [ ] **Step 2: Confirm no healthy goal was newly broken**

```bash
sqlite3 -header data/aios.sqlite "select gseq,goal_id,substr(payload,1,120) from goal_journal where type='attempt.finished' and payload like '%did not complete%' order by gseq desc limit 10;"
```

Expected immediately after deploy: **zero rows**. A row here before any test goal has run means a healthy node was failed by the gate — stop and investigate before going further.

- [ ] **Step 3: Run a goal whose node cannot succeed**

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 240 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/chat -d '{"target":"","text":"Goal: open the file goals/2026-01-01-does-not-exist/report.md in the vault and rewrite its second paragraph to be one sentence shorter. Single node, no research, no plan — just the edit."}'
```

The file does not exist, so the agent should search, fail, and report it — the exact shape of the c03a3bda failures.

- [ ] **Step 4: Read the journal for that goal**

```bash
sqlite3 -header data/aios.sqlite "select gseq,type,datetime(ts/1000,'unixepoch'),substr(payload,1,220) from goal_journal where goal_id like '<id>%' order by gseq;"
```

Expected, and each is a distinct claim to check:
- an `attempt.finished` with `"outcome":"error"` whose `error` starts `did not complete: ` — **the gate fired**;
- **no** `node.completed` for that node — the false success is closed;
- a second `attempt.started` for the same node — the retry ran;
- the goal ends `goal.failed` naming the node. That is the correct outcome for a genuinely impossible task.

If instead the node completed and the daemon log shows `no work report (agent …)`, the gate did not fire because the model never emitted a report. That is the lenient path working as designed — record it, do not "fix" it by tightening the gate in this cycle. It is the datum the strict-mode decision needs.

- [ ] **Step 5: Check the daemon log for report coverage**

```bash
log show --predicate 'process == "node"' --last 30m 2>/dev/null | grep "no work report" | head
```
or read the launchd stdout path configured for `com.ihab.aios`.

Expected: how often real agents skip the report. Zero occurrences across a few goals is the green light to flip §2 to strict in a later cycle; frequent occurrences mean leniency stays and the upgrade path is a judge agent instead.

- [ ] **Step 6: Push**

```bash
git push origin main
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 The contract (`WORK_REPORT_SCHEMA`, `WorkReport`, deliberately not in `SCHEMA_BY_NAME`) | Task 1, Steps 3–4 |
| §2 The gate — schema passed per call | Task 1, Steps 5–6 |
| §2 The gate — `completed === false` fails the attempt | Task 2, Steps 3–4 |
| §2 The artifact does not change | Task 2, Step 1 (byte-identical test) |
| §2 A missing report is not an error + log line | Task 2, Steps 1, 4 |
| §3 Blockers reach the retry, prefix-filtered | Task 3 |
| §4 Ceilings marked with `ponytail:` comments | Task 2, Step 4 (leniency); the foreign-shape ceiling is carried by the gate comment and its test |
| Security posture (no new permission) | No task — nothing is granted; `runner.ts:143` already widens `StructuredOutput` when a schema is present |
| Testing §1–8 | Tasks 1–3 (8 tests total, mapped 1:1) |
| Live verification | Task 4 |

**Placeholder scan:** none. Every code step carries the literal code; `<id>` in Task 4 Step 4 is a value the previous step produces, not an unfilled blank.

**Type consistency:** `WorkReport` fields (`completed`, `summary`, `blockers`) match the schema's `properties` and `required` exactly, and match every test fixture. `BLOCKED_PREFIX` is written once and read once — the tests assert the literal `"did not complete: "` on both sides so a change to the constant fails loudly rather than silently decoupling writer from reader. `res.structured` is cast to `Partial<WorkReport>`, which is what makes `rep.blockers?.join` and `rep?.completed === false` typecheck without a non-null assertion.
