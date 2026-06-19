# Speculate — Email Drafts (design)

Date: 2026-06-19
Status: approved, pre-implementation
Cycle: Phase 8 Dream Cycle → speculate, stage 2 (after speculate-research, PR #10)

## Summary

The second speculate sub-cycle. Overnight, read the operator's inbound email
unattended, pick the few messages that genuinely want a reply, compose a draft
reply for each, and queue it through the Action Gate as a supervised
`email.draft`. In the morning the operator approves from a private surface; on
approval a Gmail *draft* is created (never auto-sent).

It reuses the speculate orchestration shape from speculate-research (03:00
anchor → plan → enqueue → morning brief surface) and adds the three harder
parts this cycle is about:

1. **Unattended inbound-email reading** — a new access path. The system never
   reads inbound email bodies autonomously today (`mail.received` is metadata
   only and is explicitly never indexed). This pass reads bodies, bounded.
2. **A recall-privacy wall** — draft content (recipient/subject/body) must never
   leak into the recall index or the vaulted brief, mirroring the money/bank
   wall.
3. **The first real `gate.propose` from speculate** — speculate-research was
   pure read-only research with no outward effect; email drafts are an outward
   write to Google, so they go through the gate, pairing with the existing
   `email.draft` executor.

## Decisions (from brainstorm)

- **Email scope: conservative.** Only direct personal asks: `in:inbox is:unread`,
  not a promotion/social/automated message, unanswered. Top-K by recency, with
  the LLM still filtering "does this actually want a reply."
- **Gated path: gate overnight.** `runSpeculateEmail` calls
  `gate.propose(email.draft)` for each composed reply → K actions queue
  supervised. Morning brief surfaces them; operator `/approve` → Gmail draft.
- **Index wall: exclude all `email.*` decisions from recall.** The indexer skips
  any resolved decision whose type starts with `email.`. Clean primitive that
  also fixes the existing on-demand `email.draft` leak. The approval-prompt
  preview (in the operator's private chat) stays informative.
- **Posture: ships enabled** for the primary Google account, kill-switch to
  disable. No-ops when no google account is authed.

## Architecture

New module `src/heartbeat/speculate-email.ts`, invoked in the existing 03:00
"speculate" anchor branch in `src/heartbeat/index.ts`, immediately after
`runSpeculate`. Independent of speculate-research: it does its own Gmail scan,
stamps its own kv key, and renders its own brief section. Fire-and-forget, like
the research pass and the dream pass.

### Pipeline — `runSpeculateEmail(deps)`

1. **Resolve account.** `config.speculateEmailAccount` if set, else the first
   enabled google account (`accounts.accounts()`). None → log + return
   (fail-silent). Also return early when `config.speculateEmailDisabled`.
2. **Cheap metadata scan.** Gmail query
   `in:inbox is:unread -category:promotions -category:social`, `maxResults` ~10,
   metadata only (From / Subject / snippet / id / threadId). Reuse
   `listInbox`-style access on the read client.
3. **Drop already-drafted threads.** Skip any `threadId` present in kv
   `speculate-email:drafted` (a bounded recent set). Prevents re-drafting the
   same unapproved thread on consecutive nights.
4. **LLM metadata triage** → `query`, json_schema, returns the `threadId`s of
   ≤K genuinely reply-worthy threads (anti-repeat against the drafted set is
   already applied in step 3; the LLM judges reply-worthiness from
   From/Subject/snippet only). Bounds full-body reads to what will be drafted.
5. **Read body + compose, per chosen thread (≤K).** `readEmail` for the latest
   message body, then a one-shot `query` (json_schema, mirrors
   `speculatePlanLLM`) that returns **body text only** for the reply. Per-thread
   `try/catch` isolation.
6. **Deterministic envelope.** `to` = the original message `From`; `subject` =
   `Re: <original subject>` (de-duplicated `Re:` prefix); `threadId` = the
   thread. Derived from the original headers, **never** from LLM output.
   `account` = the resolved account.
7. **`gate.propose`** `{type:"email.draft", payload:{account,to,subject,body,threadId}}`
   with `origin = {channel, chatId} = config.primaryChat`. Queues supervised
   (email.draft starts supervised; trust ledger unchanged). Per-propose
   `try/catch`.
8. **Stamp.** kv `speculate-email:latest = {date, drafts:[{actionId,to,subject}]}`
   (date = `localParts(now).date`). Add the drafted `threadId`s to
   `speculate-email:drafted`. Both writes guarded — jobs are already queued
   before the stamp, so a stamp throw cannot orphan them silently (review
   lesson carried from speculate-research).

### Morning surface (07:30 brief)

`src/heartbeat/briefs.ts` reads `speculate-email:latest` (morning-only,
date-matched to today, stale omitted):

- **Vaulted brief section (generic only):**
  `Speculate — email drafts: N reply draft(s) await approval (details sent privately)`.
  No recipient/subject/body. Counted in `isEmptyBrief` (an email-drafts-only
  morning still narrates).
- **Private transport-send (per-draft detail):** a separate `sendVia` direct to
  `config.primaryChat` — no agent turn, no vault write — listing each draft's
  `to`, subject, and `/approve <actionId>`. Exact money-signals pattern.
  Transport-only → never vaulted, never indexed. Fires only when there are
  drafts for today and `primaryChat` is set.

## The recall-privacy wall (three vectors)

**Vector A — gate preview → recall.** `indexer.ts` indexes resolved decisions
(preview + reject_reason). Add a guard: skip any decision whose `type` starts
with `email.`. The recall index never holds who/what was emailed. The
approval-prompt preview (`Draft to X: "subj"`) is unaffected — it is shown in
the operator's private chat for the approve/reject judgment and simply never
enters the index. Also closes the pre-existing on-demand `email.draft` leak.
Pinned regression test.

**Vector B — vaulted brief.** The brief section is a generic count only (above).
Pinned test asserts the assembled/vaulted brief string contains no recipient or
subject.

**Vector C — per-draft detail.** Delivered only via the private transport-send
(above): `sendVia` direct, no vault, no agent turn. Never indexed.

**Body containment.** Read bodies live only in (a) the action payload — which is
never indexed (only decision preview + reject_reason are) — and (b) ephemeral
LLM context during composition. Never vaulted, never in an indexed event, never
stored in kv beyond `to`/`subject`.

## Configuration

| Key | Env | Default |
| --- | --- | --- |
| `speculateEmailDisabled` | `AIOS_SPECULATE_EMAIL_DISABLED` | off (feature on) |
| `speculateEmailAccount` | `AIOS_SPECULATE_EMAIL_ACCOUNT` | first enabled google account |
| `speculateEmailMaxJobs` | `AIOS_SPECULATE_EMAIL_MAX_JOBS` | 2 |
| `speculateEmailModel` | `AIOS_SPECULATE_EMAIL_MODEL` | → specialistModel |

Shares the 03:00 `AIOS_ANCHOR_SPECULATE` anchor (no new anchor).

## Safety invariants (Opus review)

1. **Bounded reads.** Full-body reads ≤K (the triage-chosen threads). Bodies
   never vaulted, never in indexed events.
2. **Index wall.** Recall index never contains `email.*` decision previews
   (indexer skip + pinned test).
3. **Brief wall.** Vaulted brief = generic count only — no recipient/subject/
   body (pinned test).
4. **Envelope wall.** `to`/`threadId`/`subject` derived deterministically from
   the original headers, not LLM output → recipient-redirect injection
   neutralized (pinned test). `buildRawEmail` already strips CR/LF from `to`.
   Composer system prompt also instructs the model to ignore any instructions
   embedded in the email content and draft only a courteous reply to the actual
   ask.
5. **Gate-only effect.** The only outward effect is `gate.propose(email.draft)`
   → supervised → human approval. Never auto-send; `email.draft` creates a Gmail
   draft only.
6. **Fail-silent.** No account / disabled / scan error / triage error / composer
   error / per-thread isolation / gate-propose error / post-enqueue kv stamp
   guarded → degrade to no-work / no-section. Anchor is fire-and-forget
   (`.catch`); the clock loop is try/caught → an email-pass failure cannot break
   reminders or the other anchors.

## Testing

Mirror the speculate-research test structure. ~15–20 new tests:

- selection query shape + drafted-set dedupe
- metadata-triage stub → ≤K threadIds
- deterministic envelope derivation (to/subject/threadId from headers, ignoring
  LLM-supplied values)
- composer stub → body only
- `gate.propose` invoked with `email.draft` and the correct payload
- kv `speculate-email:latest` + drafted-set stamping (and guard on stamp throw)
- brief generic rendering — **no PII** assertion (Vector B pinned)
- private detail send contains `to`/subject/`/approve` id (Vector C)
- indexer skips `email.*` decisions — recall returns no draft strings (Vector A
  pinned)
- recipient-redirect injection neutralized (invariant 4, envelope wall, pinned)
- fail-silent paths (no account, composer throws, stamp throws)

## Files

- `src/heartbeat/speculate-email.ts` — new
- `src/heartbeat/index.ts` — wire `runSpeculateEmail` into the 03:00 branch
- `src/heartbeat/briefs.ts` — generic section + private detail send (WIP-overlap
  file; 3-way merges cleanly on deploy as in dream/speculate-research)
- `src/memory/indexer.ts` — skip `email.*` decisions
- `src/config.ts` — 4 keys
- `test/speculate-email.test.ts` (+ privacy assertions, possibly a small
  addition to an indexer/brief test file)

Reuses: `readEmail`/`listInbox` (`src/senses/google/read.ts`),
`emailExecutors`/`email.draft` (`src/senses/google/executors.ts`), `ActionGate`
(`src/kernel/gate.ts`), `sendVia` (channels), `localParts` (`clock.ts`),
`speculatePlanLLM` shape (`speculate.ts`).

## Out of scope (deferred)

- `email.send` from speculate (auto-send) — drafts only this cycle.
- Multi-account scanning — one configured account in v1.
- Reading already-read / awaiting-my-reply threads (the "moderate" scope) —
  conservative unread-only in v1.
- Real token/cost-budget enforcement — K-cap is the v1 bound.
