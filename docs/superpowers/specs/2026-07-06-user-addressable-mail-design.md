# User-addressable mail — agent asks you — design

Date: 2026-07-06
Status: approved (brainstorm)
Depends on: `2026-07-05-mail-threads-clarification-design.md` (ask → park → resume, `thread_id`/`in_reply_to`/`awaiting_mail`, `resumeFromAnswer`)

## 1. Problem

The org can already talk *to* the human — `/api/chat` POST routes a directed
`@agent` message synchronously and returns the reply inline. What it cannot do
is the inverse: **an agent, mid-goal, cannot ask the human a question and block
on the answer.** `ask_mail` resolves only real agents, so a working agent has no
way to say "I need a decision from the owner before I continue."

The prior cycle shipped the entire suspend/resume machinery (ask → park goal →
resume on the answering report). It works for agent↔agent. This cycle makes the
**human a valid ask target**: an agent asks you, its goal parks, you answer from
Mission Control or by replying in chat, and the *same goal* resumes — reusing
`resumeFromAnswer` wholesale.

This is the *human-in-thread* item explicitly deferred by the threads spec (§3).

## 2. Scope

**In:** agent → human `ask_mail`; the human answers; the parked goal resumes.
Two answer surfaces (Mission Control reply box + primary-chat `@agent` reply).

**Out (this cycle):**
- **Human originates cold mail to an agent** (durable-task direction "a"). Chat's
  `@target` path already hands an agent a synchronous turn; a durable
  human-authored *goal* is a separate cycle.
- **Full compose/inbox tab** — reverses spec §9 of the phase-4 design. This cycle
  adds a *reply affordance on an existing pending question*, not a compose tab.
- Answer TTL / auto-decline (indefinite park is correct for human-in-loop; add
  later only if a stuck goal is ever an actual problem).

## 3. Locked decisions (carried, do not relitigate)

- Turn/loop bound = **chain-depth-cap only** (`AIOS_MAIL_MAX_DEPTH`). No new
  quota, budget, or fan-out cap.
- No second execution path. Resume reuses `resumeFromAnswer` unchanged.
- Code work enters only via `code_task`; mail-goals get no workspace.
- Private-department wall, subscription auth (`CLAUDE_CODE_OAUTH_TOKEN`),
  `node:sqlite` (no FTS5, no better-sqlite3), integer cents, no new npm deps.

## 4. The human identity

A reserved target `USER = 'user'` with alias set `{you, me, owner, principal}`
canonicalizing to `user`. A helper `isUserTarget(to: string): boolean`.

**Not a registry entry.** The registry stays real-agents-only — the sweeper,
standups, org view, and `@mention` routing never see a phantom agent. `'user'`
is a distinct *branch* in `resolveRecipient`/`ask` and a distinct *value* in
`mail.to_agent` / `mail.from_agent`. No `AgentDef`, no department, no lead.

Rationale (rejected alternatives): a full synthetic `AgentDef` forces every
registry consumer to special-case a fake agent that never runs; a separate
`ask_user` tool + `human_asks` table re-implements park/resume/thread that
already key off the `mail` table. The reserved-value branch is the smallest diff
that reuses the shipped substrate.

## 5. Data model

**No new columns.** `thread_id`, `in_reply_to`, `awaiting_mail` already exist.

| Change | Purpose |
|---|---|
| `MailStatus` gains `'awaiting-human'` | A `request` delivered to the human and waiting for an answer. Distinct from `'queued'` so it **never enters `queuedRequests()`** — human-asks bypass the sweeper entirely. |
| New event `mail.asked_user {id, from, question, goalId}` | Drives the chat notification; triage default **`ignore`** (internal-machinery-never-pings guard, same as `mail.sent`/`mail.spawned`). |

A human-ask request `M` stays `'awaiting-human'` indefinitely; "answered?" is
derived from `mailAnsweringRequest(M.id)` (the existing report lookup), never
from `M.status`. Mirrors how agent-ask answered-ness is already derived.

## 6. `ask` → user branch (`mailbox.ts`)

In `Mailbox.ask(ctx, { to, question })`, before the normal `resolveRecipient`,
branch when `isUserTarget(to)`:

1. **Validate:** mailbox enabled (`!disabled`); inside a goal (`ctx.goalId` set —
   same guard as agent-ask); **no private-visibility wall** (the owner is always
   reachable — the wall protects finance from *other agents*, not from you).
2. One transaction:
   - Insert request `M`: `from_agent = ctx.from`, `to_agent = 'user'`,
     `kind = 'request'`, `body = question`, `status = 'awaiting-human'`,
     `in_reply_to = null`, `chain_depth = ctx.goalDepth + 1`;
     `thread_id` = the goal's incoming thread if the goal was itself mail-spawned
     (`goal.spawned_by_mail`), else fresh (`= M.id`) — identical to agent-ask.
   - `parkGoalAwaiting(ctx.goalId, M.id)` → goal → `awaiting-mail`.
   - If `ctx.nodeKey`: `updateNodeStatus(goalId, nodeKey, 'done')` (the asking
     node did its job) — inside the same tx so a late reject can't un-park.
3. Emit `mail.asked_user`. **Do not** call `onQueued` (nothing to sweep/spawn).
4. Return: `"Question sent to you — your task pauses and resumes automatically
   when you answer (Mission Control, or reply @<agent> in chat)."`

**Ceiling — one outstanding ask per goal** (unchanged): a second `ask` while
`goal.awaiting_mail` is set is refused, same as agent-ask.

**Depth cap — exempt by construction.** Human-asks skip the sweeper, so the
depth-downgrade guard never runs on them. Correct: asking the owner terminates a
chain (the human is not a fan-out agent). `// ponytail:` note at the branch.

## 7. Notification (`index.ts`)

On `mail.asked_user`, if `config.primaryChat` is set, send to it:

```
🙋 <from_agent> is asking:
<question>

Answer in Mission Control, or reply here: @<from_agent> <your answer>
```

**Transport-only** — a chat `send`, never vaulted or indexed into recall.
Safe even when the asker is a private/finance agent (midas): the primary chat is
the owner's own private channel, and the wall governs leakage to *other agents /
vault / recall*, not to the owner. Same class as the money-signals
transport-only watcher. If `primaryChat` is unset, no ping — the question still
waits and is answerable in Mission Control.

## 8. Answer — two paths, one primitive

New engine method **`answerUserMail(mailId, text)`**:

1. Load `M`; guard: exists, `kind='request'`, `to_agent='user'`,
   `status='awaiting-human'`, not already answered (`!mailAnsweringRequest(M.id)`).
   Any guard fails → no-op / return a reason (idempotent — double-submit safe).
2. Insert `report` `user` → `M.from_agent`: `in_reply_to = M.id`,
   `thread_id = M.thread_id`, `body = text`.
3. `resumeFromAnswer(M.id, text)` — the existing primitive: continuation node
   (agent = `M.from_agent`, brief = original asking-node brief + Q + A), clear
   `awaiting_mail`, goal → `running`, `pump()`.

### 8a. Mission Control

`POST /api/mail/:id/answer { text }` (token-gated) → `answerUserMail(id, text)`.
Returns `200 { resumed: true }` on success; `409` if already answered / not a
pending user-ask; `400` if `text` empty.

### 8b. Primary chat `@agent` reply

Intercept in `onMessage` (index.ts:314), **before** `router.handle`, and **only**
for the primary chat:

- Parse a leading `@token`. Resolve `token` via `registry.agentOf`.
- If the resolved agent has ≥1 `awaiting-human` mail (`pendingUserAsksFrom(agent)`)
  → answer the **oldest** with the remaining message text
  (`answerUserMail`), reply `"Answer sent to <agent> — resuming."`, and
  **short-circuit** (do not route).
- Otherwise fall through to `router.handle` **unchanged**.

**No message-swallowing:** the intercept fires only for `@agent`-addressed
messages where that agent is *already waiting on you*. Bare messages (no
`@agent`) are never intercepted — normal routing is untouched. A normal new
`@vulcan` chat turn is only diverted while vulcan is parked on your answer, which
is the correct reading of "@vulcan" in that moment.

**`>1` outstanding for one agent** (an agent has two parked goals both asking
you): answer the **oldest**. `// ponytail:` ceiling — widen to per-question
addressing only if a real need appears; Mission Control already targets an exact
mail id.

## 9. Boot reconcile

Unchanged. `resumeUnfinished` → `awaitingMailGoals()` already checks
`mailAnsweringRequest(g.awaiting_mail)`:
- Answer report already landed (e.g. answered just before a crash) → resume.
- Else stay parked — indefinite park is correct for a human-in-loop goal; it sits
  in the **Waiting** bucket until you answer.

Because `M.status='awaiting-human'` (not `'queued'`), a human-ask never touches
the sweeper on restart — no spurious spawn, nothing to reconcile beyond the
existing awaiting-mail path.

## 10. Mission Control (UI)

Reply affordance, **not** a compose/inbox tab (does not reverse §9):

- Parked goals already appear in the **Waiting** bucket; the thread view
  (`GET /api/mail/thread/:id`) already renders the conversation.
- Add a reply box on a pending user-ask (rendered where the parked question shows)
  → `POST /api/mail/:id/answer`.
- Fold a `pendingUser` count into the existing `GET /api/mail/unread` response →
  a `🙋 N waiting for you` indicator, reusing the unread-badge pattern.

Store helper `pendingUserAsks()` (all `awaiting-human`) backs the count; the
thread/mail detail marks which mail is answerable.

## 11. Walls / invariants held

- `code_task` wall and no-workspace-for-mail-goals — untouched.
- Private-department wall — unchanged for agent↔agent. The human target bypasses
  the private-visibility check **as a recipient only** (the owner is always
  reachable); no agent-to-agent leakage path is added. The §7 ping is
  transport-only.
- Mail table still not indexed into recall; no `personal_*`/bank/email content
  enters mail, briefs, or vault via this path (the answer body is owner-authored).
- Subscription auth, `node:sqlite`, integer cents, no new npm deps, no new
  quota/budget/fan-out cap.

## 12. Testing

- **`Mailbox.ask` (user branch):** `isUserTarget` alias canonicalization;
  refuses outside a goal; refuses when disabled; **no private-wall** (a private
  agent CAN ask the human from any origin); inserts `awaiting-human` request with
  `chain_depth+1`; parks goal + marks asking node done in one tx; fresh vs
  inherited `thread_id`; second ask while parked refused; does **not** call
  `onQueued`.
- **Sweeper isolation:** an `awaiting-human` request is never returned by
  `queuedRequests()` → never spawns a goal.
- **`answerUserMail`:** inserts report (`in_reply_to`, `thread_id`, from `user`);
  resumes the parked goal (continuation node agent = asker, brief carries Q+A,
  goal → running); idempotent on double-answer; rejects a non-pending / unknown
  mail id.
- **Chat intercept:** `@agent <answer>` with a pending ask answers + resumes +
  short-circuits; `@agent` with no pending ask falls through to routing; a bare
  message is never intercepted; oldest-wins with two outstanding for one agent;
  fires only on the primary chat.
- **Notification:** `mail.asked_user` triage default `ignore` (pinned alongside
  `mail.sent`/`mail.spawned`); ping rendered to primaryChat; no ping when
  primaryChat unset (question still answerable).
- **Boot:** parked user-ask whose answer already landed resumes; whose answer has
  not stays parked.
- **UI/API:** `/api/mail/:id/answer` token gate, 200/409/400 paths;
  `pendingUser` count in `/api/mail/unread`.
- Suite green; backend + UI `tsc` clean; UI build green at merge.

## 13. File touch-list (anticipated)

- `src/store/db.ts` — `MailStatus` += `'awaiting-human'`; `pendingUserAsks()`,
  `pendingUserAsksFrom(agent)`.
- `src/mail/mailbox.ts` — `USER`/`isUserTarget`; `ask` user branch.
- `src/engine/goals.ts` — `answerUserMail(mailId, text)`; nothing else (resume,
  reconcile, sweeper all reused).
- `src/events.ts` — `mail.asked_user` event + triage-ignore default.
- `src/index.ts` — `mail.asked_user` → primaryChat ping; `onMessage` primary-chat
  `@agent`-answer intercept before `router.handle`.
- `src/web/server.ts` — `POST /api/mail/:id/answer`; `pendingUser` in
  `/api/mail/unread`.
- `ui/src/…` — reply box on pending user-ask; `🙋 N` waiting indicator.
- `test/{mailbox,mail-store,goal-scheduler,mail-endpoints}.test.ts` — coverage §12.
