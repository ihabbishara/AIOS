# Coding-Routing Gap — Design

Date: 2026-06-26
Status: approved (brainstorm)

## Problem

There are two live coding paths and nothing routes between them:

- **`software-feature`** — a top-level **packless** playbook (`needsProjectDir: true`). Because it is
  packless, `JobManager.resolvePackFor` returns `undefined`, so `runner.ts` skips `packRunOptions`
  and each role runs with its **raw** `roleQueryOptions`. Its `developer` and `tester` stages use
  roles whose `RoleDef.permissionMode === "bypassPermissions"` with `Edit/Write/Bash`. Packless +
  bypass means `roleQueryOptions` sets `allowDangerouslySkipPermissions: true` → **unrestricted
  Bash/Write on the real filesystem**, cwd = the real `project_dir`. No jail, no `sandbox-exec`,
  no secret-deny, no env-scrub.

- **`code-build` / `code-analyze`** — the **code pack** (`sandbox: true`). The pack confinement
  overrides `permissionMode` → `default`, deletes `allowDangerouslySkipPermissions`, replaces raw
  `Bash` with the sandboxed `mcp__code__sh`, and installs the write-jail / read-scope guard.
  `code-build` worktrees an existing repo (real checkout untouched) or greenfields; `code-analyze`
  is read-only.

### Why this is a hole

`config.projectsRoot` defaults to `~/projects`, which **contains `~/projects/AIOS`, the daemon's own
source**. The only guard on `run_playbook` is "project_dir must be under projectsRoot". So:

```
run_playbook(software-feature, project_dir=~/projects/AIOS)
  → developer + tester run with bypassPermissions + Bash + Write on the daemon's own code, unsandboxed.
```

Trigger surface: a prompt-injected email/request → moderator → `run_playbook`. The code pack's entire
threat model (self-modify, OAuth-token exfil) is bypassed because `software-feature` is packless.
`code-build`'s worktree mode already covers the legitimate "work on my real repo" use, strictly more
safely (changes land on an `aios/<slug>` branch). `software-feature`'s only unique capability is
in-place real-repo mutation — which is the hazard itself.

## Decision (locked in brainstorm)

The user is comfortable with the bypassPermissions capability existing, but wants it **deliberate and
guarded**, never an accidental default. "Close the gap" =

> **One coding entry that deterministically routes by an explicit `mode`, with a safe default; the
> in-place bypass path is reachable only when named, and even then cannot target the daemon itself or
> secrets.**

No intent inference — the mode is an explicit signal, defaulting to the safe path.

## Design

### 1. Single coding entry — `code_task` moderator tool

One tool becomes the coding entry; the moderator passes `mode` from the user's explicit words.

```
code_task(mode, title, request, project_dir?)
  mode = "build"   → playbook code-build   (sandboxed: worktree if project_dir, else greenfield)   [DEFAULT]
  mode = "analyze" → playbook code-analyze (sandboxed, read-only audit; project_dir REQUIRED)
  mode = "inplace" → playbook code-inplace (packless, bypassPermissions on the REAL repo;
                                            project_dir REQUIRED + guarded)
```

- Deterministic `mode → playbook` map. No intent inference. Absent an explicit ask, the moderator
  uses `build` (safe). `inplace` must be named by the user.
- `mode` defaults to `build` if omitted.
- `code_task` sets `inplace: true` on `createJob` **only** when `mode === "inplace"`.
- The tool description instructs: default build (sandboxed); analyze for read-only audits; inplace
  ONLY when the user explicitly asks to modify their real checkout in place — and warns it is not
  sandboxed.

`run_playbook` stays for non-code playbooks (echo, research-report, market-research, product-design)
and is changed to **refuse the three code playbooks** (`code-build`, `code-analyze`, `code-inplace`),
directing the caller to `code_task`. This removes the generic by-name entry to coding.

`playbooks/software-feature.yaml` is **renamed to `playbooks/code-inplace.yaml`**, with a persona/brief
that states plainly: "You are editing the user's REAL checkout in place. This is NOT sandboxed."
Pipeline is unchanged (research → design loop → implement → test-and-fix → code-review). It stays
packless (so it keeps real `Bash` + bypassPermissions — that is the inplace semantics).

### 2. Enforcement chokepoint — `JobManager.createJob`

The actual lock. Every coding path (`run_playbook`, `code_task`, web Packs "Run", overnight
`speculate`) funnels through `createJob`, so the invariant lives there, not at any single entry.

Structural classifier (cheap; uses the already-loaded registry + the `roles` map):

```
isUnsandboxedWrite(pb) =
     pillarOf.get(pb.name) === undefined                       // packless → no pack confinement
  && pb.stages reference a role whose roles[r].permissionMode === "bypassPermissions"
```

Stage→role extraction covers every stage shape: `single.role`, `loop.producer`/`loop.critic`,
`verify.runner`/`verify.fixer`. Today this matches exactly one playbook: `code-inplace` (developer +
tester). Future-proof: any new packless write playbook auto-qualifies.

`createJob` gains an optional `inplace?: boolean`. Rule, applied before the job row is inserted:

```
if isUnsandboxedWrite(pb):
    if !inplace          → throw "Refused: <pb> is an unsandboxed in-place coding path;
                                  run it via code_task mode:inplace."
    if !projectDir       → throw "inplace requires project_dir."
    assertInplaceTarget(projectDir, { selfRoot: resolveReal(process.cwd()),
                                      workspaceRoot, projectsRoot })   // §3
```

- Only `code_task(mode:inplace)` sets `inplace: true`. A raw `run_playbook("code-inplace", …)`, a web
  call, a `speculate` enqueue, or any future caller → **refused**.
- Pack playbooks (`code-build`, `code-analyze`) have a `pillarOf` entry → `isUnsandboxedWrite` is
  false → normal flow, unaffected.

The classifier needs the `roles` map and `pillarOf` inside `JobManager`. `pillarOf` is already a dep
(`JobManagerDeps.pillarOf`). `roles` is imported directly from `../agents/roles/index.js` (a static
module) — no new dep wiring. The check is a pure function `isUnsandboxedWrite(pb, pillarOf)` for
unit-testability.

### 3. In-place target guard — `assertInplaceTarget`

Even on the deliberate inplace path, bound the blast radius. Lives in `src/code/paths.ts` (reuses
`resolveReal`, `isSecretPath`, `isUnder`). Resolves symlinks first (realpath), then refuses if the
target is any of:

1. **The AIOS source root itself** — derived self-locating as `resolveReal(process.cwd())`. Refuse if
   `isUnder(target, selfRoot) || isUnder(selfRoot, target)` (bidirectional containment — target is the
   repo, inside it, or an ancestor of it). Stops the daemon being steered to edit/execute against its
   own running code. Disallowed regardless of explicit intent. (The codebase already assumes
   `process.cwd() === repo root`, e.g. `runner.ts:12` resolves the skills plugin from `process.cwd()`;
   boot asserts this — see §5.)
2. **A secret path** — `isSecretPath(target)` (`.ssh/.aws/.gnupg/.env/.config/AIOS`, token/credential/
   secret dirs — the same denylist the sandbox uses).
3. **Inside the workspace root** — `isUnder(target, workspaceRoot)` (`AIOS-Workspace` is the sandbox's
   territory; inplace there is nonsensical).
4. **Containment / existence** — must exist, be a directory, and be under `projectsRoot` (the existing
   `run_playbook` containment check is retained; now centralized here).

Fail-closed: any realpath error → refuse.

**Explicitly NOT done:** this does not sandbox inplace, restrict its Bash, or scrub its env. The user
accepted bypassPermissions, so an inplace run on e.g. `~/projects/halalo` gets full real Bash there.
The guard only removes the targets where the capability turns on *the daemon itself* or *the user's
secrets*. Capability preserved; self-harm path removed.

## Components & boundaries

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `code_task` tool (`src/moderator/tools.ts`) | Map `mode` → `{playbook, inplace}`; call `createJob`. UX only. | `JobManager` |
| `run_playbook` tool (changed) | Refuse the 3 code playbooks; unchanged otherwise. | code-playbook-name set |
| `isUnsandboxedWrite(pb, pillarOf)` (pure, exported from `src/engine/jobs.ts`) | Classify packless+bypass-write playbooks. | `roles` map, `pillarOf` |
| `createJob` (changed) | Enforce: refuse unsandboxed-write unless `inplace` + guard passes. | classifier, `assertInplaceTarget` |
| `assertInplaceTarget` (`src/code/paths.ts`) | Refuse AIOS-self / secret / workspace / out-of-root targets. | `resolveReal`, `isSecretPath`, `isUnder` |
| `playbooks/code-inplace.yaml` (renamed) | Unsandboxed in-place pipeline (unchanged stages, new persona). | — |

## Error handling

- `createJob` refusals throw with a clear message (surfaced to the moderator/tool caller, mirroring
  the existing `Unknown playbook` / `needs a project directory` throws).
- `assertInplaceTarget` throws `Refused: …` strings; realpath failure is caught → refuse.
- `code_task` with an unknown `mode` → reject with the allowed set (zod enum on the tool arg).

## Testing (TDD)

- `isUnsandboxedWrite`: true for `code-inplace`; false for `code-build`/`code-analyze` (pack present),
  `echo` (no write role), `research-report` (pack present). Stage-shape coverage: single/loop/verify
  role extraction.
- `createJob`: refuses `code-inplace` without `inplace:true`; refuses with `inplace:true` but no
  `project_dir`; refuses when `assertInplaceTarget` throws; succeeds with `inplace:true` + valid dir.
- `assertInplaceTarget`: refuses cwd-derived self root (target == self, target under self, self under
  target); refuses a secret path; refuses under workspace root; refuses non-existent / file; refuses
  outside projectsRoot; allows a normal repo dir under projectsRoot.
- `code_task`: mode→playbook+inplace mapping for all three modes + default; passes through to
  `createJob`.
- `run_playbook`: refuses each of the 3 code playbooks; still runs `echo` / `research-report`.
- Regression: `code-build` / `code-analyze` jobs unaffected (sandbox path intact).

## Out of scope (deferred, own cycles)

Sandboxing the inplace path; sandbox network-egress restriction (Docker-tier); workspace reaper;
token/cost-budget enforcement. All already deferred elsewhere in the roadmap.

## §5 Notes / invariants to assert

- Boot asserts `resolveReal(process.cwd())` is a real directory (the daemon already depends on this
  via the skills plugin path). If `process.cwd()` is ever not the repo root, the self-guard widens
  harmlessly (refuses more) rather than narrowing — fail-safe direction.
- No `node:sqlite` migration this cycle (no schema change).
- The rename `software-feature.yaml` → `code-inplace.yaml` updates: `docs/ARCHITECTURE.md`,
  `src/moderator/tools.ts` (description example), `test/playbook.test.ts`,
  `test/packs-run-endpoint.test.ts`.
