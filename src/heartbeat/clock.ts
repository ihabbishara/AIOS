// src/heartbeat/clock.ts
import type { Store, ReminderRow } from "../store/db.js";

export interface AnchorConfig {
  name: "morning" | "evening" | "dream";
  /** Local time "HH:MM". */
  hhmm: string;
}

export interface ClockDeps {
  store: Store;
  /** Checked in order — keep morning before evening for the double-catch-up case. */
  anchors: AnchorConfig[];
  onAnchor: (name: "morning" | "evening" | "dream") => Promise<void>;
  onReminderDue: (reminder: ReminderRow) => void;
  log?: (line: string) => void;
  /** Injectable clock for tests. */
  nowFn?: () => Date;
}

export function localParts(d: Date): { date: string; hhmm: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Due when the local clock has passed the anchor time and it hasn't fired today. */
export function anchorDue(
  now: { date: string; hhmm: string },
  anchorHHMM: string,
  lastFiredDate: string | undefined,
): boolean {
  return now.hhmm >= anchorHHMM && lastFiredDate !== now.date;
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
        if (!anchorDue(parts, anchor.hhmm, this.deps.store.kvGet(key))) continue;
        this.deps.store.kvSet(key, parts.date); // stamp first — never retry a crashed brief
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
    } catch (err) {
      this.deps.log?.(`heartbeat tick error: ${(err as Error).message}`);
    }
  }
}
