# Compose UI + human cold mail — design

Date: 2026-07-07
Status: approved (brainstorm)
Depends on: `2026-07-06-user-addressable-mail-design.md` (user identity, answer surfaces,
`answerUserMail`), `2026-07-05-mail-threads-clarification-design.md` (`thread_id`/`in_reply_to`),
`2026-07-04-mail-multinode-graphs-design.md` (lead-mail planned graphs)

## 1. Problem

The org can ask the human (shipped 2026-07-06), but the human still cannot
originate durable work by mail: `@agent` chat gives a synchronous turn that
ends when the reply lands, and goals born from chat lack a correspondence
surface. The 2026-07-06 spec deferred exactly this pair (§2: "human originates
cold mail" — durable-task direction "a" — and "full compose/inbox tab",
which reverses phase-4 §9). This cycle reverses both, by explicit user choice.

## 2. Scope

**In:** owner-originated cold mail (durable goal via the sweeper);
reply-into-thread follow-ups; a user-centric Mail tab in Mission Control
(inbox threads + compose); report-arrival ping to primary chat; read-marking
for the human inbox.

**Out (this cycle):**
- Cold **notes** (fire-and-forget injection into an agent's next run). Compose
  sends requests only; add notes later if a real need shows up.
- Org-wide mail browser (all agent↔agent threads). The existing `/api/mail`
  list stays as-is; the Mail tab is the *user's* correspondence only.
- Multi-user semantics. `'user'` is the single owner; Mission Control is
  single-operator by construction (127.0.0.1 + bearer token).
- Any change to sweeper, depth cap, awaiting-human machinery, agent
  `read_at`-at-success semantics, or the recall wall.

## 3. Locked decisions (carried, do not relitigate)

- `'user'` is a reserved mail value, NOT a registry entry.
- Request mail status never flips on answer; answered-ness derives from
  `in_reply_to`.
- Depth cap is the only mail bound; no quotas/fan-out caps.
- Code work enters only via `code_task`; mail-goals get no workspace.
- Mail recall-indexing (2026-07-07): every insert path must emit `mail.sent`
  or `mail.asked_user` — the new compose path emits `mail.sent`.
- `node:sqlite`, no new npm deps, subscription auth, integer cents.

## 4. Decisions made this brainstorm

| Question | Decision |
|---|---|
| Execution semantics | **Durable goal via existing sweeper.** Cold mail = `from_agent='user'`, `kind='request'`, `status='queued'`, `chain_depth=0`, origin `web/ui`. No engine change. |
| Inbox scope | **User-centric threads only** (any message from/to `'user'`). |
| Notification | **Badge + transport-only primary-chat ping** on report-to-user (📨, the 🙋 pattern). |
| Reply scope | **Fresh compose AND in-thread reply** — follow-up = new request in the same `thread_id`, `in_reply_to` the report → new goal with thread continuity. |
| Read semantics | Human opened the thread = read (`markDelivered`), distinct from agents' read-at-success. |

## 5. Why the substrate already does the heavy lifting

- `isPrivateOrigin` hardcodes `web/ui` as private (`direct.ts`), so cold mail
  passes the private-agent wall at send AND at the sweep re-check. No new wall
  logic; composing to a private agent (e.g. the CFO) just works.
- The sweeper treats a `from_agent='user'` request like any other: specialist
  recipient → single-node goal, department lead → planned multi-node graph.
- `mailReport` already addresses the completion report to `src.from_agent` —
  `'user'` — as an `unread` report in the same thread. `resumeFromAnswer`
  no-ops (no goal awaits the user's cold mail). Nothing consumes `'user'`
  unread mail today, which is exactly what the inbox is for.
- Recall indexing rides the `mail.sent` emit; user threads are indexable
  (`'user'` is wall-exempt), so past correspondence becomes recallable free.
- `chain_depth=0` matches chat-born goals: agents' `ask_mail` from the spawned
  goal gets depth 1, leaving normal headroom under `AIOS_MAIL_MAX_DEPTH=2`.
- The daily budget gate applies to user-spawned goals like all others — cold
  mail queues until budget allows; deliberate, not a bug.

## 6. Backend

**`Mailbox.sendFromUser(args: { to: string; body: string; threadId?: string; inReplyTo?: string })`**
→ human-readable string result (tool-friendly convention). A dedicated method,
not a `send()` shoehorn — `send()` cannot set thread/reply fields and derives
depth from an agent ctx. Behavior:

1. Reuse `resolveRecipient` with a synthetic ctx (`from: 'user'`, origin
   `{channel:'web', chatId:'ui'}`): disabled-mailbox refusal, unknown-recipient
   refusal, private wall (passes — private origin). `isUserTarget(to)` →
   refusal ("mail yourself?").
2. `insertMail` with the §4 fields; `thread_id = threadId ?? id`,
   `in_reply_to = inReplyTo ?? null`, `from_node = null`.
3. Emit `mail.sent` (recall + listeners), fire `onQueued()` (pump).

**Store:**
- `userThreads()` — thread summaries for threads containing a message from/to
  `'user'`: `{thread_id, last_ts, last_from, last_body_prefix, unread (to
  'user'), pending_ask (awaiting-human count)}`, newest-last-message first,
  rowid tiebreak.
- `unreadCountsByAgent()` gains `WHERE to_agent != 'user'` — reports to the
  human must not pollute the per-agent MailSection badge.
- `unreadUserInbox()` — count of `status='unread' AND to_agent='user'`.

**Endpoints (`web/server.ts`, bearer-gated like all `/api`):**
- `POST /api/mail/compose` `{to, body, threadId?, inReplyTo?}` → 200
  `{ok:true, id}` | 200 `{ok:false, refusal}` (mirrors tool-string convention;
  400 only for malformed JSON/missing fields). Body length clamp 4000 chars.
- `GET /api/mail/mine` → `{threads: userThreads()}`; thread detail reuses the
  existing `GET /api/mail/thread/:id`.
- `POST /api/mail/:id/read` → `markDelivered([id])` — only for mail addressed
  to `'user'` (400 otherwise); emits the existing `mail.read`.
- `GET /api/mail/unread` response gains `userInbox: unreadUserInbox()`.

## 7. Notification

`index.ts` bus listener (same block as the 🙋 ping): on `mail.sent` where
`kind === 'report'` and `to === 'user'` → transport-only primary-chat ping:
`📨 vulcan → you: <first line, clipped>`. No store writes, no read-marking —
the ping is a courtesy copy; the inbox is the source of truth. Answer-mail
from the user (`from='user'`) never pings (to ≠ user). Standups (to hermes)
never ping.

## 8. UI — Mail tab

New `ui/src/views/Mail.tsx` + App tab with `userInbox` badge:

- **Thread list**: from `/api/mail/mine`; unread bold, 🙋 marker on threads
  with a pending ask; click → detail.
- **Thread detail**: messages from `/api/mail/thread/:id` (from → to, body,
  ts); opening marks unread `to='user'` messages read (`POST /api/mail/:id/read`
  per message, fire-and-forget). Reply box → `POST /api/mail/compose` with
  `threadId` + `inReplyTo` = latest report id. Pending ask in thread → answer
  box wired to the existing `POST /api/mail/:id/answer`.
- **Compose**: recipient picker from `/api/org` agents (shared + private —
  the surface is private), body textarea, send → compose endpoint; refusal
  strings rendered inline.
- In-flight guards on all three submit paths (shipped reply-box pattern).
- Live refresh: subscribe to the existing event stream for `mail.sent` /
  `mail.read` (extend `AGENT_MAIL_EVENTS`-adjacent handling carefully — the
  sets in `App.tsx` and `Org.tsx` are explicit and must stay identical).

## 9. Security notes

- Compose is reachable only through the bearer-gated `/api` on 127.0.0.1 —
  the same trust as the shipped answer endpoint. The synthetic origin is
  hardcoded server-side to `web/ui`; the client cannot supply origin, sender,
  depth, or status.
- `to` is validated against the registry via `resolveRecipient`; refusals are
  strings, not silent drops.
- Report bodies rendered in the UI are agent-generated text — render as text,
  never HTML (existing UI convention).
- The chat ping clips to the first line; full body only in Mission Control.

## 10. Testing

1. `sendFromUser`: queued request row with exact fields (from `'user'`, depth
   0, origin web/ui, thread defaulting/threading); unknown recipient refusal;
   disabled-mailbox refusal; user-target refusal; private recipient ACCEPTED
   (origin is private — pinned).
2. Sweep e2e: user cold mail → goal spawned (specialist single-node), report
   lands `to='user'`, `status='unread'`, same thread; `resumeFromAnswer` no-op.
3. Reply-in-thread: compose with `threadId`+`inReplyTo` → second goal, same
   thread; thread endpoint shows the full conversation in order.
4. `userThreads()` shape: unread + pending_ask counts, ordering, rowid
   tiebreak; `unreadCountsByAgent` excludes `'user'`; `unreadUserInbox` counts.
5. Endpoints: compose 200/refusal/400 paths, body clamp; `/read` rejects
   non-user mail; `/api/mail/unread` carries `userInbox`.
6. Ping: `mail.sent` report-to-user pings once; note/request/standup and
   user-sent answers do not.
7. Recall: composed thread indexed via existing listener (one integration
   assertion — `recall()` finds the cold-mail body).

## 11. Touched files

- `src/mail/mailbox.ts` — `sendFromUser` (~35 lines)
- `src/store/db.ts` — `userThreads`, `unreadUserInbox`, counts tweak (~40)
- `src/web/server.ts` — compose/mine/read endpoints, unread field (~60)
- `src/index.ts` — report-to-user ping listener (~8)
- `ui/src/views/Mail.tsx` — new (~200); `ui/src/App.tsx` — tab + badge (~15)

One build cycle: worktree off origin/main, TDD, review, FF-merge, deploy,
read-only smoke (endpoints only; no live agent spend).
