# Code Pillar Pack — Design Spec

**Date:** 2026-06-21
**Status:** Approved (brainstorm complete) — ready for implementation plan
**Cycle:** 4th pillar pack on the Phase-7 framework (after money). PACK-ONLY, one MVP spec.
**Related:** [[phase7-pillar-packs-design]], [[money-pillar-pack-design]], [[sdk-permission-semantics]]

## 1. Motivation

The code pillar is load-bearing: it is the user's own software-development workflow. This
cycle binds the `code` pillar to a **sandboxed software-engineering workshop** — agents that
research, design, build, test, review, and do DevOps work on real code, with the entire write
surface jailed to a dedicated workspace and reads of existing repos scoped away from secrets.

Safety and validation are the #1 priority. Every containment boundary is **deterministic**
(path guards, an OS sandbox, the action-type ceiling) — never persona-dependent. The Action
Gate stays the sole outward door; this cycle's ceiling is `[vault.write]` only.

## 2. Scope, decomposition, deferrals

**In scope (one MVP spec, sequenced MVP-first in the plan):**

- A persistent **workspace sandbox** under `$AIOS_WORKSPACE_ROOT` (default
  `/Users/ihabbishara/projects/AIOS-Workspace`). Three task modes:
  - **greenfield** — a fresh empty task dir the developer scaffolds from scratch.
  - **worktree** — `git worktree add` of a named existing repo INTO a task dir (the user's
    main checkout is never touched, nothing is pushed).
  - **analyze** — read-only inspection of a named existing repo (no allocation, no writes).
- Deterministic **confinement guards**: write-jail, read-scope, and OS-sandboxed exec.
- `playbooks/code/pack.yaml` manifest binding the pillar.
- A new **`devops`** role (CI/CD, IaC, observability — authors configs into the jail, never
  deploys to live infra this cycle).
- Reuse of `researcher / architect / reviewer / tester / developer / code-reviewer`, clamped +
  confined under the pack.
- Two code playbooks: `code-build`, `code-analyze`.
- Two small, safety-positive **framework refinements** to the pack runner/resolve (per-role
  tool clamp; optional pack-injected confinement).
- Trigger surface: **anywhere** (any channel). Safety rests entirely on the deterministic
  guards, not on origin.

**Deferred (each its own later, security-reviewed cycle):**

- Landing code into the user's real repos: `git.push`, PR creation, `code.apply_patch`, live
  deploy / `terraform apply` / `kubectl`. No such executor exists this cycle → unreachable by
  construction.
- Real token / cost-budget enforcement (this cycle reuses the existing job wall-time +
  per-role `maxTurns` caps).
- Workspace reaper / disk-quota / parallel-task isolation (workspaces persist; the user
  collects + prunes manually).
- Multi-repo / multi-source builds.

## 3. Architecture

```
@code  /  code playbook  (any channel)
        │
   JobManager.runJob
        │   playbook is code-pack-owned (pillarOf) AND pack declares confinement
        ▼
   allocateWorkspace({ mode, source, slug })            src/code/workspace.ts
        │   greenfield → mkdir   $WS_ROOT/<date>-<slug>-<id>/
        │   worktree   → git -C <source> worktree add <taskDir> -b aios/<slug> <baseRef>
        │   analyze    → no alloc; taskDir = <source> (read-only)
        │   validate source: realpath ∈ read-roots, is a git repo, ∉ {AIOS, $WS_ROOT}, no symlink escape
        ▼
   job.project_dir = taskDir                              (executor cwd, runner jail anchor)
        ▼
   resolvePack(code, { taskDir, source, mode, origin })  src/packs/resolve.ts (+confinement)
        │   contextBlock  = persona + code memo
        │   mcpServers     = aios-pack (shared) + code (sandboxed-exec tool, bound to taskDir)
        │   confinement    = { permissionMode:"default", guard: codeGuard(taskDir, source, mode) }
        │   tools (ceiling) = union; per-role clamp happens at packRunOptions
        ▼
   PlaybookExecutor.execute  →  stages run with project_dir=taskDir, additionalDirectories=[source]
        │   each role: roleQueryOptions → packRunOptions(clamp + confinement) → guards live
        ▼
   artifacts → vault/jobs/<jobdir>/*.md  (executor writeJobArtifact, existing sink)
   code      → persists in the jail; implement-stage artifact embeds abs path + `git diff`
   ad-hoc @code notes/proposals → gate vault.write (ceiling-checked, audited)
```

New modules: `src/code/workspace.ts`, `src/code/guard.ts`, `src/code/exec.ts`.
New manifest + playbooks under `playbooks/code/`. New `devops` RoleDef.

## 4. Components

### 4.1 Config (`src/config.ts`)

- `workspaceRoot` ← `AIOS_WORKSPACE_ROOT`, default `/Users/ihabbishara/projects/AIOS-Workspace`.
- `codeReadRoots` ← `AIOS_CODE_READ_ROOTS` (comma-sep), default `[~/projects]`. A source repo
  to analyze/worktree must realpath-resolve under one of these.
- `codeDisabled` ← `AIOS_CODE_DISABLED=1` kill-switch (default off → pack ships enabled).
- Hard denylist (constant, not config): `~/projects/AIOS`, `$AIOS_WORKSPACE_ROOT`, `~/.ssh`,
  `~/.aws`, `~/.config`, `~/.gnupg`, any `*.env` / `*token*` / `*credential*` / `*secret*`
  path. Always wins over read-roots.
- Reuses existing job `wallTimeMs` + role `maxTurns`. The pack server's exec tool has its own
  per-command timeout.

### 4.2 Workspace allocator (`src/code/workspace.ts`)

`allocateWorkspace(opts: { mode: "greenfield"|"worktree"|"analyze"; source?: string; slug: string }) → { taskDir: string; source?: string }`

- **greenfield:** `taskDir = join(workspaceRoot, \`${today}-${slug}-${shortId}\`)`; `mkdir -p`.
  No source.
- **worktree:** validate `source` (below); allocate `taskDir`; `git -C <source> worktree add
  <taskDir> -b aios/<slug> HEAD`. Main checkout untouched, branch local-only, no push.
- **analyze:** validate `source`; `taskDir = source` (read-only — guard blocks every write).
- Persistence: never torn down (the user collects the code). Reaper deferred.
- Determinism for tests: `today` + `shortId` are injected (the codebase already avoids
  `Date.now()`/random in pure code; allocator takes a clock + id generator).

**Source validation (refusal guards, fail-closed):**
1. `realpath(source)` must exist and be a directory containing `.git`.
2. realpath must be under a `codeReadRoots` entry.
3. realpath must NOT equal/contain `~/projects/AIOS` or `$AIOS_WORKSPACE_ROOT`.
4. realpath must not match the secret denylist.
5. Any failure → throw a clear refusal; the job fails before any stage runs.

### 4.3 Confinement guards (`src/code/guard.ts`)

`codeGuard(taskDir, source, mode) → Record<string, ToolCheck>` plus `toolCheckFallback:"deny"`,
consumed by the existing `guardOptions(...)` (PreToolUse hook + `canUseTool`) — the same
machinery `halalo` uses. PreToolUse hooks fire even under SDK permission modes (see
[[sdk-permission-semantics]]), so these are the always-on enforcement layer.

- **Write-jail** (`Edit`, `Write`, `NotebookEdit`): allow iff `realpath(dirname(file_path))`
  is under `taskDir`. `analyze` mode → deny all. Path arg is explicit → airtight.
- **Read-scope** (`Read`, `Grep`, `Glob`): allow iff the target path realpath-resolves under
  `taskDir` OR `source`; deny the secret denylist unconditionally. Closes the
  read-secret-then-write-to-workspace exfil path.
- **Raw `Bash`**: not in the pack tool ceiling and denied by fallback — the only exec path is
  the sandboxed tool (§4.4).
- All path checks realpath-resolve first (defeats `../` and symlink escapes), and treat
  unresolvable paths as denied.

### 4.4 Sandboxed exec tool (`src/code/exec.ts`, pack `toolServer: code`)

A pack-specific MCP tool server (registered in `ResolveDeps.toolServers.code`, mirroring
money's `toolServer`), bound at resolve time to `taskDir`/`source`/`mode`. Exposes one tool:

- `mcp__code__sh({ cmd, cwd? })`: runs `cmd` via macOS `sandbox-exec -p '<profile>' /bin/sh -lc
  <cmd>` with `cwd` defaulting to `taskDir` (must be under `taskDir`). The sandbox profile:
  - **write** allowed only under `taskDir` (+ a per-task tmp); denied elsewhere.
  - **read** allowed under `taskDir`, `source` (worktree/analyze), and the toolchain/system
    paths needed to run builds (`/usr`, `/bin`, `/opt/homebrew`, nvm, `/Library`, Xcode SDK);
    denied for the secret denylist + `~/projects/AIOS`.
  - process/exec allowed (so `node`/`npm`/`git`/`python`/compilers run); network left at the
    OS default for MVP (egress restriction is a Docker-tier concern, noted as a follow-up).
  - per-command timeout; stdout/stderr/exit captured and returned to the agent.

This handles the shell-escape case a regex cannot: even `cat ~/projects/AIOS/.env` inside `cmd`
is denied by the OS profile.

> **Decision (user skipped → recommended path taken):** `sandbox-exec` over Docker (no daemon
> dependency, built into macOS, MVP-sized) and over a regex-only guard (leaky against an
> injected shell). Crafting/validating the profile is the single riskiest implementation task
> and gets dedicated escape tests.

### 4.5 Pack manifest (`playbooks/code/pack.yaml`)

```yaml
pillar: code
persona: |
  You are the user's senior software engineer working inside a SANDBOXED workshop. All file
  writes are confined to your task workspace; you can read the one project you were given but
  never the user's secrets or the AIOS source. You never push, deploy, or modify the user's
  real repositories — your deliverables are the code in the workspace plus markdown artifacts.
  Be rigorous: validate inputs, write tests, prefer the simplest correct solution.
memoDomain: code
vaultSection: code
toolServer: code
roles: [researcher, architect, reviewer, developer, tester, code-reviewer, devops]
actions: [vault.write]
tools:                      # union ceiling — per-role clamp narrows this (§4.7)
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

### 4.6 Roles

**Reused** (defined already in `src/agents/roles/index.ts`; clamp + confinement applied by the
pack, not by editing the roles): `researcher`, `architect`, `reviewer`, `code-reviewer`
(read-only roles → clamp leaves them read-only), `developer`, `tester` (write roles → jailed +
sandboxed exec instead of raw Bash).

**New `devops` role:**
- Description: CI/CD, deployment strategy, IaC, observability.
- System prompt: senior platform/DevOps engineer. Authors/improves CI + pipeline + IaC +
  observability **configs into the workspace jail**; designs deploy/rollback runbooks as
  markdown. **Refuses** to execute real deploys / `terraform apply` / `kubectl` / cloud-mutating
  CLI against live infrastructure (outward effect → deferred cycle) and says so. Credential
  hygiene: never writes secrets/tokens into configs or replies; uses placeholders.
- `allowedTools`: `[Read, Grep, Glob, Edit, Write, WebSearch, WebFetch, TodoWrite]`. The
  sandboxed `mcp__code__sh` comes from the pack (it is `mcp__*`, passes the clamp); the role
  never carries raw `Bash`.
- `permissionMode`: `"default"` (the pack confinement overrides it to `"default"` + guard
  anyway). `@devops` always resolves the code pack (role ∈ exactly one pack), so it is never
  invoked unconfined.
- Addressable directly as `@devops` (role ∈ exactly one pack → inherits the code pack).

### 4.7 Framework refinements (`src/packs/resolve.ts`, `src/agents/runner.ts`)

Two changes, both narrowing-only and gated so the money pack is provably unaffected (regression
test pins cfo's resolved tools byte-for-byte).

**(a) Per-role tool clamp.** `packRunOptions(base, pack)` currently sets
`allowedTools: pack.tools` uniformly. New rule:

```
effective = pack.tools.filter(t =>
     t.startsWith("mcp__")                        // pack-provided MCP tools (shared aios-pack + named toolServer) pass through —
                                                  //   each carries its own gate (vault.write) or OS sandbox (mcp__code__sh)
  || (base.allowedTools ?? []).includes(t)        // BUILT-IN OS-touching tools clamped to the role's own allowlist
)
// raw Bash is never in pack.tools → no role gets an unsandboxed shell; the only exec path is mcp__code__sh.
```

The meaningful least-privilege boundary is on the dangerous **built-ins**: `reviewer` /
`architect` / `researcher` (allowlist = Read/Grep/Glob[/Web]) get **no Edit/Write** even though
the ceiling lists them; `developer` / `tester` keep Edit/Write. The pack-provided MCP tools
(`mcp__code__sh`, `recall`, `vault_read`, `vault_write`) pass through to every role — but each
is bounded by construction (the exec tool is OS-sandboxed, so a read-only role that calls it is
still contained to the jail / read-only profile; vault_write is ceiling-checked + gate-routed).
For the single-role money pack the result is **identical to today**: cfo's built-in allowlist is
`[]`, and all its tools are `mcp__money__*` / `mcp__aios-pack__*` which pass through unchanged
(pinned by a byte-for-byte regression test).

**(b) Optional pack-injected confinement.** `ResolvedPack` gains
`confinement?: { permissionMode: "default"; guard: Record<string,ToolCheck>; fallback:"deny" }`,
produced by `resolvePack` only when the manifest opts in (the code pack does, via its runtime
`taskDir`/`source`/`mode`). `packRunOptions`, when `pack.confinement` is present, **overrides**
the role's `permissionMode` (dropping any `bypassPermissions`/`allowDangerouslySkipPermissions`)
and merges `guardOptions(confinement.guard, "deny")` into the SDK options. Absent confinement →
no change (money + all packless paths behave exactly as before).

`resolvePack` deps therefore gain optional `{ taskDir, source, mode }`; `makeResolvePackFor`
threads them from the job. When absent (non-code packs) confinement + exec server are omitted.

### 4.8 Executor / JobManager integration

- `JobManager.runJob`: when the job's playbook is code-pack-owned and the pack declares
  confinement, call `allocateWorkspace` (mode derived from the playbook: `code-analyze`→analyze,
  `code-build`→worktree if a valid `source`/`project_dir` was supplied else greenfield), then
  set the effective `job.project_dir = taskDir` and resolve the pack with `{taskDir, source,
  mode}`. (`job.project_dir` is the executor cwd at executor.ts:136; `job_dir` column already
  exists from the date-coupling fix — reused for the vault job dir, distinct from `project_dir`.)
- Executor passes `additionalDirectories: [source]` (read access to the worktree's origin /
  analyzed repo) via `runOpts`; cwd stays `taskDir`.
- The `implement` stage's summary artifact embeds the absolute `taskDir` and a `git diff` (run
  via `mcp__code__sh`) so `vault/jobs/<jobdir>/implement.md` references where the code lives.
- The `verify` stage already surfaces a failing test report instead of throwing
  (executor.ts:259) → the test-gate is honored: a failing build completes with a visible
  failing report, never a silent "done".

### 4.9 Playbooks (`playbooks/code/`)

`code-build.yaml` (`needsProjectDir` optional — greenfield needs none, worktree supplies one):
research → design (loop: architect/reviewer, ≤3) → implement (developer) → verify (tester/
developer, ≤2) → code-review (code-reviewer). A devops stage is included when the task is
deploy/infra-shaped (MVP: a single optional `devops` single-stage after code-review, brief
instructs it to skip if not infra-relevant). Mirrors `software-feature` structure but
pack-owned (jailed) rather than packless.

`code-analyze.yaml` (`needsProjectDir: true`, read-only): research (read the repo) → review
loop (architect produces an assessment, reviewer critiques) → code-review. Output = a markdown
audit in the vault; no writes to the repo.

## 5. Safety / validation model (summary)

| Layer | Mechanism | Property |
|---|---|---|
| Write-jail | PreToolUse path guard on Edit/Write | airtight (explicit path arg) |
| Read-scope | PreToolUse path guard on Read/Grep/Glob + secret denylist | airtight; blocks exfil |
| Exec | `sandbox-exec` profile in `mcp__code__sh`; raw Bash denied | OS-level shell containment |
| Action ceiling | `proposeThroughCeiling` refuses ∉ `[vault.write]` before the gate | no outward code effect |
| Input validation | source repo realpath ∈ read-roots, is git, ∉ {AIOS, WS}, no symlink escape | fail-closed refusal |
| Least-privilege | per-role built-in tool clamp | reviewer/architect/researcher get no Edit/Write |
| Test-gate | `verify` stage surfaces failing report, never silent done | honest completion |
| Kill-switch | `AIOS_CODE_DISABLED=1`; pack absent = no-op | reversible |

Disjointness invariant: AIOS = `~/projects/AIOS`, jail = `~/projects/AIOS-Workspace` → AIOS
self-modification impossible.

## 6. Testing strategy (TDD)

Guard/allocator tests written first (the critical surface), each proving denial by *attempting*
the escape:

- **guard.test:** write outside jail denied; write inside allowed; analyze denies all writes;
  read of `~/projects/AIOS/.env` denied; read of source + jail allowed; `../` and symlink
  escapes denied; unresolvable path denied.
- **exec.test:** `sandbox-exec` profile blocks an out-of-jail write and a secret read while
  permitting an in-jail build command (gated behind a darwin/`sandbox-exec`-present check;
  skipped with a logged reason elsewhere, mirroring the real-voice opt-in pattern).
- **workspace.test:** greenfield mkdir; worktree add leaves main checkout + HEAD untouched;
  validation refusals (non-repo, AIOS, traversal, outside read-roots).
- **resolve/runner refinement tests:** clamp narrows-never-widens for each role; **money-pack
  regression** (cfo resolved tools unchanged); confinement injected only when declared;
  `bypassPermissions` dropped under confinement.
- **pack + playbook integration:** loader owns code playbooks; ceiling refuses a non-`vault.write`
  proposal; `code-analyze` produces a vault audit with zero repo writes; `code-build` greenfield
  end-to-end produces code in the jail + artifacts in the vault.

## 7. What ships

- Ships **enabled** (kill-switch off), zero behavior change until `@code`/`@devops`/a code
  playbook is invoked. Money + all packless playbooks unaffected (pinned by regression tests).
- Built subagent-driven in an isolated git worktree off clean main HEAD; the uncommitted
  pdf-attachments WIP in the main checkout is left untouched (explicit-path commits only).
- MVP-first plan sequence: config + workspace allocator + guards + exec (the safety core,
  fully tested) → framework refinements (clamp + confinement) → pack manifest + devops role →
  playbooks + JobManager integration → end-to-end.

## 8. Open implementation risks

- **`sandbox-exec` profile** is the delicate part: too tight breaks real builds (node/npm/git
  toolchain reads), too loose leaks. Mitigated by dedicated escape + build-smoke tests and a
  conservative read-allow / write-deny default. If the profile proves unworkable for a given
  toolchain, fall back to the Docker tier (deferred) — not the regex guard.
- `git worktree` writes objects into the source repo's `.git` (shared object store). No branch
  in the source is moved and the main checkout/working tree is untouched, so this is within
  "no outward code effect"; documented as an accepted, reversible side effect (`git worktree
  remove` + `git branch -D aios/<slug>`).
