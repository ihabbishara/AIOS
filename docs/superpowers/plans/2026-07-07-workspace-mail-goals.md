# Workspace-carrying mail-goals (user-gated) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let user-sent mail to the engineering lead spawn goals that carry a real code workspace, while hardening the engine so every other mail-goal is workspace-stripped regardless of planner behavior.

**Architecture:** Three layers. (1) Engine (`GoalEngine.startGoal`) gains a `mailWorkspaceEligible` predicate — user-sent + lead-planned graph + engineering — and hard-nulls `project_dir` on ineligible mail-goals (closes the soft-layer hole where a planner-passed projectDir became an unsandboxed cwd). (2) Planner (`planFromMail`) stops forcing `needsWorkspace:"none"` for user-sent engineering mail, reusing `plan()`'s projectDir validation via a shared helper. (3) `mailReport` appends a `Workspace:` line so the owner learns where the branch/sandbox lives.

**Tech Stack:** TypeScript, node:sqlite (synchronous), vitest (in-process `:memory:` Store + stub planner/runner). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-07-workspace-mail-goals-design.md`

## Global Constraints

- No new npm dependencies. No new DB columns (eligibility is derived via `store.getMail`).
- `node:sqlite` — never nest `store.transaction()`.
- Suite baseline **915 pass + 1 skip** — all existing tests must stay green unchanged. The agent-sender "no workspace" tests (`test/mail-sweep.test.ts:159`, `test/goal-planner.test.ts:127`) are the regression anchors: do NOT edit their fixtures.
- `tsc --noEmit` clean (backend), `cd ui && npx tsc --noEmit && npm run build` clean (UI untouched by this plan but must still build).
- Every mail insert path already emits its event — this plan adds no new mail insert paths.
- Build cycle (session-locked): this plan executes in a worktree off `origin/main`; per-task commits; whole-branch review before FF-merge; deploy = `npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`; live smoke is READ-ONLY.

---

### Task 1: Engine hard layer — `mailWorkspaceEligible` + workspace strip

**Files:**
- Modify: `src/store/db.ts:559` (`setGoalProjectDir` accepts null)
- Modify: `src/engine/goals.ts:338-349` (startGoal gate) + new private method
- Test: `test/mail-sweep.test.ts`

**Interfaces:**
- Consumes: `Store.getMail(id): MailRow | undefined`, `GoalRow.{spawned_by_mail, plan_summary, department, project_dir}`, `MAIL_PREFIX` (all existing).
- Produces: `GoalEngine` behavior later tasks rely on — eligible mail-goals reach `prepareSandbox`; ineligible mail-goals end with `project_dir === null`. `setGoalProjectDir(id: string, dir: string | null)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/mail-sweep.test.ts` (after the `graphPlanner` const, add the passthrough planner; new `describe` at file end). Also change the harness `prepareSandbox` fixture dir from `"/tmp/should-not-be-used"` to `"/tmp/ms-sandbox"` (no existing test asserts that string; the positive tests below do):

```ts
// Mimics the post-spec planner: passes a plan-declared workspace straight through.
// The engine layer alone must decide whether it survives.
const workspacePlanner = (projectDir?: string, lead = "athena"): Planner => ({
  plan: async () => { throw new Error("unused"); },
  replan: async () => {},
  planFromMail: async (engine, params, mail): Promise<GoalRow> => engine.startPlannedGoal({
    title: params.title, request: params.request, department: params.department, lead,
    origin: { channel: params.channel, chatId: params.chatId }, summary: "graph plan",
    nodes: [{ node_key: "n1", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: [], max_rounds: 1 }],
    projectDir, needsWorkspace: projectDir ? "worktree" : "none",
    spawnedByMail: mail.id, chainDepth: mail.chain_depth,
  }),
});
```

```ts
describe("mail workspace (user-gated, spec 2026-07-07)", () => {
  it("user mail to an engineering lead carries a workspace: prepareSandbox runs", async () => {
    const { store, engine, prepareSandbox } = harness(okRun, undefined, workspacePlanner("/tmp/projects/x"));
    store.insertMail(reqMail({ from_agent: "user", to_agent: "athena", chain_depth: 0 }));
    engine.pump();
    await flush();
    const goal = store.getGoal(store.getMail("m1")!.goal_id!)!;
    expect(prepareSandbox).toHaveBeenCalledOnce();
    expect(goal.project_dir).toBe("/tmp/ms-sandbox");
    expect(goal.status).toBe("done");
  });

  it("agent mail graph with a planner-passed projectDir is hard-stripped by the engine", async () => {
    const { store, engine, prepareSandbox } = harness(okRun, undefined, workspacePlanner("/tmp/projects/x"));
    store.insertMail(reqMail({ to_agent: "athena" })); // from athena (agent) → lead
    engine.pump();
    await flush();
    const goal = store.getGoal(store.getMail("m1")!.goal_id!)!;
    expect(goal.project_dir).toBeNull();
    expect(prepareSandbox).not.toHaveBeenCalled();
    expect(goal.status).toBe("done"); // stripped goal still runs to completion
  });

  it("user mail to a specialist (single-node) stays workspace-less", async () => {
    const { store, engine, prepareSandbox } = harness(okRun);
    store.insertMail(reqMail({ from_agent: "user", to_agent: "vulcan", chain_depth: 0 }));
    engine.pump();
    await flush();
    const goal = store.getGoal(store.getMail("m1")!.goal_id!)!;
    expect(goal.plan_summary).toBe(`${MAIL_PREFIX}m1`);
    expect(goal.project_dir).toBeNull();
    expect(prepareSandbox).not.toHaveBeenCalled();
  });

  it("user mail to a non-engineering lead is stripped (engineering only)", async () => {
    const { store, engine, prepareSandbox } = harness(okRun, undefined, workspacePlanner("/tmp/projects/x", "midas"));
    store.insertMail(reqMail({ from_agent: "user", to_agent: "midas", chain_depth: 0 }));
    engine.pump();
    await flush();
    const goal = store.getGoal(store.getMail("m1")!.goal_id!)!;
    expect(goal.department).toBe("finance");
    expect(goal.project_dir).toBeNull();
    expect(prepareSandbox).not.toHaveBeenCalled();
  });

  it("fail-closed: spawned_by_mail pointing at a missing row strips the workspace", async () => {
    const { store, engine, prepareSandbox } = harness(okRun);
    engine.startPlannedGoal({
      title: "t", request: "r", department: "engineering", lead: "athena",
      origin: { channel: "telegram", chatId: "1" }, summary: "graph plan",
      nodes: [{ node_key: "n1", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: [], max_rounds: 1 }],
      projectDir: "/tmp/projects/x", needsWorkspace: "worktree", spawnedByMail: "ghost", chainDepth: 0,
    });
    await flush();
    const goal = store.listGoals()[0]!;
    expect(goal.project_dir).toBeNull();
    expect(prepareSandbox).not.toHaveBeenCalled();
  });
});
```

Note: `reqMail` defaults `from_agent: "athena"` (agent-sent) — the second test relies on that default. The user tests override `from_agent: "user"`. `insertMail` is required before `pump()` because the engine predicate reads the row via `store.getMail`.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/mail-sweep.test.ts`
Expected: the 5 new tests FAIL. First test fails with `prepareSandbox` not called / `project_dir` null (engine still blanket-blocks `spawned_by_mail`). Strip tests fail with `project_dir` = `/tmp/projects/x` (nothing nulls it today — this proves the hole is real). All pre-existing tests in the file still PASS.

- [ ] **Step 3: Implement**

`src/store/db.ts:559` — widen the signature (body unchanged; sqlite binds null fine):

```ts
setGoalProjectDir(id: string, dir: string | null): void {
```

`src/engine/goals.ts` — add the predicate as a private method directly above `startGoal`:

```ts
/** Workspace eligibility (spec 2026-07-07-workspace-mail-goals): non-mail goals are always
 *  eligible; mail-goals only when user-sent + lead-planned graph + engineering. Fail-closed
 *  when the source mail row is missing. */
private mailWorkspaceEligible(goal: GoalRow): boolean {
  if (!goal.spawned_by_mail) return true;
  if (goal.plan_summary.startsWith(MAIL_PREFIX)) return false; // single-node: never
  if (goal.department !== "engineering") return false;
  return this.deps.store.getMail(goal.spawned_by_mail)?.from_agent === "user";
}
```

Replace the gate inside `startGoal`'s `try` block (currently lines 338-349, the comment + `const sandbox = goal.spawned_by_mail ? undefined : ...` through the `mkdirSync` line):

```ts
try {
  // Mail-spawned goals may carry a workspace ONLY when user-sent + lead-planned +
  // engineering (spec 2026-07-07). Everything else is hard-stripped here — including a
  // planner-passed project_dir — so the wall holds regardless of planner behavior.
  const eligible = this.mailWorkspaceEligible(goal);
  if (!eligible && goal.project_dir) {
    store.setGoalProjectDir(goal.id, null);
    goal.project_dir = null;
  }
  const sandbox = eligible ? await this.deps.prepareSandbox?.(goal, { playbook: pb }) : undefined;
  if (sandbox) {
    store.setGoalProjectDir(goal.id, sandbox.taskDir);
    goal.project_dir = sandbox.taskDir;
    this.sandboxes.set(goal.id, sandbox);
  }
  if (goal.project_dir) mkdirSync(goal.project_dir, { recursive: true });
} catch (err) {
```

(The `catch` block and everything after it are unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/mail-sweep.test.ts test/goal-planner.test.ts`
Expected: ALL PASS — including the pre-existing `mail-goals NEVER get a workspace` (agent-sent, still stripped) and `forces no workspace even when the plan proposes a worktree` (planner still forces; engine now also strips).

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts src/engine/goals.ts test/mail-sweep.test.ts
git commit -m "feat(mail): engine-enforced workspace eligibility for mail-goals

User-sent + lead-planned + engineering mail-goals may reach prepareSandbox;
every other mail-goal is hard-stripped of any planner-passed project_dir at
startGoal (closes the unsandboxed-cwd hole). Fail-closed on a missing mail row."
```

---

### Task 2: `mailReport` names the workspace

**Files:**
- Modify: `src/engine/goals.ts:514-517` (`mailReport` body construction)
- Test: `test/mail-sweep.test.ts`

**Interfaces:**
- Consumes: Task 1's behavior (only eligible mail-goals have `project_dir` set; harness sandbox dir is `/tmp/ms-sandbox`).
- Produces: report mail body contains `Workspace: <project_dir>` iff set — on both success and failure reports.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("mail workspace (user-gated, spec 2026-07-07)")` block:

```ts
  it("reports name the workspace on success and failure; workspace-less reports do not", async () => {
    // success + workspace
    const a = harness(okRun, undefined, workspacePlanner("/tmp/projects/x"));
    a.store.insertMail(reqMail({ from_agent: "user", to_agent: "athena", chain_depth: 0 }));
    a.engine.pump();
    await flush();
    expect(a.store.unreadMailFor("user")[0].body).toContain("Workspace: /tmp/ms-sandbox");

    // failure + workspace (sandbox is allocated before nodes run)
    const failRun: SpecialistRunFn = async () => { throw new Error("agent exploded"); };
    const b = harness(failRun, undefined, workspacePlanner("/tmp/projects/x"));
    b.store.insertMail(reqMail({ from_agent: "user", to_agent: "athena", chain_depth: 0 }));
    b.engine.pump();
    await flush();
    const failed = b.store.unreadMailFor("user")[0];
    expect(failed.body).toContain("Failed");
    expect(failed.body).toContain("Workspace: /tmp/ms-sandbox");

    // workspace-less mail-goal → no Workspace line
    const c = harness(okRun);
    c.store.insertMail(reqMail());
    c.engine.pump();
    await flush();
    expect(c.store.unreadMailFor("athena")[0].body).not.toContain("Workspace:");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mail-sweep.test.ts -t "reports name the workspace"`
Expected: FAIL — success-report body lacks `Workspace:` line.

- [ ] **Step 3: Implement**

`src/engine/goals.ts` `mailReport` — replace the `body` construction (currently lines 514-517):

```ts
const refs = files.map((f) => `goals/${goal.goal_dir}/${f}`).join(", ");
const ws = goal.project_dir ? `\nWorkspace: ${goal.project_dir}` : "";
const body = ok
  ? `Done: ${goal.title}\nArtifacts: ${refs || "(none)"}${ws}`
  : `Failed: ${goal.title}\n${error ?? "unknown error"}${ws}`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/mail-sweep.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/goals.ts test/mail-sweep.test.ts
git commit -m "feat(mail): report mail names the goal workspace when one was carried"
```

---

### Task 3: Planner — unforce workspace for user-sent engineering mail

**Files:**
- Modify: `src/engine/plan.ts:219-244` (`plan()` + `planFromMail()`, shared helper)
- Test: `test/goal-planner.test.ts`

**Interfaces:**
- Consumes: `buildValidatedPlan` (existing), `RawPlan.{needsWorkspace, projectDir}`, `deps.projectsRoot`, `mail.from_agent`; Task 1's engine (eligible user-mail goals keep their `project_dir` when no `prepareSandbox` is wired in the harness).
- Produces: `planFromMail` passes `projectDir`/`needsWorkspace` through for user-sent engineering mail; forces `none` otherwise. `resolveWorkspaceDir(raw: RawPlan): string | undefined` used by both `plan()` and `planFromMail()`.

- [ ] **Step 1: Write the failing tests**

In `test/goal-planner.test.ts`, inside `describe("planFromMail")`, add a store-inserted user-mail helper and three tests. Note the existing local `mail()` fixture builds rows that are never inserted — the engine's eligibility check reads the store, so these tests must insert first:

```ts
  const insertUserMail = (store: Store) => {
    store.insertMail({
      id: "mu1", from_agent: "user", to_agent: "athena", kind: "request", body: "do x",
      goal_id: null, origin_channel: "web", origin_chat_id: "ui", chain_depth: 0,
      status: "planning", error: null, thread_id: null, in_reply_to: null,
    } as Omit<MailRow, "created_at" | "read_at">);
    return store.getMail("mu1")!;
  };

  it("user mail passes a validated workspace through to the goal", async () => {
    const WORKTREE_PLAN = { ...GOOD_PLAN, needsWorkspace: "worktree", projectDir: "/tmp/projects/x" };
    const { engine, store } = harness([WORKTREE_PLAN]);
    const m = insertUserMail(store);
    const g = await engine["deps"].planner!.planFromMail(engine, {
      department: "engineering", title: "Do X", request: "do x", channel: "web", chatId: "ui",
    }, m);
    expect(g.project_dir).toBe("/tmp/projects/x"); // no prepareSandbox in this harness — raw dir survives
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
  });

  it("user mail with a projectDir outside projectsRoot fails planning", async () => {
    const BAD_PLAN = { ...GOOD_PLAN, needsWorkspace: "worktree", projectDir: "/etc" };
    const { engine, store } = harness([BAD_PLAN]);
    const m = insertUserMail(store);
    await expect(engine["deps"].planner!.planFromMail(engine, {
      department: "engineering", title: "Do X", request: "do x", channel: "web", chatId: "ui",
    }, m)).rejects.toThrow(/projectDir under/);
    expect(store.listGoals()).toHaveLength(0);
  });

  it("user mail with needsWorkspace none stays workspace-less", async () => {
    const { engine, store } = harness([GOOD_PLAN]);
    const m = insertUserMail(store);
    const g = await engine["deps"].planner!.planFromMail(engine, {
      department: "engineering", title: "Do X", request: "do x", channel: "web", chatId: "ui",
    }, m);
    expect(g.project_dir).toBeNull();
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
  });
```

The pre-existing `forces no workspace even when the plan proposes a worktree` test (agent sender `odin`) is the sender-gate regression pin — leave it byte-identical.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/goal-planner.test.ts`
Expected: `user mail passes a validated workspace through` FAILS (`project_dir` null — planFromMail still forces none). `projectDir outside projectsRoot` FAILS (resolves without error today because the dir is discarded). `needsWorkspace none` may already pass. All pre-existing tests PASS.

- [ ] **Step 3: Implement**

`src/engine/plan.ts` — inside `makePlanner`, after `buildValidatedPlan`, add the shared helper:

```ts
/** worktree/analyze require a projectDir under projectsRoot; returns the resolved dir
 *  (undefined for greenfield/none). Throws a planning error otherwise — fail-closed. */
const resolveWorkspaceDir = (raw: RawPlan): string | undefined => {
  if (raw.needsWorkspace !== "worktree" && raw.needsWorkspace !== "analyze") return undefined;
  if (!raw.projectDir || !resolve(raw.projectDir).startsWith(resolve(deps.projectsRoot))) {
    throw new Error(`planning failed: needsWorkspace ${raw.needsWorkspace} requires projectDir under ${deps.projectsRoot}`);
  }
  return resolve(raw.projectDir);
};
```

In `plan()`, replace the inline block (lines 221-227) with:

```ts
const projectDir = resolveWorkspaceDir(raw);
```

Replace `planFromMail` (lines 235-244):

```ts
async planFromMail(engine, params, mail) {
  // Mail-origin: no chat preview (no human waiting). Workspace only for user-sent mail to
  // engineering (spec 2026-07-07-workspace-mail-goals) — agent mail keeps the hard
  // force-none wall (§2/§5); the engine strips independently as defense in depth.
  const { lead, raw, specs, origin } = await buildValidatedPlan(params);
  const workspaceEligible = mail.from_agent === "user" && params.department === "engineering";
  return engine.startPlannedGoal({
    title: params.title, request: params.request, department: params.department, lead,
    origin, summary: raw.summary, nodes: toNewTaskNodes(specs),
    projectDir: workspaceEligible ? resolveWorkspaceDir(raw) : undefined,
    needsWorkspace: workspaceEligible ? raw.needsWorkspace : "none",
    spawnedByMail: mail.id, chainDepth: mail.chain_depth,
  });
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/goal-planner.test.ts test/mail-sweep.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/plan.ts test/goal-planner.test.ts
git commit -m "feat(mail): planFromMail honors plan workspace for user-sent engineering mail

Shared resolveWorkspaceDir helper (dedup with plan()); agent mail and
non-engineering departments keep the forced-none wall at the planner layer."
```

---

### Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: **≥ 924 pass + 1 skip** (baseline 915 + 9 new), zero failures.

- [ ] **Step 2: Typecheck + builds**

Run: `npx tsc --noEmit && npm run build && cd ui && npx tsc --noEmit && npm run build`
Expected: all clean, zero errors.

- [ ] **Step 3: Dependency drift check**

Run: `git diff origin/main -- package.json package-lock.json ui/package.json ui/package-lock.json`
Expected: empty output.

- [ ] **Step 4: Commit (only if anything changed — normally nothing to commit)**

---

## Post-merge (session build cycle, not plan tasks)

Whole-branch review → fix findings → FF-merge to main → push → `npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios` → READ-ONLY smoke (`/api/mail/unread` with bearer token, boot ~2min) → ExitWorktree remove → update memory (`aios-project.md`: wall reversal shipped; narrow the "code only via code_task" lock to agent-autonomous).
