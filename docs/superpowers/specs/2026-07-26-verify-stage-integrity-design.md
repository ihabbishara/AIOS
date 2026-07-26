# Verify-stage integrity — survive an unreachable API, and say what actually went wrong

## Problem

Goal `cab8495e` (the cycle ⑫ rework) failed with node error `no structured report`. The code was
correct: run by hand afterwards, backend `tsc` was clean, the suite was 191 files / 1445 passing,
and ui2 typechecked and built. Nothing was wrong with the work or with the verify agent.

The vault artifacts hold the real cause, verbatim and twice:

```
verify-a1-run-1.md → API Error: Unable to connect to API (ConnectionRefused)
verify-a2-run-2.md → API Error: Unable to connect to API (ConnectionRefused)
```

Corroborated by the daemon logs for the same window — `ENOTFOUND api.telegram.org`,
`ENOTFOUND slack.com`, and an `onComplete failed: … (ConnectionRefused)` at 10:53:00Z. The Mac
lost DNS/network for roughly ten minutes. Both attempts of the verify node burned inside it.

Three distinct defects follow, and they compound:

1. **An unreachable API is treated as agent failure.** `runAgent` sniffs the SDK's returned text
   for a session limit (`workers.ts:149`) but nothing else. A connection error becomes ordinary
   output, `res.structured` is undefined, and `workers.ts:281` classifies it as "the verification
   never ran". Correct as far as it goes — but the response is to consume an attempt. With
   `maxAttempts` defaulting to 2 (`engine.ts:138`), a ten-minute outage exhausts the node in three.
2. **The real error is discarded at the boundary where debugging starts.** The artifact says
   "Unable to connect to API"; the node error says `no structured report`. The evidence exists and
   never surfaces. This cost roughly an hour of misdiagnosis — the wrong root cause (a brittle
   report envelope) was investigated first, and the right one only appeared on reading the vault.
3. **The cascade is silent.** Node error → attempts exhausted → `FailGoal` (`decide.ts:70`) → every
   pending node is journaled `node.skipped` (`engine.ts:241`). The review node never ran, so
   agent-written code reached a reviewable branch with zero agent review, and nothing said so.
   It took a sqlite query to notice.

What is explicitly **not** broken: a verification that runs and genuinely fails already behaves
well. `workers.ts:290` emits `review.requested` with the failures as objections and parks the goal
as `needs-review` for a human. The engine already distinguishes "verification failed" from "node
errored"; only the error path is wrong.

## Design

### 1. Classify an unreachable API (src/engine/workers.ts)

Mirror the existing session-limit seam. The SDK reports failures as *text* rather than throwing, so
sniffing its output is the only available signal:

```ts
export class ApiUnreachableError extends Error { readonly name = "ApiUnreachableError"; }
```

The match must be tight. Agents in this codebase legitimately write *about* connection failures — a
goal debugging network code can print "connection refused" inside a perfectly valid report, and
misreading that as an outage would pause a healthy goal. So the predicate anchors on the SDK's
envelope shape, not on a bare substring:

- the trimmed, lowercased output **starts with** `api error:`, **and**
- it contains `unable to connect`.

The observed artifact is exactly that and nothing else (175 bytes, the single line). The existing
`isSessionLimitOutput` already calls `trimStart()` for the same reason; this follows it.

### 2. Hybrid response: retry briefly, then pause (src/engine/workers.ts, src/engine/engine.ts, src/index.ts)

**In-place retry** inside `runAgent` absorbs micro-blips: on detection, re-issue the SDK call up to
two more times with a short backoff (~5s, then ~15s). The sleep is injected through deps so tests
never wait. Most transient failures die here and never reach the engine.

**Pause** handles sustained outages. If all tries are unreachable, `runAgent` throws
`ApiUnreachableError`; `runAttempt` catches it beside the existing `SessionLimitError` branch
(`workers.ts:311`) and returns `apiUnreachable: true`; `engine.ts` mirrors its `res.sessionLimit`
branch (`engine.ts:264`) and journals `goal.paused` with reason `api` and the verbatim error.
`resumeApiPaused()` on the heartbeat tick mirrors `resumeBudgetPaused()` (`index.ts:745`), so the
goal continues on its own when connectivity returns. Blocking a worker for ten minutes is not an
option, which is why retry alone is insufficient.

**An unreachable attempt must not count toward `maxAttempts`.** This is load-bearing, not a
refinement: if it counts, two separate outages exhaust a node and kill the goal, defeating the
feature. `decide.ts:85` already grants a cap-bypassing retry for `review.resolved{retry}`; resuming
from an `api` pause reuses that mechanism. `SessionLimitError` has the same latent flaw today and is
deliberately left alone (see Non-goals).

### 3. Keep the real error (src/engine/workers.ts)

The pause reason carries the verbatim SDK error rather than a paraphrase. Independently, the
genuine no-report path keeps its behavior but stops throwing evidence away: the node error becomes
`no structured report (last output: "<first ~200 chars>")`. An agent that returns prose instead of
a `TestReport` is a real failure and must still fail — but the next person to read that error should
not have to open the vault to learn why.

### 4. Name what was skipped (src/index.ts)

`FailGoal` already journals `node.skipped` for every pending node, so the information exists. The
`[GOAL-FAILED]` notice in `onGoalComplete` gains it: `skipped: review (goal failed at verify)`. The
cascade itself is unchanged — hard-failing on a genuine error is defensible; being unable to see it
happen is not.

## Security posture

No change. No new network calls, no new filesystem access, no new secrets surface. Retry re-issues
an SDK call the engine was already authorized to make; pause/resume reuses existing journal events
and the existing heartbeat.

One risk is introduced and bounded by design: a false-positive sniff would pause a healthy goal.
The anchored predicate (§1) plus a test asserting that an agent writing "connection refused"
mid-report is *not* matched is the mitigation. A paused goal is recoverable by the user (`resume`);
it is not a destructive failure mode.

## Testing

- `test/workers.test.ts`: the predicate matches the real
  SDK string `API Error: Unable to connect to API (ConnectionRefused)`; it does **not** match a
  report that merely mentions "connection refused" or "unable to connect" in its body; it does not
  match ordinary agent prose.
- Retry: an injected sleep and a run function failing twice then succeeding returns the success
  without touching the engine; failing all three times throws `ApiUnreachableError`. Assert the
  sleep was called with the expected backoffs, so the test fails if the retry silently stops.
- Engine: an `apiUnreachable` attempt journals `goal.paused` with reason `api` and the verbatim
  error, and does **not** fail the goal. A second attempt after resume must still be startable —
  i.e. assert the attempt was not counted against `maxAttempts`.
- `resumeApiPaused()` un-pauses api-paused goals and leaves budget-paused and user-paused goals
  alone.
- Provenance: the no-report error string contains a snippet of the agent's last output.
- Cascade: a goal that fails at verify produces a `[GOAL-FAILED]` notice naming the skipped nodes.
- Full suite and both `tsc --noEmit` roots stay clean; no golden re-pin expected (no tool or
  capability changes).

## Non-goals

- No change to the genuine verification-failure path — `review.requested` → `needs-review` already
  parks correctly for a human.
- No redesign of the failure cascade. A genuine error still fails the goal and still skips pending
  nodes; only its visibility changes.
- No attempt-count change for `SessionLimitError`. It shares the flaw, but it is well-tested
  existing behavior in engine code and widening the blast radius is not worth it in this cycle.
  Recorded here so the inconsistency is deliberate and findable.
- No general-purpose retry framework, backoff library, or error-taxonomy layer. One predicate, one
  typed error, one pause reason.
- No change to `maxAttempts` itself.
