# Policy-Wall Approval Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A node whose attempt errors while tools were denied parks `needs-review` naming each wall, with an always-supervised `permission.grant` auto-queued for allowlist denials — instead of burning retries.

**Architecture:** One per-run denial collector fed by both observable layers (allowlist observer + guards), carried on `SpecialistResult.denials` / thrown `SpecialistError`. The worker parks via the existing `review.requested` machinery on the first agent-caused error with denials, and calls an injected `proposeGrant` for allowlist-layer denials only. Zero new statuses, events, or APIs.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, node:sqlite.

## Global Constraints

- **No new npm dependencies.**
- **Commit explicitly named paths only** — never `git add -A`; `agents/_retired/` stays untracked.
- **Trunk-based:** land on `main`.
- **Read the vitest "Tests" summary line.** Baseline: 192 files, 1504 passed + 2 skipped.
- **No agent YAML edits, no golden regen.**
- **`permission.grant` stays always-supervised** — nothing in this plan may write `setRolePermission` directly; only the existing gate executor does that.
- The `isApiErrorOutput` predicate and SessionLimit/ApiUnreachable paths keep exact semantics — tests pin them; the park must not touch those branches.
- Spec: `docs/superpowers/specs/2026-07-28-policy-wall-approval-design.md`. One deliberate addition over the spec's `DeniedTool`: a `role` field (populated by the runner from the canonical role name), because loop/verify attempts run two roles and the grant + objection must name the right one.
- Live-test grants must be revoked afterwards through the same gate.
- ui2 untouched this cycle — no ui2 build needed on deploy.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/agents/guards/index.ts` | Guard construction (`guardOptions`) | **Modify** — optional `onDeny` third param, called (deduped) on every deny from both `canUseTool` and the PreToolUse hook |
| `src/agents/resolve.ts` | Per-run agent resolution | **Modify** — `ResolveCtx.onDeny?`, passed to the single `guardOptions` call (line 253) |
| `src/agents/runner.ts` | `makeRunSpecialist` | **Modify** — `DeniedTool`, `SpecialistError`, per-run collector, observer wrap, result attach, throw sites |
| `src/engine/workers.ts` | Attempt runner | **Modify** — per-attempt denial map, `finishOrPark`, 4 call-site conversions, `WorkerDeps.proposeGrant?` |
| `src/engine/engine.ts` | Engine deps | **Modify** — `GoalEngineDeps.proposeGrant?` threaded into the `runAttempt` deps (line 259) |
| `src/kernel/propose-grant.ts` | Dedupe + propose closure | **Create** — `makeGrantProposer(store, gate)` |
| `src/index.ts` | Wiring | **Modify** — pass `makeGrantProposer(store, gate)` into the engine deps |
| `test/guard-deny.test.ts` | Guard `onDeny` unit tests | **Create** |
| `test/workers.test.ts` | Park behaviour | **Modify** — one describe block (6 tests) |
| `test/propose-grant.test.ts` | Dedupe closure | **Create** |
| `test/resolve-agent.test.ts` | `ResolveCtx.onDeny` threading | **Modify** — one test |

---

## Task 1: `guardOptions` gains `onDeny`

**Files:**
- Modify: `src/agents/guards/index.ts:50-104` (`guardOptions`)
- Create: `test/guard-deny.test.ts`

**Interfaces:**
- Produces: `guardOptions(checks, fallback, onDeny?: (tool: string, reason: string) => void)` — existing callers compile unchanged (optional param). Task 2 threads the callback from `ResolveCtx`.

- [ ] **Step 1: Write the failing tests**

Create `test/guard-deny.test.ts`:

```ts
// test/guard-deny.test.ts — guardOptions onDeny: every guard denial reaches the collector,
// once per tool per wiring, from BOTH the canUseTool path and the PreToolUse hook path.
import { describe, it, expect } from "vitest";
import { guardOptions, type ToolCheck } from "../src/agents/guards/index.js";

const denyAll: Record<string, ToolCheck> = {
  Bash: () => ({ ok: false, reason: "advisory context: filesystem/exec disabled — use recall/vault_read" }),
};

// The PreToolUse hook is stored as [{ hooks: [fn] }]
const hookFn = (opts: ReturnType<typeof guardOptions>) =>
  (opts.hooks!.PreToolUse![0] as { hooks: Array<(raw: unknown) => Promise<unknown>> }).hooks[0];

describe("guardOptions onDeny", () => {
  it("fires on a canUseTool deny with the guard's verbatim reason", async () => {
    const seen: Array<[string, string]> = [];
    const opts = guardOptions(denyAll, "allow", (tool, reason) => seen.push([tool, reason]));
    const v = await opts.canUseTool!("Bash", {}, { signal: new AbortController().signal });
    expect(v).toMatchObject({ behavior: "deny" });
    expect(seen).toEqual([["Bash", "advisory context: filesystem/exec disabled — use recall/vault_read"]]);
  });

  it("fires on the PreToolUse-hook deny path, and dedupes per tool across both paths", async () => {
    const seen: string[] = [];
    const opts = guardOptions(denyAll, "allow", (tool) => seen.push(tool));
    await hookFn(opts)({ tool_name: "Bash", tool_input: {} });
    await opts.canUseTool!("Bash", {}, { signal: new AbortController().signal });
    await hookFn(opts)({ tool_name: "Bash", tool_input: {} });
    expect(seen).toEqual(["Bash"]); // one report per tool, however many times it is hit
  });

  it("fires on a fallback-deny for an unlisted tool", async () => {
    const seen: Array<[string, string]> = [];
    const opts = guardOptions({}, "deny", (tool, reason) => seen.push([tool, reason]));
    await opts.canUseTool!("WebSearch", {}, { signal: new AbortController().signal });
    expect(seen).toEqual([["WebSearch", "tool WebSearch is not permitted for this agent"]]);
  });

  it("never fires on allows, and a throwing onDeny never breaks the guard", async () => {
    const opts = guardOptions(denyAll, "allow", () => { throw new Error("collector broke"); });
    const allow = await opts.canUseTool!("Read", {}, { signal: new AbortController().signal });
    expect(allow).toMatchObject({ behavior: "allow" });
    const deny = await opts.canUseTool!("Bash", {}, { signal: new AbortController().signal });
    expect(deny).toMatchObject({ behavior: "deny" }); // deny still returned despite the throw
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/guard-deny.test.ts`
Expected: FAIL — `guardOptions` takes 2 args; the third is ignored, `seen` stays empty.

- [ ] **Step 3: Implement**

In `src/agents/guards/index.ts`, change the `guardOptions` signature and report from the shared `decide` choke point's two callers:

```ts
export function guardOptions(
  checks: Record<string, ToolCheck>,
  fallback: "allow" | "deny",
  onDeny?: (tool: string, reason: string) => void,
): Partial<Options> {
```

Directly after the `decide` definition, add the deduped reporter:

```ts
  // Denial collector seam (policy-wall spec §1): report each denied tool once per wiring so
  // the engine can park the node and name the wall. A collector failure must never affect
  // the guard's verdict.
  const reported = new Set<string>();
  const report = (tool: string, reason: string): void => {
    if (!onDeny || reported.has(tool)) return;
    reported.add(tool);
    try { onDeny(tool, reason); } catch { /* never break a guard */ }
  };
```

In the `canUseTool` deny branch (currently `: { behavior: "deny", message: v.reason ?? "denied by guard" }`):

```ts
      if (!v.ok) report(toolName, v.reason ?? "denied by guard");
      return v.ok
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: v.reason ?? "denied by guard" };
```

In the PreToolUse hook deny branch (before the `return { continue: true, hookSpecificOutput: ... }`):

```ts
              report(input.tool_name ?? "", v.reason ?? "denied by guard");
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/guard-deny.test.ts && npx vitest run test/mail-runner.test.ts && npx tsc --noEmit`
Expected: guard-deny 4 passed; mail-runner untouched green (it calls `guardOptions` with 2 args); tsc silent.

- [ ] **Step 5: Commit**

```bash
git add src/agents/guards/index.ts test/guard-deny.test.ts
git commit -m "feat(agents): guardOptions reports denials to an optional collector

Both the canUseTool path and the PreToolUse hook path report through
one deduped seam; a collector failure never affects the verdict.
Nothing passes a collector yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: The runner collects both layers

**Files:**
- Modify: `src/agents/resolve.ts:34-42` (`ResolveCtx`), `:253` (the `guardOptions` call)
- Modify: `src/agents/runner.ts` (types + `makeRunSpecialist`)
- Test: `test/resolve-agent.test.ts` (one appended test)

**Interfaces:**
- Produces:
  - `export interface DeniedTool { role: string; tool: string; reason: string; layer: "allowlist" | "guard" }` (runner.ts)
  - `export class SpecialistError extends Error { denials: DeniedTool[] }` (runner.ts)
  - `SpecialistResult.denials?: DeniedTool[]`
  - `ResolveCtx.onDeny?: (tool: string, reason: string) => void` (resolve.ts)

- [ ] **Step 1: Write the failing test**

Append to `test/resolve-agent.test.ts` (use its existing fixture/harness helpers — the file already builds a real `resolveAgent`; follow its local naming exactly when inserting):

```ts
  it("threads ctx.onDeny into the guard chain: a guard deny reaches the collector", async () => {
    // Workspace-less resolution of a code-capable agent mounts advisoryGuard (resolve.ts:247),
    // which denies filesystem tools — the exact wall from goal f83d56cf.
    const seen: Array<[string, string]> = [];
    const resolved = resolveAgent("atlas", { channel: "t", chatId: "1" }, {
      onDeny: (tool, reason) => seen.push([tool, reason]),
    })!;
    expect(resolved).toBeTruthy();
    const v = await resolved.options.canUseTool!("Read", {}, { signal: new AbortController().signal });
    expect(v).toMatchObject({ behavior: "deny" });
    expect(seen[0][0]).toBe("Read");
    expect(seen[0][1]).toContain("filesystem/exec disabled");
  });
```

Adapt the agent name to one the test fixture defines with a code-sandbox capability; if the
fixture has none, add one fixture agent YAML with `capabilities: [editing]` mirroring the file's
existing fixture style. The assertion core — `ctx.onDeny` fires from the resolved options — must
not change.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/resolve-agent.test.ts -t "onDeny"`
Expected: FAIL — `onDeny` is not a `ResolveCtx` field; TypeScript error, or `seen` empty.

- [ ] **Step 3: Extend `ResolveCtx` and the guard call**

`src/agents/resolve.ts` — add to `ResolveCtx`:

```ts
  /** Per-run denial collector (policy-wall spec §1) — receives every guard-layer deny. */
  onDeny?: (tool: string, reason: string) => void;
```

And the single wiring site (line 253):

```ts
      const wired = guardOptions(g.checks, g.fallback ?? "allow", ctx.onDeny);
```

- [ ] **Step 4: The runner types and collector**

`src/agents/runner.ts`. Add beside `SpecialistResult`:

```ts
/** One denied tool, correlated exactly to the run that hit it (policy-wall spec §1).
 *  `layer` decides the fix: "allowlist" is grantable via permission.grant; "guard" is
 *  engine policy and is not. `role` is the canonical role that hit the wall — a loop/verify
 *  attempt runs two roles and the grant must name the right one. */
export interface DeniedTool { role: string; tool: string; reason: string; layer: "allowlist" | "guard" }

/** A specialist failure that still carries what the run learned before dying —
 *  denials survive the throw (the burn-turns-against-a-wall case). */
export class SpecialistError extends Error {
  readonly name = "SpecialistError";
  constructor(message: string, readonly denials: DeniedTool[] = []) { super(message); }
}
```

Add `denials?: DeniedTool[];` to `SpecialistResult`.

In `makeRunSpecialist`, at the top of the returned function (before `resolveAgent` is called),
create the per-run collector, and pass the guard hook through the resolve ctx:

```ts
    const denials: DeniedTool[] = [];
    const collect = (tool: string, reason: string, layer: DeniedTool["layer"]): void => {
      if (!denials.some((d) => d.tool === tool && d.layer === layer)) {
        denials.push({ role: roleName, tool, reason, layer });
      }
    };
    const resolved = deps.resolveAgent(roleName, opts.origin ?? DEFAULT_ORIGIN, {
      cwd: opts.cwd, workspace: opts.workspace,
      idempotencyKey: opts.idempotencyKey, model: opts.model,
      onDeny: (tool, reason) => collect(tool, reason, "guard"),
    });
```

(`collect` stamps `roleName` as given; after resolution succeeds the canonical name is available —
use `canonical` for the stored `role` by assigning through a mutable `let roleForDenials =
roleName` updated after resolve, or simply keep `roleName`: the registry accepts aliases and
`setRolePermission` keys on the canonical name, so prefer canonical — set the collector's role
from `canonical` by defining `collect` AFTER the resolve block and threading a small
`pendingGuardDenials: Array<[string,string]>` captured before it. Simplest correct order:
declare `denials` + a `collect` that reads a `let collectRole = roleName`, and set
`collectRole = canonical` immediately after `const { canonical, def } = resolved;`.)

Wrap the observer emit (line ~146):

```ts
      const observed = withDenialObserver(withSchema, canonical, (e) => {
        collect(e.tool, `${e.tool} is not in ${canonical}'s allowlist`, "allowlist");
        deps.bus.emit({ type: "tool.denied", ...e });
      });
```

Attach on the success return:

```ts
            return {
              text: msg.result,
              structured: msg.structured_output,
              costUsd: msg.total_cost_usd,
              numTurns: msg.num_turns,
              ...(denials.length ? { denials } : {}),
            };
```

Replace the two throw sites at the bottom of the run path:

```ts
          throw new SpecialistError(
            `Specialist ${roleName} failed: ${msg.subtype}${"errors" in msg ? ` — ${msg.errors.join("; ")}` : ""}`,
            denials,
          );
```
```ts
      throw new SpecialistError(`Specialist ${roleName} ended without a result message`, denials);
```

(The `Unknown agent` throw stays a plain Error — no run happened, nothing was denied.)

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/resolve-agent.test.ts && npx tsc --noEmit`
Expected: all pass including the new test; tsc silent.

- [ ] **Step 6: Commit**

```bash
git add src/agents/resolve.ts src/agents/runner.ts test/resolve-agent.test.ts
git commit -m "feat(agents): every run collects its denied tools, both layers

One per-run collector: guard denials arrive via ResolveCtx.onDeny,
allowlist denials via the existing observer wrap. Results carry
denials; specialist failures throw SpecialistError so the denials
survive the burn-turns-against-a-wall path.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The park

**Files:**
- Modify: `src/engine/workers.ts`
- Test: `test/workers.test.ts`

**Interfaces:**
- Consumes: `DeniedTool`, `SpecialistError` from Task 2 (imported from `../agents/runner.js`).
- Produces: `WorkerDeps.proposeGrant?: (role: string, tool: string) => Promise<void>` — Task 4 wires it.

- [ ] **Step 1: Write the failing tests**

Append a new describe block to `test/workers.test.ts` (`harness`, `SPEC`, `payloadOf`, `journalTypes`, `appendEvents` all exist; add `SpecialistError` to the runner import line):

```ts
describe("policy-wall park", () => {
  const DENIED = [{ role: "athena", tool: "Bash", reason: "Bash is not in athena's allowlist", layer: "allowlist" as const }];
  const GUARD_DENIED = [{ role: "athena", tool: "Read", reason: "advisory context: filesystem/exec disabled — use recall/vault_read", layer: "guard" as const }];

  it("attempt error + allowlist denial → parks needs-review and queues a grant", async () => {
    const grants: Array<[string, string]> = [];
    const { store, deps, goal } = harness(async () => ({
      text: "I could not do it",
      structured: { completed: false, summary: "blocked", blockers: ["Bash denied"] },
      denials: DENIED, costUsd: 0.1, numTurns: 3,
    }));
    deps.proposeGrant = async (role, tool) => { grants.push([role, tool]); };

    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.outcome).toBe("error");
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({ outcome: "error" });
    const park = payloadOf(store, "review.requested")[0] as { objections: string[]; lastArtifactRef: string };
    expect(park.objections.join("\n")).toContain("athena was denied: Bash");
    expect(park.objections.join("\n")).toContain("Actions");
    expect(park.lastArtifactRef).toContain("denied");
    expect(store.listNodes("g1")[0].status).toBe("needs-review");
    expect(grants).toEqual([["athena", "Bash"]]);
  });

  it("guard-layer denial → parks with the verbatim reason, NO grant queued", async () => {
    const grants: string[] = [];
    const { store, deps, goal } = harness(async () => ({
      text: "blocked", structured: { completed: false, summary: "fs blocked", blockers: [] },
      denials: GUARD_DENIED, costUsd: 0.1, numTurns: 3,
    }));
    deps.proposeGrant = async (_r, t) => { grants.push(t); };

    await runAttempt(goal(), SPEC(), 1, deps);
    const park = payloadOf(store, "review.requested")[0] as { objections: string[] };
    expect(park.objections.join("\n")).toContain("filesystem/exec disabled");
    expect(park.objections.join("\n")).toContain("not a grantable permission");
    expect(grants).toEqual([]);
  });

  it("mixed layers → both objections, grant only for the allowlist one", async () => {
    const grants: string[] = [];
    const { store, deps, goal } = harness(async () => ({
      text: "blocked", structured: { completed: false, summary: "walls", blockers: [] },
      denials: [...DENIED, ...GUARD_DENIED], costUsd: 0.1, numTurns: 3,
    }));
    deps.proposeGrant = async (_r, t) => { grants.push(t); };

    await runAttempt(goal(), SPEC(), 1, deps);
    const park = payloadOf(store, "review.requested")[0] as { objections: string[] };
    expect(park.objections).toHaveLength(2);
    expect(grants).toEqual(["Bash"]);
  });

  it("a successful attempt with denials parks nothing", async () => {
    const grants: string[] = [];
    const { store, deps, goal } = harness(async () => ({
      text: "worked around it", structured: { completed: true, summary: "ok", blockers: [] },
      denials: DENIED, costUsd: 0.1, numTurns: 3,
    }));
    deps.proposeGrant = async (_r, t) => { grants.push(t); };

    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.outcome).toBe("ok");
    expect(journalTypes(store)).not.toContain("review.requested");
    expect(grants).toEqual([]);
  });

  it("a thrown SpecialistError carrying denials parks; a plain error does not", async () => {
    const { store, deps, goal } = harness(async () => {
      throw new SpecialistError("Specialist athena failed: error_max_turns", DENIED);
    });
    deps.proposeGrant = async () => {};
    await runAttempt(goal(), SPEC(), 1, deps);
    expect(journalTypes(store)).toContain("review.requested");

    const plain = harness(async () => { throw new Error("flake"); });
    await runAttempt(plain.goal(), SPEC(), 1, plain.deps);
    expect(journalTypes(plain.store)).not.toContain("review.requested");
  });

  it("session-limit and api-unreachable keep their semantics even with denials recorded", async () => {
    const sl = harness(async () => ({ text: "You've hit your session limit", denials: DENIED, costUsd: 0, numTurns: 1 }));
    const r1 = await runAttempt(sl.goal(), SPEC(), 1, sl.deps);
    expect(r1.sessionLimit).toBe(true);
    expect(journalTypes(sl.store)).not.toContain("review.requested");

    const api = harness(async () => ({ text: "API Error: Unable to connect to API", denials: DENIED, costUsd: 0, numTurns: 0 }));
    api.deps.sleep = async () => {};
    const r2 = await runAttempt(api.goal(), SPEC(), 1, api.deps);
    expect(r2.apiUnreachable).toBe(true);
    expect(journalTypes(api.store)).not.toContain("review.requested");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/workers.test.ts -t "policy-wall"`
Expected: FAIL — 4 of 6 fail (no park exists); "successful attempt" and the session-limit/api test pass already and must stay green. `deps.proposeGrant` is a TS error until Step 3 — that is the compile-level RED.

- [ ] **Step 3: Implement the park**

`src/engine/workers.ts`:

1. Import: `import { SpecialistError, type DeniedTool } from "../agents/runner.js";` (merge into the existing runner import).
2. `WorkerDeps` gains:

```ts
  /** Queue an always-supervised permission.grant (policy-wall spec §3). Optional — absent in
   *  tests and stripped-down harnesses; the park still names the tool either way. */
  proposeGrant?: (role: string, tool: string) => Promise<void>;
```

3. Inside `runAttempt`, beside the cost accumulators:

```ts
  const denied = new Map<string, DeniedTool>(); // key role:tool — all runAgent calls of this attempt feed it
  const collectDenials = (ds?: DeniedTool[]): void => {
    for (const d of ds ?? []) denied.set(`${d.role}:${d.tool}`, d);
  };
```

4. In `runAgent`'s success path (where `costCents`/`turns` accumulate), add `collectDenials(res.denials);`.
5. The park helper, beside `finish`:

```ts
  /** Agent-caused error funnel (policy-wall spec §2): if the attempt hit denied tools, park
   *  needs-review naming each wall instead of joining the retry treadmill — the retry would
   *  hit the same wall. Infra outcomes (timeout/abort/session-limit/api) never come here. */
  const finishOrPark = (error: string): void => {
    if (denied.size === 0) { finish("error", error); return; }
    const walls = [...denied.values()];
    for (const d of walls.filter((d) => d.layer === "allowlist")) {
      // Fire-and-forget: a gate failure must not lose the park; objections still name the tool.
      void deps.proposeGrant?.(d.role, d.tool).catch((e) =>
        deps.log?.(`proposeGrant ${d.role}/${d.tool} failed: ${(e as Error).message}`));
    }
    const objections = walls.map((d) => d.layer === "allowlist"
      ? `${d.role} was denied: ${d.tool} (not in allowlist). A permission grant is queued in Actions — approve it (or reject), then Retry.`
      : `${d.role} was denied: ${d.tool} — "${d.reason}". This is engine policy, not a grantable permission; fix the cause (e.g. reopen with guidance, or give the goal a workspace) and Retry.`);
    const artifact = save(`${spec.key}-a${attempt}-denied.md`,
      `# Attempt ${attempt} blocked by denied tools\n\n**Error:** ${error}\n\n${objections.map((o) => `- ${o}`).join("\n")}`,
      spec.agent);
    appendEvents(store, goal.id, [
      { type: "attempt.finished", payload: { node: spec.key, attempt, outcome: "error", costCents, turns, error } },
      { type: "review.requested", payload: { node: spec.key, lastArtifactRef: artifact, objections } },
    ]);
    deps.onEvent?.({ type: "node.status", goalId: goal.id, nodeKey: spec.key, status: "needs-review", agent: spec.agent });
  };
```

6. Convert the four agent-caused error sites:
   - run case empty output: `finish("error", "agent returned no output")` → `finishOrPark("agent returned no output")` + keep the same `return`.
   - run case ⑭ gate: `finish("error", \`${BLOCKED_PREFIX}...\`)` → `finishOrPark(...)` + same return.
   - verify no-report: replace the inline `appendEvents(...)` (the `attempt.finished` with the
     snippet error) with `finishOrPark(snippet ? ... : "no structured report")` (keep the
     preceding `save` line and the return; the error string is unchanged).
   - the generic catch tail:

```ts
    const abortReason = deps.registry.reason(regKey);
    const outcome: AttemptOutcome =
      abortReason === "timeout" ? "timeout" : abortReason ? "aborted" : "error";
    if (err instanceof SpecialistError) collectDenials(err.denials);
    if (outcome === "error") finishOrPark((err as Error).message);
    else finish(outcome, (err as Error).message);
    return { claimed: true, outcome, sessionLimit: false, apiUnreachable: false };
```

   The SessionLimitError and ApiUnreachableError branches above it keep plain `finish` — pinned.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/workers.test.ts && npx tsc --noEmit`
Expected: 42 passed (36 + 6); tsc silent. In particular the ⑭ block and the verify no-report test stay green (no denials in those harnesses → `finishOrPark` degrades to `finish`).

- [ ] **Step 5: Commit**

```bash
git add src/engine/workers.ts test/workers.test.ts
git commit -m "feat(engine): an attempt blocked by denied tools parks for approval

First agent-caused error with denials parks the node needs-review with
one objection per wall, instead of burning the retry against the same
wall. Allowlist denials queue an always-supervised permission.grant;
guard denials carry their verbatim reason — no grant fixes those.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Wiring — engine dep + gate closure

**Files:**
- Create: `src/kernel/propose-grant.ts`
- Modify: `src/engine/engine.ts` (`GoalEngineDeps` + the `runAttempt` deps at line ~259)
- Modify: `src/index.ts` (engine construction)
- Test: `test/propose-grant.test.ts`

**Interfaces:**
- Consumes: `WorkerDeps.proposeGrant` (Task 3); `ActionGate.propose`, `store.listActions`.
- Produces: `makeGrantProposer(store, gate): (role, tool) => Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `test/propose-grant.test.ts`:

```ts
// test/propose-grant.test.ts — the grant proposer queues exactly once per (role, tool):
// an identical already-queued proposal is never duplicated.
import { describe, it, expect } from "vitest";
import { makeGrantProposer } from "../src/kernel/propose-grant.js";

const fakeStore = (queued: Array<{ role: string; tool: string }>) => ({
  listActions: () => queued.map((q, i) => ({
    id: `a${i}`, type: "permission.grant", payload: JSON.stringify(q),
  })),
}) as never;

describe("makeGrantProposer", () => {
  it("proposes a permission.grant with the role and tool", async () => {
    const proposals: unknown[] = [];
    const gate = { propose: async (input: unknown) => { proposals.push(input); return {} as never; } } as never;
    await makeGrantProposer(fakeStore([]), gate)("clio", "Bash");
    expect(proposals[0]).toMatchObject({ type: "permission.grant", payload: { role: "clio", tool: "Bash" } });
  });

  it("dedupes against an identical queued proposal, but not a different tool", async () => {
    const proposals: unknown[] = [];
    const gate = { propose: async (input: unknown) => { proposals.push(input); return {} as never; } } as never;
    const propose = makeGrantProposer(fakeStore([{ role: "clio", tool: "Bash" }]), gate);
    await propose("clio", "Bash");      // identical → skipped
    await propose("clio", "WebSearch"); // different tool → proposed
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ payload: { role: "clio", tool: "WebSearch" } });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/propose-grant.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the closure**

Create `src/kernel/propose-grant.ts`:

```ts
// src/kernel/propose-grant.ts — the engine's path into the action gate for policy-wall parks
// (policy-wall spec §3). Queue-only: approving the proposal is the ONLY thing that ever writes
// a grant (executors.ts), and permission.grant is always-supervised (trust.ts).
import type { Store } from "../store/db.js";
import type { ActionGate } from "./gate.js";

export function makeGrantProposer(store: Store, gate: ActionGate) {
  return async (role: string, tool: string): Promise<void> => {
    const queued = store.listActions("proposed", 200).some((a) => {
      if (a.type !== "permission.grant") return false;
      const p = JSON.parse(a.payload) as { role?: string; tool?: string };
      return p.role === role && p.tool === tool;
    });
    if (queued) return; // never double-propose the same wall
    await gate.propose(
      { type: "permission.grant", payload: { role, tool }, preview: "" },
      { channel: "engine", chatId: "goals" },
    );
  };
}
```

- [ ] **Step 4: Thread through the engine**

`src/engine/engine.ts` — `GoalEngineDeps` gains:

```ts
  /** Queue an always-supervised permission.grant when a park hits an allowlist wall. */
  proposeGrant?: (role: string, tool: string) => Promise<void>;
```

And the `runAttempt` deps object (line ~259) gains one line:

```ts
        proposeGrant: this.deps.proposeGrant,
```

`src/index.ts` — in the `GoalEngine` construction (find `new GoalEngine({`), add:

```ts
    proposeGrant: makeGrantProposer(store, gate),
```

with the import `import { makeGrantProposer } from "./kernel/propose-grant.js";`. The `gate`
variable exists at line ~181; if the engine is constructed before the gate, move the
`makeGrantProposer` line to a `deps` assignment after both exist — check construction order
and keep it a one-line wiring either way.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/propose-grant.test.ts && npx tsc --noEmit`
Expected: 2 passed; tsc silent.

- [ ] **Step 6: Commit**

```bash
git add src/kernel/propose-grant.ts src/engine/engine.ts src/index.ts test/propose-grant.test.ts
git commit -m "feat(daemon): parks queue their permission grants through the gate

makeGrantProposer dedupes against already-queued proposals and only
ever queues — approving remains the sole writer of a grant.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Full suite, deploy, live loop

**Files:** none.

- [ ] **Step 1: Full suite + both typecheckers**

Run: `npx vitest run && npx tsc --noEmit && (cd ui2 && npx tsc --noEmit)`
Expected **Tests** line: 195 files (192 + guard-deny + propose-grant + nothing else new), passed = 1504 + 13 new (4 guard-deny + 1 resolve + 6 workers + 2 propose-grant) = **1517 passed + 2 skipped**. Zero failures required; any delta must be explainable before proceeding.

- [ ] **Step 2: Deploy**

```bash
npm run build && launchctl kickstart -k gui/501/com.ihab.aios
```

(ui2 untouched — no ui2 build.)

- [ ] **Step 3: Live — allowlist wall**

clio has no `Bash` (research writer). Create a goal that needs it:

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 240 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/chat -d '{"target":"","text":"Goal for clio, single node, no research: run the shell command `date` with the Bash tool and write its exact output to your goal folder. Using Bash is REQUIRED — do not simulate the output. This is a deliberate engine test; create the goal even though clio may lack the tool."}'
```

Then watch:

```bash
sqlite3 -header data/aios.sqlite "select gseq,type,substr(payload,1,200) from goal_journal where goal_id like '<id>%' order by gseq;"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/actions | python3 -m json.tool | head -30
```

Each a distinct claim: node status `needs-review` with an objection naming `clio was denied: Bash`; a `permission.grant {role: clio, tool: Bash}` action in `proposed`; the goal NOT failed.

- [ ] **Step 4: Live — approve and retry**

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/actions/<actionId>/resolve -d '{"verdict":"approve"}'
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/goals/<goalId>/review/<nodeKey> -d '{"verdict":"retry"}'
```

Expected: retry attempt runs with Bash live (fresh `effectiveAllowedTools`), node completes, goal `done`, the artifact contains real `date` output.

- [ ] **Step 5: Live — revoke the test grant**

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/permissions/propose -d '{"role":"clio","tool":"Bash","action":"revoke"}'
# then approve that action via /api/actions/<id>/resolve as above
sqlite3 -header data/aios.sqlite "select * from role_permissions where role='clio';"
```

Expected: the grant row flips to `allow=0` (or is superseded) — clio's Bash does not outlive the test.

- [ ] **Step 6: False-positive sweep + push**

```bash
sqlite3 -header data/aios.sqlite "select count(*) from goal_journal where type='review.requested' and payload like '%was denied%' and ts > (strftime('%s','now')-600)*1000;"
```

Expected: only the deliberate test's park. Then:

```bash
git push origin main
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 collection — guard layer (`onDeny` through `guardOptions` + `ResolveCtx`) | Tasks 1, 2 |
| §1 collection — allowlist layer (observer wrap) + `SpecialistError` thrown path | Task 2 |
| §2 park on first agent-caused error; artifact; objections per layer; infra outcomes excluded | Task 3 |
| §3 auto-propose allowlist-only; dedupe; fire-and-forget failure handling | Tasks 3, 4 |
| §4 zero new surfaces | By construction — no route/UI/status/event added anywhere |
| Security posture (queue-only, always-supervised) | Task 4 header comment + no `setRolePermission` call in the diff |
| Testing 1–8 | T1 (guards), T2 (resolve threading), T3 (workers 2–7), T4 (closure/8) |
| Live verification incl. grant revocation | Task 5 |

**Placeholder scan:** clean. `<id>`/`<actionId>`/`<goalId>`/`<nodeKey>` in Task 5 are values produced by the preceding step's output, not blanks. Task 2 Step 4's role-naming note resolves to a concrete instruction (canonical via `collectRole`).

**Type consistency:** `DeniedTool {role, tool, reason, layer}` identical across runner (definition), workers tests (fixtures), and objection formatting. `proposeGrant(role, tool) => Promise<void>` identical in `WorkerDeps`, `GoalEngineDeps`, and `makeGrantProposer`'s return. `SpecialistError(message, denials)` constructor matches every throw and test usage.
