// ui2/src/lib/clock.ts — the day as an axis (spec 2026-08-02 §6).
//
// Everything is LOCAL time. The axis is the user's day, and Home derives its NOW
// marker from local getters; mixing in UTC would put the marker in the wrong
// place for every user outside UTC.
import type { ScheduleView } from "../api.js";

export type MarkKind = "past" | "next" | "future";

export interface ClockMark {
  key: string;
  label: string;
  hhmm: string;
  /** Minutes from local midnight — the x position on the axis. */
  minutes: number;
  kind: MarkKind;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function localHhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function clockMarks(s: ScheduleView, now: Date): ClockMark[] {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const raw: Array<Omit<ClockMark, "kind"> & { fired: boolean }> = [];

  for (const a of s.anchors) {
    raw.push({
      key: `anchor:${a.name}`, label: a.name, hhmm: a.hhmm,
      minutes: toMinutes(a.hhmm), fired: a.firedToday,
    });
  }
  for (const r of s.routines) {
    if (!r.enabled || !r.nextFire) continue;
    // nextFire is display-local "YYYY-MM-DD HH:MM" — take the clock part only.
    const hhmm = r.nextFire.slice(11, 16);
    raw.push({ key: `routine:${r.id}`, label: r.name, hhmm, minutes: toMinutes(hhmm), fired: false });
  }
  for (const rem of s.reminders) {
    const hhmm = localHhmm(new Date(rem.dueAt));
    raw.push({ key: `reminder:${rem.id}`, label: rem.text, hhmm, minutes: toMinutes(hhmm), fired: false });
  }

  raw.sort((a, b) => a.minutes - b.minutes);

  // Exactly one "next": the earliest thing still ahead. Everything else ahead is
  // "future", so only one pin ever pulses.
  const nextKey = raw.find((m) => !m.fired && m.minutes > nowMin)?.key;
  return raw.map(({ fired, ...m }) => ({
    ...m,
    kind: fired || m.minutes <= nowMin ? "past" : m.key === nextKey ? "next" : "future",
  }));
}
