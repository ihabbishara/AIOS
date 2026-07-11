# Verification Hardening — Design

**Date:** 2026-07-11
**Status:** Approved (brainstorm with user)
**Scope:** Hard quality gates in the goal engine + shadow-mode trust graduation in the kernel. Small spec. Ships with or after the Journaled Execution Core (loop-cap escalation requires the journal; items 1, 3, 4 work on the legacy engine too).

## 1. Problem

Two soft gates let pipelines "succeed" without verification passing:

- A `verify` runner that emits no structured `TestReport` breaks the loop immediately and the node passes silently (`goals.ts:193,204-207`).
- A `loop` that hits `maxRounds` without critic approval proceeds with the last version plus a `[!warning]` note; the node still reads `done`.

Trust graduation counts raw approval streaks (10 approvals + 30 days), which measures usage, not judgment alignment.

## 2. Decisions (locked with user)

| Decision | Choice |
|---|---|
| Loop cap without approval | **Escalate to user** — node parks as `needs-review`, lands in the Home queue |
| Verify without report | **Failed attempt** (retry per policy, then node fails) |
| Shadow-mode graduation | **Build it** — promotion evidence = consecutive agreement between shadow decisions and human verdicts |

## 3. Verify nodes: no report = no pass

A verify runner attempt that returns no parseable `TestReport` is recorded `attempt.finished{outcome:"error", error:"no structured report"}`. Normal attempt policy applies (one retry); exhaustion fails the node → re-plan/deadlock rules. Flips the existing pinned soft-pass behavior; that test is inverted, not deleted.

## 4. Loop cap: escalate, don't proceed

Cap reached without approval:

1. Journal `review.requested {node, lastArtifactRef, objections[]}` (objections = the critic's last `reasons[]`).
2. Node status → **`needs-review`** (new `NodeStatus`); dependents stay pending; goal keeps running other branches.
3. New `/api/attention` queue kind `review` — Home shows last version + outstanding objections.
4. User verdicts (journaled as `review.resolved {verdict, by, guidance?}`):
   - **accept** → node completes; waiver recorded in artifact frontmatter (`approved-with-waiver: true`, objections listed).
   - **retry** → one new attempt; the user's guidance is injected as producer feedback.
   - **abandon** → node fails → normal `onNodeFailure` path.

Every waiver is queryable — "done with waiver" is never silent.

## 5. No self-approval

`validateGraph` gains two rules: a loop's `producer !== critic`; a verify's `fixer !== runner`. Cross-department planning (already shipped) means leads can always pick a foreign critic, so this cannot make a plan unsatisfiable in practice. Planner retry feedback explains the rule on violation.

## 6. Shadow-mode trust graduation

While an action type's trust state is `graduating`:

- At propose time the gate stores `shadow_decision` on the action row (what autonomy would have done — for a graduating type this is `execute`).
- On the human verdict the gate records **match** (approved) or **mismatch** (rejected).
- Promotion evidence = `AIOS_SHADOW_MATCHES` (default 10) **consecutive** matches. Mismatch resets the match counter AND demotes to supervised (current rejection behavior kept).
- The auto-proposed `trust.promote` action (still always-supervised, still human-approved, executor still re-checks `graduating`) carries the match record in its gate-authored preview.
- Governance UI shows match rate per action type.

Schema: `actions` gains nullable `shadow_decision`; `trust` gains `shadow_matches` counter. Both idempotent ALTERs.

## 7. Engine tie-in

`needs-review` / `review.requested` / `review.resolved` are reducer + `decide()` cases in the Journaled Execution Core (declared out-of-scope there; this spec fills them). On the legacy engine, §3, §5, §6 can ship independently.

## 8. Testing

- Reducer lifecycle: requested → each verdict path; dependents blocked while parked; waiver frontmatter.
- `validateGraph` rejects self-critic/self-runner graphs; accepts foreign-critic graphs.
- Gate shadow tests: match/mismatch/reset sequences; promotion preview carries evidence; demotion on mismatch.
- Attention integration: review item appears in `/api/attention`, resolves on verdict.
- Inverted regression: verify-no-report now fails the attempt.

## 9. Out of scope

- Automated evaluator agents beyond existing critics (worker/evaluator separation is structural via §5, not a new agent kind).
- Changing `maxRounds` defaults or attempt counts.
- UI beyond the new queue kind + Governance match rate (Ember Cockpit spec owns rendering).

## 10. Open questions

None — resolved in brainstorm (§2).
