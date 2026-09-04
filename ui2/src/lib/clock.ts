// ui2/src/lib/clock.ts — the day as an axis (spec 2026-08-02 §6).
//
// Everything is LOCAL time. The axis is the user's day, and Home derives its NOW
// marker from local getters; mixing in UTC would put the marker in the wrong
// place for every user outside UTC.
import type { ScheduleView } from "../api.js";

export type MarkKind = "past" | "next" | "future";

export interface ClockMark {
  key: string;
  /** What the axis prints: short enough to be a NAME. See shortLabel. */
  label: string;
  /** The untruncated text, for the hover title — set only when it differs from `label`. */
  full?: string;
  hhmm: string;
  /** Minutes from local midnight — the x position on the axis. */
  minutes: number;
  kind: MarkKind;
}

/** Anchors and routines are named; a reminder is only a body of text, and the axis printed the
 *  whole thing. One reminder carrying a paragraph of deadlines rendered as a single nowrap line
 *  wider than the page, stacked in lanes across the bottom of Home and spilling off both edges
 *  (observed 2026-09-04). A mark on a timeline is a name, not a message — the message is one
 *  hover or one click into the Schedule away.
 *
 *  Cut at a sentence end when one lands inside the budget, because "Book the CADA session" reads
 *  as a name while a hard slice mid-clause does not. Otherwise fall back to the last word break,
 *  and only then to a blunt cut, so a long unbroken string still cannot escape the budget. */
const LABEL_MAX = 44;
const MIN_USEFUL = 12;

export function shortLabel(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= LABEL_MAX) return flat;
  // A clause that ENDS inside the budget is a better name than a slice through the middle of
  // one. A dash counts alongside sentence punctuation because people write reminders as
  // "<the thing> — <all the detail>", and the half before the dash is exactly the name.
  const stop = flat.slice(0, LABEL_MAX).search(/[.!?;](?=\s|$)|\s[—–]\s/);
  if (stop >= MIN_USEFUL) return flat.slice(0, stop).trim();
  const space = flat.lastIndexOf(" ", LABEL_MAX);
  const cut = space >= MIN_USEFUL ? space : LABEL_MAX;
  return `${flat.slice(0, cut).replace(/[\s,;:—–-]+$/, "")}…`;
}

/** A mark carries `full` only when the label had to be shortened — no tooltip that just
 *  repeats what is already on screen. */
function mark(key: string, text: string, hhmm: string, fired: boolean) {
  const label = shortLabel(text);
  const flat = text.replace(/\s+/g, " ").trim();
  return { key, label, ...(label === flat ? {} : { full: flat }), hhmm, minutes: toMinutes(hhmm), fired };
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

  // Every kind goes through `mark`, not just reminders: a routine name is user-typed too, and
  // the axis should never be at the mercy of how long someone made it.
  for (const a of s.anchors) {
    raw.push(mark(`anchor:${a.name}`, a.name, a.hhmm, a.firedToday));
  }
  for (const r of s.routines) {
    if (!r.enabled || !r.nextFire) continue;
    // nextFire is display-local "YYYY-MM-DD HH:MM" — take the clock part only.
    raw.push(mark(`routine:${r.id}`, r.name, r.nextFire.slice(11, 16), false));
  }
  for (const rem of s.reminders) {
    raw.push(mark(`reminder:${rem.id}`, rem.text, localHhmm(new Date(rem.dueAt)), false));
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
