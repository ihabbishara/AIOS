# Coding-Routing Gap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all coding work flow through one `code_task(mode)` entry that routes deterministically (build=sandboxed default / analyze=read-only / inplace=guarded real-repo bypass), and enforce at the `JobManager.createJob` chokepoint that the unsandboxed in-place path can never run accidentally or against the daemon's own source.

**Architecture:** Three small pure functions carry the safety logic — `isUnsandboxedWrite(pb, pillarOf)` classifies a packless+bypass-write playbook, `assertInplaceTarget(target, roots)` forbids dangerous targets, and `codeTaskPlan(mode)` maps a mode to a playbook + inplace flag. `createJob` calls the first two as a refusal gate; the new `code_task` moderator tool calls the third and is the only caller that ever sets `inplace: true`. The old `software-feature` playbook is renamed `code-inplace` and stays packless (that is the in-place semantics); `run_playbook` refuses all three code playbooks.

**Tech Stack:** TypeScript, Node 23 `node:sqlite`, Claude Agent SDK, vitest, zod, yaml.

## Global Constraints

- Subscription auth only — `CLAUDE_CODE_OAUTH_TOKEN`; NEVER `ANTHROPIC_API_KEY`. (No code in this plan touches auth.)
- Persistence is `node:sqlite` — NEVER `better-sqlite3`. No schema change this cycle (no migration).
- No new npm dependencies.
- Commit EXPLICIT paths only — never `git add -A`.
- TDD: failing test first, minimal code, green, commit. Run the full suite (`npx vitest run`) before each commit.
- Build path: `tsc` `rootDir:"."` → `dist/src/...` (do not assume `dist/`).
- Tests are vitest (`import { describe, it, expect } from "vitest"`). `Store` in tests is `new Store(":memory:")`.

---

### Task 1: `isUnsandboxedWrite` classifier (pure)

Classifies a playbook as the dangerous packless+bypass-write kind. A playbook is unsandboxed-write iff it has NO pack pillar (packless → no confinement override) AND any stage references a role whose `permissionMode` is `bypassPermissions`.

**Files:**
- Modify: `src/engine/jobs.ts` (add imports + two exported helpers near the top, after the existing imports)
- Test: `test/unsandboxed-write.test.ts` (create)

**Interfaces:**
- Consumes: `Playbook`, `Stage` from `./playbook.js`; `roles` from `../agents/roles/index.js`.
- Produces: `export function isUnsandboxedWrite(pb: Playbook, pillarOf?: Map<string, string>): boolean`; `export function stageRoles(stage: Stage): string[]`.

- [ ] **Step 1: Write the failing test**

Create `test/unsandboxed-write.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { isUnsandboxedWrite, stageRoles } from "../src/engine/jobs.js";
import type { Playbook } from "../src/engine/playbook.js";

const inplacePb: Playbook = {
  name: "code-inplace",
  description: "x",
  needsProjectDir: true,
  stages: [
    { type: "single", id: "research", role: "researcher" },
    { type: "loop", id: "design", producer: "architect", critic: "reviewer", maxRounds: 3 },
    { type: "single", id: "implement", role: "developer" },
    { type: "verify", id: "test", runner: "tester", fixer: "developer", maxRounds: 2 },
    { type: "single", id: "code-review", role: "code-reviewer" },
  ],
};

describe("stageRoles", () => {
  it("extracts roles from every stage shape", () => {
    expect(stageRoles({ type: "single", id: "a", role: "developer" })).toEqual(["developer"]);
    expect(stageRoles({ type: "loop", id: "b", producer: "architect", critic: "reviewer", maxRounds: 3 }))
      .toEqual(["architect", "reviewer"]);
    expect(stageRoles({ type: "verify", id: "c", runner: "tester", fixer: "developer", maxRounds: 2 }))
      .toEqual(["tester", "developer"]);
  });
});

describe("isUnsandboxedWrite", () => {
  it("flags a packless playbook that uses a bypassPermissions write role", () => {
    expect(isUnsandboxedWrite(inplacePb, new Map())).toBe(true);
    expect(isUnsandboxedWrite(inplacePb, undefined)).toBe(true);
  });

  it("does NOT flag a playbook that has a pack pillar", () => {
    expect(isUnsandboxedWrite(inplacePb, new Map([["code-inplace", "code"]]))).toBe(false);
  });

  it("does NOT flag a packless playbook with only read/dontAsk roles", () => {
    const readOnly: Playbook = {
      name: "echo", description: "x", needsProjectDir: false,
      stages: [{ type: "single", id: "a", role: "researcher" }],
    };
    expect(isUnsandboxedWrite(readOnly, new Map())).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unsandboxed-write.test.ts`
Expected: FAIL — `isUnsandboxedWrite`/`stageRoles` not exported from jobs.ts.

- [ ] **Step 3: Add the helpers to `src/engine/jobs.ts`**

Add to the import block at the top:

```typescript
import { type Playbook, type Stage } from "./playbook.js";
import { roles } from "../agents/roles/index.js";
```

(Note: `jobs.ts` already imports `{ type Playbook }` — widen that line to also import `Stage`, and add the `roles` import. Do not duplicate the `Playbook` import.)

Add these exported functions immediately after the imports, before `export interface JobOutcome`:

```typescript
/** All role names a stage references, across every stage shape. */
export function stageRoles(stage: Stage): string[] {
  switch (stage.type) {
    case "single": return [stage.role];
    case "loop": return [stage.producer, stage.critic];
    case "verify": return [stage.runner, stage.fixer];
  }
}

/** A playbook is "unsandboxed-write" iff it is packless (no pillar → no pack confinement
 *  overrides the role's permissionMode) AND a stage uses a bypassPermissions role. Such a
 *  playbook runs with raw role options (Bash/Write + allowDangerouslySkipPermissions) on the
 *  real filesystem — the in-place coding path that must be gated. */
export function isUnsandboxedWrite(pb: Playbook, pillarOf?: Map<string, string>): boolean {
  if (pillarOf?.get(pb.name)) return false; // has a pillar → pack-confined, not raw
  return pb.stages.some((s) => stageRoles(s).some((r) => roles[r]?.permissionMode === "bypassPermissions"));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unsandboxed-write.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add src/engine/jobs.ts test/unsandboxed-write.test.ts
git commit -m "feat(jobs): isUnsandboxedWrite classifier for packless bypass-write playbooks"
```

---

### Task 2: `assertInplaceTarget` guard (pure)

Refuses an in-place target that is the AIOS source tree (self), a secret path, inside the sandbox workspace, outside `projectsRoot`, or not an existing directory. Fail-closed.

**Files:**
- Modify: `src/code/paths.ts` (add `statSync` to the `node:fs` import; append the function)
- Test: `test/inplace-target.test.ts` (create)

**Interfaces:**
- Consumes: `resolveReal`, `isUnder`, `isSecretPath` (same module); `existsSync`, `statSync` from `node:fs`.
- Produces: `export function assertInplaceTarget(target: string, roots: { selfRoot: string; workspaceRoot: string; projectsRoot: string }): void` — throws `Error("Refused: …")` on any violation.

- [ ] **Step 1: Write the failing test**

Create `test/inplace-target.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertInplaceTarget } from "../src/code/paths.js";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "inplace-"));
  const projectsRoot = join(base, "projects");
  const selfRoot = join(projectsRoot, "AIOS");        // the daemon's own tree
  const workspaceRoot = join(projectsRoot, "AIOS-Workspace");
  const repo = join(projectsRoot, "app");             // a legit target
  for (const d of [projectsRoot, selfRoot, workspaceRoot, repo]) mkdirSync(d, { recursive: true });
  return { base, projectsRoot, selfRoot, workspaceRoot, repo };
}

describe("assertInplaceTarget", () => {
  it("allows a normal repo dir under projectsRoot", () => {
    const s = setup();
    expect(() => assertInplaceTarget(s.repo, s)).not.toThrow();
  });

  it("refuses the AIOS self root and anything containing/under it", () => {
    const s = setup();
    expect(() => assertInplaceTarget(s.selfRoot, s)).toThrow(/AIOS source/);
    expect(() => assertInplaceTarget(join(s.selfRoot, "src"), s)).toThrow(/AIOS source/);
    // self under target: target is an ancestor of selfRoot
    expect(() => assertInplaceTarget(s.projectsRoot, s)).toThrow(/AIOS source/);
  });

  it("refuses a secret path", () => {
    const s = setup();
    const secret = join(s.projectsRoot, "my-token-store");
    mkdirSync(secret, { recursive: true });
    expect(() => assertInplaceTarget(secret, s)).toThrow(/secret/);
  });

  it("refuses a target inside the sandbox workspace", () => {
    const s = setup();
    const ws = join(s.workspaceRoot, "task1");
    mkdirSync(ws, { recursive: true });
    expect(() => assertInplaceTarget(ws, s)).toThrow(/workspace/);
  });

  it("refuses a target outside projectsRoot", () => {
    const s = setup();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    expect(() => assertInplaceTarget(outside, s)).toThrow(/under/);
  });

  it("refuses a non-existent target and a file", () => {
    const s = setup();
    expect(() => assertInplaceTarget(join(s.projectsRoot, "ghost"), s)).toThrow(/directory/);
    const f = join(s.repo, "file.txt");
    writeFileSync(f, "x");
    expect(() => assertInplaceTarget(f, s)).toThrow(/directory/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/inplace-target.test.ts`
Expected: FAIL — `assertInplaceTarget` not exported.

- [ ] **Step 3: Implement in `src/code/paths.ts`**

Change the `node:fs` import line from:

```typescript
import { realpathSync, existsSync } from "node:fs";
```

to:

```typescript
import { realpathSync, existsSync, statSync } from "node:fs";
```

Append at the end of the file:

```typescript
/** Guard an in-place coding target. Refuses (fail-closed) the AIOS source tree, secret paths,
 *  the sandbox workspace, anything outside projectsRoot, and non-directories. selfRoot is the
 *  daemon's own source root (caller passes resolveReal(process.cwd())). */
export function assertInplaceTarget(
  target: string,
  roots: { selfRoot: string; workspaceRoot: string; projectsRoot: string },
): void {
  let real: string;
  try {
    real = resolveReal(target);
  } catch {
    throw new Error("Refused: cannot resolve inplace target");
  }
  if (isUnder(real, roots.selfRoot) || isUnder(roots.selfRoot, real)) {
    throw new Error("Refused: inplace cannot target the AIOS source tree");
  }
  if (isSecretPath(real)) throw new Error("Refused: inplace target is on the secret denylist");
  if (isUnder(real, roots.workspaceRoot)) throw new Error("Refused: inplace target is inside the sandbox workspace");
  if (!isUnder(real, roots.projectsRoot)) throw new Error(`Refused: inplace target must be under ${roots.projectsRoot}`);
  if (!existsSync(real) || !statSync(real).isDirectory()) {
    throw new Error(`Refused: inplace target is not an existing directory: ${target}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/inplace-target.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add src/code/paths.ts test/inplace-target.test.ts
git commit -m "feat(code): assertInplaceTarget guard — forbid self/secret/workspace/out-of-root targets"
```

---

### Task 3: Enforce the gate at `JobManager.createJob`

Add an optional `inplace` flag to `createJob` and the two roots to `JobManagerDeps`. When the playbook is unsandboxed-write, refuse unless `inplace` is set, `project_dir` is present, and `assertInplaceTarget` passes. Wire the roots in `index.ts`.

**Files:**
- Modify: `src/engine/jobs.ts` (`JobManagerDeps`, `createJob`)
- Modify: `src/index.ts` (pass `projectsRoot` + `workspaceRoot` to `new JobManager`)
- Test: `test/createjob-inplace.test.ts` (create)

**Interfaces:**
- Consumes: `isUnsandboxedWrite` (Task 1); `assertInplaceTarget`, `resolveReal` from `../code/paths.js` (Task 2).
- Produces: `JobManagerDeps` gains `projectsRoot?: string; workspaceRoot?: string`. `createJob` params gain `inplace?: boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/createjob-inplace.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobManager } from "../src/engine/jobs.js";
import { Store } from "../src/store/db.js";
import type { Playbook } from "../src/engine/playbook.js";

const inplacePb: Playbook = {
  name: "code-inplace", description: "x", needsProjectDir: true,
  stages: [
    { type: "single", id: "implement", role: "developer" },
  ],
};

function mgr(opts: { projectsRoot?: string; workspaceRoot?: string }) {
  const store = new Store(":memory:");
  const jm = new JobManager({
    store,
    vault: {} as any,
    run: (async () => { throw new Error("run should not be called"); }) as any,
    playbooks: new Map([["code-inplace", inplacePb]]),
    wallTimeMs: 1000,
    maxConcurrent: 0, // queue but never pump → createJob returns without executing
    onComplete: async () => {},
    pillarOf: new Map(), // packless
    projectsRoot: opts.projectsRoot,
    workspaceRoot: opts.workspaceRoot,
  });
  return { store, jm };
}

function roots() {
  const base = mkdtempSync(join(tmpdir(), "cj-"));
  const projectsRoot = join(base, "projects");
  const workspaceRoot = join(projectsRoot, "AIOS-Workspace");
  const repo = join(projectsRoot, "app");
  for (const d of [projectsRoot, workspaceRoot, repo]) mkdirSync(d, { recursive: true });
  return { projectsRoot, workspaceRoot, repo };
}

describe("createJob inplace gate", () => {
  it("refuses an unsandboxed-write playbook without the inplace flag", () => {
    const r = roots();
    const { jm } = mgr(r);
    expect(() => jm.createJob({
      playbook: "code-inplace", title: "t", request: "q",
      projectDir: r.repo, channel: "c", chatId: "x",
    })).toThrow(/code_task/);
  });

  it("refuses inplace when assertInplaceTarget rejects the target", () => {
    const r = roots();
    const { jm } = mgr(r);
    expect(() => jm.createJob({
      playbook: "code-inplace", title: "t", request: "q",
      projectDir: r.workspaceRoot, inplace: true, channel: "c", chatId: "x",
    })).toThrow(/workspace/);
  });

  it("refuses inplace when roots are not configured (fail-closed)", () => {
    const { jm } = mgr({});
    expect(() => jm.createJob({
      playbook: "code-inplace", title: "t", request: "q",
      projectDir: "/anything", inplace: true, channel: "c", chatId: "x",
    })).toThrow(/not configured/);
  });

  it("allows inplace with the flag + a valid target", () => {
    const r = roots();
    const { jm, store } = mgr(r);
    const job = jm.createJob({
      playbook: "code-inplace", title: "Fix bug", request: "q",
      projectDir: r.repo, inplace: true, channel: "c", chatId: "x",
    });
    expect(job.playbook).toBe("code-inplace");
    expect(store.getJob(job.id)!.status).toBe("queued");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/createjob-inplace.test.ts`
Expected: FAIL — `createJob` has no `inplace` param / no gate; `JobManagerDeps` has no roots.

- [ ] **Step 3: Implement the gate in `src/engine/jobs.ts`**

Add to the imports at the top:

```typescript
import { resolveReal, assertInplaceTarget } from "../code/paths.js";
```

In `JobManagerDeps`, add two fields (after `pillarOf?`):

```typescript
  /** Root for inplace containment + self-guard derivation. Required for inplace jobs. */
  projectsRoot?: string;
  /** Sandbox workspace root, forbidden as an inplace target. */
  workspaceRoot?: string;
```

In `createJob`, widen the params type to include `inplace`:

```typescript
  createJob(params: {
    playbook: string;
    title: string;
    request: string;
    projectDir?: string;
    channel: string;
    chatId: string;
    inplace?: boolean;
  }): JobRow {
```

Insert the gate immediately after the existing `needsProjectDir` check (after the `throw new Error(\`Playbook ${pb.name} needs a project directory…\`)` block, before `const id = randomUUID();`):

```typescript
    if (isUnsandboxedWrite(pb, this.deps.pillarOf)) {
      if (!params.inplace) {
        throw new Error(
          `Refused: ${pb.name} is an unsandboxed in-place coding path; run it via code_task mode:inplace.`,
        );
      }
      if (!params.projectDir) throw new Error("Refused: inplace requires project_dir.");
      if (!this.deps.projectsRoot || !this.deps.workspaceRoot) {
        throw new Error("Refused: inplace is not configured (no projectsRoot/workspaceRoot).");
      }
      assertInplaceTarget(params.projectDir, {
        selfRoot: resolveReal(process.cwd()),
        workspaceRoot: this.deps.workspaceRoot,
        projectsRoot: this.deps.projectsRoot,
      });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/createjob-inplace.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Wire the roots in `src/index.ts`**

In the `new JobManager({ … })` block (around line 185), add two fields alongside `pillarOf`:

```typescript
    pillarOf,
    projectsRoot: config.projectsRoot,
    workspaceRoot: config.workspaceRoot,
    prepareSandbox,
```

(Insert `projectsRoot`/`workspaceRoot` lines next to the existing `pillarOf,` line; keep `prepareSandbox` / `resolvePackFor` as they are.)

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — no existing test creates a `software-feature`/`code-inplace` job, so the new refusal does not fire anywhere yet.

- [ ] **Step 7: Commit**

```bash
git add src/engine/jobs.ts src/index.ts test/createjob-inplace.test.ts
git commit -m "feat(jobs): gate unsandboxed-write playbooks at createJob (inplace flag + target guard)"
```

---

### Task 4: Rename `software-feature` → `code-inplace` (+ persona, tests, docs)

The packless in-place playbook gets an honest name and brief. Update the two tests that name it and the architecture doc.

**Files:**
- Rename: `playbooks/software-feature.yaml` → `playbooks/code-inplace.yaml` (via `git mv`)
- Modify: `playbooks/code-inplace.yaml` (name + description + implement-stage brief)
- Modify: `test/playbook.test.ts`
- Modify: `test/packs-run-endpoint.test.ts:27`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Produces: a playbook named `code-inplace` (packless, `needsProjectDir: true`, same 5-stage pipeline).

- [ ] **Step 1: Rename + edit the playbook**

```bash
git mv playbooks/software-feature.yaml playbooks/code-inplace.yaml
```

Edit `playbooks/code-inplace.yaml` — replace the `name` and `description`:

```yaml
name: code-inplace
description: >-
  In-place software pipeline on a REAL repository (research, design with review loop,
  implementation, test-and-fix, final code review). NOT sandboxed: the developer/tester
  edit and run commands directly in the given project_dir. Requires project_dir. Reachable
  only via code_task mode:inplace.
needsProjectDir: true
```

And change the `implement` stage `brief` to make the in-place semantics explicit:

```yaml
  - type: single
    id: implement
    role: developer
    brief: >-
      Implement the approved design directly in the project_dir working directory. This is the
      user's REAL checkout — changes are NOT sandboxed. Match existing style; run builds to verify.
```

(Leave the research/design/test/code-review stages unchanged.)

- [ ] **Step 2: Update `test/playbook.test.ts`**

Replace the two `software-feature` references. The loaded-playbooks set:

```typescript
    expect([...playbooks.keys()].sort()).toEqual([
      "code-inplace",
      "echo",
    ]);
```

And the pipeline test:

```typescript
  it("code-inplace has the full pipeline and needs a project dir", () => {
    const playbooks = loadPlaybooks(join(process.cwd(), "playbooks"));
    const pb = playbooks.get("code-inplace")!;
    expect(pb.needsProjectDir).toBe(true);
    expect(pb.stages.map((s) => s.id)).toEqual(["research", "design", "implement", "test", "code-review"]);
    const design = pb.stages.find((s) => s.id === "design");
    expect(design).toMatchObject({ type: "loop", producer: "architect", critic: "reviewer", maxRounds: 3 });
  });
```

- [ ] **Step 3: Update `test/packs-run-endpoint.test.ts:27`**

Change the assertion's playbook name (it asserts a non-pack code playbook is rejected from the code pillar):

```typescript
    expect(validateRunRequest(cfg(), "code", "code-inplace", undefined).ok).toBe(false);
```

- [ ] **Step 4: Update `docs/ARCHITECTURE.md`**

Make these exact replacements:

- Line ~83 (sequence diagram): `Mod->>Eng: run_playbook(software-feature, ...) → job id` → `Mod->>Eng: code_task(build, ...) → job id`
- Line ~104 heading: `## The \`software-feature\` playbook` → `## The coding playbooks (code_task)`
- Add one sentence directly under that heading:
  `All coding flows through one \`code_task(mode)\` tool: \`build\` (sandboxed worktree, default), \`analyze\` (read-only audit), \`inplace\` (edits your real checkout — not sandboxed, reachable only by explicit request and blocked from the AIOS source tree). \`run_playbook\` does not run code playbooks.`
- Line ~135 shipped-playbooks list: replace `\`software-feature\` (full pipeline, needs project dir),` with `\`code-build\`/\`code-analyze\` (sandboxed code pack), \`code-inplace\` (in-place pipeline, needs project dir),`
- Line ~268 tree comment: replace `software-feature` with `code-inplace`.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — playbook + packs-run-endpoint tests now green against the new name.

- [ ] **Step 6: Commit**

```bash
git add playbooks/code-inplace.yaml test/playbook.test.ts test/packs-run-endpoint.test.ts docs/ARCHITECTURE.md
git commit -m "refactor(playbooks): rename software-feature → code-inplace (honest in-place naming + docs)"
```

---

### Task 5: `code_task` tool + `run_playbook` refuses code playbooks

The single coding entry. Pure mapping helpers are unit-tested; the tool is thin glue over them + `createJob`. `run_playbook` rejects the three code playbooks so `code_task` is the only door.

**Files:**
- Modify: `src/moderator/tools.ts` (add helpers + `code_task` tool; guard `run_playbook`; register the tool)
- Test: `test/code-task.test.ts` (create)

**Interfaces:**
- Consumes: `JobManager.createJob` (now accepts `inplace`).
- Produces: `export type CodeMode = "build" | "analyze" | "inplace"`; `export function codeTaskPlan(mode: CodeMode): { playbook: string; inplace: boolean }`; `export const CODE_PLAYBOOKS: Set<string>`; `export function isCodePlaybook(name: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/code-task.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { codeTaskPlan, isCodePlaybook, CODE_PLAYBOOKS } from "../src/moderator/tools.js";

describe("codeTaskPlan", () => {
  it("maps each mode to a playbook + inplace flag", () => {
    expect(codeTaskPlan("build")).toEqual({ playbook: "code-build", inplace: false });
    expect(codeTaskPlan("analyze")).toEqual({ playbook: "code-analyze", inplace: false });
    expect(codeTaskPlan("inplace")).toEqual({ playbook: "code-inplace", inplace: true });
  });
});

describe("isCodePlaybook", () => {
  it("is true for the three code playbooks, false otherwise", () => {
    for (const n of ["code-build", "code-analyze", "code-inplace"]) expect(isCodePlaybook(n)).toBe(true);
    expect(CODE_PLAYBOOKS.size).toBe(3);
    expect(isCodePlaybook("echo")).toBe(false);
    expect(isCodePlaybook("research-report")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/code-task.test.ts`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Add helpers + tool to `src/moderator/tools.ts`**

Add the exported helpers near the top of the file (after the imports, before `export function teachingDomain`):

```typescript
export type CodeMode = "build" | "analyze" | "inplace";

/** Deterministic mode → playbook + inplace flag. No intent inference; build is the safe default. */
export function codeTaskPlan(mode: CodeMode): { playbook: string; inplace: boolean } {
  switch (mode) {
    case "analyze": return { playbook: "code-analyze", inplace: false };
    case "inplace": return { playbook: "code-inplace", inplace: true };
    case "build": return { playbook: "code-build", inplace: false };
  }
}

export const CODE_PLAYBOOKS = new Set(["code-build", "code-analyze", "code-inplace"]);
export function isCodePlaybook(name: string): boolean { return CODE_PLAYBOOKS.has(name); }
```

In the `runPlaybook` tool handler, add a refusal as the FIRST line inside `async (args) => {`:

```typescript
      if (isCodePlaybook(args.playbook)) {
        return text(`Refused: ${args.playbook} runs via code_task (mode build/analyze/inplace), not run_playbook.`);
      }
```

Add the `code_task` tool definition (place it right after the `runPlaybook` definition, before `jobStatus`):

```typescript
  const codeTask = tool(
    "code_task",
    "Run a coding job. mode 'build' (default) builds or extends code in a SANDBOXED workspace " +
      "(a git worktree of project_dir if given, else a fresh greenfield dir); 'analyze' is a " +
      "read-only audit of project_dir; 'inplace' edits the user's REAL checkout at project_dir " +
      "directly and is NOT sandboxed — use ONLY when the user explicitly asks to modify a real " +
      "repo in place. Returns a job id; you are notified on completion.",
    {
      mode: z.enum(["build", "analyze", "inplace"]).optional().describe("Default 'build'."),
      title: z.string().describe("Short human title for the job"),
      request: z.string().describe("Full task description for the specialist agents — include all context"),
      project_dir: z.string().optional().describe("Absolute path to the target repo (required for analyze and inplace)"),
    },
    async (args) => {
      const mode = (args.mode ?? "build") as CodeMode;
      const plan = codeTaskPlan(mode);
      if ((mode === "analyze" || mode === "inplace") && !args.project_dir) {
        return text(`Refused: mode '${mode}' requires project_dir.`);
      }
      try {
        const job = deps.jobs.createJob({
          playbook: plan.playbook,
          title: args.title,
          request: args.request,
          projectDir: args.project_dir,
          inplace: plan.inplace,
          channel: deps.origin.channel,
          chatId: deps.origin.chatId,
        });
        return text(`Job started: ${job.id} (${job.slug}, ${plan.playbook}${plan.inplace ? ", in-place" : ""}). You will be notified on completion.`);
      } catch (err) {
        return text(`Refused: ${(err as Error).message}`);
      }
    },
  );
```

Register `codeTask` in the returned `tools` array — add it next to `runPlaybook`:

```typescript
      runPlaybook, codeTask, jobStatus, listPlaybooks, askSpecialist,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/code-task.test.ts`
Expected: PASS (all assertions).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — whole suite green.

- [ ] **Step 6: Commit**

```bash
git add src/moderator/tools.ts test/code-task.test.ts
git commit -m "feat(moderator): code_task single coding entry + run_playbook refuses code playbooks"
```

---

## Self-review notes

- **Spec coverage:** §1 single entry → Task 5 (`code_task`) + Task 4 (rename). §2 chokepoint → Task 3 (`createJob` gate) + Task 1 (classifier). §3 target guard → Task 2 (`assertInplaceTarget`). §4 housekeeping/tests/docs → Task 4. §5 invariants (no migration, self via `process.cwd()`) → Tasks 2–3. Every spec section maps to a task.
- **No DB migration** (no schema touched) — consistent with the spec.
- **Type consistency:** `codeTaskPlan` returns `{ playbook, inplace }`; `createJob` consumes `inplace?`; `isUnsandboxedWrite(pb, pillarOf?)` and `assertInplaceTarget(target, {selfRoot, workspaceRoot, projectsRoot})` signatures are identical everywhere they appear.
- **Ordering safety:** after Task 3 the gate is live but no existing test creates an unsandboxed-write job, so the suite stays green; Task 4 renames the file and updates the only two tests that name it.
```
