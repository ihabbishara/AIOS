# Workspace-carrying mail-goals (user-gated) — design

**Date:** 2026-07-07
**Status:** approved, pre-implementation
**Builds on:** `2026-07-04-mail-multinode-graphs-design.md` (§2 workspace decision — this spec
deliberately reverses that wall for one narrow case), `2026-07-06-user-addressable-mail-design.md`,
`2026-07-07-compose-ui-cold-mail-design.md` (user cold mail is the trigger surface).

## Problem

Every mail-spawned goal is workspace-blocked: `planFromMail` forces `needsWorkspace: "none"`, and
`startGoal` skips `prepareSandbox` for any `spawned_by_mail` goal. `code_task` exists only on the
moderator (owner chat); specialists and leads inside goal nodes have no coding entry at all. Net
effect: a user who cold-mails the engineering lead "fix X in repo Y" gets a graph whose nodes
cannot touch code — observed live as a useless/failed vulcan goal. The original wall's rationale
was "background mail cannot autonomously spin a sandbox and write code". User-sent mail is not
background autonomy — a human initiated it, same trust as chat `plan_goal`.

## Decision

Mail-spawned goals may carry a code workspace **iff all three hold**:

1. **Sender:** the spawning mail's `from_agent === 'user'`. Gate is on the *message sender*, not
   the thread root — an agent request piggybacked into a user-rooted thread must not inherit
   workspace rights. User cold mail and user reply-in-thread both qualify (`sendFromUser` hardcodes
   `from='user'`, `chain_depth=0`; agents cannot forge it). All agent mail — including sub-mail
   sent from inside a workspace graph — stays walled.
2. **Path:** lead-mail **graph** path only (`plan_summary` is a planner summary, not the
   `mail:<id>` prefix). Specialist single-node mail has no planner run and therefore no structured
   `projectDir`/`needsWorkspace` source; it stays workspace-less and is the regression anchor.
3. **Department:** `engineering` only. Matches `prepareGoalSandbox`'s existing dept gate;
   prevents a non-engineering plan from landing a raw repo path as node cwd (see hole below).

Everything else about mail-goals — depth cap, spend guard, private wall, report-back, recall
indexing — is unchanged.

## Hole being closed alongside (engine layer was soft)

Today the engine's "defense in depth" only skips **sandbox allocation** for mail-goals. A planner
that (through bug or prompt drift) returns a `projectDir` on a mail plan still lands it on the goal
row via `startPlannedGoal → insertGoal`, and nodes then run with **cwd = that real repo,
unsandboxed** — only the planner's own force-none prevents this today. The engine layer becomes
hard: ineligible mail-goals get any planner-passed `project_dir` **nulled** (store + in-memory row)
before use.

## Architecture

### 1. Eligibility predicate (single definition)

`GoalEngine.mailWorkspaceEligible(goal)`:

```
!goal.spawned_by_mail                          → true   (non-mail goals unaffected)
store.getMail(goal.spawned_by_mail) missing    → false  (fail-closed)
mail.from_agent !== 'user'                     → false
goal.plan_summary.startsWith(MAIL_PREFIX)      → false  (graph only)
goal.department !== 'engineering'              → false
else                                           → true
```

### 2. Planner (`src/engine/plan.ts`)

- Extract `plan()`'s workspace-resolution block (worktree/analyze ⇒ `projectDir` required and
  under `projectsRoot`, else planning error into the retry loop) into a shared helper used by both
  `plan()` and `planFromMail()`.
- `planFromMail`: when `mail.from_agent === 'user'` **and** the department is engineering, resolve
  workspace via the helper and pass `projectDir`/`needsWorkspace` through to `startPlannedGoal`.
  Otherwise force `projectDir: undefined, needsWorkspace: "none"` exactly as today.
- Invalid/missing `projectDir` on a user mail-plan after the retry → `planning failed` → existing
  path: mail `refused` with the error, waiter resumed, thread re-indexed. Owner sees it in the Mail
  tab via the shipped `· refused: <error>` marker.

### 3. Engine (`src/engine/goals.ts` `startGoal`)

Replace the `goal.spawned_by_mail ? undefined : prepareSandbox(...)` gate with:

- eligible (per §1) → `await prepareSandbox(...)` (identical to chat-planned goals).
- ineligible mail-goal → no sandbox **and** if `goal.project_dir` is set, null it in the store and
  on the row before the `mkdirSync`/pump. This is the hard layer — holds regardless of planner
  behavior.

`prepareGoalSandbox` (`src/index.ts`) is unchanged: `MAIL_PREFIX` gate (single-node), engineering
gate, worktree/greenfield allocation via `allocateWorkspace` with `validateSource` fail-closed
(read roots, secret denylist, not-AIOS, git-repo-required). A user-mail graph with a plan-declared
source repo gets `wsMode: "worktree"` → isolated `aios/<slug>-<id>` branch + workspace dir;
greenfield plans get a scratch dir.

### 4. Report-back (`mailReport`)

Append one line when `goal.project_dir` is set: `Workspace: <project_dir>`. Only workspace
mail-goals have `project_dir` among mail-goals, so no extra gate. The owner learns from the report
mail where the branch/sandbox lives for review/merge.

### 5. Error handling

No new states. `allocateWorkspace` throw at `startGoal` → existing catch → goal `failed` → failure
report mail to sender. Planning invalid → mail `refused` (existing). Missing source-mail row at
eligibility check → workspace-less goal (fail-closed), goal still runs.

## Known / inherited (explicitly not fixed here)

- Planned `analyze` goals allocate a worktree copy instead of a read-only attach
  (`prepareGoalSandbox` derives `mode: "analyze"` only from the `code-analyze` playbook name) —
  pre-existing, safe-but-heavier; inherited by the mail path.
- Non-engineering **chat**-planned goals can still carry a raw `projectDir` as node cwd —
  pre-existing chat-trust posture, out of scope.
- `domain:"money"` recall broadening hole — unrelated, still out of scope.

## Testing (TDD, in-process)

`:memory:` Store + `VaultWriter(tmp)` + stub planner/runner, style of `test/mail-sweep.test.ts`:

1. **user → engineering lead, worktree plan:** `prepareSandbox` invoked; `goal.project_dir` =
   sandbox taskDir; graph completes; report mail body contains `Workspace: <dir>`.
2. **agent → engineering lead:** stub plan declaring `worktree` → `project_dir` null, no sandbox
   (the old forced-none behavior, now sender-gated).
3. **user → specialist (single-node):** still workspace-less; observable behavior identical.
4. **user → non-engineering lead, worktree plan:** engine nulls `project_dir`, no sandbox.
5. **planner misbehaves:** plan carrying `projectDir` for an *agent* mail-graph → engine nulls it
   (the new hard layer, tested independently of the planner force).
6. **invalid projectDir on user mail-plan:** mail `refused` with the planning error; no goal.
7. **report line gating:** workspace-less mail-goal report has no `Workspace:` line.
8. **regression:** full suite stays green (baseline 915 pass + 1 skip). The multinode spec's
   "workspace forced none" test must remain valid — if its fixture mail lacks an explicit agent
   sender, pin one (it must not accidentally become user-sent).

## Locks touched

- Reverses "mail-goals no workspace" — sanctioned §13 backlog item, user-approved 2026-07-07.
- "Code only via code_task" narrows to: **agent-autonomous** code enters only via `code_task`;
  user-sent mail to the engineering lead is now a second, human-gated entry.
- No new columns, no new npm deps, no query-time recall ACLs. Depth cap only bound (user mail is
  depth 0 by construction).
