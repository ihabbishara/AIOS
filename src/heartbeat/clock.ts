// src/heartbeat/clock.ts
import type { Store, ReminderRow, RoutineRow } from "../store/db.js";
import { routineDue } from "./routines.js";

export interface AnchorConfig {
  name: "morning" | "evening" | "dream" | "speculate" | "standup";
  /** Local time "HH:MM". */
  hhmm: string;
}

export interface ClockDeps {
  store: Store;
  /** Checked in order — keep morning before evening for the double-catch-up case. */
  anchors: AnchorConfig[];
  onAnchor: (name: "morning" | "evening" | "dream" | "speculate" | "standup") => Promise<void>;
  onReminderDue: (reminder: ReminderRow) => void;
  /** Optional — routines fire only when wired (tests that don't care omit it). */
  onRoutineDue?: (routine: RoutineRow) => void;
  /** Invoked at the end of every tick — cheap periodic work (e.g. budget-paused goal resume). */
  onTick?: () => void;
  log?: (line: string) => void;
  /** Injectable clock for tests. */
  nowFn?: () => Date;
  /** Local "HH:MM" before which cross-midnight catch-ups hold (default 08:00). */
  catchupAfter?: string;
}

export function localParts(d: Date): { date: string; hhmm: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Local date one day before `date` ("YYYY-MM-DD"), month/year rollover included. */
export function yesterdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return localParts(new Date(y, m - 1, d - 1)).date;
}

/**
 * Returns the occurrence date this fire covers, or null when not due.
 * Occurrence is today once the anchor time has passed, else yesterday —
 * so an outage spanning midnight catches up exactly once. Yesterday
 * occurrences (catch-ups) are additionally held until `catchupAfter`
 * local time so brief anchors never ping in the small hours.
 */
export function anchorDue(
  now: { date: string; hhmm: string },
  anchorHHMM: string,
  lastFiredDate: string | undefined,
  catchupAfter = "08:00",
): string | null {
  const occurrence = now.hhmm >= anchorHHMM ? now.date : yesterdayOf(now.date);
  if ((lastFiredDate ?? "") >= occurrence) return null;
  if (occurrence < now.date && now.hhmm < catchupAfter) return null;
  return occurrence;
}

/**
 * The daemon's pulse: one cheap tick checks due anchors and due reminders.
 * Anchor stamps are written BEFORE the brief runs (fire-once even through
 * crashes); reminder claiming is atomic (at-most-once).
 */
export class Clock {
  private timer?: NodeJS.Timeout;

  constructor(private deps: ClockDeps) {}

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    try {
      const now = (this.deps.nowFn ?? (() => new Date()))();
      const parts = localParts(now);

      for (const anchor of this.deps.anchors) {
        const key = `anchor:${anchor.name}:last`;
        const hhmm = this.deps.store.kvGet(`anchor:${anchor.name}:hhmm`) ?? anchor.hhmm;
        const occurrence = anchorDue(parts, hhmm, this.deps.store.kvGet(key), this.deps.catchupAfter);
        if (!occurrence) continue;
        // Stamp the covered occurrence, not today — a morning catch-up of yesterday's
        // evening must not swallow tonight's fire. Stamp first: never retry a crashed brief.
        this.deps.store.kvSet(key, occurrence);
        try {
          await this.deps.onAnchor(anchor.name);
        } catch (err) {
          this.deps.log?.(`anchor ${anchor.name} failed: ${(err as Error).message}`);
        }
      }

      for (const reminder of this.deps.store.claimDueReminders(now.toISOString())) {
        try {
          this.deps.onReminderDue(reminder);
        } catch (err) {
          this.deps.log?.(`reminder ${reminder.id} dispatch failed: ${(err as Error).message}`);
        }
      }

      if (this.deps.onRoutineDue) {
        for (const routine of this.deps.store.listRoutines()) {
          if (!routineDue(now, routine)) continue;
          // CAS stamp BEFORE the fire — same fire-once-through-crashes property as anchors.
          if (!this.deps.store.stampRoutineFired(routine.id, routine.last_fired_at, parts.date, now.toISOString())) continue;
          try {
            this.deps.onRoutineDue(routine);
          } catch (err) {
            this.deps.log?.(`routine ${routine.id} dispatch failed: ${(err as Error).message}`);
          }
        }
      }

      this.deps.onTick?.();
    } catch (err) {
      this.deps.log?.(`heartbeat tick error: ${(err as Error).message}`);
    }
  }
}
