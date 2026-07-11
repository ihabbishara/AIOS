# Journaled Execution Core — Design

**Date:** 2026-07-11
**Status:** Approved (brainstorm with user)
**Scope:** Full event-sourced rewrite of GoalEngine internals. Public API, projections (`goals`/`task_nodes` shapes), planner, playbook compiler, Action Gate, mail table: preserved. Legacy goal history frozen read-only.

## 1. Problem

The current GoalEngine (`src/engine/goals.ts`, 787 lines) is a mutable-status scheduler with hand-rolled recovery:

- In-memory `runningNodes` counter as concurrency truth (resets on restart; not crash-safe).
- No atomic claim for node launches (actions and mail have atomic claims; nodes don't).
- Blind whole-node retry duplicates side effects and cost; loop rounds restart from 1 after a crash.
- No per-node timeout — a hung SDK call holds a global slot indefinitely.
- Budget checked only between nodes; one expensive node blows through the daily cap.
- Recovery is bespoke per-case code (`resetRunningNodes`, `reconcilePlanningMail`, stale-executing sweeps).
- Re-entrant `pump→sweepMail→startGoal→pump` relies on live-row re-checks against stale snapshots.
- Oldest-goal-first scheduling lets a wide early goal starve later goals.

## 2. Decisions (locked with user)

| Decision | Choice |
|---|---|
| Depth | **Full event sourcing** — journal is the source of truth; tables become projections |
| Migration | **Freeze legacy** — old `goals`/`task_nodes` rows flagged `legacy=1`, readable, never scheduled; new goals journal-only. In-flight goals at deploy finish on the old engine or are abandoned |
| API compatibility | GoalEngine public signatures preserved; `dto.ts`, views, moderator tools, `/api/goals` unchanged |

## 3. Journal

New `goal_journal` table:

```sql
CREATE TABLE goal_journal (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,  -- global order
  goal_id TEXT NOT NULL,
  gseq    INTEGER NOT NULL,                   -- per-goal sequence
  type    TEXT NOT NULL,
  payload TEXT NOT NULL,                      -- JSON
  v       INTEGER NOT NULL DEFAULT 1,         -- event schema version
  ts      INTEGER NOT NULL,
  UNIQUE (goal_id, gseq)
);
```

Append-only; never UPDATE/DELETE. **Optimistic concurrency:** an append must use `gseq = current max + 1`; the UNIQUE constraint makes a conflicting append fail atomically. A failed INSERT *is* the claim-loss signal. Synchronous `node:sqlite` makes each append a natural critical section.

## 4. Event taxonomy

| Event | Payload (core fields) |
|---|---|
| `goal.created` | slug, dept, lead, origin, brief, chainDepth, spawnedByMail? |
| `plan.recorded` | summary, needsWorkspace, projectDir?, nodes[{key, kind, agent, critic?, brief, dependsOn[], maxRounds}] |
| `replan.recorded` | replaced[], added[], reason — reducer enforces done-node immutability |
| `workspace.prepared` | taskDir, mode |
| `workspace.failed` | error |
| `attempt.started` | node, attempt#, agent, deadlineTs, idempotencyKey |
| `round.recorded` | node, round#, role (producer/critic/runner/fixer), verdict?/report?, artifactRef |
| `attempt.finished` | node, attempt#, outcome (`ok\|error\|timeout\|aborted\|orphaned`), costUsd, turns, artifactRef?, error? |
| `node.completed` | node, artifactRef |
| `node.failed` | node, error |
| `node.skipped` | node |
| `ask.parked` | node, mailId |
| `ask.resumed` | mailId, resumeNodeKey |
| `goal.paused` | reason (`budget\|user`) |
| `goal.resumed` | by (`user\|budget-reset`) |
| `goal.completed` / `goal.failed` / `goal.abandoned` | — / error / by |

## 5. Reducer

`reduce(events: JournalEvent[]) → GoalState` — pure, no clock, no IO (events carry timestamps).

`GoalState`: goal status, per-node `{status, currentRound, attempts, cost, artifactRef, lastFeedback}`, total spend, parkedOn (mailId), replansUsed, workspace.

Properties:
- Golden-testable: event list in, state snapshot out.
- Crash recovery is replay of the same function — `resetRunningNodes`, `reconcilePlanningMail`, and stale-executing recovery code are **deleted**, replaced by fold.
- "Running" is derived (`attempt.started` without matching `attempt.finished`) — no in-memory counter as truth.

## 6. Scheduler

`decide(state: GoalState[], caps, now) → Command[]` — pure.

Commands: `RequestPlan`, `PrepareWorkspace`, `StartAttempt{goal, node, attempt#}`, `ParkForBudget`, `CompleteGoal`, `FailGoal{deadlockInfo}`.

Rules preserved from today: dependency gating, deadlock guard (pending nodes transitively blocked on failed/skipped → fail loudly), replan cap (2), wall-time budget (measured from last resume event), mail-depth semantics, private-agent walls (validated at plan time as today).

**Fairness change:** ready nodes are picked **round-robin across goals** (not oldest-goal-first), so a wide early goal cannot starve later goals.

Engine loop: on journal append or clock tick → fold affected goal(s) → decide → dispatch commands to workers. No re-entrant pump.

## 7. Workers

Pool cap = `AIOS_MAX_CONCURRENT_NODES`. Worker executing `StartAttempt`:

1. Append `attempt.started` (the claim — conflict means another worker owns it; drop silently).
2. Run the SDK agent with an AbortController registered in an **abort registry** keyed `goalId:node:attempt#`.
3. Append `round.recorded` per loop/verify round as it happens — crash mid-loop resumes at round N with the critic's last feedback, not round 1.
4. Append `attempt.finished` with outcome + cost.

### Timeouts
`attempt.started.deadlineTs` = now + per-kind default (config `AIOS_NODE_TIMEOUT_MS`; suggested 15min run / 30min loop-verify). Clock tick sweeps past-deadline unfinished attempts: abort via registry + append `attempt.finished{timeout}`. A hung SDK call cannot hold a slot indefinitely.

### Retry policy — explicit, never silent
Attempt error → `decide()` may issue `StartAttempt` with attempt#+1 while `attempts < maxAttempts` (default 2). Every retry is a visible, costed journal event. `SessionLimitError` → `goal.paused{user}` (as today).

### Idempotency
Gate proposals made inside an attempt carry `idempotencyKey = goalId:node:attempt#`. The Action Gate dedupes on it — a retried node cannot double-propose the same effect. Gate change is minimal: nullable `idempotency_key` column + unique index on `actions`; gate logic otherwise untouched.

## 8. Budget

Per-attempt cost lands in the journal and `budget_ledger` (unchanged). Two enforcement points:

1. `decide()` parks goals (`ParkForBudget`) before starting new attempts once the daily cap is hit — today's behavior.
2. **New:** crossing the cap aborts all running attempts via the registry → `attempt.finished{aborted}` → goals park. No more blowing through the cap mid-node.

Midnight resume appends `goal.resumed{budget-reset}` (existing clock hook).

## 9. Recovery = replay

Boot: for each non-terminal goal → fold journal → any dangling `attempt.started` gets `attempt.finished{orphaned}` appended → decide → continue. Same code path as normal operation. No bespoke recovery functions.

## 10. Projections — API/UI untouched

`goals` and `task_nodes` become **materialized projections**: a per-event-type updater maintains them in the same transaction as each append. Shapes preserved, therefore `dto.ts`, `goals-view.ts`, Mission Control, moderator tools (`goal_status`, `plan_goal`), and `/api/goals` are unchanged.

GoalEngine public API keeps its signatures: `createFromPlaybook`, `planGoal`, `pause/resume/abandon`, `answerUserMail`, `answerFromChat`, `sweepMail`. Internals swap.

## 11. Mail integration

Mail rows stay relational (mail itself is not event-sourced). Interactions become goal events:
- Sweep spawning a goal → `goal.created`.
- `ask_mail` → `ask.parked`.
- Answer → `ask.resumed` + continuation node added via the `replan.recorded` mechanism (depends on the asking node; dependents repointed — current semantics preserved).
- `claimMailPlanning` survives as-is (it guards the mail row, not the goal).

## 12. Module layout

```
src/engine/journal.ts   append/read, optimistic gseq        (~100 loc)
src/engine/reduce.ts    pure reducer                         (~250)
src/engine/decide.ts    pure scheduler                       (~200)
src/engine/workers.ts   attempt runner, abort registry       (~200)
src/engine/project.ts   projection updaters                  (~150)
src/engine/engine.ts    wiring, public GoalEngine API        (~200)
```

`plan.ts` (planner + validateGraph) and `compile.ts` (playbook→graph) survive nearly unchanged — outputs recorded as `plan.recorded` events.

## 13. Migration

- Legacy `goals`/`task_nodes` rows get `legacy=1` (idempotent ALTER + backfill). Readable in UI; never scheduled.
- Deploy waits for in-flight goals to finish on the old engine, or the user abandons them.
- New goals are journal-only from first boot of the new engine.

## 14. Testing

- **Reducer golden tests:** event lists → state snapshots, every event type covered.
- **decide() property tests:** never exceeds caps; round-robin fairness; no command for non-ready nodes; deadlock detection fires.
- **Replay determinism:** fold twice ≡ fold once; fold(prefix)+fold(suffix) ≡ fold(all).
- **Projection equivalence:** reduced state ≡ projected rows after every event type.
- **Crash simulation:** truncate journal at every position mid-attempt → recover → goal still terminates.
- Existing goal-scheduler/goal-runner test intents ported to the new seams.

## 15. Out of scope

- Verification hard-gating changes (loop-cap/verify-report semantics) — separate Verification Hardening spec; this spec preserves current soft-gate behavior at the reducer level so the two specs land independently.
- Multi-process execution (single daemon assumption stands; the journal makes it possible later).
- Event-sourcing the Action Gate or mail (gate's `actions` table already serves as its journal).

## 16. Open questions

None — resolved in brainstorm (§2).
