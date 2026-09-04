// ui2/src/views/home/Clock.tsx — the day as an axis (spec 2026-08-02 §6).
// The resting screen's signature: what happened today, what comes next, where in the
// day we are. Labels hang from the axis in collision-free lanes (lib/clock-lanes) —
// close anchors step down a rung on a longer stem instead of printing over each other.
// Only the single nearest upcoming mark pulses; a second pulsing pin would be mood
// rather than information.
import type { ClockMark } from "../../lib/clock.js";
import { clockLanes } from "../../lib/clock-lanes.js";

const PIN: Record<ClockMark["kind"], string> = {
  past: "bg-past",
  next: "bg-next",
  future: "bg-rest",
};

const pct = (minutes: number) => `${(minutes / 1440) * 100}%`;

/** A label centred on its pin hangs half its width to each side, so one near midnight or
 *  midnight-again runs off the page. Inside the first/last tenth of the day it anchors to that
 *  edge instead. Belt to shortLabel's braces: the model bounds the TEXT, this bounds the BOX. */
function anchorX(minutes: number): { transform: string; textAlign: "left" | "center" | "right" } {
  const p = minutes / 1440;
  if (p < 0.1) return { transform: "translateX(0)", textAlign: "left" };
  if (p > 0.9) return { transform: "translateX(-100%)", textAlign: "right" };
  return { transform: "translateX(-50%)", textAlign: "center" };
}
const AXIS_TOP = 34;      // px from the band's top to the axis line
const LANE_H = 20;        // px per label lane below the axis
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function Clock({ marks, nowMinutes, live }: {
  marks: ClockMark[];
  /** Minutes from local midnight. Home re-renders this on a 30s tick, not per second. */
  nowMinutes: number;
  live: boolean;
}) {
  if (marks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full px-5">
        <span className="label">Nothing scheduled today</span>
      </div>
    );
  }
  const laned = clockLanes(marks);
  const laneCount = Math.max(...laned.map((m) => m.lane)) + 1;
  const height = AXIS_TOP + 14 + laneCount * LANE_H;
  return (
    // Centred in the band so the clock reads as a line through the middle of the
    // resting screen rather than a strip stranded at the top of a tall empty box.
    <div className="h-full flex items-center px-6">
      <div className="relative w-full" style={{ height }}>
        {/* The axis carries the day's progress structurally: elapsed solid, remaining faint. */}
        <div className="absolute left-0 h-px bg-line" style={{ top: AXIS_TOP, width: pct(nowMinutes) }} />
        <div className="absolute right-0 h-px bg-line opacity-40" style={{ top: AXIS_TOP, left: pct(nowMinutes) }} />
        {/* NOW: the only live element at rest — a tick that says what time it is. */}
        <div className="absolute w-px bg-next" style={{ left: pct(nowMinutes), top: AXIS_TOP - 14, height: 20 }} />
        <div
          className="absolute -translate-x-1/2 font-mono text-[10px] text-next whitespace-nowrap"
          style={{ left: pct(nowMinutes), top: AXIS_TOP - 30 }}
        >
          now {hhmm(nowMinutes)}
        </div>
        {laned.map((m) => (
          <div key={m.key} data-mark={m.key} data-lane={m.lane}>
            <span
              className={`absolute size-2 rounded-full -translate-x-1/2 -translate-y-1/2 ${PIN[m.kind]} ${
                live && m.kind === "next" ? "approach" : ""
              }`}
              style={{ left: pct(m.minutes), top: AXIS_TOP }}
            />
            {/* Stem from the axis down to the label's rung — lane 0 sits close, deeper
                lanes hang lower so the eye can trace which time a label belongs to. */}
            <span
              className="absolute w-px bg-line"
              style={{ left: pct(m.minutes), top: AXIS_TOP + 5, height: 6 + m.lane * LANE_H }}
            />
            <div
              className="absolute whitespace-nowrap max-w-[52ch] overflow-hidden text-ellipsis"
              title={m.full ?? undefined}
              style={{
                left: pct(m.minutes),
                top: AXIS_TOP + 13 + m.lane * LANE_H,
                ...anchorX(m.minutes),
              }}
            >
              <span className="font-mono text-[10px] text-dim">{m.hhmm}</span>{" "}
              <span className={`text-[11.5px] ${m.kind === "next" ? "text-strong" : m.kind === "past" ? "text-dim" : "text-fg"}`}>
                {m.label}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
