# Cross-midnight anchor catch-up

**Date:** 2026-07-20
**Status:** Approved
**Cycle:** ⑥

## Problem

`anchorDue` (src/heartbeat/clock.ts) fires an anchor when `now.hhmm >= anchorHHMM && lastFiredDate !== now.date`. Same-day recovery works (the condition stays true until midnight), but an outage that spans midnight silently skips the anchor: on restart the new date makes `lastFiredDate !== now.date` true, yet `now.hhmm < anchorHHMM` until the next scheduled time.

Exposure by anchor: evening (21:00) needs only a 3-hour outage window (21:00→00:00) to be skipped; morning (07:30) / standup (07:15) need overnight outages; dream (02:00) / speculate (03:00) sit just past midnight so nearly the whole day remains for same-day recovery.

What a missed evening actually costs: **not brief content** — `runBrief` windows by `brief:last-ts`, so the next brief covers the whole gap ("window always advances — no overlaps, no gaps"). The real losses are the evening-only side effects (`reindexVault` + `distill` delayed 24h) and the daily dream/speculate jobs for that day.

## Design

### Occurrence-based `anchorDue`

`anchorDue(now, anchorHHMM, lastFiredDate, catchupAfter)` returns the **occurrence date** the fire covers, or `null`:

- `occurrence = now.hhmm >= anchorHHMM ? now.date : yesterday(now.date)`
- due when `(lastFiredDate ?? "") < occurrence` (ISO date string compare)
- **catch-up gate:** when `occurrence < now.date` (covering yesterday), additionally require `now.hhmm >= catchupAfter`

`Clock.tick` stamps `anchor:<name>:last` with the **returned occurrence**, not today's date. This is the load-bearing change: a catch-up fired this morning stamps yesterday, so tonight's normal occurrence still fires. Stamping today would swallow it.

`yesterday(date)` is a small local-date helper (parse y/m/d, subtract one day via Date arithmetic, re-format).

### Config

- `catchupAfter: process.env.AIOS_CATCHUP_AFTER ?? "08:00"` in src/config.ts, wired through ClockDeps.
- 08:00 (after morning 07:30) deliberately avoids the double-morning-brief edge: by the time catch-up unlocks, today's morning anchor has fired and advanced the brief window, so the evening catch-up brief assembles empty → `isEmptyBrief` suppresses the message, while index.ts still runs `reindexVault` + `distill` for evening.

### Behavior walkthrough (down 20:55 → restart 03:00)

1. 03:00 restart: dream (02:00) and speculate (03:00) occurrences = today → fire immediately; both are silent system jobs designed for those hours.
2. Standup/morning occurrences = yesterday → gated; their today-occurrences fire normally at 07:15/07:30. The morning brief covers the entire gap window.
3. 08:00: evening catch-up fires (occurrence = yesterday). Brief is empty → no ping. Distill + vault reindex run.
4. Stamp evening = yesterday → tonight 21:00 fires normally.

Multi-day outage: occurrence never looks back more than one day → exactly one catch-up per anchor, no stacking.

### Existing structure relied on

- Anchor ordering in index.ts (dream, speculate, standup, morning, evening) — the clock.ts:13 comment's "double-catch-up case" ordering makes the morning brief absorb content before the evening catch-up runs.
- `brief:last-ts` windowing — makes brief content self-healing; this design only restores side effects and timing.
- Per-anchor kv overrides (`anchor:<name>:hhmm`) keep working; `catchupAfter` has no kv override.

## Tests

- `anchorDue` unit table: not-yet-due, same-day due, already-fired-today, cross-midnight occurrence = yesterday, gate blocks before `catchupAfter` / allows after, returned occurrence value, multi-day outage yields single catch-up, `lastFiredDate` undefined.
- `Clock.tick` integration: cross-midnight scenario — evening missed, catch-up fires once with stamp = yesterday, normal 21:00 occurrence fires the same day.
- `anchorDue` signature changes boolean → `string | null`; audit callers (clock.ts internal; check schedule-view.ts and tests) during planning.

## Not doing (YAGNI)

- Per-anchor catch-up opt-out
- N-day catch-up stacking
- "Catch-up" labeling in brief narration (empty-brief suppression makes it moot)
- kv override for `catchupAfter`
