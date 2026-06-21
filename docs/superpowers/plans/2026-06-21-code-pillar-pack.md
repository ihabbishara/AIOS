# Code Pillar Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind the `code` pillar to a sandboxed software-engineering pack — agents that build, test, review, and do DevOps on real code, with every write jailed to `$AIOS_WORKSPACE_ROOT`, reads scoped away from secrets, and the only gated outward effect being `vault.write`.

**Architecture:** A code playbook job allocates a persistent workspace dir (greenfield mkdir / `git worktree add` of an existing repo / read-only analyze), the JobManager rewrites the job's `project_dir` to that jail, and the pack resolves with a deterministic confinement guard (write-jail + read-scope, PreToolUse-enforced) plus an OS-sandboxed exec tool (`mcp__code__sh` via `sandbox-exec`) that replaces raw Bash. Two small framework refinements (per-role built-in tool clamp; optional pack-injected confinement) make this safe without regressing the money pack.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 23 `node:sqlite`, `@anthropic-ai/claude-agent-sdk`, vitest, macOS `sandbox-exec`.

## Global Constraints

- Node 23 built-in `node:sqlite` only — NEVER better-sqlite3. FTS5 unavailable.
- Subscription auth via `CLAUDE_CODE_OAUTH_TOKEN` — NO `ANTHROPIC_API_KEY`.
- ESM: every relative import ends in `.js`. Tests: `import { describe, it, expect } from "vitest"`; run with `npx vitest run`.
- Pure code must NOT call `Date.now()` / `Math.random()` / argless `new Date()` — inject clocks/ids (mirror existing `dream.ts`/allocator patterns).
- Commit EXPLICIT paths only (`git add <path> ...`). The uncommitted pdf-attachments WIP in the main checkout must never be staged. Build artifacts land at `dist/src/...`.
- Work in the isolated worktree's absolute path. `src/agents/roles/index.ts` and `src/index.ts` are WIP-overlap files — they 3-way merge at deploy; edit them normally in the worktree (which is off clean HEAD).
- New money-pack-style behavior must be regression-pinned: the money pack's resolved tools/options must be byte-for-byte unchanged.

**Module map (new):** `src/code/paths.ts` (path safety), `src/code/workspace.ts` (allocator), `src/code/guard.ts` (confinement ToolChecks), `src/code/exec.ts` (sandboxed exec MCP server). **Modified:** `src/config.ts`, `src/packs/types.ts`, `src/packs/resolve.ts`, `src/agents/runner.ts`, `src/agents/roles/index.ts`, `src/store/db.ts`, `src/engine/jobs.ts`, `src/index.ts`. **New manifests:** `playbooks/code/{pack.yaml,code-build.yaml,code-analyze.yaml}`.

---

### Task 1: Config — workspace root, read roots, kill-switch

**Files:**
- Modify: `src/config.ts` (Config interface + buildConfig literal)
- Test: `test/code-config.test.ts`

**Interfaces:**
- Produces: `config.workspaceRoot: string`, `config.codeReadRoots: string[]`, `config.codeDisabled: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// test/code-config.test.ts
import { describe, it, expect } from "vitest";
import { buildConfig } from "../src/config.js";

describe("code pack config", () => {
  it("defaults workspaceRoot under home, readRoots to [projectsRoot], codeDisabled false", () => {
    const c = buildConfig();
    expect(c.workspaceRoot).toMatch(/AIOS-Workspace$/);
    expect(c.codeReadRoots).toEqual([c.projectsRoot]);
    expect(c.codeDisabled).toBe(false);
  });

  it("honors env overrides", () => {
    const c = buildConfig({
      AIOS_WORKSPACE_ROOT: "/tmp/ws",
      AIOS_CODE_READ_ROOTS: "/a, /b",
      AIOS_CODE_DISABLED: "1",
    });
    expect(c.workspaceRoot).toBe("/tmp/ws");
    expect(c.codeReadRoots).toEqual(["/a", "/b"]);
    expect(c.codeDisabled).toBe(true);
  });
});
```

> NOTE: if `buildConfig` currently reads `process.env` directly with no arg, add an optional `env: NodeJS.ProcessEnv = process.env` parameter in this task and thread `env.AIOS_*` for the three new fields (only). Keep existing fields reading `process.env` unchanged to minimize churn, OR thread `env` fully if trivial — match the file's existing style.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/code-config.test.ts`
Expected: FAIL — `workspaceRoot` undefined / `buildConfig` arity.

- [ ] **Step 3: Implement**

In `src/config.ts`, add to the `Config` interface:
```ts
  workspaceRoot: string;
  codeReadRoots: string[];
  codeDisabled: boolean;
```
In `buildConfig`, near `projectsRoot`, add (use the `env` arg if you introduced it, else `process.env`):
```ts
    workspaceRoot: process.env.AIOS_WORKSPACE_ROOT ?? join(home, "projects", "AIOS-Workspace"),
    codeReadRoots: (process.env.AIOS_CODE_READ_ROOTS ?? join(home, "projects"))
      .split(",").map((s) => s.trim()).filter(Boolean),
    codeDisabled: process.env.AIOS_CODE_DISABLED === "1",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/code-config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/code-config.test.ts
git commit -m "feat(code-pack): config — workspaceRoot, codeReadRoots, kill-switch"
```

---

### Task 2: Path safety utilities

**Files:**
- Create: `src/code/paths.ts`
- Test: `test/code-paths.test.ts`

**Interfaces:**
- Produces:
  - `resolveReal(p: string): string` — realpath of the nearest existing ancestor + the unresolved tail (so a not-yet-created file resolves to where it *would* live, symlinks collapsed).
  - `isUnder(child: string, parent: string): boolean` — true iff `resolveReal(child)` is `parent` or below it (realpath-based; defeats `..`/symlinks).
  - `isSecretPath(p: string): boolean` — true for the hard secret denylist.

- [ ] **Step 1: Write the failing test**

```ts
// test/code-paths.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isUnder, isSecretPath, resolveReal } from "../src/code/paths.js";

describe("code path safety", () => {
  const root = mkdtempSync(join(tmpdir(), "paths-"));
  const jail = join(root, "jail");
  mkdirSync(jail, { recursive: true });

  it("isUnder true for a child (existing and not-yet-existing)", () => {
    expect(isUnder(join(jail, "a/b.txt"), jail)).toBe(true);
    writeFileSync(join(jail, "real.txt"), "x");
    expect(isUnder(join(jail, "real.txt"), jail)).toBe(true);
  });

  it("isUnder false for an escape via ..", () => {
    expect(isUnder(join(jail, "../outside.txt"), jail)).toBe(false);
  });

  it("isUnder false for a symlink that escapes the jail", () => {
    const link = join(jail, "escape");
    symlinkSync(root, link); // jail/escape -> root (parent)
    expect(isUnder(join(link, "x.txt"), jail)).toBe(false);
  });

  it("isSecretPath flags AIOS, ssh, env, tokens", () => {
    expect(isSecretPath("/Users/me/projects/AIOS/.env")).toBe(true);
    expect(isSecretPath("/Users/me/.ssh/id_rsa")).toBe(true);
    expect(isSecretPath("/Users/me/app/google-tokens.json")).toBe(true);
    expect(isSecretPath("/Users/me/app/src/main.ts")).toBe(false);
  });

  it("resolveReal collapses .. against an existing ancestor", () => {
    expect(resolveReal(join(jail, "..", "jail", "z"))).toBe(join(resolveReal(jail), "z"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/code-paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/code/paths.ts
import { realpathSync, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** Realpath the nearest existing ancestor, then re-append the not-yet-existing tail.
 *  Collapses `..` and symlinks in the part that exists — the part an attacker controls. */
export function resolveReal(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break; // reached filesystem root
    tail.unshift(cur.slice(parent.length + 1));
    cur = parent;
  }
  const realBase = existsSync(cur) ? realpathSync(cur) : cur;
  return tail.length ? join(realBase, ...tail) : realBase;
}

/** True iff `child` resolves to `parent` or a path strictly below it. */
export function isUnder(child: string, parent: string): boolean {
  const c = resolveReal(child);
  const base = resolveReal(parent);
  return c === base || c.startsWith(base.endsWith(sep) ? base : base + sep);
}

const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.config(\/|$)/,
  /(^|\/)projects\/AIOS(\/|$)/,
  /\.env(\.[^/]+)?$/,
  /(token|credential|secret)/i,
];

/** Hard denylist that always wins over any read-root. */
export function isSecretPath(p: string): boolean {
  const r = resolveReal(p);
  return SECRET_PATTERNS.some((re) => re.test(r));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/code-paths.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/code/paths.ts test/code-paths.test.ts
git commit -m "feat(code-pack): realpath-based path containment + secret denylist"
```

---

### Task 3: Workspace allocator

**Files:**
- Create: `src/code/workspace.ts`
- Test: `test/code-workspace.test.ts`

**Interfaces:**
- Consumes: `isUnder`, `isSecretPath` (Task 2).
- Produces:
  - `type WorkspaceMode = "greenfield" | "worktree" | "analyze"`
  - `interface AllocateDeps { workspaceRoot: string; readRoots: string[]; now: string; id: string; git?: (args: string[], cwd: string) => void }`
  - `validateSource(source: string, deps: Pick<AllocateDeps,"readRoots"|"workspaceRoot">): void` — throws on invalid.
  - `allocateWorkspace(opts: { mode: WorkspaceMode; source?: string; slug: string }, deps: AllocateDeps): { taskDir: string }`

- [ ] **Step 1: Write the failing test**

```ts
// test/code-workspace.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allocateWorkspace, validateSource } from "../src/code/workspace.js";

function gitInit(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
}

describe("workspace allocator", () => {
  const home = mkdtempSync(join(tmpdir(), "ws-home-"));
  const wsRoot = join(home, "AIOS-Workspace");
  const projects = join(home, "projects");
  const deps = { workspaceRoot: wsRoot, readRoots: [projects], now: "2026-06-21", id: "abc123" };

  it("greenfield creates a fresh dir under workspaceRoot", () => {
    const { taskDir } = allocateWorkspace({ mode: "greenfield", slug: "new-cli" }, deps);
    expect(taskDir).toBe(join(wsRoot, "2026-06-21-new-cli-abc123"));
    expect(existsSync(taskDir)).toBe(true);
  });

  it("worktree adds a worktree of a source repo without moving its HEAD", () => {
    const repo = join(projects, "myapp");
    gitInit(repo);
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString();
    const { taskDir } = allocateWorkspace({ mode: "worktree", source: repo, slug: "feat-x" }, deps);
    expect(existsSync(join(taskDir, ".git"))).toBe(true);
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString();
    expect(headAfter).toBe(headBefore); // main checkout untouched
  });

  it("validateSource refuses a non-git dir", () => {
    const plain = join(projects, "plain");
    mkdirSync(plain, { recursive: true });
    expect(() => validateSource(plain, deps)).toThrow(/git repo/i);
  });

  it("validateSource refuses a path outside read roots", () => {
    expect(() => validateSource("/etc", deps)).toThrow(/read root/i);
  });

  it("validateSource refuses the workspace root itself", () => {
    mkdirSync(wsRoot, { recursive: true });
    expect(() => validateSource(wsRoot, { ...deps, readRoots: [home] })).toThrow(/workspace|AIOS/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/code-workspace.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/code/workspace.ts
import { mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { isUnder, isSecretPath, resolveReal } from "./paths.js";

export type WorkspaceMode = "greenfield" | "worktree" | "analyze";

export interface AllocateDeps {
  workspaceRoot: string;
  readRoots: string[];
  now: string;            // YYYY-MM-DD, injected for determinism
  id: string;             // short unique id, injected
  git?: (args: string[], cwd: string) => void;
}

/** A source repo to worktree/analyze must be a real git repo inside a read root,
 *  and must NOT be a secret path, AIOS, or the workspace root. Fail-closed. */
export function validateSource(source: string, deps: Pick<AllocateDeps, "readRoots" | "workspaceRoot">): void {
  const real = resolveReal(source);
  if (!existsSync(join(real, ".git"))) throw new Error(`Not a git repo: ${source}`);
  if (isSecretPath(real)) throw new Error(`Refused: source path is on the secret denylist`);
  if (isUnder(real, deps.workspaceRoot)) throw new Error(`Refused: source is inside the workspace root`);
  if (!deps.readRoots.some((root) => isUnder(real, root))) {
    throw new Error(`Refused: source is outside the allowed read roots [${deps.readRoots.join(", ")}]`);
  }
}

export function allocateWorkspace(
  opts: { mode: WorkspaceMode; source?: string; slug: string },
  deps: AllocateDeps,
): { taskDir: string } {
  if (opts.mode === "analyze") {
    if (!opts.source) throw new Error("analyze mode needs a source repo");
    validateSource(opts.source, deps);
    return { taskDir: resolveReal(opts.source) }; // read-only; guard blocks writes
  }

  const taskDir = join(deps.workspaceRoot, `${deps.now}-${opts.slug}-${deps.id}`);
  mkdirSync(deps.workspaceRoot, { recursive: true });

  if (opts.mode === "greenfield") {
    mkdirSync(taskDir, { recursive: true });
    return { taskDir };
  }

  // worktree
  if (!opts.source) throw new Error("worktree mode needs a source repo");
  validateSource(opts.source, deps);
  const git = deps.git ?? ((args, cwd) => { execFileSync("git", args, { cwd }); });
  git(["worktree", "add", "-b", `aios/${opts.slug}-${deps.id}`, taskDir, "HEAD"], resolveReal(opts.source));
  return { taskDir };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/code-workspace.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/code/workspace.ts test/code-workspace.test.ts
git commit -m "feat(code-pack): workspace allocator (greenfield/worktree/analyze) + source validation"
```

---

### Task 4: Confinement guards

**Files:**
- Create: `src/code/guard.ts`
- Test: `test/code-guard.test.ts`

**Interfaces:**
- Consumes: `isUnder`, `isSecretPath` (Task 2); `ToolCheck` from `../agents/guards/halalo-readonly.js`.
- Produces:
  - `codeGuard(taskDir: string, mode: "build" | "analyze"): Record<string, ToolCheck>`
  - `advisoryGuard(): Record<string, ToolCheck>` — denies ALL filesystem/exec tools (used when a sandbox pack resolves without a workspace, e.g. direct chat).
- Both are consumed by the existing `guardOptions(checks, "deny")` (Task 8 wires them in).

Guard contract: `Edit`/`Write`/`NotebookEdit` → allow iff `file_path` under jail (build) / always deny (analyze). `Read`/`Grep`/`Glob` → allow iff path under jail AND not a secret. `Bash` → always deny (exec only via `mcp__code__sh`). Tools not listed fall through to the `"deny"` fallback in `guardOptions`, except `mcp__*` which `guardOptions` already passes (the exec tool self-sandboxes).

- [ ] **Step 1: Write the failing test**

```ts
// test/code-guard.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codeGuard, advisoryGuard } from "../src/code/guard.js";

const home = mkdtempSync(join(tmpdir(), "guard-"));
const jail = join(home, "jail");
mkdirSync(jail, { recursive: true });

describe("codeGuard build mode", () => {
  const g = codeGuard(jail, "build");
  it("allows Write inside the jail", () => {
    expect(g.Write({ file_path: join(jail, "src/x.ts") }).ok).toBe(true);
  });
  it("denies Write outside the jail", () => {
    expect(g.Write({ file_path: join(home, "outside.ts") }).ok).toBe(false);
  });
  it("denies Read of a secret even inside-looking paths", () => {
    expect(g.Read({ file_path: "/Users/me/projects/AIOS/.env" }).ok).toBe(false);
  });
  it("allows Read inside the jail", () => {
    expect(g.Read({ file_path: join(jail, "README.md") }).ok).toBe(true);
  });
  it("denies Read outside the jail", () => {
    expect(g.Read({ file_path: join(home, "secrets.txt") }).ok).toBe(false);
  });
  it("denies raw Bash", () => {
    expect(g.Bash({ command: "ls" }).ok).toBe(false);
  });
});

describe("codeGuard analyze mode", () => {
  const g = codeGuard(jail, "analyze");
  it("denies all writes", () => {
    expect(g.Write({ file_path: join(jail, "x.ts") }).ok).toBe(false);
  });
  it("allows reads inside the analyzed dir", () => {
    expect(g.Read({ file_path: join(jail, "main.ts") }).ok).toBe(true);
  });
});

describe("advisoryGuard", () => {
  const g = advisoryGuard();
  it("denies every filesystem tool", () => {
    for (const t of ["Read", "Write", "Edit", "Grep", "Glob", "Bash"]) {
      expect(g[t]({ file_path: "/anything", command: "x" }).ok).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/code-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/code/guard.ts
import type { ToolCheck, GuardVerdict } from "../agents/guards/halalo-readonly.js";
import { isUnder, isSecretPath } from "./paths.js";

const deny = (reason: string): GuardVerdict => ({ ok: false, reason });
const ok: GuardVerdict = { ok: true };

function pathArg(input: Record<string, unknown>): string | undefined {
  return (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
}

/** Deterministic confinement for a jailed code job. */
export function codeGuard(taskDir: string, mode: "build" | "analyze"): Record<string, ToolCheck> {
  const readCheck: ToolCheck = (input) => {
    const p = pathArg(input);
    if (!p) return deny("missing path");
    if (isSecretPath(p)) return deny("read denied: secret path");
    return isUnder(p, taskDir) ? ok : deny(`read denied: outside workspace ${taskDir}`);
  };
  const writeCheck: ToolCheck = (input) => {
    if (mode === "analyze") return deny("analyze mode is read-only");
    const p = pathArg(input);
    if (!p) return deny("missing path");
    return isUnder(p, taskDir) ? ok : deny(`write denied: outside workspace ${taskDir}`);
  };
  const denyExec: ToolCheck = () => deny("raw Bash is disabled; use mcp__code__sh");
  return {
    Read: readCheck, Grep: readCheck, Glob: readCheck,
    Write: writeCheck, Edit: writeCheck, NotebookEdit: writeCheck,
    Bash: denyExec,
  };
}

/** Sandbox pack resolved without a workspace (e.g. direct chat): advisory only. */
export function advisoryGuard(): Record<string, ToolCheck> {
  const no: ToolCheck = () => deny("advisory context: filesystem/exec disabled — use recall/vault_read");
  return { Read: no, Grep: no, Glob: no, Write: no, Edit: no, NotebookEdit: no, Bash: no };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/code-guard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/code/guard.ts test/code-guard.test.ts
git commit -m "feat(code-pack): deterministic write-jail + read-scope confinement guards"
```

---

### Task 5: Sandboxed exec MCP server

**Files:**
- Create: `src/code/exec.ts`
- Test: `test/code-exec.test.ts`

**Interfaces:**
- Consumes: `tool`, `createSdkMcpServer` from `@anthropic-ai/claude-agent-sdk` (see `src/packs/server.ts` for the pattern).
- Produces:
  - `sandboxProfile(taskDir: string, mode: "build" | "analyze"): string` — pure SBPL string.
  - `buildCodeServer(ctx: { taskDir: string; mode: "build" | "analyze"; timeoutMs?: number }): ReturnType<typeof createSdkMcpServer>` — exposes one tool `sh({ cmd: string })`.

The MCP server name is `code` so the tool is addressed as `mcp__code__sh`. The tool runs `sandbox-exec -p <profile> /bin/bash -lc <cmd>` with `cwd = taskDir`.

- [ ] **Step 1: Write the failing test**

```ts
// test/code-exec.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sandboxProfile } from "../src/code/exec.js";

const hasSandbox = (() => {
  try { execFileSync("which", ["sandbox-exec"]); return true; } catch { return false; }
})();

describe("sandboxProfile (pure)", () => {
  it("allows writes under the task dir and denies the rest", () => {
    const p = sandboxProfile("/ws/task", "build");
    expect(p).toContain("(allow file-write* (subpath \"/ws/task\")");
    expect(p).toContain("(deny default)");
  });
  it("analyze mode emits no file-write allow", () => {
    expect(sandboxProfile("/ws/task", "analyze")).not.toContain("file-write* (subpath \"/ws/task\")");
  });
});

// OS-level escape proof — only meaningful on darwin with sandbox-exec present.
describe.runIf(hasSandbox && process.platform === "darwin")("sandbox-exec enforcement", () => {
  const task = mkdtempSync(join(tmpdir(), "exec-task-"));
  const outside = mkdtempSync(join(tmpdir(), "exec-out-"));
  const run = (cmd: string) => {
    const prof = sandboxProfile(task, "build");
    return execFileSync("sandbox-exec", ["-p", prof, "/bin/bash", "-lc", cmd], { cwd: task });
  };

  it("permits an in-jail write", () => {
    run(`echo hi > ${join(task, "ok.txt")}`);
    expect(readFileSync(join(task, "ok.txt"), "utf8")).toContain("hi");
  });
  it("blocks an out-of-jail write", () => {
    expect(() => run(`echo hi > ${join(outside, "bad.txt")}`)).toThrow();
    expect(existsSync(join(outside, "bad.txt"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/code-exec.test.ts`
Expected: FAIL — module not found. (The `sandbox-exec` block auto-skips off-darwin via `describe.runIf`.)

- [ ] **Step 3: Implement**

```ts
// src/code/exec.ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { z } from "zod";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** macOS sandbox profile (SBPL). Deny-default; broad read minus the secret denylist;
 *  write only under the task dir (build) + tmp. Later rules override earlier for the
 *  same operation, so the secret denies must come AFTER the broad read allow. */
export function sandboxProfile(taskDir: string, mode: "build" | "analyze"): string {
  const writeAllow = mode === "build"
    ? `(allow file-write* (subpath "${taskDir}") (subpath "/private/tmp") (subpath "/private/var/folders"))`
    : "";
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow signal (target self))",
    "(allow network*)", // egress restriction is a Docker-tier follow-up
    "(allow file-read*)",
    // secrets win (last-match): never readable inside the sandbox
    '(deny file-read* (regex #"/\\.ssh/") (regex #"/\\.aws/") (regex #"/\\.gnupg/"))',
    '(deny file-read* (regex #"/projects/AIOS/") (regex #"\\.env($|\\.)") (regex #"(token|credential|secret)"))',
    writeAllow,
  ].filter(Boolean).join("\n");
}

export function buildCodeServer(ctx: { taskDir: string; mode: "build" | "analyze"; timeoutMs?: number }) {
  const shTool = tool(
    "sh",
    "Run a shell command inside the sandboxed workspace. Writes are confined to the workspace; the user's secrets and other repos are unreadable. Use this instead of raw shell access.",
    { cmd: z.string() },
    async (args) =>
      new Promise((resolve) => {
        const profile = sandboxProfile(ctx.taskDir, ctx.mode);
        execFile(
          "sandbox-exec",
          ["-p", profile, "/bin/bash", "-lc", args.cmd],
          { cwd: ctx.taskDir, timeout: ctx.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const out = `${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
            resolve(text(err ? `Command failed (${err.message}).\n${out}` : out || "(no output)"));
          },
        );
      }),
  );
  return createSdkMcpServer({ name: "code", version: "0.1.0", tools: [shTool] });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/code-exec.test.ts`
Expected: PASS (pure-profile tests always; the enforcement block runs on darwin, otherwise reported skipped).

> NOTE for the implementer: the SBPL profile is the spec's #1 risk (`§8`). If the darwin enforcement test cannot run a real `npm`/`git` build (toolchain read denials), widen the read-allow / add explicit toolchain subpaths — but NEVER weaken the secret denies or the write confinement. Re-run the escape assertions after any profile change.

- [ ] **Step 5: Commit**

```bash
git add src/code/exec.ts test/code-exec.test.ts
git commit -m "feat(code-pack): sandbox-exec'd mcp__code__sh shell tool"
```

---

### Task 6: Pack manifest `sandbox` field

**Files:**
- Modify: `src/packs/types.ts`
- Test: `test/code-pack-schema.test.ts`

**Interfaces:**
- Produces: `Pack.sandbox: boolean` (default false).

- [ ] **Step 1: Write the failing test**

```ts
// test/code-pack-schema.test.ts
import { describe, it, expect } from "vitest";
import { packSchema } from "../src/packs/types.js";

describe("packSchema sandbox flag", () => {
  it("defaults sandbox to false", () => {
    const p = packSchema.parse({ pillar: "x", persona: "p", memoDomain: "x" });
    expect(p.sandbox).toBe(false);
  });
  it("accepts sandbox: true", () => {
    const p = packSchema.parse({ pillar: "code", persona: "p", memoDomain: "code", sandbox: true });
    expect(p.sandbox).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/code-pack-schema.test.ts`
Expected: FAIL — `sandbox` undefined.

- [ ] **Step 3: Implement**

In `src/packs/types.ts`, add to `packSchema` (before the `.transform`):
```ts
  /** When true, the pack requires a jailed workspace + confinement (the code pack). */
  sandbox: z.boolean().default(false),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/code-pack-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/packs/types.ts test/code-pack-schema.test.ts
git commit -m "feat(code-pack): packSchema sandbox flag"
```

---

### Task 7: Resolve — confinement + workspace + code exec server

**Files:**
- Modify: `src/packs/resolve.ts`
- Test: `test/code-pack-resolve.test.ts`

**Interfaces:**
- Consumes: `codeGuard`, `advisoryGuard` (Task 4); `buildCodeServer` (Task 5); `Pack.sandbox` (Task 6).
- Produces:
  - `ResolvedPack` gains `confinement?: { permissionMode: "default"; guard: Record<string, import("../agents/guards/halalo-readonly.js").ToolCheck>; fallback: "deny" }`.
  - `ResolveDeps` gains `workspace?: { taskDir: string; mode: "build" | "analyze" }`.
  - `resolvePack(pack, deps)`: when `pack.sandbox` and `deps.workspace` present → add `mcpServers.code = buildCodeServer(workspace)` and `confinement = { permissionMode:"default", guard: codeGuard(taskDir, mode), fallback:"deny" }`. When `pack.sandbox` and no workspace → `confinement = { ..., guard: advisoryGuard(), ... }`, no code server. When `!pack.sandbox` → no confinement (unchanged).
  - `makeResolvePackFor(reg, deps)` returns `(key, origin, byRole?, workspace?) => ResolvedPack | undefined` — threads `workspace` into `resolvePack`.

- [ ] **Step 1: Write the failing test**

```ts
// test/code-pack-resolve.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { resolvePack } from "../src/packs/resolve.js";
import { packSchema } from "../src/packs/types.js";

function deps(extra: object = {}) {
  const vaultRoot = mkdtempSync(join(tmpdir(), "vault-"));
  const store = new Store(":memory:");
  const vault = new VaultWriter(vaultRoot, "AIOS");
  const gate = new ActionGate({ store, vault, registry: undefined as any, config: undefined as any } as any);
  return { store, vault, gate, origin: { channel: "x", chatId: "y" }, ...extra };
}

const codePack = packSchema.parse({
  pillar: "code", persona: "p", memoDomain: "code", sandbox: true,
  tools: ["Read", "Write", "mcp__code__sh", "recall"], actions: ["vault.write"], roles: ["developer"],
});

describe("resolvePack confinement", () => {
  it("with a workspace → jailed guard + code server", () => {
    const r = resolvePack(codePack, deps({ workspace: { taskDir: "/ws/t", mode: "build" } }) as any);
    expect(r.confinement?.permissionMode).toBe("default");
    expect(r.confinement?.guard.Write).toBeTypeOf("function");
    expect(Object.keys(r.mcpServers)).toContain("code");
  });

  it("without a workspace → advisory guard, no code server", () => {
    const r = resolvePack(codePack, deps() as any);
    expect(r.confinement?.guard.Write({ file_path: "/ws/t/x" }).ok).toBe(false);
    expect(Object.keys(r.mcpServers)).not.toContain("code");
  });

  it("a non-sandbox pack has no confinement (unchanged)", () => {
    const money = packSchema.parse({ pillar: "money", persona: "p", memoDomain: "money", roles: ["cfo"] });
    const r = resolvePack(money, deps() as any);
    expect(r.confinement).toBeUndefined();
  });
});
```

> NOTE: match the real `ActionGate`/`VaultWriter` constructor signatures in this repo when wiring `deps()` — copy them from an existing pack/gate test (e.g. `test/money-*` or a gate test). The assertions above only touch `confinement` and `mcpServers`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/code-pack-resolve.test.ts`
Expected: FAIL — `confinement` undefined.

- [ ] **Step 3: Implement**

In `src/packs/resolve.ts`:
- Add imports: `import { codeGuard, advisoryGuard } from "../code/guard.js";` and `import { buildCodeServer } from "../code/exec.js";` and `import type { ToolCheck } from "../agents/guards/halalo-readonly.js";`.
- Extend `ResolvedPack`:
```ts
  confinement?: { permissionMode: "default"; guard: Record<string, ToolCheck>; fallback: "deny" };
```
- Extend `ResolveDeps`:
```ts
  workspace?: { taskDir: string; mode: "build" | "analyze" };
```
- In `resolvePack`, after building `mcpServers` (and the existing `toolServer` block), before `return`:
```ts
  let confinement: ResolvedPack["confinement"];
  if (pack.sandbox) {
    if (deps.workspace) {
      mcpServers.code = buildCodeServer(deps.workspace);
      confinement = { permissionMode: "default", guard: codeGuard(deps.workspace.taskDir, deps.workspace.mode), fallback: "deny" };
    } else {
      confinement = { permissionMode: "default", guard: advisoryGuard(), fallback: "deny" };
    }
  }
  return { pillar: pack.pillar, contextBlock, tools, mcpServers, confinement };
```
- In `makeResolvePackFor`, widen the returned closure signature and thread `workspace`:
```ts
  return (key, origin, byRole = false, workspace?: { taskDir: string; mode: "build" | "analyze" }): ResolvedPack | undefined => {
    const pillar = byRole ? reg.roleOf.get(key) : reg.pillarOf.get(key);
    if (!pillar) return undefined;
    const pack = reg.packs.get(pillar);
    return pack
      ? resolvePack(pack, { store: deps.store, vault: deps.vault, gate: deps.gate, origin, toolServers: deps.toolServers, workspace })
      : undefined;
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/code-pack-resolve.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/packs/resolve.ts test/code-pack-resolve.test.ts
git commit -m "feat(code-pack): resolve confinement + workspace-bound code exec server"
```

---

### Task 8: Runner — per-role tool clamp + confinement application

**Files:**
- Modify: `src/agents/runner.ts`
- Test: `test/code-runner-clamp.test.ts`

**Interfaces:**
- Consumes: `ResolvedPack.confinement` (Task 7); `guardOptions` from `./guards/index.js`.
- Produces:
  - `clampTools(roleTools: string[] | undefined, packTools: string[]): string[]` — keeps every `mcp__*` pack tool; keeps built-ins only if in `roleTools`.
  - `packRunOptions(base, pack)` updated: `allowedTools = clampTools(base.allowedTools, pack.tools)`; when `pack.confinement` present, override `permissionMode: "default"`, drop `allowDangerouslySkipPermissions`, and merge `guardOptions(pack.confinement.guard, "deny")`.

- [ ] **Step 1: Write the failing test**

```ts
// test/code-runner-clamp.test.ts
import { describe, it, expect } from "vitest";
import { clampTools, packRunOptions } from "../src/agents/runner.js";

describe("clampTools", () => {
  it("clamps built-ins to the role's allowlist, passes all mcp__ through", () => {
    const role = ["Read", "Grep", "Glob"];
    const pack = ["Read", "Edit", "Write", "Grep", "Glob", "mcp__code__sh", "mcp__aios-pack__recall"];
    expect(clampTools(role, pack).sort()).toEqual(
      ["Grep", "Glob", "Read", "mcp__aios-pack__recall", "mcp__code__sh"].sort(),
    );
  });
  it("a write role keeps Edit/Write", () => {
    expect(clampTools(["Read", "Edit", "Write", "Bash"], ["Read", "Edit", "Write", "mcp__code__sh"]))
      .toEqual(expect.arrayContaining(["Edit", "Write", "mcp__code__sh"]));
  });
});

describe("packRunOptions confinement", () => {
  const base = { systemPrompt: "s", allowedTools: ["Read", "Edit", "Write", "Bash"], permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } as any;
  const pack = {
    pillar: "code", contextBlock: "ctx", tools: ["Read", "Edit", "Write", "mcp__code__sh"], mcpServers: {},
    confinement: { permissionMode: "default", guard: { Write: () => ({ ok: false }) }, fallback: "deny" },
  } as any;

  it("overrides permissionMode and drops the skip flag", () => {
    const o = packRunOptions(base, pack);
    expect(o.permissionMode).toBe("default");
    expect((o as any).allowDangerouslySkipPermissions).toBeUndefined();
  });
  it("installs the guard hooks (PreToolUse present)", () => {
    const o = packRunOptions(base, pack) as any;
    expect(o.hooks?.PreToolUse?.length).toBeGreaterThan(0);
    expect(typeof o.canUseTool).toBe("function");
  });
  it("clamps raw Bash out", () => {
    expect(packRunOptions(base, pack).allowedTools).not.toContain("Bash");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/code-runner-clamp.test.ts`
Expected: FAIL — `clampTools` not exported.

- [ ] **Step 3: Implement**

In `src/agents/runner.ts`:
- Add import: `import { guardOptions } from "./guards/index.js";` (verify it isn't already imported; the file already imports from `./guards/index.js` for nothing — add it).
- Add the helper and rewrite `packRunOptions`:
```ts
/** Built-in tools narrow to the role's own allowlist; pack-provided MCP tools pass through. */
export function clampTools(roleTools: string[] | undefined, packTools: string[]): string[] {
  const owned = new Set(roleTools ?? []);
  return packTools.filter((t) => t.startsWith("mcp__") || owned.has(t));
}

export function packRunOptions(base: Options, pack: ResolvedPack): Options {
  const merged: Options = {
    ...base,
    systemPrompt: `${base.systemPrompt}\n\n${pack.contextBlock}`,
    allowedTools: clampTools(base.allowedTools, pack.tools),
    mcpServers: { ...(base.mcpServers ?? {}), ...(pack.mcpServers as Options["mcpServers"]) },
  };
  if (pack.confinement) {
    merged.permissionMode = pack.confinement.permissionMode;
    delete (merged as { allowDangerouslySkipPermissions?: boolean }).allowDangerouslySkipPermissions;
    const g = guardOptions(pack.confinement.guard, pack.confinement.fallback);
    merged.canUseTool = g.canUseTool;
    merged.hooks = { ...(merged.hooks ?? {}), ...(g.hooks ?? {}) };
  }
  return merged;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/code-runner-clamp.test.ts`
Expected: PASS

- [ ] **Step 5: Money-pack regression test**

```ts
// add to test/code-runner-clamp.test.ts
import { roles } from "../src/agents/roles/index.js";

describe("money pack regression — cfo tools unchanged", () => {
  it("cfo ([] built-ins) keeps all mcp__ pack tools after clamp", () => {
    const cfoTools = roles.cfo.allowedTools; // []
    const moneyPackTools = ["mcp__money__spending_summary", "mcp__aios-pack__recall", "mcp__aios-pack__vault_read"];
    expect(clampTools(cfoTools, moneyPackTools).sort()).toEqual([...moneyPackTools].sort());
  });
});
```

Run: `npx vitest run test/code-runner-clamp.test.ts`
Expected: PASS — cfo's resolved tools are identical (all `mcp__`, none dropped).

- [ ] **Step 6: Commit**

```bash
git add src/agents/runner.ts test/code-runner-clamp.test.ts
git commit -m "feat(code-pack): per-role tool clamp + pack-injected confinement in packRunOptions"
```

---

### Task 9: New `devops` role

**Files:**
- Modify: `src/agents/roles/index.ts` (WIP-overlap file — edit normally in the worktree)
- Test: `test/code-devops-role.test.ts`

**Interfaces:**
- Produces: `roles.devops: RoleDef`.

- [ ] **Step 1: Write the failing test**

```ts
// test/code-devops-role.test.ts
import { describe, it, expect } from "vitest";
import { roles } from "../src/agents/roles/index.js";

describe("devops role", () => {
  it("exists with Edit/Write but no raw Bash, default permission mode", () => {
    const d = roles.devops;
    expect(d).toBeTruthy();
    expect(d.allowedTools).toEqual(expect.arrayContaining(["Read", "Edit", "Write"]));
    expect(d.allowedTools).not.toContain("Bash");
    expect(d.permissionMode).toBe("default");
  });
  it("its prompt refuses live deploys", () => {
    expect(roles.devops.systemPrompt.toLowerCase()).toMatch(/never|refuse/);
    expect(roles.devops.systemPrompt.toLowerCase()).toMatch(/deploy|terraform|kubectl/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/code-devops-role.test.ts`
Expected: FAIL — `roles.devops` undefined.

- [ ] **Step 3: Implement**

In `src/agents/roles/index.ts`, add to the `roles` record (after `code-reviewer`):
```ts
  devops: {
    name: "devops",
    description: "DevOps/platform engineer: CI/CD, IaC, observability, deployment strategy.",
    systemPrompt:
      "You are the DevOps/platform engineer in a multi-agent system, working inside a SANDBOXED " +
      "workspace. You author and improve CI/CD pipelines, Infrastructure-as-Code (Terraform/Pulumi/" +
      "CloudFormation), container/orchestration manifests, and observability configs (metrics, logs, " +
      "traces, alerts) — writing them as files INTO the workspace. You design deploy and rollback " +
      "runbooks as markdown.\n\n" +
      "## Hard rules\n" +
      "- You NEVER execute a real deployment against live infrastructure: no `terraform apply`, no " +
      "`kubectl apply`, no cloud-mutating CLI, no `git push`. If asked, refuse and explain that " +
      "applying changes is a separate, human-approved step — deliver the configs + runbook instead.\n" +
      "- CREDENTIALS HYGIENE: never write real secrets, tokens, or keys into configs or replies. Use " +
      "placeholders like `${TF_VAR_db_password}` or `<from-secret-manager>`.\n" +
      "- All file writes go to the workspace; you cannot touch the user's real repositories.\n\n" +
      "Finish with a markdown summary: what you produced, where (workspace paths), and the exact " +
      "human steps to apply it.",
    allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "WebSearch", "WebFetch", "TodoWrite"],
    permissionMode: "default",
    maxTurns: 40,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/code-devops-role.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/roles/index.ts test/code-devops-role.test.ts
git commit -m "feat(code-pack): devops role (configs in jail, never deploys live)"
```

---

### Task 10: Pack manifest + playbooks

**Files:**
- Create: `playbooks/code/pack.yaml`, `playbooks/code/code-build.yaml`, `playbooks/code/code-analyze.yaml`
- Test: `test/code-pack-loader.test.ts`

**Interfaces:**
- Consumes: `loadPacks` from `src/packs/loader.js`; the roles from Task 9.
- Produces: a loadable `code` pack owning `code-build` + `code-analyze`, with `roleOf` mapping its roles to `code`.

- [ ] **Step 1: Write the failing test**

```ts
// test/code-pack-loader.test.ts
import { describe, it, expect } from "vitest";
import { loadPacks } from "../src/packs/loader.js";
import { join } from "node:path";

describe("code pack loads", () => {
  const reg = loadPacks(join(process.cwd(), "playbooks"));
  it("registers the code pillar with sandbox + vault.write ceiling", () => {
    const pack = reg.packs.get("code");
    expect(pack?.sandbox).toBe(true);
    expect(pack?.actions).toEqual(["vault.write"]);
    expect(pack?.tools).toContain("mcp__code__sh");
    expect(pack?.tools).not.toContain("Bash");
  });
  it("owns code-build and code-analyze", () => {
    expect(reg.playbooks.has("code-build")).toBe(true);
    expect(reg.playbooks.has("code-analyze")).toBe(true);
    expect(reg.pillarOf.get("code-build")).toBe("code");
  });
  it("maps devops uniquely to code (roleOf)", () => {
    expect(reg.roleOf.get("devops")).toBe("code");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/code-pack-loader.test.ts`
Expected: FAIL — `reg.packs.get("code")` undefined.

- [ ] **Step 3: Implement**

`playbooks/code/pack.yaml`:
```yaml
pillar: code
sandbox: true
persona: |
  You are the user's senior software engineer working inside a SANDBOXED workshop. Every file
  write is confined to your task workspace; you can read only the project you were given, never
  the user's secrets or the AIOS source. You never push, deploy, or modify the user's real
  repositories — your deliverables are the code in the workspace plus markdown artifacts.
  Validate inputs, write tests, prefer the simplest correct solution.
memoDomain: code
vaultSection: code
roles: [researcher, architect, reviewer, developer, tester, code-reviewer, devops]
actions: [vault.write]
tools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - WebSearch
  - WebFetch
  - TodoWrite
  - mcp__code__sh
  - recall
  - vault_read
  - vault_write
playbooks: [code-build, code-analyze]
```

`playbooks/code/code-build.yaml`:
```yaml
name: code-build
description: >-
  Build or extend software inside a sandboxed workspace: research, design (review loop),
  implement, test-and-fix, code review. Code persists in the workspace; never pushed.
needsProjectDir: false
stages:
  - type: single
    id: research
    role: researcher
    brief: >-
      Research what is needed to build this task well in the workspace: libraries, patterns,
      pitfalls. If a source repo is present in the working directory, study it first.
  - type: loop
    id: design
    producer: architect
    critic: reviewer
    maxRounds: 3
    brief: Design the solution using the research brief.
  - type: single
    id: implement
    role: developer
    brief: >-
      Implement the approved design in the working directory using mcp__code__sh for any shell
      step. End your summary with the absolute workspace path and the output of `git status`/diff.
  - type: verify
    id: test
    runner: tester
    fixer: developer
    maxRounds: 2
    brief: Build and run the tests in the workspace via mcp__code__sh.
  - type: single
    id: code-review
    role: code-reviewer
    brief: Review the implementation in the workspace (use mcp__code__sh `git diff`).
```

`playbooks/code/code-analyze.yaml`:
```yaml
name: code-analyze
description: >-
  Read-only audit of an existing repository: assess architecture, quality, risks. Writes a
  vault report only — never modifies the analyzed repo. Requires project_dir.
needsProjectDir: true
stages:
  - type: single
    id: research
    role: researcher
    brief: Read and map the repository in the working directory. Summarize structure and stack.
  - type: loop
    id: assessment
    producer: architect
    critic: reviewer
    maxRounds: 2
    brief: >-
      Produce an architecture + quality assessment of the repository: strengths, risks,
      tech-debt, concrete recommendations. The reviewer checks accuracy and completeness.
  - type: single
    id: code-review
    role: code-reviewer
    brief: Deep-review the most important modules (read-only) and list issues with file:line.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/code-pack-loader.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add playbooks/code/pack.yaml playbooks/code/code-build.yaml playbooks/code/code-analyze.yaml test/code-pack-loader.test.ts
git commit -m "feat(code-pack): manifest + code-build/code-analyze playbooks"
```

---

### Task 11: Store.setProjectDir + JobManager sandbox hook

**Files:**
- Modify: `src/store/db.ts` (add `setProjectDir`)
- Modify: `src/engine/jobs.ts` (prepareSandbox hook + project_dir rewrite + threaded resolvePackFor)
- Test: `test/code-jobs-sandbox.test.ts`

**Interfaces:**
- Consumes: `WorkspaceMode` concept (Task 3).
- Produces:
  - `Store.setProjectDir(id: string, dir: string): void` (mirrors `setJobDir`).
  - `JobManagerDeps.prepareSandbox?: (job: JobRow, playbook: Playbook) => Promise<{ taskDir: string; mode: "build" | "analyze" } | undefined>`.
  - `JobManagerDeps.resolvePackFor?` signature widens to `(playbook, origin, sandbox?: { taskDir: string; mode: "build" | "analyze" }) => ResolvedPack | undefined`.
  - `runJob` calls `prepareSandbox`; on a result it `setProjectDir` + mutates `job.project_dir`, then passes the sandbox to `resolvePackFor`.

- [ ] **Step 1: Write the failing test**

```ts
// test/code-jobs-sandbox.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

describe("Store.setProjectDir", () => {
  it("updates project_dir on a job row", () => {
    const store = new Store(":memory:");
    store.insertJob({
      id: "j1", slug: "s", title: "t", playbook: "code-build", request: "r",
      project_dir: null, channel: "c", chat_id: "ch", status: "queued", error: null,
    } as any);
    store.setProjectDir("j1", "/ws/task");
    expect(store.getJob("j1")!.project_dir).toBe("/ws/task");
  });
});
```

> NOTE: a fuller `runJob`-calls-`prepareSandbox` test is covered by the integration test (Task 13); this task pins the new store method + that the build still type-checks with the widened deps.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/code-jobs-sandbox.test.ts`
Expected: FAIL — `setProjectDir` not a function.

- [ ] **Step 3: Implement**

In `src/store/db.ts`, next to `setJobDir`:
```ts
  setProjectDir(id: string, dir: string): void {
    this.db.prepare("UPDATE jobs SET project_dir = ?, updated_at = ? WHERE id = ?")
      .run(dir, new Date().toISOString(), id);
  }
```
> (Match `setJobDir`'s exact timestamp/column style in this file — copy its body and swap the column.)

In `src/engine/jobs.ts`:
- Widen `JobManagerDeps`:
```ts
  prepareSandbox?: (job: JobRow, playbook: Playbook) => Promise<{ taskDir: string; mode: "build" | "analyze" } | undefined>;
  resolvePackFor?: (
    playbookName: string,
    origin: { channel: string; chatId: string },
    sandbox?: { taskDir: string; mode: "build" | "analyze" },
  ) => import("../packs/resolve.js").ResolvedPack | undefined;
```
- In `runJob`, replace the `const pack = this.deps.resolvePackFor?.(...)` line with:
```ts
    let sandbox: { taskDir: string; mode: "build" | "analyze" } | undefined;
    try {
      sandbox = await this.deps.prepareSandbox?.(job, pb);
    } catch (err) {
      store.updateJobStatus(job.id, "failed", `workspace setup failed: ${(err as Error).message}`);
      this.deps.onEvent?.({ type: "job.status", jobId: job.id, status: "failed", error: (err as Error).message });
      await this.deps.onComplete({ job, ok: false, error: (err as Error).message, jobDirName, artifactFiles: [] });
      return;
    }
    if (sandbox) {
      store.setProjectDir(job.id, sandbox.taskDir);
      job.project_dir = sandbox.taskDir;
    }
    const pack = this.deps.resolvePackFor?.(job.playbook, { channel: job.channel, chatId: job.chat_id }, sandbox);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/code-jobs-sandbox.test.ts && npx tsc --noEmit`
Expected: PASS + clean type-check.

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts src/engine/jobs.ts test/code-jobs-sandbox.test.ts
git commit -m "feat(code-pack): JobManager allocates workspace + rewrites project_dir before resolve"
```

---

### Task 12: index.ts wiring + kill-switch

**Files:**
- Modify: `src/index.ts` (WIP-overlap file — edit normally in the worktree)
- Test: `test/code-killswitch.test.ts`

**Interfaces:**
- Consumes: `allocateWorkspace` (Task 3); the widened `makeResolvePackFor` (Task 7); `prepareSandbox` + widened `resolvePackFor` (Task 11); config (Task 1).
- Produces: a `prepareSandbox` callback wired into `JobManager`; the code pack removed from the registry when `config.codeDisabled`; `resolvePackFor` closures thread the sandbox arg.

- [ ] **Step 1: Write the failing test** (kill-switch is a pure helper so it's unit-testable)

```ts
// test/code-killswitch.test.ts
import { describe, it, expect } from "vitest";
import { dropCodePack } from "../src/index.js";

describe("kill-switch removes the code pack from the registry", () => {
  it("dropCodePack deletes pillar + its playbooks + roleOf entries", () => {
    const reg = {
      packs: new Map([["code", { pillar: "code", roles: ["devops"], playbooks: ["code-build"] } as any]]),
      pillarOf: new Map([["code-build", "code"]]),
      roleOf: new Map([["devops", "code"]]),
      playbooks: new Map([["code-build", {} as any]]),
    };
    dropCodePack(reg as any);
    expect(reg.packs.has("code")).toBe(false);
    expect(reg.playbooks.has("code-build")).toBe(false);
    expect(reg.pillarOf.has("code-build")).toBe(false);
    expect(reg.roleOf.has("devops")).toBe(false);
  });
});
```

> NOTE: `dropCodePack` must be `export`ed from `src/index.ts`. If `src/index.ts` runs the daemon on import (top-level side effects), guard the bootstrap behind an `import.meta`-main check OR move `dropCodePack` to a tiny exported helper at the top of the file so importing it in a test does not boot the daemon. Prefer exporting the pure helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/code-killswitch.test.ts`
Expected: FAIL — `dropCodePack` not exported.

- [ ] **Step 3: Implement**

In `src/index.ts`:
- Add imports:
```ts
import { allocateWorkspace } from "./code/workspace.js";
import { randomUUID } from "node:crypto";
import type { LoadedPacks } from "./packs/loader.js";
```
- Add the exported pure helper near the top:
```ts
/** Kill-switch: strip the code pack (and its playbooks/roles) from a loaded registry. */
export function dropCodePack(reg: LoadedPacks): void {
  const pack = reg.packs.get("code");
  if (!pack) return;
  for (const pb of pack.playbooks) { reg.playbooks.delete(pb); reg.pillarOf.delete(pb); }
  for (const role of pack.roles) { if (reg.roleOf.get(role) === "code") reg.roleOf.delete(role); }
  reg.packs.delete("code");
}
```
- After `loadPacks(...)` (and inside `reloadPacks`), apply the switch:
```ts
  if (config.codeDisabled) dropCodePack({ playbooks, packs, pillarOf, roleOf } as LoadedPacks);
```
  (Apply the same guard on the `fresh` registry inside `reloadPacks`.)
- Build the `prepareSandbox` callback (after `pillarOf` is in scope):
```ts
  const prepareSandbox = async (job: import("./store/db.js").JobRow, _pb: unknown) => {
    if (pillarOf.get(job.playbook) !== "code") return undefined;
    const mode: "build" | "analyze" = job.playbook === "code-analyze" ? "analyze" : "build";
    const wsMode = mode === "analyze" ? "analyze" : (job.project_dir ? "worktree" : "greenfield");
    const { taskDir } = allocateWorkspace(
      { mode: wsMode, source: job.project_dir ?? undefined, slug: job.slug },
      { workspaceRoot: config.workspaceRoot, readRoots: config.codeReadRoots, now: localDate(), id: randomUUID().slice(0, 8) },
    );
    return { taskDir, mode };
  };
```
  (`localDate()` = the existing local-date helper used by dream/speculate, e.g. `localParts(new Date()).date`; reuse whatever the codebase already exposes — grep for `localParts`.)
- Pass `prepareSandbox` into the `JobManager({...})` deps, and update the two `resolvePackFor` closures to forward the sandbox arg:
```ts
    resolvePackFor: (playbook, origin, sandbox) => resolvePackFor(playbook, origin, false, sandbox),
```
  (the direct-chat one at line ~195 stays `(role, origin) => resolvePackFor(role, origin, true)` — direct chats get the advisory path, no workspace.)

- [ ] **Step 4: Run test + full build**

Run: `npx vitest run test/code-killswitch.test.ts && npx tsc --noEmit`
Expected: PASS + clean type-check.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/code-killswitch.test.ts
git commit -m "feat(code-pack): wire workspace prepare into JobManager + kill-switch"
```

---

### Task 13: End-to-end integration

**Files:**
- Test: `test/code-integration.test.ts`

**Interfaces:**
- Consumes: everything above. Drives a real `code-analyze` job through `JobManager` with a stub `run` (no live model) to prove the wiring: workspace allocated, `project_dir` rewritten, pack resolved with confinement, artifacts written, zero writes to the analyzed repo.

- [ ] **Step 1: Write the failing test**

```ts
// test/code-integration.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { JobManager } from "../src/engine/jobs.js";
import { loadPacks } from "../src/packs/loader.js";
import { allocateWorkspace } from "../src/code/workspace.js";
import { makeResolvePackFor } from "../src/packs/resolve.js";

describe("code-analyze end-to-end (stubbed model)", () => {
  it("allocates analyze workspace = source, writes a vault report, never writes the repo", async () => {
    const home = mkdtempSync(join(tmpdir(), "e2e-"));
    const projects = join(home, "projects");
    const repo = join(projects, "target");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "i"], { cwd: repo });
    writeFileSync(join(repo, "main.ts"), "export const x = 1;\n");
    const repoFilesBefore = readdirSync(repo).sort();

    const store = new Store(":memory:");
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "vault-")), "AIOS");
    const { playbooks, packs, pillarOf, roleOf } = loadPacks(join(process.cwd(), "playbooks"));

    // stub specialist: returns canned text, asserts cwd is the analyzed repo
    const run = vi.fn(async (_role: string, _brief: string, opts: any) => {
      expect(opts.cwd).toBe(repo); // analyze → taskDir = source
      expect(opts.pack?.confinement?.guard).toBeTruthy();
      return { text: "assessment ok", costUsd: 0, numTurns: 1 };
    });

    const gate = { propose: vi.fn() } as any;
    const resolvePackFor = makeResolvePackFor(
      { packs, pillarOf, roleOf },
      { store, vault, gate },
    );

    const jobs = new JobManager({
      store, vault, run, playbooks, wallTimeMs: 60_000, maxConcurrent: 1,
      onComplete: async () => {},
      pillarOf,
      prepareSandbox: async (job) => {
        if (pillarOf.get(job.playbook) !== "code") return undefined;
        const { taskDir } = allocateWorkspace(
          { mode: "analyze", source: job.project_dir ?? undefined, slug: job.slug },
          { workspaceRoot: join(home, "ws"), readRoots: [projects], now: "2026-06-21", id: "deadbeef" },
        );
        return { taskDir, mode: "analyze" };
      },
      resolvePackFor: (playbook, origin, sandbox) => resolvePackFor(playbook, origin, false, sandbox),
    });

    const job = jobs.createJob({
      playbook: "code-analyze", title: "audit target", request: "assess this repo",
      projectDir: repo, channel: "system", chatId: "test",
    });

    await vi.waitFor(() => expect(store.getJob(job.id)!.status).toBe("done"), { timeout: 10_000 });

    expect(store.getJob(job.id)!.project_dir).toBe(repo); // rewritten to the analyze taskDir (= source)
    expect(run).toHaveBeenCalled();
    expect(readdirSync(repo).sort()).toEqual(repoFilesBefore); // analyzed repo untouched
  });
});
```

> NOTE: align the `JobManager`/`makeResolvePackFor`/`VaultWriter` constructor args with their real signatures (copy from `src/index.ts`'s wiring). The behavioral assertions — status `done`, `project_dir` rewritten, repo files unchanged, confinement present in `opts.pack` — are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/code-integration.test.ts`
Expected: FAIL initially (wiring mismatch) → iterate imports/signatures until the assertions drive correctly.

- [ ] **Step 3: Make it pass**

No new product code should be required — if the test cannot reach `done`, fix the wiring assertion/signature mismatches in the test, not by weakening guards. If a real gap surfaces (e.g. `prepareSandbox` not awaited), fix it in the owning module.

- [ ] **Step 4: Run the full suite + type-check + build**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all green; `dist/src/...` emitted.

- [ ] **Step 5: Commit**

```bash
git add test/code-integration.test.ts
git commit -m "test(code-pack): code-analyze end-to-end wiring (workspace, confinement, repo untouched)"
```

---

## Self-Review

**Spec coverage:**
- §2 scope (greenfield/worktree/analyze) → Tasks 3, 10, 13. Deferrals (git.push/deploy) → enforced by `actions:[vault.write]` (Task 10) + no executor exists.
- §4.1 config → Task 1. §4.2 allocator + validation → Task 3. §4.3 guards → Task 4. §4.4 sandbox exec → Task 5.
- §4.5 manifest → Task 10. §4.6 devops + reused roles → Tasks 9, 10. §4.7 clamp + confinement → Tasks 7, 8. §4.8 JobManager integration → Tasks 11, 12. §4.9 playbooks → Task 10.
- §5 safety table: write-jail/read-scope (Task 4), exec (Task 5), ceiling (Task 10 manifest + existing `proposeThroughCeiling`), input validation (Task 3), least-privilege clamp (Task 8), test-gate (existing executor `verify` semantics, exercised by code-build), kill-switch (Tasks 1, 12).
- §6 TDD: every task is test-first; guards/allocator/exec have escape-proof tests. §7 ship: kill-switch + money regression (Task 8). §8 risk: SBPL profile flagged in Task 5 with the tuning note.

**Placeholder scan:** no TBD/TODO; every code step shows real code. The two "match the real signature" notes (Tasks 7, 13) point at existing files to copy from, not unfinished work.

**Type consistency:** `WorkspaceMode`/`mode:"build"|"analyze"` consistent across Tasks 3/4/5/7/11/12; `clampTools(roleTools, packTools)` signature consistent Task 8; `ResolvedPack.confinement` shape identical in Tasks 7 and 8; `prepareSandbox` return `{taskDir, mode}` identical in Tasks 11, 12, 13; `resolvePackFor(..., sandbox?)` 4-arg form consistent Tasks 7, 11, 12, 13.

**One spec→plan note:** §4.8 mentioned `additionalDirectories` for a source repo; the plan drops it because worktree mode places repo files *inside* `taskDir` and analyze sets `taskDir = source`, so read-scope = `taskDir` everywhere and `executor.ts` needs no change. This is a simplification, not a gap.
