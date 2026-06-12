# AI-OS Phase 4 — Heartbeat Design

**Date:** 2026-06-12
**Status:** Approved (brainstorm complete, awaiting implementation plan)
**Parent spec:** `2026-06-11-cognitive-kernel-design.md` (Phase 4 of the roadmap)

## Summary

Give the daemon a pulse: a 30-second tick drives two daily anchors (morning brief,
evening close) and user reminders; a triage layer decides which bus events interrupt
the user immediately versus wait for the next brief. Briefs are assembled
deterministically from the store and narrated by the moderator into the user's
primary chat, with a raw archive in the vault.

## Requirements (from brainstorm)

| Dimension | Decision |
|---|---|
| Brief delivery | `AIOS_PRIMARY_CHAT` config (`channel:chatId`); Telegram the moment its token lands; vault archive always |
| Brief authorship | Moderator-narrated: deterministic data assembly → one moderator turn → natural chief-of-staff message |
| Triage | Full pipeline now: rules table short-circuits first, Haiku-class model classifies the rest, user corrections persist as rules |
| Reminders | In scope: `add_reminder` moderator tool, clock-fired, pinged to origin chat |
| Architecture | Heartbeat module inside the existing daemon process (no new deps, no cron framework, no worker threads) |

## Architecture — one tick, three modules

```
src/heartbeat/clock.ts ── 30s tick ──┬─ anchor due?   → briefs.ts
                                     └─ reminder due? → emit reminder.due on EventBus

EventBus (existing) ───────────────► src/heartbeat/triage.ts
                                       rules table → first match wins
                                       no match    → Haiku one-shot {verdict}
                                       verdict: notify_now → ping primary chat
                                                batch      → silent (next brief picks it up)
                                                ignore     → nothing

src/heartbeat/briefs.ts: assemble(store) → moderator.handle(narrate) → primary chat + vault
```

No batch queue table: events are already persisted (Phase 3 `events` table). The
`batch` verdict simply means "stay silent"; the next brief queries everything since
the last brief and builds digests. Triage is purely the interrupt gatekeeper.

All state in SQLite: `reminders` and `triage_rules` tables, anchor stamps and
`brief:last-ts` in the existing `kv` table. Restarts lose nothing.

## Clock + anchors (`src/heartbeat/clock.ts`)

One `setInterval` (30 s); each tick is cheap and synchronous except brief runs.

- **Anchor due:** local `HH:MM >= configured time` AND kv `anchor:<name>:last` ≠
  today's date. Local-time string comparison (lexicographic on `HH:MM`) — DST-proof
  because the current local clock is always read directly.
- **Fire-once:** the kv stamp is written BEFORE the brief runs. A crashing brief is
  logged and mentioned in the next brief — never retried in a loop.
- **Catch-up:** daemon offline at 07:30, started 11:00 → morning brief fires
  immediately. Same-day only; yesterday's missed briefs never replay.
- **Double-catch-up edge:** daemon starts 22:00 with neither anchor fired → both
  fire, morning first. Accepted (stale morning brief is harmless; the close is the
  valuable one).
- **Reminder scan:** `claimDueReminders(now)` atomically flips due `pending` rows to
  `fired` (Phase 3 claim pattern) and returns them; one `reminder.due` event emitted
  per row. At-most-once delivery; max 30 s late.
- Tick body wrapped in try/catch — heartbeat never kills the daemon.

## Triage (`src/heartbeat/triage.ts`)

Subscribes to the EventBus. Decides `ignore | batch | notify_now` per event.

- **Rules first** — `triage_rules` `{id, event_type (exact or glob "action.*"),
  verdict, source (seed|manual|correction), created_at}`. First match wins; exact
  match beats glob. Zero tokens, deterministic.
- **Seeded defaults:**
  | Event | Verdict |
  |---|---|
  | `reminder.due` | notify_now |
  | `action.executed` (auto) | batch |
  | `trust.changed` | batch |
  | `job.status` (all) | ignore (moderator completion flow already narrates both success and failure) |
  | `chat.*`, `agent.*`, `action.proposed`, `action.resolved` | ignore (Phase 3 notifier already pings proposals — no double-ping) |
- **Model fallback** — no rule matches → one-shot SDK call (`AIOS_TRIAGE_MODEL`,
  default Haiku-class) returning strict JSON `{verdict, reason}`. Malformed output or
  SDK error → `batch` (fail-quiet: never lost, never spamming). Every decision emits
  a `triage.decision` event for observability.
- **Corrections** — moderator tool `add_triage_rule(event_type, verdict)`: "stop
  pinging me about X" in chat becomes a persistent deterministic rule.
- **notify_now delivery** — short plain ping to `AIOS_PRIMARY_CHAT` (no moderator
  turn — instant and free; the user replies in chat if they want conversation).
  Reminders ping their origin chat instead (see below).

## Briefs (`src/heartbeat/briefs.ts`)

**Assembly** — pure function over the Store:

```
BriefData {
  anchor: "morning" | "evening",
  pendingApprovals: [{id, type, preview, expires_at, expiringSoon}],
  graduationProposals: [...],            // pending trust.promote actions
  autonomousDigest: [{type, count}],     // auto-executed since last brief
  jobsFinished: [{title, status}], jobsFailed: [...],
  trustChanges: [{type, state}],
  remindersToday: [...],                 // morning: due today; evening: due tomorrow
  sinceLastBrief: ISO
}
```

Window from kv `brief:last-ts` — no overlaps, no gaps.

**Narration** — `moderator.handle(primaryChannel, primaryChatId,
"[MORNING-BRIEF] <BriefData JSON> — narrate as my chief of staff: short, lead with
what needs me, plain text")`. Same mechanism as Phase 3's `[JOB-COMPLETE]` notices,
so the brief lives inside the normal chat session and follow-ups ("approve the
second one") have full context.

**Delivery + archive** — narration → primary chat; narration + raw data table →
vault `briefs/YYYY-MM-DD-<anchor>.md`; `brief.sent` event emitted.

**Empty-brief rule** — morning always sends at least a one-liner ("Quiet night.
Nothing needs you.") as heartbeat proof-of-life; an empty evening close is skipped.

## Reminders

Table: `{id, text, due_at ISO, origin_channel, origin_chat_id,
status pending|fired|cancelled, created_at}`.

- Fired ping goes to the reminder's **origin chat**, not primary — set it where you
  asked for it.
- Moderator tools: `add_reminder(due_at ISO, text)` (the LLM converts natural
  language to ISO itself; the tool stays dumb and echoes the resolved time back so
  misparses surface immediately), `list_reminders()`, `cancel_reminder(id)`.

## Config additions

```
AIOS_PRIMARY_CHAT=             # "telegram:12345" | "cli:local" — empty: briefs vault-only + boot warning
AIOS_ANCHOR_MORNING=07:30
AIOS_ANCHOR_EVENING=21:00
AIOS_TRIAGE_MODEL=             # default claude-haiku-4-5-20251001
```

## Events union additions

`reminder.due`, `brief.sent`, `triage.decision`.

## Store additions

`reminders` + `triage_rules` tables; methods `addReminder`, `listReminders`,
`cancelReminder`, `claimDueReminders(now)`, `addTriageRule`, `listTriageRules`;
kv reused for anchor stamps and `brief:last-ts`.

## Daemon wiring (`src/index.ts`)

Construct triage (bus subscriber) and clock (interval) after channels start; clock
receives callbacks `{onAnchor: runBrief, onReminderDue: emit}`. Heartbeat starts
after channel startup so pings always have a live channel map.

## Error handling — never kill, never spam

- Tick crash → caught + logged; next tick proceeds.
- Narration failure → raw BriefData still archived; plain-text fallback to primary
  chat; anchor stamp already written → no retry loop.
- Triage model failure → `batch`.
- Primary chat unset/down → vault-only + boot warning.
- Reminder claim atomic → at-most-once (a crash between claim and ping may lose one
  ping; the reminder shows `fired` in `list_reminders` — chosen over double-ping).

## Testing

- **Clock:** pure due-logic with injected time — DST, midnight, catch-up,
  double-anchor; no timers in tests.
- **Reminders:** claim idempotence, due boundaries.
- **Triage:** precedence (exact > glob > model), seeded defaults, stubbed model
  fallback (malformed JSON → batch), corrections win.
- **Briefs:** assembly from seeded in-memory store → exact BriefData; empty rules;
  stub moderator narration; delivery + vault write asserted.
- **E2E (scripted, no LLM):** fake clock advance → anchor fires → stub-narrated
  brief on fake channel + vault file; reminder add → due → ping → fired.

## Out of scope

- Dashboard Briefs tab (Phase 8 per parent spec).
- External watchers — mail, calendar, git, RSS (Phase 5).
- Preference memos / memory index (Phase 6).
- Batch queue table (events table already persists everything).

## Roadmap addendum

**Phase 4.5 — Voice** (new, user-requested): voice in/out on every surface —
Telegram voice messages transcribed and processed, cockpit (Mission Control) mic
input and spoken replies. Own brainstorm → spec → plan cycle immediately after
Phase 4 ships. Key open decision deferred to that brainstorm: engine choice
(local-first whisper.cpp + local TTS vs cloud STT/TTS vs hybrid).

## Known blockers

- Telegram bot token still missing — `AIOS_PRIMARY_CHAT` points at CLI/web until
  it lands; everything else unaffected.
