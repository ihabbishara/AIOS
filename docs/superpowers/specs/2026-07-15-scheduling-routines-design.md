# Scheduling & Routines — Design Spec

**Date:** 2026-07-15
**Status:** Approved (brainstorm), pending implementation plan
**Context:** First of a platform-evolution series (next candidates, each its own cycle:
skills manager, persona explorer, Obsidian daily/jobs write-path repair, media/research
modalities).

## Summary

Scheduling in AIOS is real but invisible: the `Clock` in `src/heartbeat/clock.ts`
drives five fixed anchors (morning/evening/dream/speculate/standup) and one-shot
reminders, with crash-safe fire-once stamping — and none of it has a UI. This design
adds a **`routines`** primitive (recurring schedule + prompt payload) and a dedicated
**Schedule** view in ui2 that surfaces all three scheduling surfaces: anchors
(editable times), routines (full CRUD), and reminders (list/cancel).

A routine's body is a **prompt**, not a typed target. When due, it fires a
`routine.due` bus event and the prompt enters the kernel through the same path as an
incoming chat message — so "every Monday 09:00: run the research playbook on X"
needs zero new execution machinery. Existing routing, playbooks, and trust gates
apply unchanged.

## Goals / Non-goals

**Goals**
- New `routines` table + due-checking on the existing 30s Clock tick.
- Prompt-payload firing through the existing bus → kernel message path.
- Structured recurrence presets: `daily` / `weekdays` / `weekly` / `interval`. No cron.
- Unified Schedule view in ui2: anchors, routines, reminders — visible and editable.
- Anchor times editable from the UI (persisted in store; env value stays the default).
- Run-now button per routine (manual fire of the same bus event — doubles as a test path).

**Non-goals (v1)**
- No typed routine targets (playbook/goal/agent bindings with params). Prompt covers it;
  schema leaves room if ever needed.
- No cron expressions, no cron parser.
- No timezone handling beyond the daemon's local clock (matches anchors today).
- No routine run-history table (bus events + existing logs suffice; revisit if audit
  demand appears).
- No changes to reminder semantics — reminders stay one-shot, table untouched.

## Architecture

### 1. Data model — `routines`

`CREATE TABLE IF NOT EXISTS` in `src/store/db.ts` (greenfield, no migration — same
pattern as `research_sources`):

| column | type | notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | |
| `name` | TEXT NOT NULL | display name |
| `prompt` | TEXT NOT NULL | injected into kernel on fire |
| `recurrence` | TEXT NOT NULL | JSON struct, see below |
| `enabled` | INTEGER NOT NULL DEFAULT 1 | |
| `last_fired_at` | TEXT | ISO timestamp, for `interval` due-test |
| `last_fired_date` | TEXT | local date stamp, for time-of-day kinds (mirrors anchor stamping) |
| `origin_channel` | TEXT | where fire output should land (same convention as reminders) |
| `origin_chat_id` | TEXT | |
| `created_at` | TEXT NOT NULL | |

Recurrence struct (validated on write, invalid JSON rejected at the API boundary):

```ts
type Recurrence =
  | { kind: "daily"; hhmm: string }                  // every day at HH:MM
  | { kind: "weekdays"; hhmm: string }               // Mon–Fri at HH:MM
  | { kind: "weekly"; dow: number; hhmm: string }    // 0=Sun … 6=Sat
  | { kind: "interval"; everyMinutes: number };      // since last_fired_at
```

Store methods mirror the reminders block in `db.ts`: `addRoutine`, `listRoutines`,
`updateRoutine`, `deleteRoutine`, plus an atomic `claimDueRoutines(now)` that stamps
`last_fired_at`/`last_fired_date` **before** returning claimed rows (at-most-once,
same guarantee as `claimDueReminders`).

Anchor time overrides: a small `anchor_overrides` key-value entry (name → HH:MM) in
the existing settings/kv storage; `index.ts` reads overrides over env defaults when
building `AnchorConfig[]`. If no kv facility exists, a two-column table with
`INSERT OR REPLACE` — nothing fancier.

### 2. Engine — Clock extension

`ClockDeps` gains `onRoutineDue: (routine: RoutineRow) => void`. `tick()` adds one
step after reminders: `claimDueRoutines(now)` → fire each.

Due-test per kind (pure function, exported for tests, style of `anchorDue`):
- `daily`: `now.hhmm >= hhmm && last_fired_date !== now.date`
- `weekdays`: same, plus `dow(now) ∈ 1..5`
- `weekly`: same, plus `dow(now) === dow`
- `interval`: `last_fired_at == null || now - last_fired_at >= everyMinutes`

Disabled routines never claim. Stamping before firing preserves the fire-once-through-
crashes property anchors already have.

`index.ts` wires `onRoutineDue` to emit `routine.due { id, name, prompt, channel,
chatId }` on the bus. The subscriber builds a synthetic `InboundMessage`
(`channel`/`chatId` from the routine's origin, `text` = prompt) and feeds it to the
existing `onMessage` handler (`src/index.ts:388`) — the exact entry point channel
messages use, so routing, playbooks, trust gates, reply delivery, and error handling
apply unchanged. Note: `reminder.due` handling is notification-only (`sendVia`);
routines deliberately take the deeper message path instead.

### 3. API — `src/web/server.ts`

- `GET /api/schedule` — unified snapshot: anchors (name, effective HH:MM, fired-today,
  next-fire), routines (all columns + computed next-fire), pending reminders.
- `POST /api/routines` — create; validates recurrence struct, rejects unknown kinds.
- `PATCH /api/routines/:id` — partial update (name/prompt/recurrence/enabled).
- `DELETE /api/routines/:id`.
- `POST /api/routines/:id/run` — manual fire (same bus event; stamps neither
  `last_fired_date` nor `last_fired_at`, so the scheduled cadence is unaffected).
- `PATCH /api/anchors/:name` — set HH:MM override; rejects unknown anchor names and
  malformed times.

### 4. UI — `ui2/src/views/Schedule.tsx`

New view registered in ui2 nav (alongside Home/Goals/Mail/Queue/Staff/System).
Three groups, one screen:

- **Anchors** — name, time (inline-editable, PATCH on commit), fired-today marker,
  next fire.
- **Routines** — list with enable toggle, edit, delete (TwoStepButton, matching
  existing destructive-action convention), run-now. Create form: name, prompt
  (textarea), recurrence preset picker (kind dropdown + conditional HH:MM / day /
  minutes inputs).
- **Reminders** — pending list (text, due time, origin), cancel.

Data via `GET /api/schedule` on mount + refetch after mutations — same fetch
conventions as existing views in `ui2/src/api.ts`.

## Error handling

- API validates recurrence and time strings at the boundary; store trusts validated
  input.
- A routine whose prompt fails downstream (kernel error) does not retry — same
  fire-and-forget posture as reminders; failure is visible in daemon logs and the
  event stream.
- Clock tick wraps routine firing in the existing try/catch so one bad routine can't
  kill the pulse.

## Testing

- **Due logic** — unit tests per recurrence kind with injectable `nowFn`, including:
  weekly on wrong day, interval first-fire (null `last_fired_at`), fired-today
  suppression, disabled routine, catch-up after daemon downtime (fires once, not N
  times).
- **Claiming** — `claimDueRoutines` stamps atomically; double-tick fires once.
- **Wiring** — routine fires → `routine.due` on bus → prompt reaches kernel stub
  (integration, same harness as reminder tests).
- **API** — create/validate/reject malformed recurrence; anchor PATCH validation.
- **UI** — one render test per group + create-form submit, matching ui2 test
  conventions in `ui2/test/`.
