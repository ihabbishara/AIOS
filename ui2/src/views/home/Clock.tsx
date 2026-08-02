// ui2/src/views/home/Clock.tsx — the day as an axis (spec 2026-08-02 §6).
// Only the single nearest upcoming mark pulses; a second pulsing pin would be
// mood rather than information.
import type { ClockMark } from "../../lib/clock.js";

const PIN: Record<ClockMark["kind"], string> = {
  past: "bg-past",
  next: "bg-next",
  future: "bg-rest",
};

const pct = (minutes: number) => `${(minutes / 1440) * 100}%`;

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
  return (
    <div className="relative h-full px-5">
      <div className="absolute left-5 right-5 top-8 h-px bg-line" />
      <div className="absolute top-4 w-px h-6 bg-next" style={{ left: pct(nowMinutes) }} />
      {marks.map((m) => (
        <div
          key={m.key}
          data-mark={m.key}
          className="absolute top-5 -translate-x-1/2 text-center"
          style={{ left: pct(m.minutes) }}
        >
          <span
            className={`block size-1.5 rounded-full mx-auto mb-1.5 ${PIN[m.kind]} ${
              live && m.kind === "next" ? "approach" : ""
            }`}
          />
          <div className="font-mono text-[8.5px] text-dim">{m.hhmm}</div>
          <div className={`text-[9px] mt-0.5 whitespace-nowrap ${m.kind === "next" ? "text-strong" : "text-dim"}`}>
            {m.label}
          </div>
        </div>
      ))}
    </div>
  );
}
