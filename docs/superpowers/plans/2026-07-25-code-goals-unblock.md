# Code Goals Unblock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Code goals can actually read, build and test a real repo — any project under `~/projects`, and AIOS itself via a self-contained clone.

**Architecture:** Four independent defect fixes, each isolated to one module: the sandbox profile gains the standard device sinks so `git`/npm run at all; the secret regex is anchored so ordinary source files stop being denied; `allocateWorkspace` serves a self-source request as a `git clone`; and the planner is allowed to name the daemon's own root as a workspace source.

**Tech Stack:** TypeScript, vitest, macOS `sandbox-exec` (SBPL), git.

**Spec:** `docs/superpowers/specs/2026-07-25-code-goals-unblock-design.md`

## Global Constraints

- No new npm dependencies.
- Trunk-based: commit on main, EXPLICIT file paths only in `git add` (a parallel session shares this checkout).
- `src/kernel/secrets.ts` stays THE single secret source for all three consumers (`isSecretPath`, SBPL profile, jail env). Never fork the patterns.
- The `/projects/AIOS/` SBPL **read deny stays**. Self-work reads the clone in the workspace, never the real repo.
- `assertInplaceTarget` is NOT touched — in-place edits of the AIOS tree stay forbidden.
- Writes stay confined to the task dir; the only new write surface is device sinks (`/dev/null`, `/dev/zero`, `/dev/tty`, `/dev/fd/*`).
- Read vitest's "Tests" summary line, not exit codes. `npx tsc --noEmit` clean in both roots.
- Deploy: `npm run build && launchctl kickstart -k gui/501/com.ihab.aios`, poll `/api/state`.

---

### Task 1: Sandbox device sinks — make `git` runnable

**Files:**
- Modify: `src/code/exec.ts` (`sandboxProfile`, the array before `writeAllow`)
- Test: `test/code-exec.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: the profile string gains device-write allows. No signature change.

- [ ] **Step 1: Write the failing test**

Add to `test/code-exec.test.ts` inside the `describe("sandboxProfile (pure)")` block:

```ts
  it("allows the device sinks so git and npm can run", () => {
    const p = sandboxProfile("/ws/task", "build");
    expect(p).toContain('(allow file-write-data (literal "/dev/null")');
    expect(p).toContain('(literal "/dev/tty")');
    expect(p).toContain('(allow file-ioctl (literal "/dev/null") (literal "/dev/tty"))');
  });

  it("device sinks are allowed in analyze mode too (read-only still needs /dev/null)", () => {
    expect(sandboxProfile("/ws/task", "analyze")).toContain('(allow file-write-data (literal "/dev/null")');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/code-exec.test.ts -t "device sinks"`
Expected: FAIL — the profile has no `file-write-data` line.

- [ ] **Step 3: Implement**

In `src/code/exec.ts`, in the array returned by `sandboxProfile`, insert these two lines immediately BEFORE `...sbplSecretDenyLines(),`:

```ts
    // Device sinks: git and most npm scripts open /dev/null for read+write and fail hard
    // without it ("fatal: could not open '/dev/null'"). Writing to a sink leaks nothing,
    // and the filesystem write surface stays confined to the task dir.
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/tty"))',
```

(They go before the secret denies only for readability — these are `file-write-data`/`file-ioctl` operations, which the `file-read*` denies never match, so ordering is not load-bearing here.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/code-exec.test.ts test/secrets-module.test.ts && npx tsc --noEmit`
Expected: green, tsc clean.

- [ ] **Step 5: Prove it live — git must now run inside the sandbox**

```bash
mkdir -p /tmp/aios-devnull-probe
npx tsx -e "
import { sandboxProfile } from './src/code/exec.ts';
import { execFileSync } from 'node:child_process';
const profile = sandboxProfile('/tmp/aios-devnull-probe','build');
const run = (c) => { try { return 'OK: ' + execFileSync('sandbox-exec',['-p',profile,'/bin/bash','--noprofile','--norc','-c',c],{encoding:'utf8'}).trim().split('\n')[0]; } catch(e){ return 'DENIED: ' + String(e.stderr||e.message).trim().split('\n')[0]; } };
console.log('git   :', run('git --version'));
console.log('devnull:', run('echo hi > /dev/null && echo ok'));
"
rm -rf /tmp/aios-devnull-probe
```
Expected: both OK. (Before this task both were DENIED.)

- [ ] **Step 6: Commit**

```bash
git add src/code/exec.ts test/code-exec.test.ts
git commit -m "fix(sandbox): allow device sinks — git and npm could not run without /dev/null"
```

---

### Task 2: Anchor the secret regex

**Files:**
- Modify: `src/kernel/secrets.ts` (`SECRET_PATH_PATTERNS` last entry, and the matching SBPL line)
- Test: `test/secrets-module.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: the same exports with a narrower final pattern. `isSecretPath`, the SBPL profile and jail env all inherit it.

- [ ] **Step 1: Write the failing test**

In `test/secrets-module.test.ts`, add these fixtures and a new test. Keep `HOSTILE_PATHS` as-is (they must all still be denied):

```ts
// Ordinary source files whose PATH merely contains a secret-ish word. Denying these
// broke real builds (postcss tokenize.js, sucrase TokenProcessor.d.ts) — see spec ⑪.
const INNOCENT_PATHS = [
  "/Users/x/app/node_modules/postcss/lib/tokenize.js",
  "/Users/x/app/node_modules/sucrase/dist/types/TokenProcessor.d.ts",
  "/Users/x/projects/Foo/src/kernel/secrets.ts",
  "/Users/x/projects/Foo/src/auth/tokenizer.test.ts",
  "/Users/x/projects/Foo/docs/credentials-guide.md",
];

describe("secret patterns are anchored to secret-looking FILES", () => {
  it("still denies every hostile fixture", () => {
    for (const p of HOSTILE_PATHS) expect(isSecretPath(p), p).toBe(true);
  });
  it("denies secret-named data files", () => {
    for (const p of [
      "/Users/x/projects/AIOS/data/google-tokens.json",
      "/Users/x/app/credentials.json",
      "/Users/x/app/.secrets",
      "/Users/x/app/config/api-token.txt",
    ]) expect(isSecretPath(p), p).toBe(true);
  });
  it("allows ordinary source files that merely contain the word", () => {
    for (const p of INNOCENT_PATHS) expect(isSecretPath(p), p).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/secrets-module.test.ts -t "anchored"`
Expected: FAIL — the innocent paths are currently denied by the unanchored `(token|credential|secret)`.

- [ ] **Step 3: Implement**

In `src/kernel/secrets.ts`, replace the last entry of `SECRET_PATH_PATTERNS`:

```ts
  /(token|credential|secret)/i,
```

with:

```ts
  // Anchored to a secret-looking FILENAME, not any path containing the word: the old
  // unanchored form denied node_modules/.../tokenize.js and src/kernel/secrets.ts,
  // breaking ordinary builds inside the sandbox (spec 2026-07-25).
  /(^|\/)\.?[\w-]*(token|credential|secret)s?(\.(json|ya?ml|txt|pem|key|ini|conf|env))?$/i,
```

And in `sbplSecretDenyLines`, replace the `(regex #"(token|credential|secret)")` fragment on the second line with the same expression, SBPL-escaped:

```ts
    '(deny file-read* (regex #"/projects/AIOS/") (regex #"\\.env($|\\.)") (regex #"(^|/)\\.?[\\w-]*(token|credential|secret)s?(\\.(json|ya?ml|txt|pem|key|ini|conf|env))?$"))',
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/secrets-module.test.ts test/code-paths.test.ts test/code-exec.test.ts && npx tsc --noEmit`
Expected: green, tsc clean. If `code-paths.test.ts` has a fixture asserting a now-allowed path is secret, READ it — if its intent is "a path containing 'token' is secret", update the fixture to a real secret file (e.g. `oauth_token.txt` → keep; `tokenize.js` → must flip to allowed). Do NOT weaken a fixture whose intent is a genuine secret.

- [ ] **Step 5: Prove it live**

```bash
npx tsx -e "
import { isSecretPath } from './src/code/paths.ts';
for (const p of ['/x/node_modules/postcss/lib/tokenize.js','/x/src/kernel/secrets.ts','/x/data/google-tokens.json','/x/.aws/credentials'])
  console.log(isSecretPath(p) ? 'DENY ' : 'ALLOW', p);
"
```
Expected: ALLOW for the first two, DENY for the last two.

- [ ] **Step 6: Commit**

```bash
git add src/kernel/secrets.ts test/secrets-module.test.ts
git commit -m "fix(secrets): anchor the token/credential/secret pattern to filenames — tokenize.js is not a secret"
```

---

### Task 3: Clone mode for the daemon's own repo

**Files:**
- Modify: `src/code/workspace.ts` (`AllocateDeps`, `validateSource`, `allocateWorkspace`)
- Modify: `src/index.ts` (pass `selfRoot` into `allocateWorkspace` deps in `prepareGoalSandbox`)
- Test: `test/code-workspace.test.ts`

**Interfaces:**
- Consumes: `resolveReal`, `isUnder`, `isSecretPath` from `./paths.js` (already imported).
- Produces: `AllocateDeps.selfRoot?: string`. `allocateWorkspace({mode:"worktree", source})` yields a CLONE when `source` is under `selfRoot`. `validateSource(source, deps)` accepts a self-root source.

- [ ] **Step 1: Write the failing tests**

Add to `test/code-workspace.test.ts` (the existing `deps` object in that describe block has no `selfRoot`; these tests build their own):

```ts
  it("a source under selfRoot is served as a self-contained CLONE, not a worktree", () => {
    const self = join(projects, "AIOS-like");
    gitInit(self);
    const d = { ...deps, selfRoot: self, id: "clone01" };
    const { taskDir } = allocateWorkspace({ mode: "worktree", source: self, slug: "self-work" }, d);
    // a clone has a real .git DIRECTORY; a worktree has a .git FILE pointing back at the source
    expect(existsSync(join(taskDir, ".git"))).toBe(true);
    expect(statSync(join(taskDir, ".git")).isDirectory()).toBe(true);
    // and git works inside it without reaching the source repo
    expect(() => execFileSync("git", ["log", "--oneline", "-1"], { cwd: taskDir })).not.toThrow();
  });

  it("a normal project is still a worktree (.git is a file)", () => {
    const repo = join(projects, "otherapp");
    gitInit(repo);
    const d = { ...deps, selfRoot: join(projects, "AIOS-like"), id: "wt01" };
    const { taskDir } = allocateWorkspace({ mode: "worktree", source: repo, slug: "other" }, d);
    expect(statSync(join(taskDir, ".git")).isFile()).toBe(true);
  });

  it("validateSource accepts the self root but still refuses other secret paths", () => {
    const self = join(projects, "AIOS-like");
    const d = { ...deps, selfRoot: self };
    expect(() => validateSource(self, d)).not.toThrow();
    expect(() => validateSource(join(projects, ".ssh"), d)).toThrow(/denylist|Not a git repo/);
  });
```

Add `statSync` to the `node:fs` import at the top of the file.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/code-workspace.test.ts -t "CLONE"`
Expected: FAIL — `allocateWorkspace` still runs `git worktree add`, so `.git` is a file (and for a real AIOS-like path `validateSource` throws on the denylist).

- [ ] **Step 3: Implement**

In `src/code/workspace.ts`, add to `AllocateDeps`:

```ts
  /** The daemon's own source root. A worktree request for a source under it is served as a
   *  clone: a worktree's .git points back into the real repo, which the sandbox denies. */
  selfRoot?: string;
```

In `validateSource`, change the signature to accept `selfRoot` and let the self root pass the denylist:

```ts
export function validateSource(source: string, deps: Pick<AllocateDeps, "readRoots" | "workspaceRoot" | "selfRoot">): void {
  const real = resolveReal(source);
  const isSelf = Boolean(deps.selfRoot && isUnder(real, deps.selfRoot));
  if (!isSelf && isSecretPath(real)) throw new Error(`Refused: source path is on the secret denylist`);
  if (!deps.readRoots.some((root) => isUnder(real, root))) {
    throw new Error(`Refused: source is outside the allowed read roots [${deps.readRoots.join(", ")}]`);
  }
  if (isUnder(real, deps.workspaceRoot)) throw new Error(`Refused: source is inside the workspace root`);
  if (!existsSync(join(real, ".git"))) throw new Error(`Not a git repo: ${source}`);
}
```

In `allocateWorkspace`, replace the worktree tail:

```ts
  // worktree
  if (!opts.source) throw new Error("worktree mode needs a source repo");
  validateSource(opts.source, deps);
  const git = deps.git ?? ((args, cwd) => { execFileSync("git", args, { cwd }); });
  git(["worktree", "add", "-b", `aios/${opts.slug}-${deps.id}`, taskDir, "HEAD"], resolveReal(opts.source));
  return { taskDir };
```

with:

```ts
  // worktree
  if (!opts.source) throw new Error("worktree mode needs a source repo");
  validateSource(opts.source, deps);
  const git = deps.git ?? ((args, cwd) => { execFileSync("git", args, { cwd }); });
  const source = resolveReal(opts.source);
  const branch = `aios/${opts.slug}-${deps.id}`;
  // Self-source ⇒ CLONE. A worktree's .git is a file pointing into the source repo, which the
  // sandbox denies for the daemon's own tree; a clone is self-contained, and because .env and
  // data/ are untracked it carries no secrets. --no-hardlinks so the copy shares no inodes.
  if (deps.selfRoot && isUnder(source, deps.selfRoot)) {
    git(["clone", "--no-hardlinks", "--quiet", source, taskDir], deps.workspaceRoot);
    git(["checkout", "-q", "-b", branch], taskDir);
    return { taskDir };
  }
  git(["worktree", "add", "-b", branch, taskDir, "HEAD"], source);
  return { taskDir };
```

In `src/index.ts` `prepareGoalSandbox`, add `selfRoot` to the deps object passed to `allocateWorkspace`:

```ts
      { workspaceRoot: config.workspaceRoot, readRoots: config.codeReadRoots, now: localParts(new Date()).date, id: randomUUID().slice(0, 8), selfRoot: resolveReal(process.cwd()) },
```

Import `resolveReal` in `src/index.ts` if it is not already imported: `import { resolveReal } from "./code/paths.js";` (check first — `assertInplaceTarget` wiring may already import from that module).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/code-workspace.test.ts && npx tsc --noEmit`
Expected: green, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/code/workspace.ts src/index.ts test/code-workspace.test.ts
git commit -m "feat(workspace): clone mode for the daemon's own repo — a worktree's .git points into denied territory"
```

---

### Task 4: Let the planner name the daemon's own root

**Files:**
- Modify: `src/engine/plan.ts` (`PlannerDeps`, `workspaceError`)
- Modify: `src/index.ts` (`makePlanner({ … selfRoot })`)
- Test: `test/goal-planner.test.ts`

**Interfaces:**
- Consumes: `isUnder` (already imported in plan.ts), `selfRoot` from index.
- Produces: `PlannerDeps.selfRoot?: string`. `workspaceError` accepts a self-root `projectDir`.

- [ ] **Step 1: Write the failing test**

`workspaceError` is a closure, not exported, so drive it through the planner the way the existing tests do. Add to `test/goal-planner.test.ts`:

```ts
  it("accepts a projectDir under selfRoot (AIOS self-work) instead of forcing needsWorkspace none", async () => {
    const store = new Store(":memory:");
    const previews: string[] = [];
    const plan = {
      summary: "self work", needsWorkspace: "worktree", projectDir: "/tmp/projects/AIOS",
      nodes: [{ key: "a", kind: "run", agent: "vulcan", brief: "fix it", deps: [] }],
    };
    const planner = makePlanner({
      registry: testRegistry(), store,
      run: (async (role: string) => role === "athena"
        ? { text: "plan", structured: plan, costUsd: 0, numTurns: 1 }
        : { text: "out", costUsd: 0, numTurns: 1 }) as SpecialistRunFn,
      projectsRoot: "/tmp/projects",
      selfRoot: "/tmp/projects/AIOS",
      postPreview: async (_o, t) => { previews.push(t); },
    });
    // planGoal must not throw "on the secret denylist"
    await expect(planner.plan(engineFor(store, planner), {
      department: "engineering", title: "t", request: "r", channel: "cli", chatId: "x",
    })).resolves.toBeTruthy();
  });
```

Reuse whatever `testRegistry`/engine helper the file already has (`harness()` builds both — prefer extending that helper over duplicating it; if `harness()` does not accept plan outputs with `projectDir`, pass the plan through its existing `planOutputs` array instead of hand-rolling a planner).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/goal-planner.test.ts -t "selfRoot"`
Expected: FAIL — `planning failed: projectDir /tmp/projects/AIOS is on the secret denylist …`.

- [ ] **Step 3: Implement**

In `src/engine/plan.ts`, add to `PlannerDeps`:

```ts
  /** Daemon's own source root — a workspace source under it is allowed (served as a clone
   *  by allocateWorkspace). Every other secret path is still refused. */
  selfRoot?: string;
```

In `workspaceError`, replace:

```ts
    if (isSecretPath(raw.projectDir)) {
```

with:

```ts
    const isSelf = Boolean(deps.selfRoot && isUnder(raw.projectDir, deps.selfRoot));
    if (!isSelf && isSecretPath(raw.projectDir)) {
```

In `src/index.ts`, add `selfRoot` to the `makePlanner({ … })` call:

```ts
      registry, store, run: runSpecialist,
      primaryChat: config.primaryChat, projectsRoot: config.projectsRoot,
      selfRoot: resolveReal(process.cwd()),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/goal-planner.test.ts test/planning-brief.test.ts && npx tsc --noEmit`
Expected: green, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/plan.ts src/index.ts test/goal-planner.test.ts
git commit -m "feat(planner): allow the daemon's own root as a workspace source (served as a clone)"
```

---

### Task 5: Full suite + deploy + live proof + push

**Files:** none (verification and shipping only).

- [ ] **Step 1: Typecheck both roots + full suite**

Run: `npx tsc --noEmit && (cd ui2 && npx tsc --noEmit); npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: all green; file count grows by 0 (all tests were added to existing files). Unrelated failures → STOP and report.

- [ ] **Step 2: Deploy**

```bash
npm run build && launchctl kickstart -k gui/501/com.ihab.aios
sleep 5
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 10 -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/state | head -c 60
```
Expected: JSON state.

- [ ] **Step 3: Live proof — a goal that works on AIOS itself**

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 600 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/chat \
  -d '{"target":"","text":"Have engineering work in /Users/ihabbishara/projects/AIOS: report the exact number of lines in src/moderator/prompt.ts and the first line of that file. They must read the real file in their workspace, not guess."}' | head -c 600
```
Then inspect the workspace that goal allocated:
```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/aios.sqlite');
const g = db.prepare('SELECT slug,project_dir,status FROM goals ORDER BY created_at DESC LIMIT 1').get();
console.log(g);
" 2>/dev/null
```
Expected: the goal's workspace is a real clone containing `src/moderator/prompt.ts`, and the reported line count matches `wc -l src/moderator/prompt.ts` on the real repo. A wrong number means the agent guessed → STOP and report.

- [ ] **Step 4: Live proof — git runs inside a real allocated workspace**

Take the `project_dir` from step 3 and run:
```bash
WS="<project_dir from step 3>"
npx tsx -e "
import { sandboxProfile } from './src/code/exec.ts';
import { execFileSync } from 'node:child_process';
const ws = process.env.WS;
const profile = sandboxProfile(ws,'build');
const run = (c) => { try { return 'OK: ' + execFileSync('sandbox-exec',['-p',profile,'/bin/bash','--noprofile','--norc','-c',c],{encoding:'utf8'}).trim().split('\n')[0]; } catch(e){ return 'DENIED: ' + String(e.stderr||e.message).trim().split('\n')[0]; } };
console.log('git status:', run('cd ' + ws + ' && git status --short | head -1 || echo clean'));
console.log('read src  :', run('head -1 ' + ws + '/src/moderator/prompt.ts'));
" WS="$WS"
```
Expected: both OK — git runs, and the clone's source is readable.

- [ ] **Step 5: Confirm the real repo is still protected**

```bash
npx tsx -e "
import { sandboxProfile } from './src/code/exec.ts';
import { execFileSync } from 'node:child_process';
const profile = sandboxProfile('/tmp','build');
try { execFileSync('sandbox-exec',['-p',profile,'/bin/bash','--noprofile','--norc','-c','head -1 /Users/ihabbishara/projects/AIOS/.env'],{encoding:'utf8'}); console.log('LEAK — .env readable'); }
catch { console.log('OK: real repo .env still denied'); }
"
```
Expected: `OK: real repo .env still denied`. A leak here is a STOP-and-revert.

- [ ] **Step 6: Push**

```bash
git push origin main
```
