# Failure-class retry — session-limit pause + max-turns raised cap (cycle ⑰)

**Date:** 2026-07-29
**Status:** approved design, pre-plan

## Context

Two failure classes still burn attempts on retries that cannot succeed:

1. **SessionLimitError** (subscription quota exhausted): today it consumes an attempt and the
   engine pauses the goal as `paused-user` (`engine.ts:271`) — it sits until a human resumes,
   even though quota resets on ~5h boundaries. Deferred from ⑬ by user decision; due now.
2. **error_max_turns**: an attempt that dies on the turn cap retries with the *same* cap and
   an identical brief, so attempt 2 burns the same way. The retry needs headroom.

Existing seams this builds on: `isSessionLimitOutput` sniff + `SessionLimitError` throw in
`workers.ts`, the `uncounted` flag on `AttemptFinishedPayload` (⑬), `goal.paused{reason}`
with the shared `pausedStatus` helper (`journal.ts:32` — one map both reduce.ts and
project.ts call), `resumeApiPaused`/`resumeBudgetPaused` on the heartbeat onTick (30s),
and `RunOptions` (no turns override today; `maxTurns: role.maxTurns` at `runner.ts:48`).

## Decisions (user-confirmed)

- Session-limit resume = **time-gated probe, 30 min** — no parsing of reset times from SDK
  copy (brittle), no unconditional 30s resume (a probe SDK spawn every heartbeat).
- Max-turns raise = **2× once** via a factor in RunOptions; a second max_turns failure fails
  the node normally. No escalation ladder, no maxAttempts change.

## A. Session-limit class → uncounted + `paused-session` + 30-min probe

1. `workers.ts` SessionLimitError branch: `finish("error", err.message)` becomes
   `finish("error", err.message, undefined, true)` — the attempt is **uncounted**, exactly
   mirroring the ApiUnreachable branch one line below. The other infra branches
   (timeout/abort/api) stay byte-identical (pinned by ⑯).
2. `engine.ts:271`: the pause after `res.sessionLimit` uses `reason: "session"` (was
   `"user"`); the error message stays verbatim ("Agent hit session limit — re-run after
   quota resets"). Old journals with `reason: "user"` still replay to `paused-user` — those
   goals are long resolved; no migration.
3. `journal.ts:32` `pausedStatus` gains `"session" → "paused-session"`. Because reduce.ts
   and project.ts both call this one helper, the two-writer tax is paid in a single place;
   `project.ts:135`'s payload type union gains `"session"`. `GoalStatus` (db.ts:7) gains
   `"paused-session"`, and `pausedSessionGoals()` is added as a copy of `pausedApiGoals()`
   filtering `status = 'paused-session'`.
4. `engine.ts` `resumeSessionPaused(minAgeMs = 30 * 60_000)`: resumes each
   `pausedSessionGoals()` row whose `updated_at <= now − minAgeMs` with
   `goal.resumed{by: "session-probe"}` + tick. `now` comes from an injectable clock
   parameter (default `Date.now`) so tests pin the gate without fake timers. A probe that
   hits the limit again re-pauses uncounted — steady-state cost is one SDK spawn per
   30 min per paused goal.
5. `index.ts` onTick (currently `resumeBudgetPaused(); resumeApiPaused();`) adds
   `resumeSessionPaused()`.
6. Surfacing: `attention-view.ts` adds `store.pausedSessionGoals()` to the paused-goals
   spread (same resume/abandon verbs); `ui2 Goals.tsx` adds `"paused-session"` to the
   resume-button status list; `ui2 components/ui.tsx toneOfStatus` treats it like the other
   paused states.

## B. max_turns class → retry at 2× cap

1. `RunOptions` gains `maxTurnsFactor?: number`. In the runner's option builder the line
   `maxTurns: role.maxTurns` becomes
   `maxTurns: Math.ceil(role.maxTurns * (opts.maxTurnsFactor ?? 1))`. The role's cap stays
   private to the runner; callers only send a multiplier. Unlike the `model` override
   (manifest wins), the factor multiplies the manifest value — raising the cap is the point.
2. `workers.ts` `runAttempt`: at attempt start, if `attempt > 1` and the node's
   `lastError` contains `"error_max_turns"` (the SpecialistError message the runner
   formats: `Specialist <role> failed: error_max_turns`), every `runAgent` call of that
   attempt passes `maxTurnsFactor: 2` through to `deps.run`. This raises producer and
   critic caps alike on loop nodes — acceptable: the factor only ever raises.
3. The retry brief is unchanged — identical input with more headroom is the fix for this
   class. A second max_turns failure exhausts the node normally; replan/park paths are
   untouched.

## C. Testing

- `test/workers.test.ts`: session-limit attempt emits `attempt.finished` with
  `uncounted: true`; retry after an `error_max_turns` lastError passes
  `maxTurnsFactor: 2` to the injected run fn; attempt 1 passes no factor; a non-max-turns
  prior error passes no factor.
- Engine-level: `res.sessionLimit` pause lands the goal in `paused-session`;
  `resumeSessionPaused` resumes at 31 min but not at 29 min (injected clock), and emits
  `goal.resumed{by:"session-probe"}`.
- Runner: factor math — `maxTurns` doubles with factor 2, unchanged without.
- Reduce + project: `goal.paused{reason:"session"}` folds phase AND projects goals.status
  to `paused-session` (two-writer pin through the shared helper).
- Suite baseline 195 files / 1523 pass + 2 skip holds; both roots `npx tsc --noEmit` clean.

## Non-goals

Reset-time parsing from SDK copy, escalating cap ladders, maxAttempts changes, touching
timeout/abort/api-unreachable branches, journal schema changes (reason is a payload string),
pack-logic denial collection.
