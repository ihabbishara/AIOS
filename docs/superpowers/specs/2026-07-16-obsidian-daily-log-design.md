# Obsidian Daily-Log Repair — Design Spec

Date: 2026-07-16
Cycle: ④ in the platform-evolution series (after Scheduling, Skills, Persona explorer)

## Diagnosis (evidence, 2026-07-16)

- `daily/` in the vault (`~/Desktop/AI-Vault/AIOS/`) is dead since 2026-07-02 21:30.
- Root cause: commit 964e27a (2026-07-03 00:07) — GoalEngine replaced JobManager/
  PlaybookExecutor. JobManager was the only writer of daily "job started/done" lines
  (and of `jobs/` artifacts). The GoalEngine writes `goals/<date>-<slug>/` artifacts but
  has no daily-note integration.
- `VaultWriter.appendDaily` survives with exactly one caller: the finance expense
  executor (`src/kernel/executors.ts:109`).
- `briefs/`, `memos/`, `goals/` are all healthy (written today).
- `jobs/` staleness is intended retirement — `goals/` is its successor. No repair.

## Scope (locked)

- Daily notes log **goal lifecycle + expenses**: goal started / terminal lines with
  `[[goals/…]]` wiki-links; existing expense lines keep working unchanged. Briefs,
  memos, routines, mail: excluded (they have their own files / would add noise).
- **Backfill once**: the 2026-07-03 → deploy-day gap is reconstructed from the goals
  table at deploy time.
- Approach: **bus subscriber** (not engine inline calls, not evening rollup) — the
  engine stays untouched; one decoupled, tested unit owns the daily-note format.

## Architecture

### New file: `src/vault/daily-log.ts`

**`makeDailyLogger(deps: { vault: VaultWriter; store: Store; log?: (m: string) => void }): (e: BusEvent) => void`**

Returned handler:

- `goal.created` → append `goal started: <link>`.
- `goal.status` with terminal status (`done` | `failed` | `abandoned`) → append
  `goal <status>: <link>`; for `failed`, append ` — <error>` truncated to 80 chars when
  the event carries one.
- Every other event type: no-op. **No new bus event types** (unknown types hit the LLM
  triage classifier — routine.due precedent).

Link building: `store.getGoal(goalId)` → if `goal_dir` is stamped,
`[[goals/<goal_dir>/goal|<title>]]`; if not yet stamped (created fires before start),
plain `<title>` with no link. Unknown goalId (store race): fall back to the goalId's
first 8 chars as the title — a line is still written, nothing silently dropped.

Error handling: the entire handler body is wrapped; a thrown FS/store error is logged
as `daily-log: <message>` and swallowed. A daily-note miss must never break goal
processing or the bus.

Timestamps and filenames keep `appendDaily`'s existing UTC convention (`toISOString`
slices). The UTC-vs-local quirk predates this cycle and is explicitly not touched.

**`buildBackfillDays(goals: GoalRow[], existingDates: Set<string>): Map<string, string[]>`**

Pure function used by the backfill script: takes goal rows and the set of dates that
already have a `daily/<date>.md`, returns date → ordered lines. Per goal it derives:

- a started line at `created_at` (UTC date + HH:MM),
- a terminal line at `updated_at` when `status` is `done`/`failed`/`abandoned`.

Dates already present in `existingDates` are omitted entirely (never append to an
existing file — idempotent, re-run safe). Lines within a day sort by timestamp.

### Wiring (`src/index.ts`)

Subscribe the logger at daemon boot next to the routine.due subscriber, using the same
bus-subscription mechanism. The expense path in `kernel/executors.ts` is unchanged —
same `appendDaily`, same file, lines interleave naturally.

### Backfill script: `scripts/backfill-daily.ts`

Thin runner (executed once at deploy via `npx tsx scripts/backfill-daily.ts`):

1. Open the real store (same Store class, real DB path `data/aios.sqlite`; reads only).
2. Load goals with `created_at >= 2026-07-03`.
3. Scan `daily/` for existing `<date>.md` files → `existingDates`.
4. `buildBackfillDays(...)` → for each returned date, write
   `# <date>\n\n` + lines via the vault (file creation only, never append to existing).
5. Print a summary (`<n> files written, <m> dates skipped`).

Safe to re-run: every date it wrote on the first run exists on the second, so the
second run writes nothing.

## Testing

`test/daily-log.test.ts` (builders carry tests; wiring stays thin):

- goal.created with stamped goal_dir → started line with wiki-link
- goal.created before goal_dir stamped → plain-title line, no link
- done / failed / abandoned → terminal lines; failed with error → truncated suffix
- non-goal events → no write
- unknown goalId → id-prefix fallback line
- handler swallows a thrown write error and logs it
- buildBackfillDays: groups by UTC date, skips existing dates, orders lines by time,
  emits started + terminal lines for a done goal, started-only for a running goal

VaultWriter is exercised for real against a `mkdtemp` directory (it is cheap — no fake
needed).

## Verification (post-deploy)

1. Root suite + tsc clean; daemon rebuilt + kickstarted (+5s).
2. Run backfill once → expect files for the gap days that had goal activity
   (goals exist on at least Jul 13, 14, 15, 16); re-run → "0 files written".
3. Fire a real goal (echo smoke via chat or run-now routine) → today's
   `daily/<date>.md` gains `goal started:` and `goal done:` lines whose wiki-links
   resolve in Obsidian.
4. Expense line path untouched — no regression check needed beyond suite.
