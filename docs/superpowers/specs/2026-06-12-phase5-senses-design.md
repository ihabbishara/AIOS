# AI-OS Phase 5 — First Senses Design (Gmail + Calendar)

**Date:** 2026-06-12
**Status:** Approved (brainstorm complete, awaiting implementation plan)
**Parent spec:** `2026-06-11-cognitive-kernel-design.md` (Phase 5 of the roadmap)

## Summary

Give the daemon its first external senses: per-account Gmail and Calendar watchers
(polling, incremental sync) that emit events onto the existing bus, where Phase 4
triage decides interrupt-vs-brief and Phase 3 gate executors guard every mailbox
mutation. The moderator gains read tools so email is conversational; briefs gain
mail-digest and meetings sections; meetings ping 15 minutes ahead.

## Requirements (from brainstorm)

| Dimension | Decision |
|---|---|
| Google access | Gmail + Calendar APIs via user-owned GCP OAuth desktop client; `googleapis` npm in-process (no CLI middleman — `gws` evaluated and rejected: same OAuth setup, pre-1.0, keyring-vs-launchd pain) |
| Email actions | Full gated set: `email.send`, `email.draft`, `email.archive`, `email.label` — all supervised day one, graduate via the trust ledger |
| Accounts | Multiple from day one; `account` field threaded through events, actions, digests |
| Interrupt posture | Quiet by default: everything batches unless Haiku judges it genuinely urgent; exceptions taught via `add_triage_rule` |
| Architecture | Polling watchers on the heartbeat pattern (history API / syncToken incremental); Pub/Sub push rejected as infra overkill |

## Architecture

```
scripts/google-auth.ts (one-time per account) → data/google-tokens.json

src/senses/google/
  auth.ts      — OAuth2 clients per account, token load/refresh, degraded-account tracking
  gmail.ts     — GmailWatcher: poll (default 120s), history API incremental → mail.received
  calendar.ts  — CalendarWatcher: poll (default 300s), syncToken incremental → calendar.changed
                 + meeting-soon scan → calendar.reminder (≤15 min before start)

events → existing EventBus → Phase 4 triage → notify_now ping | batch to brief
actions → Phase 3 gate executors (email.*) — supervised, audited, graduable
moderator read tools: list_inbox, read_email (perception — ungated)
```

Watchers are read-only perception; every mutation passes the gate. Nothing here is
real-time-critical: 2-minute mail latency is fine, meeting pings ride the watcher
poll with a 15-minute lead.

## Auth + accounts (`src/senses/google/auth.ts`)

**One-time setup per account** (~10 min first, ~2 min each additional):

1. GCP console: create project → enable Gmail API + Calendar API → OAuth consent
   screen (internal/testing) → create OAuth **Desktop** client → copy id/secret.
   README documents the exact click-path.
2. `npx tsx scripts/google-auth.ts <accountName>` — prompts for client id/secret
   (stored once, shared across accounts), opens the consent URL, catches the
   redirect on a localhost loopback port, exchanges the code, writes the refresh
   token.

**Storage** — `data/google-tokens.json` (data/ is gitignored; never leaves the Mac):

```json
{ "clientId": "…", "clientSecret": "…",
  "accounts": { "personal": { "email": "…", "refreshToken": "…" },
                "work":     { "email": "…", "refreshToken": "…" } } }
```

- `auth.ts` loads the file, builds one `google.auth.OAuth2` per account
  (googleapis auto-refreshes access tokens), exposes
  `accounts(): Array<{name, email, gmail, calendar}>`.
- Missing/empty file → senses disabled with one boot log line (voice pattern).
- Revoked token (`invalid_grant`) → that account marked degraded and surfaced in
  the next brief ("re-auth needed: work"); other accounts unaffected.

**Scopes:** `gmail.modify` + `gmail.send`, `calendar.readonly`. Calendar stays
read-only in Phase 5 (no scheduling executor — YAGNI until requested).

## Gmail watcher (`src/senses/google/gmail.ts`)

Per-account loop (own interval, default 120 s via `AIOS_GMAIL_POLL_SECONDS`,
isolated try/catch + backoff):

- **Incremental sync** via kv `gmail:<account>:historyId`:
  - First run: fetch one message id only to grab the current `historyId`, stamp
    it, emit **nothing** (no backlog flood).
  - Each poll: `history.list(startHistoryId, historyTypes=messageAdded)` → new
    message ids → `messages.get(format=metadata)` → emit per message:
    `{ type: "mail.received", account, messageId, threadId, from, to, subject,
    snippet, labels, receivedAt }`.
  - historyId stamped AFTER emitting — a crash between may re-emit (one duplicate
    ping after a crash is acceptable; digests dedupe by messageId).
  - Expired historyId (~404 after a week offline) → silent re-bootstrap + log.
- **Source filtering:** INBOX only (never SPAM/TRASH/SENT/DRAFT); Gmail categories
  in `AIOS_GMAIL_SKIP_CATEGORIES` (default `promotions,social`) are skipped before
  triage — zero Haiku spend on newsletters.
- **Bodies on demand:** events carry metadata + snippet only (the events table
  stores payloads — bodies would bloat it). `read_email` fetches full bodies.

## Calendar watcher (`src/senses/google/calendar.ts`)

Per-account loop (default 300 s via `AIOS_CALENDAR_POLL_SECONDS`):

- **Incremental sync** via kv `gcal:<account>:syncToken`: first run bootstraps a
  now → +7 days window without emitting; afterwards only changes emit
  `{ type: "calendar.changed", account, eventId, summary, start, end, status,
  organizer }` (new invites, moves, cancellations). Expired token (410) → silent
  re-bootstrap.
- **Meeting-soon pings:** each poll maintains today's upcoming events in memory;
  an event starting within `AIOS_MEETING_PING_MINUTES` (default 15) that hasn't
  pinged (kv `gcal:pinged:<eventId>`) emits
  `{ type: "calendar.reminder", account, summary, start, minutesUntil,
  hangoutLink? }`. Fires once per event.

## Triage defaults (added to `defaultVerdict`)

| Event | Verdict |
|---|---|
| `calendar.reminder` | notify_now |
| `calendar.changed` | batch |
| `mail.received` | none → Haiku model path, quiet-posture prompt: interrupt ONLY for genuinely urgent/time-sensitive (explicit deadlines, payment/security issues, direct requests from people who clearly matter); everything else batch |

User corrections (`add_triage_rule`) override as always.

## Gate executors (all supervised day one)

| Type | Payload | Preview (gate-side) |
|---|---|---|
| `email.send` | `{account, to, subject, body, threadId?}` | `Send to <to>: "<subject>" (<account>)` |
| `email.draft` | same | `Draft to <to>: "<subject>" (<account>)` |
| `email.archive` | `{account, messageIds[]}` | `Archive N messages (<account>): <first subjects…>` |
| `email.label` | `{account, messageIds[], add[], remove[]}` | `Label N messages (<account>): +<add> −<remove>` |

`threadId` present on send/draft → proper Gmail reply threading.

## Moderator read tools (ungated perception)

- `list_inbox(account?, query?, limit)` — Gmail search syntax pass-through
  (`is:unread from:hannah`).
- `read_email(account, messageId)` — full body, HTML→text.

Conversational flow: "what's unread?" → list → "draft a reply to the second one
saying I'll confirm Monday" → moderator reads the thread, composes, proposes
`email.draft`/`email.send` → approval ping → one tap.

## Brief additions

- **Mail digest** (since last brief, per account): counts by sender-domain or
  category, batched-but-notable items, oldest-unanswered nudge.
- **Meetings:** morning → today's agenda (times + links); evening → tomorrow's
  first meeting.
- Empty sections are omitted (existing empty-brief rules apply).

## Error handling — senses never break the daemon, never lie

- No tokens file → senses off, one boot line.
- Per-account isolation: auth/API failure → that watcher backs off
  (1 m → 5 m → 15 m cap), account marked degraded, surfaced in next brief.
- Quota/429 → respect Retry-After.
- Expired historyId/syncToken → silent re-bootstrap; never claims completeness
  over downtime gaps.
- Executor failures → standard gate `failed` status (already audited/reported).

## Config additions

```
AIOS_GMAIL_POLL_SECONDS=120
AIOS_CALENDAR_POLL_SECONDS=300
AIOS_MEETING_PING_MINUTES=15
AIOS_GMAIL_SKIP_CATEGORIES=promotions,social
```

All four editable in the Mission Control Config tab (CONFIG_KEYS). Accounts live
only in `data/google-tokens.json`, managed by the auth script.

## Events union additions

`mail.received`, `calendar.changed`, `calendar.reminder` (payloads as above).

## Testing

- Watchers with stub API clients (injectable): bootstrap-no-flood, incremental
  emits, expired-token re-bootstrap, category filtering, backoff progression.
- Meeting pings with injected clock: fires once within lead window, kv guard
  prevents re-fire.
- Executors with stub clients: payload mapping, preview text, account routing.
- Triage: new defaults; `mail.received` reaches the model path.
- Brief assembly: digest + meetings sections from seeded events.
- E2E (no network): fake clients → real bus → triage → gate → brief.
- Live opt-in smoke after real auth: one poll cycle per account.

## Out of scope (YAGNI)

- Calendar write/scheduling executors.
- Gmail push (watch + Pub/Sub).
- Attachment handling.
- Proactive auto-drafting (dream cycle, Phase 8).
- Non-Gmail providers.

## Known blockers

- User must complete the one-time GCP OAuth client setup + per-account consent
  before live operation (everything else ships and tests without it).
