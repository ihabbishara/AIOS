# Mail-spawned multi-node graphs — design

**Date:** 2026-07-04
**Status:** approved, pre-implementation
**Builds on:** `2026-07-04-phase4-agent-mailbox-design.md` (Phase 4a mail → goal spawn), §4/§5 in
particular. This spec extends §4's single-node spawn into an optional planned-graph spawn.

## Problem

Today every work-mail spawns exactly **one** `run` node (spec §4): the recipient does the whole
task in a single agent turn, `max_rounds = 1`, no workspace, reports back on completion. That is the
right shape for a direct ask to a specialist, but it caps delegation depth at one — a lead cannot
mail-delegate a task that genuinely needs a multi-step, multi-agent plan (research → analyze →
write, or producer ⇄ critic loops). This spec lets **mail to a department lead** spawn a real
planned graph via the existing lead planner, while mail to a specialist keeps the single-node path
unchanged.

## Locked decisions carried in

- Work mail spawns a **goal** through the thin queue → GoalEngine. No second execution path.
- Runaway bound is **chain-depth cap only** (`AIOS_MAIL_MAX_DEPTH`, default 2). No per-mail quota,
  no budget cap (user-accepted wide-fan-out risk). This spec adds **no** new quota.
- Private-department mail wall, report/standup non-forgeability, `mail.*`/`goal.*` triage-ignore —
  all unchanged.

## Two answered questions

1. **Routing:** mail to a **dept lead** → planned graph; mail to a **specialist** → single node.
   Mirrors the existing plan-vs-execute split; no new `send_mail` surface; "mail a lead, they
   delegate" is the org metaphor. Leads already own `plan_goal`.
2. **Workspace:** mail-graphs get **no code workspace** — `needsWorkspace` is forced to `none`.
   Graph = multi-step analyze / research / write / coordinate across agents. Real coding still
   enters **only** via `code_task` inside a node. Preserves the §4 security posture: background mail
   cannot autonomously spin a sandbox and write code.

## Architecture

### 1. Routing (`GoalEngine.sweepMail`)

Per `kind='request' AND status='queued'` mail (FIFO), after the existing depth check +
`SpendGuard.allow()` + private-wall re-validation:

```
recipient = registry.agentOf.get(m.to_agent)          // canonical
dept      = registry.agents.get(recipient).department
isLead    = registry.departments.get(dept).lead === recipient
```

- `isLead` → **graph path** (§3, async).
- else → **single-node path** — today's `spawnFromMail`, with **one** addition: it also stamps
  `goal.spawned_by_mail = m.id` (so report-back and workspace-block unify on the column, §4/§5).
  Observable behavior — one node, `mail:<id>` summary, reports back, no workspace — is unchanged.

The single-node path is the regression anchor: existing mail tests assert the same observable
behavior (they must still pass unchanged).

### 2. Data model (two idempotent migrations, `try { ALTER TABLE … } catch {}`)

- **`goals.spawned_by_mail TEXT` (nullable)** — the source mail id. Set for **both** mail paths.
  This is the single load-bearing link for report-back and workspace-block, replacing the fragile
  `plan_summary.startsWith("mail:")` overload (which cannot survive a planner summary in
  `plan_summary`).
- **Mail status gains `"planning"`** — added to the `MailStatus` union
  (`"queued" | "planning" | "spawned" | "refused" | "unread" | "read"`). A **persistent claim**: the
  graph path is async (the planner runs LLM calls), so a re-entrant `pump()` pass must not see the
  mail still `queued` and spawn a second goal. Claiming synchronously to `planning` closes that
  window. On boot, reset `planning → queued` (mirrors `resetRunningNodes`) so a crash mid-plan
  re-sweeps idempotently — no goal was committed yet.
- **`plan_summary`:** single-node keeps `mail:<id>` (unchanged, see §5 for why it stays);
  graph uses the planner's summary text (like any planned goal).

### 3. Graph spawn path (async)

Unlike the synchronous, single-transaction `spawnFromMail`, the graph path awaits the planner.
`sweepMail` runs synchronously inside `pump()`, so it does **step 2 (claim) synchronously**, then
**fires steps 3–4 as a floating async task** (`void this.spawnGraphFromMail(m)`) — it does not
`await` them, keeping `pump()` responsive. The floating task re-enters `pump()` on completion (as
`launch` does via `.finally`). Because step 2 flips the mail to `planning` before returning, the
next `pump()` pass skips this mail. Flow:

1. **Guards** (unchanged, before claim): depth check; `SpendGuard.allow()` false → mail stays
   `queued` (budget-resume tick drains it later); private-wall re-check.
2. **Claim:** one transaction, `queued → planning`.
3. **Plan:** call the planner in a new mode:
   - `announce: false` — skip `postPreview`. Chat-initiated `planGoal` posts a plan preview for the
     user to see; a mail-origin plan has no human waiting, so no preview.
   - `forceNoWorkspace: true` — `needsWorkspace` is coerced to `none` and `projectDir` left
     undefined regardless of what the lead's plan proposes (enforces the workspace decision).
   - carries `spawnedByMail: m.id` and `chainDepth: m.chain_depth` into `startPlannedGoal`, which
     sets `goal.spawned_by_mail` and `goal.chain_depth`.
4. **Commit / fail-soft:**
   - success → transaction `planning → spawned` + `goal_id` (as `markMailSpawned` does today).
   - planner throws (no structured plan after its two internal attempts, invalid graph, or lead
     recommends abandon) → mail `refused` + the error message. The sender sees the refusal in their
     inbox. `pump()` continues; one bad mail never stalls the queue.

`chain_depth` is carried onto the goal; nodes that themselves send mail inherit the existing +1
depth accounting. Node fan-out is bounded by the planner's existing **≤12 nodes** validation rule.
No new cap is introduced.

### 4. Report-back (decoupled from the prefix)

- **`GoalEngine.complete`:** replace `fresh.plan_summary.startsWith(MAIL_PREFIX)` with
  `fresh.spawned_by_mail != null`. When set, call `mailReport(fresh, ok, error, files)` instead of
  the origin-chat `onComplete`. Works for **both** paths.
- **Timing:** the report fires once, when the **whole goal** reaches `done`/`failed` (existing
  `complete` timing). A graph reports a single outcome at the end, not per node.
- **`mailReport`:** reads the source mail by `spawned_by_mail` (was: parse the id out of
  `plan_summary`). Body already = outcome summary + artifact refs (all node artifacts) + error on
  failure — unchanged, and correct for a multi-node graph.
- **`buildGoalDetail.spawnedBy`** (`web/goals-view.ts`): read `g.spawned_by_mail`, not the prefix.

### 5. Re-plan / workspace / depth policy

- **Re-plan:** graphs are re-plannable; single-node mail is not. This falls out for free — the
  existing `onNodeFailure` guard is `facade || plan_summary.startsWith(MAIL_PREFIX)`. Single-node
  keeps its `mail:<id>` prefix → still excluded. Graph uses a planner summary → not excluded → the
  lead re-plans on node failure. **This is exactly why `plan_summary` keeps the `mail:` prefix on
  the single-node path** — it remains the "fixed single node, do not re-plan" marker. No edit to
  that line.
- **Workspace:** `startGoal`'s sandbox gate flips from `plan_summary.startsWith(MAIL_PREFIX)` to
  `!!goal.spawned_by_mail`, so **both** mail paths are workspace-blocked. Single-node behavior is
  unchanged; graphs are newly covered (enforces the workspace decision at the engine, independent of
  `forceNoWorkspace` in the planner — defense in depth).
- **Depth:** chain-depth cap unchanged. No new quota (locked).

### 6. Error handling summary

| Failure | Outcome |
| --- | --- |
| `SpendGuard.allow()` false | mail stays `queued`; budget-resume tick drains later (unchanged) |
| depth exceeded | downgrade to note (unchanged) |
| recipient unresolved / private-wall | mail `refused` (unchanged) |
| planner throws / invalid / abandon | mail `refused` + error; `pump()` continues |
| crash after claim, before commit | mail stuck `planning`; boot resets → `queued` → re-swept; no goal committed |

Each state transition (claim, commit) is its own transaction; node:sqlite is synchronous so there
is no torn write within a transaction.

## Testing (TDD, in-process)

All in-process against a `:memory:` `Store` + `VaultWriter(tmp)` + stub planner/runner, in the style
of `test/goal-scheduler.test.ts` and `test/mail-sweep.test.ts`. No live daemon.

1. **lead-mail → graph:** mail to a dept lead → planner invoked once → multi-node graph runs to
   `done` → exactly **one** `report` mail back to the sender → `goal.spawned_by_mail` set →
   `project_dir` null (no workspace).
2. **specialist-mail → single node:** regression — one `run` node, `plan_summary` `mail:<id>`,
   reports back, behavior identical to Phase 4a.
3. **graph node fails → re-plan:** a node in a lead-mail graph fails → the lead re-plans (not
   excluded) → graph completes → one report.
4. **plan fails → refused:** stub planner throws → mail `refused` with the error, **no** goal
   created, `pump()` still drains the next queued mail.
5. **boot claim reset:** a mail left in `planning` (simulated crash) → boot resets it to `queued`.
6. **workspace forced none:** a stub planner returning `needsWorkspace: "worktree"` on a mail-origin
   plan → goal `project_dir` null, no sandbox prepared.
7. **report-back keyed on column:** both single-node and graph report back via `spawned_by_mail`,
   not via `plan_summary`.

Baseline before this work: 825 pass + 1 skip. `tsc --noEmit`, backend build, and `ui` build clean
at merge.

## Out of scope (unchanged from Phase 4 §13)

Multi-turn agent threads/replies, user-addressable mail, mail recall-indexing,
workspace-carrying mail-goals, cross-department single-goal graphs. A specialist-mail goal
re-planning into a graph (deliberately kept non-re-plannable — a direct ask fails and reports,
it does not escalate).
