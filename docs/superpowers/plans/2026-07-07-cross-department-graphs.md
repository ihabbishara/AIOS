# Cross-department single-goal graphs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a planned goal's graph use shared-visibility agents from any department (private agents only from the private chat), for both chat-planned and mail-spawned graphs.

**Architecture:** Two changes in `src/engine/plan.ts` only. (1) `agentCheck` drops its department-equality branch — unknown-agent, alias canonicalization, and per-agent private-origin checks stay byte-identical, so the private wall keeps holding. (2) `rosterBlock` becomes multi-department (own dept first, foreign SHARED agents under `## Borrowable — <dept>` headers, private agents listed only for private-chat origins) and the planning brief tells the lead to prefer its own roster. Execution needs zero changes: node launch already resolves each agent's pack by the agent's own department (`resolveDeptFor(node.agent, origin, byAgent=true)`), and replan re-validates through the same `validateGraph`.

**Tech Stack:** TypeScript, vitest (in-process `:memory:` Store + stub planner/runner). No new dependencies, no schema changes.

**Spec:** `docs/superpowers/specs/2026-07-07-cross-department-graphs-design.md`

## Global Constraints

- No new npm dependencies. No DB schema changes.
- Suite baseline **926 pass + 1 skip**. Two pins flip DELIBERATELY (spec §Testing 6): `test/validate-graph.test.ts` "rejects foreign-department agents" becomes acceptance; `test/goal-planner.test.ts` retry test's invalid agent switches `midas` → `nobody`. Everything else stays green unchanged.
- `goal.department` semantics unchanged everywhere (standup, report-back, recall mail domain, workspace eligibility = owning dept engineering).
- `npx tsc --noEmit` clean; `cd ui && npx tsc --noEmit && npm run build` clean (UI untouched).
- Build cycle (session-locked): execute in a worktree off `origin/main`; per-task commits; whole-branch review before FF-merge; deploy `npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`; READ-ONLY smoke.

---

### Task 1: Validator — drop the department-equality wall

**Files:**
- Modify: `src/engine/plan.ts:22-34` (`agentCheck`)
- Test: `test/validate-graph.test.ts`

**Interfaces:**
- Consumes: existing `validateGraph(nodes, ctx)` / `ValidateCtx` (unchanged shape — `ctx.department` stays a field; it just no longer gates agents).
- Produces: `validateGraph` accepting foreign agents; the private-origin per-agent rule is the only cross-department gate. Task 2 and 3 rely on exactly this behavior.

- [ ] **Step 1: Update the fixture + write the failing/flipped tests**

In `test/validate-graph.test.ts`, add a SHARED finance agent to `fixtureRegistry()` right after the `midas.yaml` write:

```ts
  writeFileSync(join(fin, "plutus.yaml"),
    "name: plutus\ntitle: Analyst\ndepartment: finance\ncharter: c.\npersona: p.\nprompt: x.\ntools: []\n");
```

Replace the whole "rejects foreign-department agents; aliases canonicalize" test with:

```ts
  it("accepts foreign-department agents (cross-dept graphs); aliases canonicalize", () => {
    expect(validateGraph([run("a", [], "midas")], ctx()).ok).toBe(true); // private agent, primary origin
    expect(validateGraph([run("a", [], "developer")], ctx()).ok).toBe(true);
  });

  it("cross-dept: foreign shared agent OK from any origin; foreign private only from private origin", () => {
    const shared = ctx({ origin: { channel: "telegram", chatId: "999" } });
    expect(validateGraph([run("a", [], "plutus")], shared).ok).toBe(true);
    expect(validateGraph([run("a", [], "midas")], shared).ok).toBe(false); // private wall holds
    expect(validateGraph([run("a", [], "nobody")], shared).ok).toBe(false); // unknown still rejected
  });
```

Leave "private agents require a private origin, fail-closed" byte-identical (it pins the wall within the agent's own department).

- [ ] **Step 2: Run to verify the flips fail**

Run: `npx vitest run test/validate-graph.test.ts`
Expected: the two new/flipped tests FAIL with `single-department goals` rejections (midas/plutus in an engineering ctx); the rest PASS.

- [ ] **Step 3: Implement — delete the department branch in `agentCheck`**

`src/engine/plan.ts` — remove exactly these lines from `agentCheck` (keep everything else):

```ts
  if (def.department !== ctx.department) {
    return `node ${node}: ${role} "${name}" is in ${def.department}, not ${ctx.department} (single-department goals)`;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/validate-graph.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/plan.ts test/validate-graph.test.ts
git commit -m "feat(goals): validator accepts cross-department agents

Per-agent private-origin rule is the only cross-dept gate; unknown-agent,
alias, and critic-schema checks unchanged."
```

---

### Task 2: Multi-department roster + brief wording

**Files:**
- Modify: `src/engine/plan.ts:142-168` (`rosterBlock` → exported multi-dept; `planningBrief` rule line) and the two `rosterBlock` call sites (`buildValidatedPlan` ~line 203, `replan` ~line 263)
- Test: `test/validate-graph.test.ts` (rosterBlock is pure; this file's fixture registry has both departments)

**Interfaces:**
- Consumes: Task 1's relaxed validator; existing `isPrivateOrigin(primaryChat, channel, chatId)` (already imported in plan.ts).
- Produces: `export function rosterBlock(registry: LoadedRegistry, department: string, origin: { channel: string; chatId: string }, primaryChat?: { channel: string; chatId: string }): string`. Task 3's e2e tests rely on the planner passing this roster.

- [ ] **Step 1: Write the failing tests**

Append to `test/validate-graph.test.ts` (add `rosterBlock` to the existing import from `../src/engine/plan.js`):

```ts
describe("rosterBlock (cross-dept)", () => {
  it("own dept first; foreign shared under Borrowable; foreign private gated by origin", () => {
    const shared = rosterBlock(registry, "engineering", { channel: "telegram", chatId: "999" }, PRIMARY);
    expect(shared).toContain("athena");
    expect(shared).toContain("## Borrowable — finance");
    expect(shared).toContain("plutus");
    expect(shared).not.toContain("midas"); // private, shared origin
    expect(shared.indexOf("athena")).toBeLessThan(shared.indexOf("## Borrowable — finance"));

    const priv = rosterBlock(registry, "engineering", { channel: "telegram", chatId: "1" }, PRIMARY);
    expect(priv).toContain("midas"); // private chat origin unlocks private agents
  });

  it("departments with no eligible agents produce no Borrowable header", () => {
    // finance's only agents from a shared origin: plutus (shared) → header present.
    // engineering viewed FROM finance always has eligible shared agents → header present.
    const fromFinance = rosterBlock(registry, "finance", { channel: "telegram", chatId: "999" }, PRIMARY);
    expect(fromFinance).toContain("## Borrowable — engineering");
    expect(fromFinance).toContain("vulcan");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/validate-graph.test.ts`
Expected: FAIL — `rosterBlock` is not exported (compile error) or signature mismatch.

- [ ] **Step 3: Implement**

Replace the current `rosterBlock` (plan.ts:142-150) with:

```ts
const firstSentence = (s: string) => s.trim().split(/(?<=\.)\s/)[0];

function agentLine(a: import("../agents/registry/loader.js").AgentDef): string {
  const schema = a.manifest.outputSchema ? ` [outputSchema: ${a.manifest.outputSchema}]` : "";
  return `- ${a.manifest.name} — ${a.manifest.title} — ${firstSentence(a.manifest.charter)}${schema}`;
}

/** Own department's full roster first, then foreign agents grouped under Borrowable headers.
 *  Foreign private-visibility agents are listed only for private-chat origins — roster
 *  filtering is UX; validateGraph remains the enforcement layer (fail-closed on races). */
export function rosterBlock(
  registry: LoadedRegistry, department: string,
  origin: { channel: string; chatId: string }, primaryChat?: { channel: string; chatId: string },
): string {
  const all = [...registry.agents.values()];
  const own = all.filter((a) => a.department === department).map(agentLine).join("\n");
  const privateOk = isPrivateOrigin(primaryChat, origin.channel, origin.chatId);
  const foreign: string[] = [];
  for (const [name, d] of registry.departments) {
    if (name === department) continue;
    const members = all.filter((a) =>
      a.department === name && (privateOk || a.manifest.visibility !== "private"));
    if (!members.length) continue;
    foreign.push(`## Borrowable — ${name} (${firstSentence(d.mission)})\n${members.map(agentLine).join("\n")}`);
  }
  return [own, ...foreign].join("\n\n");
}
```

Check whether `AgentDef` is exported from the loader (`grep "export interface AgentDef" src/agents/registry/loader.ts`); if so, prefer a top-of-file type import over the inline `import(...)` type.

Update both call sites:

```ts
// buildValidatedPlan (~line 203):
const roster = rosterBlock(deps.registry, params.department, origin, deps.primaryChat);
// replan (~line 263):
const roster = rosterBlock(deps.registry, goal.department, origin, deps.primaryChat);
```

Update `planningBrief` (~line 152): opening line drops the single-dept phrasing and the rules gain a preference line:

```ts
    `You are the ${dept} department lead. Decompose the goal below into a task graph.`,
```

and in the `# Rules` block, after `- Only agents from the roster above.` add:

```ts
- Prefer your own department's agents; borrow agents listed under other departments only when the task genuinely needs them.
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/validate-graph.test.ts test/goal-planner.test.ts && npx tsc --noEmit`
Expected: ALL PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/plan.ts test/validate-graph.test.ts
git commit -m "feat(goals): multi-department planning roster with Borrowable sections

Foreign shared agents always listed; private agents only for private-chat
origins. Planning brief nudges leads to prefer their own roster."
```

---

### Task 3: End-to-end — chat plan, mail plan, replan patch

**Files:**
- Modify: `test/goal-planner.test.ts` (fixture gains a finance dept + shared agent; harness records per-agent pack resolution; retry fixture swaps midas→nobody; three new tests)

**Interfaces:**
- Consumes: Tasks 1–2 (relaxed validator, multi-dept roster); existing harness (`harness(planOutputs)` — sequential structured outputs for lead `athena` runs); `engine["deps"].planner!.planFromMail` and the local `mail()` fixture.
- Produces: nothing downstream — final behavioral pins.

- [ ] **Step 1: Update fixture + harness, write the failing tests**

In `test/goal-planner.test.ts` `fixtureRegistry()`, after the engineering agents loop add a finance department with a SHARED agent:

```ts
  const fin = join(root, "agents", "finance");
  mkdirSync(fin, { recursive: true });
  writeFileSync(join(fin, "department.yaml"),
    "department: finance\nmission: Money.\nlead: plutus\nmemoDomain: money\nplaybooks: []\n");
  writeFileSync(join(fin, "plutus.yaml"),
    "name: plutus\ntitle: Analyst\ndepartment: finance\ncharter: c.\npersona: p.\nprompt: x.\ntools: []\n");
```

In `harness(...)`, record per-agent pack resolutions and expose them (replace the engine's `resolveDeptFor: () => undefined` and extend the return):

```ts
  const resolvedAgents: string[] = [];
  const engine = new GoalEngine({
    // ...existing fields unchanged, except:
    resolveDeptFor: (key: string, _o: { channel: string; chatId: string }, byAgent?: boolean) => {
      if (byAgent) resolvedAgents.push(key);
      return undefined;
    },
    // ...
  });
  return { store, engine, previews, planCallsRef: () => planCalls, resolvedAgents };
```

In the retry test ("invalid plan retries once with the error, then succeeds"), change the bad fixture's agent — `midas` is now a VALID plan choice:

```ts
    const bad = { ...GOOD_PLAN, nodes: [{ key: "a", type: "run", agent: "nobody", brief: "x", deps: [] }] };
```

Add the shared cross-dept plan constant near `GOOD_PLAN`:

```ts
const XDEPT_PLAN = {
  summary: "cross-dept",
  needsWorkspace: "none",
  nodes: [
    { key: "analyze", type: "run", agent: "plutus", brief: "money side", deps: [] },
    { key: "build", type: "run", agent: "vulcan", brief: "eng side", deps: ["analyze"] },
  ],
};
```

New tests inside `describe("lead planner")`:

```ts
  it("plans a cross-department graph; each node resolves its own agent's pack", async () => {
    const { engine, store, resolvedAgents } = harness([XDEPT_PLAN]);
    const g = await engine.planGoal({ department: "engineering", title: "X", request: "x", channel: "telegram", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(store.listNodes(g.id).map((n) => n.agent).sort()).toEqual(["plutus", "vulcan"]);
    expect(g.department).toBe("engineering"); // ownership unchanged
    expect(resolvedAgents).toContain("plutus"); // pack resolved per agent, not per goal dept
    expect(resolvedAgents).toContain("vulcan");
  });

  it("a replan patch may add a foreign shared agent", async () => {
    const PATCH = { ops: [{ op: "add", nodes: [{ key: "money-check", type: "run", agent: "plutus", brief: "check", deps: [] }] }] };
    const { engine, store } = harness([GOOD_PLAN, PATCH]);
    const g = await engine.planGoal({ department: "engineering", title: "Do X", request: "do x", channel: "telegram", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    await engine["deps"].planner!.replan(store.getGoal(g.id)!, store.listNodes(g.id)[0], "boom");
    expect(store.listNodes(g.id).map((n) => n.agent)).toContain("plutus");
  });
```

And inside `describe("planFromMail")`:

```ts
  it("mail-spawned graphs may be cross-department too", async () => {
    const { engine, store } = harness([XDEPT_PLAN]);
    const g = await engine["deps"].planner!.planFromMail(engine, {
      department: "engineering", title: "t", request: "r", channel: "telegram", chatId: "1",
    }, mail());
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(store.listNodes(g.id).map((n) => n.agent).sort()).toEqual(["plutus", "vulcan"]);
  });
```

Note: the replan test patches a DONE goal with an `add` op — done-node immutability only guards `replace` ops; if the planner's replan implementation rejects patching a finished goal for another reason, mark the node failed via `store.updateNodeStatus(g.id, "build", "failed")` first and re-check. Verify against `src/engine/plan.ts` replan (~line 256) while implementing.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/goal-planner.test.ts`
Expected: before Tasks 1–2 land these fail on `single-department goals` validation; run AFTER Tasks 1–2 → they should PASS except where fixture/harness wiring is wrong — i.e. this step verifies wiring, the true RED was Task 1 Step 2. If everything passes immediately, mutation-check one pin: re-add the department branch in `agentCheck` locally, confirm the three new tests fail, revert.

- [ ] **Step 3: Run the full planner+validator set**

Run: `npx vitest run test/goal-planner.test.ts test/validate-graph.test.ts test/mail-sweep.test.ts`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add test/goal-planner.test.ts
git commit -m "test(goals): pin cross-department planning e2e — chat, mail, replan, per-agent packs"
```

---

### Task 4: Full verification

**Files:** none

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: **≥ 931 pass + 1 skip** (926 baseline + ~5 new, two flipped in place), zero failures.

- [ ] **Step 2: Typecheck + builds + drift**

Run: `npx tsc --noEmit && npm run build && cd ui && npx tsc --noEmit && npm run build && cd .. && git diff origin/main -- package.json package-lock.json ui/package.json ui/package-lock.json`
Expected: clean, empty drift output.

---

## Post-merge (session build cycle, not plan tasks)

Whole-branch review → fix findings → FF-merge → push → build both → `launchctl kickstart -k gui/$(id -u)/com.ihab.aios` → READ-ONLY smoke → ExitWorktree remove → memory update (cross-dept graphs shipped; §13 backlog shrinks to injection cap).
