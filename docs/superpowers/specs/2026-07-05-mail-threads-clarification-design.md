# Mail threads + mid-goal clarification — design

Date: 2026-07-05
Status: approved (brainstorm)
Depends on: `2026-07-04-mail-multinode-graphs-design.md` (mail→goal spawn, `spawned_by_mail`, report-back)

## 1. Problem

Agent mail is fire-and-forget: a `request` spawns the recipient's goal, and on
completion `mailReport` sends a `report` back to the sender. That report is
**terminal** — it lands as `unread` mail and, at best, is surfaced in the
sender's next-run mail block (`peekInbound`). Nothing acts on it. There is no
way for a working agent to ask a question and *continue its own task* with the
answer. Mail has no conversation identity either — messages don't reference
each other, so there is no thread to read or resume.

This cycle delivers **multi-turn agent conversations**: a working agent pauses
mid-goal to ask another agent a question, its goal parks until the answer
arrives, then the *same goal* resumes with the answer in hand. Plus the shared
**thread substrate** (conversation identity + a read view) that makes those
exchanges legible.

## 2. Locked decisions (carried from prior cycle, do not relitigate)

- Turn/loop bound = **chain-depth-cap only** (`AIOS_MAIL_MAX_DEPTH=2`). An ask is
  a `request` and carries `chain_depth+1`, so back-and-forth is bounded for free.
  **No new quota, budget cap, or fan-out limit.**
- Mail→goal spawns via the **existing** request path (specialist → single node,
  lead → planned graph). This cycle adds **no second exec path**.
- Code work still enters **only** via `code_task` (§4 wall). Mail-spawned goals
  get no workspace. Unchanged.
- Private-department wall, subscription auth (`CLAUDE_CODE_OAUTH_TOKEN`),
  `node:sqlite` (no FTS5, no better-sqlite3), integer cents, no new npm deps.

## 3. Non-goals (explicitly out this cycle)

- **Standalone shape-A** (reply-chains-requests without suspend) — folded into
  the suspend/resume mechanic below; there is no non-human, non-suspend driver
  for it.
- **Human-in-thread** (a person replying into a thread from Mission Control) —
  that is the *user-addressable mail* backlog item, its own cycle.
- **Scheduled inbox-processor** (a lead periodically draining its inbox).
- **Inbox tab** (reverses spec §9 of the prior design).

## 4. Data model

All migrations additive (nullable columns / widened status union), matching the
existing `db.ts` `ALTER TABLE … ADD COLUMN` + backfill pattern.

| Change | Purpose |
|---|---|
| `mail.thread_id TEXT` | Conversation grouping key. Root mail = its own id; every ask/report/reply inherits its parent's `thread_id`. Makes the thread view one `WHERE thread_id=?`. |
| `mail.in_reply_to TEXT` | The **request** id that a `report`/refusal answers. `mailReport` already knows this value (`goal.spawned_by_mail`). This is the resume linkage. |
| `goals.awaiting_mail TEXT` | The request id a parked goal is blocked on. Non-null ⇔ goal is parked. |
| `GoalStatus` gains `'awaiting-mail'` | Parked state. `pump` skips these goals. |

No other columns. Everything the resume path needs keys off the single request
mail `M` (= `goal.awaiting_mail`):

- Question text = `M.body`
- Continuation agent = `M.from_agent`
- Answer = the answering report's body

## 5. The `ask` tool

New `Mailbox.ask(ctx, { to, question })`, sibling of `send`. Tool-facing name
`ask_mail` (alongside the existing `send_mail`).

Flow:

1. **Validate first**, reusing `send`'s checks (mailbox enabled; recipient known;
   not self; private-visibility wall). On failure → return the refusal string
   **in-session; do NOT park** — the agent keeps working and may finish normally.
2. Valid → insert a `request` mail `M`:
   - `thread_id` = the goal's incoming thread if the goal was itself
     mail-spawned (continues that conversation), else a freshly minted thread
     (`thread_id = M.id`).
   - `in_reply_to = null` (M is a fresh request, not a reply).
   - `chain_depth = ctx.goalDepth + 1`, `status = 'queued'`.
3. The asking node → `done` (it finished its part: asking). Set the parking goal
   `awaiting_mail = M.id`, transition goal → `awaiting-mail`. The node's session
   ends and frees the concurrency slot. Because `awaiting_mail` is set, the
   node-finish path **must not fire `complete`** — an `awaiting-mail` goal is
   parked, not done, even when no node is currently ready/running. `pump` skips
   it; only §6 resume un-parks it.

Ceiling — **one outstanding ask per goal**. A second `ask` while the goal is
already `awaiting-mail` returns `"Refused: you already have a pending question
(mail <id>)."`. (ponytail: single-slot; widen to a set only if a real multi-ask
need appears.)

Return string on success: `"Question sent to <canonical>. Your task will pause
and resume automatically when they answer."`

## 6. Park → resume

The ask's request `M` spawns the recipient's goal through the **unchanged**
request path (`sweepMail` → specialist single-node or lead graph). The recipient
works; `complete` → `mailReport` emits a `report` with:

- `in_reply_to = M.id` (from the recipient goal's `spawned_by_mail`)
- `thread_id` inherited from `M.thread_id`
- body = `Done: …` / `Failed: …` (existing success/failure text)

**Resume trigger.** When a mail reaches a terminal, sender-facing state carrying
`in_reply_to = X`, the engine checks for a goal with `awaiting_mail = X`:

- A **report** (success or failure) with `in_reply_to = X`.
- The awaited **request itself going `refused`** at sweep (the private-wall
  re-check race) — surfaced to the waiter as a synthetic failure so it is not
  parked forever.

On match, **resume** goal `G`:

1. Insert a continuation node:
   - `node_key` = unique (`resume_<n>`)
   - `agent` = `M.from_agent`
   - `depends_on = []` (immediately ready)
   - `type = 'run'`, `max_rounds = 1`
   - `brief` = the original asking node's brief (still in `task_nodes`, read by
     `node_key`) + `\n\nEarlier you asked
     <canonical>: "<M.body>"\nThey answered: <report.body>\nContinue the task
     with this answer.`
2. Clear `goal.awaiting_mail`, goal → `running`.
3. `pump()`.

Failure/refusal answers resume identically — the parked goal receives the bad
news in the continuation brief and decides for itself (retry differently, give
up, report up). **No infinite park** as long as every awaited request reaches a
terminal state, which it always does (`complete` always reports, sweep always
refuses-or-spawns).

## 7. Boot reconcile

`resumeUnfinished` must handle `awaiting-mail` goals:

- If the answering report/refusal (`in_reply_to = awaiting_mail`) already exists
  in the store → resume immediately (same path as §6).
- Else leave parked. The recipient goal, if interrupted, is itself restarted by
  `resumeUnfinished`, and will report on completion → normal resume.

This mirrors the existing `reconcilePlanningMail` boot reconcile for the
`planning` status.

## 8. Thread view (substrate)

`GET /api/mail/thread/:id` → all mail with `thread_id = :id`, ordered by
`created_at`, shaped by a small builder in the `goals-view.ts` style (from/to,
kind, body, created_at, linked goal id). Rendered on the existing goal/mail
detail surface. This is the read-only conversation object; no compose UI (that
is user-addressable mail).

## 9. Bounds, walls, invariants

- **Turn bound**: depth-cap only. ask → `chain_depth+1`; at `> AIOS_MAIL_MAX_DEPTH`
  the request is downgraded to a note by the existing `sweepMail` guard, so the
  waiter's answer arrives as a decline and it resumes. Deep chains self-limit.
- **Single-node specialist mail stays non-re-plannable** (`MAIL_PREFIX` marker) —
  unchanged. Resume adds a node to the *asking* goal, not the recipient's.
- **`code_task` wall / no-workspace-for-mail-goals** — untouched.
- **Private wall** — `ask` re-checks visibility at send AND sweep re-checks
  provenance (defense in depth), same as `send`.

## 10. Testing

Following the existing `mail-store` / `mail-sweep` / `goal-scheduler` split:

- `Mailbox.ask`: refuses unknown/self/private (no park); queues valid request
  with `chain_depth+1`; sets `awaiting_mail` + `awaiting-mail` status; second ask
  while parked is refused.
- Engine: park-on-ask; resume-on-success-report (continuation node spawned, agent
  = `M.from_agent`, brief carries Q+A, goal back to running); resume-on-failure
  report; refused-request resume.
- Boot: `resumeUnfinished` resumes a parked goal whose answer already landed;
  leaves parked one whose answer has not.
- Store: `thread_id` inheritance (root mints, reply inherits); thread query
  returns the ordered conversation; `in_reply_to` set on reports.
- Depth-cap holds across an ask chain (ask at max depth downgraded).

## 11. File touch-list (anticipated)

- `src/store/db.ts` — 3 columns + migration + `awaiting-mail` status; `ask`-side
  insert helpers; `mailThread(id)` query; `parkGoalAwaiting`/`clearAwaiting`.
- `src/mail/mailbox.ts` — `ask()` method; `thread_id`/`in_reply_to` on inserts.
- `src/mail/server.ts` — `ask_mail` tool wiring alongside `send_mail`.
- `src/engine/goals.ts` — park on ask outcome; resume on matching report/refusal;
  `awaiting-mail` handling in `pump`/`complete`/`resumeUnfinished`; `mailReport`
  stamps `in_reply_to` + `thread_id`.
- `src/web/goals-view.ts` (or a `mail-view.ts`) + route — thread builder + endpoint.
- `test/{mail-store,mail-sweep,goal-scheduler,goal-store}.test.ts` — coverage above.

## Addendum (2026-07-06, user-approved)
- M3: a sibling node failure that transitions a parked goal also clears `awaiting_mail` (no dangling pointer / permanent ask-block). The goal still fails or re-plans; the late answer remains dropped-but-visible in the thread.
- M4: the "no extra resume columns" lock is relaxed by exactly one nullable column — `mail.from_node` (the asking node, stamped from the baked ctx) — so `resume_<n>` joins the DAG: it depends on the asking node, carries its brief, and the asking node's dependents are repointed onto it. Legacy rows (NULL) keep the detached shape.
