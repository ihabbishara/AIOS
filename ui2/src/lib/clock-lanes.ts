// ui2/src/lib/clock-lanes.ts — label collision handling for the day axis. Two marks fifteen
// minutes apart used to print their labels on top of each other (observed live: "07:15 standup"
// and "07:30 briefing" rendered as one garble). Labels get LANES instead: a greedy sweep in time
// order drops each label into the first lane whose previous label has ended; close neighbours
// step down a rung and hang from a longer stem, train-map style. Pure so the exact collision
// that shipped is pinned in a unit test.
import type { ClockMark } from "./clock.js";

export interface LanedMark extends ClockMark {
  lane: number;
}

/** Approximate a one-line label's footprint on the axis, in minutes. The axis maps 1440
 *  minutes to the container width; at typical cockpit widths (~1100-1500px) a character is
 *  ~6.5px ≈ 7 minutes. Over-estimating just moves a label down a lane — harmless; the failure
 *  mode of under-estimating is the garble this module exists to prevent. */
const MIN_PER_CHAR = 7;
const MIN_EXTENT = 70;

export function clockLanes(marks: ClockMark[]): LanedMark[] {
  const sorted = [...marks].sort((a, b) => a.minutes - b.minutes || a.key.localeCompare(b.key));
  const laneEnds: number[] = []; // rightmost occupied minute per lane
  return sorted.map((m) => {
    const text = `${m.hhmm} ${m.label}`;
    const extent = Math.max(MIN_EXTENT, text.length * MIN_PER_CHAR);
    const start = m.minutes - extent / 2;
    let lane = laneEnds.findIndex((end) => start >= end);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = m.minutes + extent / 2;
    return { ...m, lane };
  });
}
