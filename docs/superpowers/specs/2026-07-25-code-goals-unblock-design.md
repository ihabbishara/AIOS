# Code goals unblock — work on any project (and on AIOS itself)

**Date:** 2026-07-25
**Status:** Approved
**Cycle:** ⑪

## Problem

Goals that touch code cannot do their job. Two goals ("Fix two AIOS ui2 UI bugs", "Populate app Skills page") ran four stages each and parked at `verify` in `needs-review` — the BLOCKED cards on Home. An earlier goal ("Diagnose two AIOS UI bugs") reported **done** having read no code at all: its workspace held an empty `matches.txt`, an `err.log` full of `Operation not permitted`, and a symlink it created trying to reach `/projects/AIOS/README.md`. Only the verify agent was honest about the failure.

Four independent defects, found by reading the code and probing the live sandbox profile:

1. **The planner is told AIOS can never be a workspace, so it plans blind.** The department lead already chooses `needsWorkspace` (`worktree` | `analyze` | `greenfield` | `none`) and `projectDir` during planning (src/engine/plan.ts:195), and `allocateWorkspace` already turns that into `git worktree add -b aios/<slug>-<id>` for any git repo under `AIOS_CODE_READ_ROOTS` (default `~/projects`). For a NON-AIOS project this path works today. For AIOS, `workspaceError` (plan.ts:237) rejects the projectDir via `isSecretPath` and instructs the lead: *"use needsWorkspace \"none\" (agents Read/Grep repos directly)"* — so the lead dutifully replans with no workspace, and the agents get an empty directory AND cannot read the real repo (defect 4). That is exactly the observed failure. **No new `plan_goal` parameter is needed** — the gap is that AIOS is unrepresentable, not that the project is unnameable.

2. **`git` cannot run inside the sandbox.** The SBPL profile allows `file-write*` only under the task dir, so `/dev/null` is unwritable. Probed live: `git --version` → `fatal: could not open '/dev/null' for reading and writing: Operation not permitted`; `echo hi > /dev/null` → `Operation not permitted`. Every git command and every npm script redirecting to `/dev/null` fails in every sandboxed goal.

3. **The secret regex is unanchored.** `SECRET_PATH_PATTERNS` / `sbplSecretDenyLines` contain `(token|credential|secret)` with no anchoring, so ANY path containing those substrings is denied. Real casualties observed: `node_modules/postcss/lib/tokenize.js`, `node_modules/sucrase/dist/types/TokenProcessor.d.ts`, and `src/kernel/secrets.ts`. This breaks ordinary builds in any project.

4. **AIOS is denied three ways.** `/(^|\/)projects\/AIOS(\/|$)/` is in `SECRET_PATH_PATTERNS`, so `validateSource` refuses AIOS as a worktree source; `sandboxProfile` denies reading it; `assertInplaceTarget` refuses it as an in-place target. AIOS cannot work on itself at all.

## Design

### 1. Let the planner choose AIOS as a workspace source (src/engine/plan.ts)

`workspaceError` currently rejects any `projectDir` that `isSecretPath` matches, which includes the AIOS root. Narrow that check so the **daemon's own root is allowed** while every genuine secret path (`~/.ssh`, `~/.aws`, `.env`, keychains, …) is still refused:

```ts
if (isSecretPath(raw.projectDir) && !isUnder(raw.projectDir, deps.selfRoot)) { … }
```

`PlannerDeps` gains `selfRoot: string` (the daemon's own source root, `resolveReal(process.cwd())` — the same value `assertInplaceTarget` already receives), wired in src/index.ts.

Nothing else in the planning vocabulary changes: the lead still asks for `needsWorkspace: "worktree"` with `projectDir: /Users/ihabbishara/projects/AIOS`, and §4 turns that into a clone at allocation time. Non-AIOS projects keep working exactly as they do now.

Delivery is unchanged and already correct for worktrees: the branch `aios/<slug>-<id>` is created in the source repo, so finished work is a normal branch reviewed with git.

### 2. Sandbox: allow the standard device files (src/code/exec.ts)

Add to `sandboxProfile`, after the write allow:

```
(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/"))
(allow file-ioctl (literal "/dev/null") (literal "/dev/tty"))
```

These are sinks, not secret sources — writing to `/dev/null` leaks nothing, and reads are already permitted by the broad `file-read*`. This unblocks git and npm without widening the filesystem write surface (writes stay confined to the task dir).

### 3. Anchor the secret regex (src/kernel/secrets.ts)

Replace the substring match with one that matches secret-looking FILENAMES, not any path containing the word:

```ts
/(^|\/)\.?[\w-]*(token|credential|secret)s?(\.(json|ya?ml|yml|txt|pem|key|ini|conf))?$/i
```

Matches `google-tokens.json`, `credentials.json`, `.secrets`, `api-token.txt`. Does NOT match `tokenize.js`, `TokenProcessor.d.ts`, `secrets.ts` (a `.ts` source file). The same expression is used for the SBPL line so path guard and sandbox stay in lockstep — `secrets.ts` remains the single source of truth for all three consumers.

`.env` keeps its own dedicated pattern; the `/projects/AIOS/` pattern is handled in §4.

### 4. AIOS self-work via a clone (src/code/workspace.ts, src/code/paths.ts)

A worktree of AIOS cannot work: its `.git` is a file pointing back into `/projects/AIOS/.git`, which stays denied. A **local clone** is self-contained (verified: `.git` is a real directory, `git log` works) and — because `.env` and `data/` are gitignored and untracked — carries **no secrets and no database** (verified on a probe clone).

- New workspace mode `"clone"`: `git clone --no-hardlinks <source> <taskDir>` (no hardlinks so the copy shares no inodes with the real repo).
- Selection happens in `allocateWorkspace`, not at the call site: a `"worktree"` request whose source resolves under `deps.selfRoot` is served as a clone. `AllocateDeps` gains `selfRoot`. `prepareGoalSandbox` keeps its existing `goal.project_dir ? "worktree" : "greenfield"` logic untouched, so there is one place that knows about the self case.
- `validateSource` gains an explicit allowance for the self root (still refusing every other secret path, sources outside the read roots, the workspace root, and non-repos). The `/projects/AIOS/` SBPL read deny **stays** — the sandbox still cannot read the real repo, only the clone in the workspace.
- `assertInplaceTarget` is unchanged: in-place edits of the AIOS source tree remain forbidden, so the daemon can never modify its own running code.

Delivery for clone mode: agents commit on branch `aios/<slug>-<id>` inside the clone; on goal completion the daemon (outside the sandbox) runs `git fetch <taskDir> <branch>:<branch>` in the real repo, so the branch appears for review. Nothing is merged; the working tree is untouched.

## Security posture

- Writes stay confined to the task dir; the device allowances are write-only sinks.
- Secrets: `.env`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, keychains, npmrc/netrc and secret-named files remain denied — the regex change narrows *false positives*, not the real families.
- The daemon's own source tree stays unreadable from the sandbox and unwritable in place; self-work happens on a clone whose results arrive as a reviewable branch.
- `data/aios.sqlite` and `.env` never enter a clone (untracked), so the memory DB and tokens are not exposed.

## Testing

- `test/workspace.test.ts`: clone mode creates a self-contained repo (`.git` is a directory) at the task dir; `validateSource` still refuses non-repos, secret paths, and sources outside the read roots; AIOS accepted for clone mode only.
- `test/secrets.test.ts` (or the existing secrets/paths test): the anchored regex denies `google-tokens.json`, `credentials.json`, `.env.local`; and ALLOWS `tokenize.js`, `TokenProcessor.d.ts`, `secrets.ts`. `isSecretPath` and the SBPL line agree.
- `test/code-exec.test.ts` (sandboxProfile): the emitted profile contains the `/dev/null` write allow; existing profile assertions still hold.
- `test/plan-*.test.ts`: `workspaceError` accepts a `projectDir` under `selfRoot` with `needsWorkspace: "worktree"`, and still rejects `~/.ssh`, `.env` paths, and any dir outside `projectsRoot`.
- No golden re-pin expected: no tool names or capability lists change.
- Live smoke: a goal against a non-AIOS repo under `~/projects` produces a worktree with real files; a goal against AIOS produces a clone; `git status` and `npm --version` both run inside the sandbox.

## Non-goals

- No change to in-place mode or its AIOS refusal.
- No auto-merge of agent branches.
- No change to the review/approval flow (`needs-review` still parks for a human).
