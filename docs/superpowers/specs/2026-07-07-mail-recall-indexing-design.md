# Mail recall-indexing — design

Date: 2026-07-07
Status: approved (brainstorm)
Depends on: `2026-07-05-mail-threads-clarification-design.md` (`thread_id`/`in_reply_to`),
`2026-07-06-user-addressable-mail-design.md` (user-ask threads, `answerUserMail`)

## 1. Problem

Agents forget their own correspondence. Mail (requests, notes, reports, user
Q&A) lives only in the `mail` table: an agent asked a question last week and
today's run cannot find the answer; two departments re-ask each other things
already settled. Meanwhile the second-brain recall index (`src/memory/` —
hand-rolled inverted index + BM25-in-code, because this Node build has no FTS5)
already serves vault notes, memos, calendar events, and resolved decisions to
every pack agent and the moderator through the `recall` tool.

This cycle indexes mail **threads** into that same index so past correspondence
is one `recall(query)` away. Backlog §13 item "mail recall-indexing".

## 2. Scope

**In:** thread-granularity indexing of the `mail` table into the existing
memory index; live re-index on mail events; sweep-refusal re-index; boot
reconcile backfill (including deletion of newly-walled docs); privacy wall at
index time.

**Out (this cycle):**
- Query-time ACLs on recall. The existing `domain:"money"` broadening hole in
  `packs/server.ts` (any pack agent may pass any domain) is **unchanged** —
  known, out of scope.
- A mail-reading tool (fetch full thread by ref). Recall hits return snippets
  like every other source; if snippets prove insufficient, a read tool is its
  own small cycle.
- Indexing inbound *email* (the security exclusion in `indexer.ts` stands —
  `EVENT_INDEX_ALLOW` is untouched).
- Embeddings / semantic search. BM25 only, same as everything else.

## 3. Locked decisions (carried, do not relitigate)

- `node:sqlite` — no FTS5, no better-sqlite3, no new npm deps.
- Privacy is enforced by **never indexing**, not by filtering at query time
  (precedent: inbound email and `email.*` decisions are index-time walls).
- Request mail status never flips on answer; answered-ness derives from
  `in_reply_to` (`mailAnsweringRequest`).
- `read_at` semantics, sweep mechanics, depth cap: untouched.

## 4. Decisions made this brainstorm

| Question | Decision |
|---|---|
| Privacy wall | **Index time.** A thread with ANY private-visibility participant is never indexed (and is deleted if previously indexed). |
| Granularity | **One doc per thread** (`thread_id`), rebuilt on activity. |
| Scope | **All mail except refused messages**, including user-ask threads — human answers are the highest-value content. In-flight (queued/planning) included; recall staleness acceptable. |
| Domain | **Thread-root recipient's dept `memoDomain`**; root recipient `user` → sender's dept; unresolvable → `general`. |

## 5. Doc model

New `MemorySource: "mail"` (union extension in `recall.ts`; nothing switches
exhaustively on source — verify at implementation).

Per thread `T` (all rows sharing `thread_id`, ordered `created_at ASC, rowid ASC`):

- **ref**: `thread:<thread_id>`
- **title**: participants + root kind, e.g. `mail planner ↔ researcher (request)`.
  The 3× title boost makes "what did researcher say" rank well.
- **body**: one line per non-refused message: `<from> → <to>: <body>`
- **domain**: `memoDomain` of the dept of the **root message's recipient**;
  `user` → root sender's dept; agent unknown to registry → `general`
- **ts**: `created_at` of the last message
- **fingerprint**: `<nonRefusedCount>:<lastMailId>` — a sweep refusal changes
  the count, so `indexDoc`'s fingerprint check forces a rebuild; new mail
  changes the last id. Idempotent otherwise.

**Refused exclusion.** Refused messages are dropped from the body. Two refusal
shapes exist: `resolveRecipient` refusals (never inserted — nothing to do) and
sweep-time refusals via `store.refuseMail` (`goals.ts:435/443/471` — unknown
recipient, private-dept wall at sweep, depth cap). The latter flip status
*after* insert, hence the re-index trigger in §7.

## 6. The wall

At every (re)build of a thread doc:

1. Collect all participants (`from_agent` ∪ `to_agent` over all thread rows).
2. `user` is exempt (not a registry entry, never private).
3. Resolve each against the **current** registry. If any resolved agent has
   `visibility: "private"` → `store.deleteMemoryDoc("mail", ref)` and skip.
4. Participants absent from the registry are not private (they may be
   removed/renamed agents); the thread stays indexable.

The delete in step 3 makes wall flips self-healing on the next thread activity;
boot reconcile (§7) heals dormant threads. Origin (`origin_channel`/`chat_id`)
is deliberately **not** consulted: primary-chat-originated mail between shared
agents is indexed — shared agents already carried that content, and the wall is
participant-visibility, not provenance.

## 7. Wiring

All in the existing pattern (indexer functions + `index.ts` event listener):

- **`indexMailThread(store, registry, threadId)`** in `src/memory/indexer.ts`:
  load thread rows, apply §5/§6, `indexDoc` or `deleteMemoryDoc`.
- **Live inserts**: every insert path emits `mail.sent` or `mail.asked_user`
  (mailbox send/ask both branches, `mailReport`, `answerUserMail`; verify
  standup's lead one-shot at implementation — if it doesn't emit, boot
  reconcile still covers it). The `index.ts` listener maps event → mail id →
  `thread_id` → `indexMailThread`.
- **Sweep refusals**: after each of the three `refuseMail` sites in
  `engine/goals.ts`, call `indexMailThread` (or wrap refuse+reindex in one
  helper). One line each.
- **Boot reconcile**: `reconcile()` gains a registry parameter and a mail pass:
  walk distinct `thread_id`s, `indexMailThread` each — indexing fresh threads,
  skipping unchanged fingerprints, and **deleting now-walled docs**.
- **Store**: add `listMailByThread(threadId)` and `listMailThreadIds()` if not
  already present (UI thread view may cover the former).

`AIOS_MAIL_DISABLED` needs no special case: disabled mail sends nothing new;
reconcile indexing historical mail is correct.

## 8. Query surface — zero new tool

Source `"mail"` flows through the existing BM25 machinery untouched. Pack
agents' `recall` tool and the moderator's recall both surface mail hits
automatically; `formatHits` already renders generically:

    [mail/research] thread:ab12… (2026-07-06): «snippet»

Only change: one phrase added to the `recall` tool description in
`packs/server.ts` ("…including past agent mail threads") for discoverability.

## 9. Security notes

- **Untrusted content**: mail bodies can embed external data (a goal may quote
  fetched content). Indexed text is retrieval context only — same posture and
  comment precedent as calendar events (`indexer.ts:39-41`). The Action Gate
  still guards all effects; recall never authorizes anything.
- **Wall is load-bearing**: private-dept correspondence (e.g. finance) must
  never be recallable by shared agents. Pinned by tests (§10), including the
  flip-to-private deletion path.
- Refused-at-sweep private-wall mail: its body was inserted before refusal, but
  the participant check (§6) excludes the whole thread independent of status.

## 10. Testing

Unit (vitest, in-memory store, same style as existing indexer tests):

1. Thread with a private participant: never indexed; previously-indexed thread
   deleted on rebuild AND on reconcile after a visibility flip.
2. Domain mapping: root recipient dept; `user`-root fallback to sender dept;
   unknown-agent fallback to `general`.
3. Refused message excluded after sweep refusal; fingerprint change proves
   rebuild happened.
4. Fingerprint idempotence: re-running reconcile with no new mail writes
   nothing (fingerprint short-circuit).
5. End-to-end: send mail → recall(query) returns `[mail/...]` hit with snippet.
6. User-ask thread: question + human answer both recallable.
7. Reconcile backfill indexes pre-existing threads (fresh index).

## 11. Touched files

- `src/memory/recall.ts` — `MemorySource` union +"mail" (~1 line)
- `src/memory/indexer.ts` — `indexMailThread`, reconcile mail pass (~60 lines)
- `src/index.ts` — listener wiring (~5 lines)
- `src/engine/goals.ts` — 3 re-index calls at refusal sites (~3 lines)
- `src/packs/server.ts` — tool description phrase (~1 line)
- `src/store/db.ts` — `listMailByThread` / `listMailThreadIds` if absent (~15 lines)

One build cycle: worktree off origin/main, subagent TDD, review, FF-merge,
deploy, read-only smoke.
