# Code goals unblock — work on any project (and on AIOS itself)

**Date:** 2026-07-25
**Status:** Approved
**Cycle:** ⑪

## Problem

Goals that touch code cannot do their job. Two goals ("Fix two AIOS ui2 UI bugs", "Populate app Skills page") ran four stages each and parked at `verify` in `needs-review` — the BLOCKED cards on Home. An earlier goal ("Diagnose two AIOS UI bugs") reported **done** having read no code at all: its workspace held an empty `matches.txt`, an `err.log` full of `Operation not permitted`, and a symlink it created trying to reach `/projects/AIOS/README.md`. Only the verify agent was honest about the failure.

Four independent defects, found by reading the code and probing the live sandbox profile:

1. **`plan_goal` cannot name a project.** `prepareGoalSandbox` (src/index.ts:338) picks `goal.project_dir ? "worktree" : "greenfield"`. `run_playbook` and `code_task` take a `project_dir`; **`plan_goal` does not** — so every department-planned engineering goal gets an EMPTY directory. The worktree machinery (`allocateWorkspace`, src/code/workspace.ts:47-52 — `git worktree add -b aios/<slug>-<id>`) already exists and already accepts any git repo under `AIOS_CODE_READ_ROOTS` (default `~/projects`). It is simply unreachable from the path Neo uses.

2. **`git` cannot run inside the sandbox.** The SBPL profile allows `file-write*` only under the task dir, so `/dev/null` is unwritable. Probed live: `git --version` → `fatal: could not open '/dev/null' for reading and writing: Operation not permitted`; `echo hi > /dev/null` → `Operation not permitted`. Every git command and every npm script redirecting to `/dev/null` fails in every sandboxed goal.

3. **The secret regex is unanchored.** `SECRET_PATH_PATTERNS` / `sbplSecretDenyLines` contain `(token|credential|secret)` with no anchoring, so ANY path containing those substrings is denied. Real casualties observed: `node_modules/postcss/lib/tokenize.js`, `node_modules/sucrase/dist/types/TokenProcessor.d.ts`, and `src/kernel/secrets.ts`. This breaks ordinary builds in any project.

4. **AIOS is denied three ways.** `/(^|\/)projects\/AIOS(\/|$)/` is in `SECRET_PATH_PATTERNS`, so `validateSource` refuses AIOS as a worktree source; `sandboxProfile` denies reading it; `assertInplaceTarget` refuses it as an in-place target. AIOS cannot work on itself at all.

## Design

### 1. `plan_goal` gains `project_dir` (src/moderator/tools.ts)

Optional param, same validation as `run_playbook`'s: `resolve()`d and required to be under `deps.projectsRoot`, else refuse. Threaded into `goals.planGoal(...)` → `GoalRow.project_dir` → `prepareGoalSandbox` allocates a **worktree** instead of greenfield.

Neo's prompt (`agents/operations/neo.yaml`) gains one rule: when a request concerns an existing project, pass its directory as `project_dir` so the team gets a real checkout on its own branch; without it they get an empty workspace and cannot read the code.

Delivery is unchanged and already correct: the worktree is created on branch `aios/<slug>-<id>` in the source repo, so finished work is a normal branch the user reviews with git.

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
- `prepareGoalSandbox` selects `"clone"` when the source resolves under the daemon's own root (`selfRoot`), `"worktree"` for any other project, `"greenfield"` when no project is given.
- `validateSource` gains an explicit allowance for the self root under clone mode only; every other guard (secret paths, read roots, workspace root, must-be-a-git-repo) still applies. The `/projects/AIOS/` SBPL read deny **stays** — the sandbox still cannot read the real repo, only the clone in the workspace.
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
- Moderator: `plan_goal` refuses a `project_dir` outside `projectsRoot` and passes a valid one through to `planGoal`.
- Golden fixture re-pins only if the tool surface changes (adding a param does not change tool names — expect no diff).
- Live smoke: a goal against a non-AIOS repo under `~/projects` produces a worktree with real files; a goal against AIOS produces a clone; `git status` and `npm --version` both run inside the sandbox.

## Non-goals

- No change to in-place mode or its AIOS refusal.
- No auto-merge of agent branches.
- No change to the review/approval flow (`needs-review` still parks for a human).
