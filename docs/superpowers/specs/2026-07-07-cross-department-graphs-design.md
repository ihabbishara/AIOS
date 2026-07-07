# Cross-department single-goal graphs — design

**Date:** 2026-07-07
**Status:** approved, pre-implementation
**Builds on:** `2026-07-02-phase3-goal-engine-design.md` (planner/validator),
`2026-07-04-mail-multinode-graphs-design.md` (mail graph path — inherits this automatically).

## Problem

A planned goal's graph may only use agents from the goal's own department:
`agentCheck` (src/engine/plan.ts) rejects any node agent whose department differs from the
planning department ("single-department goals"), and `rosterBlock` shows the planning lead only
its own roster. Real tasks cross that line (research → engineering → write-up). The loose
workaround exists — an agent mails a foreign lead, spawning a separate depth-capped goal — but
that severs shared artifacts, splits the report, and burns a depth hop.

## Decisions (user-approved 2026-07-07)

1. **Scope: any lead, any shared agent.** Every department lead may plan nodes using any
   SHARED-visibility agent from any department. Private agents are usable only when the goal's
   origin is the private chat — the exact per-agent rule the validator already enforces. No new
   config, no hub asymmetry, no manifest allowlist.
2. **Mail-spawned graphs included.** `buildValidatedPlan` is shared, so mail-to-lead graphs get
   cross-department planning too. Autonomous reach grows, bounded as before by depth cap, spend
   guard, and the per-agent private rule; the loose mail-chain version was already possible.

## What already works (verified in code, no changes)

- **Execution is per-agent:** `launch` resolves each node's pack via
  `resolveDeptFor(node.agent, origin, byAgent=true)` (src/packs/resolve.ts:109) — a foreign
  agent gets its own department's tools, toolServer, memoDomain, persona, and `privateMemo`
  gating (memo block only for private-visibility agents). Nothing assumes node.agent ∈
  goal.department.
- **Ownership stays single:** `goal.department` remains the planning department everywhere —
  standup filters, report-back, mail recall domain, vault artifact frontmatter, workspace
  eligibility (owning dept must be engineering, spec 2026-07-07-workspace-mail-goals).
- **Replan:** patch validation calls the same validator — cross-department patches work with no
  extra code.

## Architecture

### 1. Validator (`src/engine/plan.ts` `agentCheck`)

Delete the department-equality branch (the `single-department goals` error). Keep byte-identical:
unknown-agent check, alias canonicalization, private-origin check (fail-closed), loop-critic
`verdict` / verify-runner `test-report` schema rules, node cap, cycle detection.
`ValidateCtx.department` remains in the ctx shape (callers still pass it; roster uses it).

### 2. Roster (`rosterBlock`)

Own department first, full roster as today. Then, for each other department (stable order,
skip departments with no eligible agents):

```
## Borrowable — <dept> (<mission first sentence>)
- <agent> — <title> — <charter first sentence> [outputSchema tag as today]
```

Eligibility for foreign listing: SHARED-visibility agents always; private-visibility agents only
when `isPrivateOrigin(primaryChat, origin)`. Roster filtering is UX (prevents plan→reject→retry
churn); the validator remains the enforcement layer, so a visibility flip between roster build and
validation still fails closed. `rosterBlock` gains `origin` + `primaryChat` params (both call
sites — `buildValidatedPlan`, `replan` — already have them in scope).

### 3. Planning brief (`planningBrief`)

Rule line changes from "for YOUR department's agents" to: "Prefer your own department's agents;
borrow agents listed under other departments only when the task genuinely needs them." Node-type
rules unchanged.

### 4. Explicitly unchanged

Depth cap, spend guard, node cap 12, `maxConcurrentNodes`, workspace eligibility, report-back,
recall indexing (goal artifacts index as `general` domain, pre-existing), standup department
filter, moderator `plan_goal` surface, mail sweep routing.

## Error handling

No new states. A plan naming a foreign private agent from a shared origin fails validation → the
existing retry-with-error loop → refusal/throw as today. Unknown agents unchanged.

## Testing (TDD, in-process)

Fixture registries already contain two departments (engineering + private finance); add a shared
finance agent (e.g. `plutus`, shared visibility) where needed.

1. **validator:** accepts a foreign SHARED agent (shared origin); accepts a foreign PRIVATE agent
   when origin is the private chat; rejects foreign private on shared origin; still rejects
   unknown agents; loop/verify schema rules still enforced on foreign critics.
2. **roster:** foreign shared agents listed under their department header; foreign private agents
   excluded on shared origin, included on private origin; own department listed first.
3. **e2e chat plan:** stub lead returns a cross-department graph → goal runs to done; the foreign
   node's pack resolution was called with the agent's own key (byAgent), not the goal department.
4. **e2e mail plan:** mail to a lead planning a cross-department graph → spawns, completes,
   reports once (decision 2).
5. **replan:** a patch adding a foreign shared agent validates and runs.
6. **Deliberate pin flips:** `test/validate-graph.test.ts` "rejects foreign-department agents"
   becomes an acceptance test (midas from primary origin is now VALID — private rule passes,
   dept rule gone; add a shared-origin rejection case to keep the private wall pinned).
   `test/goal-planner.test.ts` retry test's invalid fixture switches from `midas` (now valid)
   to `nobody` (unknown).
7. **Suite:** baseline 926 pass + 1 skip stays green otherwise.

## Locks touched

None reversed. "Cross-department goal graphs" leaves the §13 backlog. Single-department goals
remain expressible (a plan that only uses its own roster) — this widens, never forces.
