# Goal resurrection — reopen a terminal goal at its exact frontier

## Problem

A failed goal is a tombstone. The platform's whole intervention surface today:

| Situation | Human power |
| --- | --- |
| Goal paused (budget / api / user) | resume |
| Node parked `needs-review` (only loop-cap and verify-fail produce it) | accept-with-waiver / retry-with-guidance / abandon |
| Running goal | pause, abandon |
| **Goal `failed` or `abandoned`** | **nothing** |

Of the 47 goals ever run, 7 failed and 3 were abandoned. Every one of those failures traces to a
cause that was subsequently fixed — a transport error recorded as success (⑬), an honest refusal
recorded as success (⑭), a lost DNS window, a workspace refusal. The goals themselves were fine.
But the only recovery is re-running from zero: a fresh goal, a fresh plan, and full price re-paid
for every node that had already finished. Goal `c03a3bda` had real money in its `done` nodes when
it died; that work was simply stranded.

This is the systemic gap behind the "fixing on the fly" feeling: the failure surface is
open-ended, so new failure classes will keep appearing — but each one is only survivable if
failure is a *checkpoint with a human decision*, not a terminal state. The engine's architecture
already agrees: state is a pure fold over `goal_journal`, `review.resolved{retry}` already proves
the append-an-event-to-intervene pattern end to end (decide.ts:84), and workspaces are never
deleted on failure. The substrate is there; only the event is missing.

## Design

### 1. The event and the fold (src/engine/journal.ts, src/engine/reduce.ts)

`"goal.reopened"` joins `JournalEventType`, payload:

```ts
export interface GoalReopenedPayload { by: string; guidance?: string }
```

The reduce case rewinds the terminal state:

- `phase → "running"`; `lastResumeTs = ev.ts` — the same fresh wall-time window that
  `goal.resumed` grants (reduce.ts:60's comment gains one more event name).
- Every node with status `failed` or `skipped` → `pending`, with counters wiped mirroring the
  `review.resolved{retry}` block (reduce.ts:213-229): `attempts = 0`, `lastOutcome = null`,
  `lastError = null`, `currentRound/loopRounds/runnerRounds/fixerRounds = 0`, `lastVerdict`,
  `lastReport`, `lastFeedback` cleared, and `reviewGuidance` set from the payload's `guidance`
  (or `null`). `attempts = 0` rather than a `reviewRetry`-style one-shot flag: reopen grants a
  full fresh budget, so the normal retry policy applies from scratch.
- **The workspace error is cleared**: if `workspaceError` is set → `null`, and
  `workspacePending = true`, so decide re-issues `PrepareWorkspace`. Without this, any goal that
  failed at workspace setup (the secret-denylist refusal is one of the 7 real failures) reopens
  and instantly re-fails on decide.ts:113. `allocateWorkspace` is re-entrant by construction —
  `taskDir` derives from `deps.now` + `deps.id`, so a re-run allocates a fresh directory.
- `done` nodes untouched — their artifacts replay for free; the reopened goal resumes at its
  exact frontier and no finished work is re-paid.
- `needs-review` nodes untouched — still parked; the existing review flow owns them.
- `replannedFor` / `replansUsed` untouched — replan budget stays per-goal-lifetime. If a
  reopened node fails again after its replan was already spent, the goal fails fast and can be
  reopened again. Deliberate: reopen is the human's loop, replan is the planner's.

Why not reset the failed node's attempt-cap trap is worth naming: flipping `failed → pending`
*without* the counter wipe would instant-re-fail on the next tick — decide.ts:53 sees
`lastOutcome !== "ok" && attempts >= maxAttempts` and emits `FailNode`. A test pins this.

Attempt numbering cannot collide: `attemptSeq` is a goal-lifetime high-water mark (decide.ts:83),
so reopened nodes claim attempt N+1 even though their budget counter reset to 0.

Because counters reset to `attempts = 0` / `lastOutcome = null`, reopened nodes re-enter decide
as **fresh** candidates (decide.ts:89's `attempts === 0 && !lastOutcome && ready`), not as
retries — the cleanest path through the scheduler, no new decide rule needed.

**The store projection follows the fold** (src/engine/project.ts). The projection switch gains a
`goal.reopened` case beside `goal.resumed`: the goals row → `running` with its `error` cleared,
and every node row whose status is `failed` or `skipped` → `pending` with its error cleared
(readiness recompute then promotes dep-satisfied ones to `ready`, as it already does elsewhere).
Without this case the engine folds `running` while the goals table — and every UI reading it —
still says `failed`.

### 2. The engine method (src/engine/engine.ts)

`reopenGoal(idOrSlug, opts: { by: string; guidance?: string }): string` beside `abandonGoal`,
same shape as its siblings:

- No goal → `No goal "…".`
- `legacy` → read-only message (existing pattern).
- Status not in `{failed, abandoned}` → `Goal <slug> is <status> — only failed or abandoned
  goals can be reopened.` `done` is never reopenable.
- Otherwise: append the single `goal.reopened` event, `tick()`, return
  `Goal <slug> reopened; failed and skipped nodes will retry.`

One event, atomic. A crash between append and tick is safe — the next heartbeat tick folds the
journal and proceeds.

### 3. Guidance reaches every node kind (src/engine/workers.ts)

`loop` and `verify` briefs already read `st?.reviewGuidance`. `run` never could park for review,
so it never read the field — reopen makes it reachable. The run brief assembly gains the same
block, exact same string (existing tests pin the format):

```ts
guidance ? `# User guidance (from review) — follow this\n${guidance}` : "",
```

This composes with ⑭: a reopened run node's brief can carry the human's guidance *and* the
`did not complete:` blockers from its last attempt — the human says what changed, the blockers
say what was missing.

### 4. Surfaces (src/web/server.ts, ui2/src/api.ts, ui2/src/views/Goals.tsx)

- Route: the existing `/^\/api\/goals\/([\w-]+)\/(pause|resume|abandon)$/` regex gains `reopen`.
  Only `reopen` reads a JSON body, `{ guidance?: string }`; the other verbs stay body-less.
  `by` is `"web"` — the route stays thin and untested per the standing decision.
- `ui2/src/api.ts`: the `verb` union widens; `reopen` passes the optional body.
- `Goals.tsx`: on goals with status `failed` or `abandoned`, a `Reopen` button (primary) plus an
  optional one-line guidance input, following the existing `verb()` + answer-input patterns
  already in the file. Abandoned goals currently render at `opacity-60` with only the card —
  they gain the button too.

Chat/neo wiring: out of scope this cycle (chosen explicitly; moderator tools has no
goal-control tools today and this cycle does not open that category).

### 5. Accepted edges

- **A second mail report.** A failed mail-spawned goal already sent `mailReport(false)`. If
  reopened and completed, `onGoalComplete` sends a second, corrected report. Accepted and
  correct — the asker learns the real outcome. Not deduplicated.
- **`deliverBranch` re-fires on re-completion.** The delivered ref advances fast-forward (the
  reopened goal's clone continued on the same branch), which `git fetch <taskDir>
  <branch>:<branch>` accepts. If the branch was force-rewritten inside the workspace the fetch
  refuses and `delivered` is null — already the existing failure-tolerant path.
- **Deterministic workspace refusals re-fail fast.** Reopening the secret-denylist goal re-runs
  `PrepareWorkspace` against the same source and fails again with the same clear error. The
  workspace-error clear exists for the transient class (git flake, disk, locked repo); the
  deterministic class needs the future approval-loop cycle, not this one.
- **Wall-time.** The fresh `lastResumeTs` means a goal reopened at 9am has the full window from
  9am — deliberately identical to budget-resume semantics.

## Security posture

Unchanged. Reopen appends a journal event on goals the operator already fully controls via
pause/resume/abandon on the same localhost-token-gated API. No agent gains any permission;
guidance is operator-authored text entering briefs through the same channel `review.resolved`
guidance already uses.

## Testing

TDD, all in root `test/` beside their subjects:

1. **Reduce**: `goal.reopened` on a failed goal → phase `running`, failed node `pending` with
   every listed counter/residue field reset, `reviewGuidance` set; `done` node untouched;
   `needs-review` node untouched; skipped node → `pending`.
2. **Reduce**: `workspaceError` cleared and `workspacePending` true after reopen; untouched when
   no workspace error existed.
3. **Reduce**: `lastResumeTs` equals the reopen event's ts.
4. **Decide**: after a reopen fold, no `FailNode` for the previously failed node (the
   attempts-cap trap) and no `FailGoal` from workspace error (the decide.ts:113 trap); the node
   appears as a fresh start candidate.
5. **Engine**: full chain — goal fails (attempts exhausted) → `reopenGoal` → node retries →
   goal `done`. The wall-time window measured from reopen.
6. **Engine**: `reopenGoal` on `abandoned` works; on `done` refuses; on `running` refuses; on a
   legacy goal refuses.
7. **Workers**: a run node whose state carries `reviewGuidance` gets the guidance block in its
   brief (the §3 addition).
8. **Projection**: after `goal.reopened`, the goals row reads `running` with error cleared and
   failed/skipped node rows read `pending`/`ready` — the store agrees with the fold.
9. Existing suites untouched and green — in particular the `review.resolved{retry}` tests, whose
   reset block §1 mirrors but does not modify.

Live verification: fail a real goal (the ⑭ test-gate goal `c1844130` is sitting failed right
now and is perfect for this — its node genuinely cannot succeed, so reopen it with guidance
naming a file that *does* exist), watch the journal: `goal.reopened` → fresh attempt with the
guidance in the brief → node completes → goal `done`. Then the ui2 button on a second goal.

## Non-goals

- **The approval loop for policy walls** (`tool.denied` → `needs-approval` park) — next cycle.
- **Triage inbox UI** — the Reopen button lands in the existing Goals view; the unified queue is
  its own cycle.
- **Failure-class-aware retry** (`error_max_turns` raised cap, `SessionLimitError` pause) —
  deferred, unchanged.
- **Neo chat tool for reopen** — explicitly descoped this cycle.
- **Editing node briefs or the plan on reopen** — guidance rides alongside the brief; rewriting
  history stays out. If guidance proves too weak, brief-editing is the upgrade path.
- **Deduplicating the second mail report** — accepted behaviour, see §5.
