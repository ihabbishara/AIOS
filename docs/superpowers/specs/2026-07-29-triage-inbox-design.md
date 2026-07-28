# Triage inbox gap-close — Reopen from inbox + grant↔park fusion (cycle ⑱)

**Date:** 2026-07-29
**Status:** approved design, pre-plan

## Context

The handoff imagined cycle ⑱ as "build one actionable queue" — but `ui2/src/views/Home.tsx`
already IS that queue: attention rows (left) + canvas (right), j/k keyboard walk, optimistic
updates, and wired verbs for approve/reject (actions), accept/retry/abandon with guidance
(reviews), read (mail), resume/abandon (goals), and answer (asks). Two real gaps remain:

1. **Failed goals cannot be reopened from the inbox.** `src/web/attention-view.ts` offers
   failed goals only `["open", "abandon"]`. The ⑮ machinery — `POST /api/goals/:ref/reopen
   {guidance?}`, `api.goalAction(id, "reopen", {guidance})`, engine `reopenGoal` — all exists;
   the inbox never surfaces it, and the Goal canvas has no guidance input.
2. **A ⑯ park puts two unlinked rows in the queue.** The parked review (severity 2) and its
   auto-proposed `permission.grant` approval (severity 1) have no connection. Resolving the
   real single decision ("let clio use Bash, then retry the node") takes three hops across
   two rows.

## Decisions (user-confirmed)

- Scope = both gaps + one-click fusion. No inbox redesign, no badge counts.
- **Fold** the standalone grant-approval row into its linked review row: one human decision,
  one row.
- Linking lives **server-side in `buildAttentionView`**, matched by exact-substring against
  the denial line `workers.ts` itself formats. No engine/journal changes, no two-writer tax.

## A. Server — `src/web/attention-view.ts` + `src/web/dto.ts`

1. Build review items **before** the approvals loop. For each `needsReviewNodes()` row, scan
   non-expired proposed `permission.grant` actions (payload `{role, tool}`) and link when:

   ```ts
   node.error.includes(`${role} was denied: ${tool} (not in allowlist)`)
   ```

   This is the exact string `workers.ts:269` writes into the park objections. Matched action
   ids accumulate in a `linkedGrantIds` set.
2. `AttentionItem` (dto.ts) gains an optional structured field:

   ```ts
   grants?: Array<{ id: string; role: string; tool: string }>;
   ```

   `ref` stays `Record<string, string>`; comma-packing ids into ref was rejected. A
   multi-wall park (several allowlist denials) links several grants on one review item.
3. The approvals loop skips any action id in `linkedGrantIds` — the fold. If the grant
   expires, or the review resolves while the grant is still proposed, the standalone
   approval row reappears on the next attention read and can be rejected there.
4. Guard-layer parks match no grant (their objection line has a different shape and nothing
   was proposed) — no `grants` field, canvas renders exactly as today.
5. Failed goals: `actions` becomes `["open", "reopen", "abandon"]`.

## B. UI — three files

1. **`ui2/src/views/Home.tsx`** — `act()` handles verb `reopen` →
   `api.goalAction(item.ref.goalId, "reopen")`; `reopen` joins the optimistic-tombstone
   verb list. Row-level reopen sends no guidance (mirrors row-level retry).
2. **`ui2/src/views/canvas/Goal.tsx`** — when `item.actions.includes("reopen")`: a guidance
   textarea (same styling as Review.tsx's) + a primary **Reopen** button calling
   `api.goalAction(goalId, "reopen", guidance.trim() ? { guidance } : undefined)`. Existing
   Resume / Abandon / Discuss buttons untouched.
3. **`ui2/src/views/canvas/Review.tsx`** — when `item.grants?.length`: a chip per grant
   ("clio → Bash") and a primary **Approve grant & Retry** button that sequentially
   `api.resolveAction(g.id, "approve")` for each grant, then
   `api.resolveReview(goalId, node, "retry", guidance)`. The existing guidance textarea is
   reused. Existing Accept / Retry / Abandon buttons stay. No reject-grant button in the
   canvas — the rare "deny the tool" path is: Abandon node → standalone grant row reappears
   → reject there.

## C. Error handling

Fusion partial failure (grants approved, retry call throws): show the error inline, the row
stays. Manual Retry recovers — the grants are already approved, so the retry proceeds past
the wall. Approving an already-resolved grant returns an API error; the fusion button
surfaces it and the user falls back to plain Retry. No new endpoints, no new journal events.

## D. Testing

- `buildAttentionView` unit tests: grant linked onto review item + standalone row
  suppressed; expired grant not linked; guard-layer park → no `grants`; multi-wall park →
  multiple grants on one item; failed goal carries `reopen` verb.
- Both roots `npx tsc --noEmit` clean; ui2 build passes; suite baseline 194 files /
  1517 pass + 2 skip holds.
- Live: user clicks Reopen once in the browser (also retires ⑮'s never-clicked button),
  and the next real park exercises fusion.

## Non-goals

Badge counts, queue regrouping/severity changes, reject-grant inside the review canvas,
⑰ failure-class retry, any journal/reduce/project change.
