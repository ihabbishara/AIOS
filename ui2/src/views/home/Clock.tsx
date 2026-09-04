// ui2/src/views/home/Clock.tsx — the day, in two parts that each do one job.
//
// It used to do both jobs with one drawing: labels hung off the axis at their own time, stepping
// down a lane whenever they collided. That cannot work, and the geometry says why. Measured live
// on 2026-09-04 at an axis width of 1322px: nine marks, of which SEVEN sat between x=378 and
// x=681 — 1094px of label competing for a 303px window, a 3.6× overflow — while 461px of
// afternoon sat empty. The lane sweep did its job and produced six rows of text in a staircase,
// which is what "still stacked" looks like. Shortening the labels helped and could not fix it:
// the day's activity occupies about a tenth of the axis, so a linear axis spends nine tenths of
// its width on emptiness and crams everything into the rest.
//
// So the axis stops carrying names. It keeps what only a proportional axis can say — WHEN things
// are, how the day is shaped, where now falls — as pins on a line, each naming itself on hover.
// The names move to an agenda beneath it: one time-ordered row of chips that wraps like text.
// Wrapping is the whole point. It is bounded by the container's width rather than by how many
// things happen to collide, so ten marks in one hour cost two rows instead of ten lanes.
import type { ClockMark } from "../../lib/clock.js";
import { href } from "../../lib/router.js";

const PIN: Record<ClockMark["kind"], string> = {
  past: "bg-past",
  next: "bg-next",
  future: "bg-rest",
};

const TEXT: Record<ClockMark["kind"], string> = {
  past: "text-dim",
  next: "text-strong",
  future: "text-fg",
};

const pct = (minutes: number) => `${(minutes / 1440) * 100}%`;
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

const AXIS_TOP = 30;   // px from the block's top to the line — room for the now label above it
const AXIS_H = 44;

/** Enough that a normal day fits whole, few enough that a runaway reminder list cannot push the
 *  agenda past a couple of rows. The pins keep showing everything either way, so the shape of
 *  the day is never the thing being truncated. */
const MAX_CHIPS = 12;

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
  const ordered = [...marks].sort((a, b) => a.minutes - b.minutes || a.key.localeCompare(b.key));
  const shown = ordered.slice(0, MAX_CHIPS);
  const hidden = ordered.length - shown.length;
  // The divider goes before the first chip still ahead of now, so the row reads
  // done-things · now · coming-things without needing colour to say it.
  const firstAhead = shown.findIndex((m) => m.minutes > nowMinutes);

  return (
    <div className="h-full flex flex-col justify-center gap-4 px-6 overflow-hidden">
      <div className="relative w-full shrink-0" style={{ height: AXIS_H }}>
        {/* The axis carries the day's progress structurally: elapsed solid, remaining faint. */}
        <div className="absolute left-0 h-px bg-line" style={{ top: AXIS_TOP, width: pct(nowMinutes) }} />
        <div className="absolute right-0 h-px bg-line opacity-40" style={{ top: AXIS_TOP, left: pct(nowMinutes) }} />
        {/* NOW: the only live element at rest — a tick that says what time it is. */}
        <div className="absolute w-px bg-next" style={{ left: pct(nowMinutes), top: AXIS_TOP - 8, height: 16 }} />
        <div
          className="absolute -translate-x-1/2 font-mono text-[10px] text-next whitespace-nowrap"
          style={{ left: pct(nowMinutes), top: AXIS_TOP - 24 }}
        >
          now {hhmm(nowMinutes)}
        </div>
        {ordered.map((m) => (
          <span
            key={m.key}
            data-mark={m.key}
            title={`${m.hhmm} ${m.full ?? m.label}`}
            className={`absolute size-2 rounded-full -translate-x-1/2 -translate-y-1/2 ${PIN[m.kind]} ${
              live && m.kind === "next" ? "approach" : ""
            }`}
            style={{ left: pct(m.minutes), top: AXIS_TOP }}
          />
        ))}
      </div>

      <div data-agenda className="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-w-0">
        {shown.map((m, i) => (
          <span key={m.key} className="contents">
            {i === firstAhead && (
              <span data-now-divider className="font-mono text-[10px] text-next whitespace-nowrap">
                now ·
              </span>
            )}
            <span
              data-chip={m.key}
              title={m.full ?? undefined}
              className="inline-flex items-baseline gap-1.5 max-w-[34ch] min-w-0 whitespace-nowrap"
            >
              <span className="font-mono text-[10px] text-dim shrink-0">{m.hhmm}</span>
              <span className={`text-[11.5px] truncate ${TEXT[m.kind]}`}>{m.label}</span>
            </span>
          </span>
        ))}
        {hidden > 0 && (
          <a href={href("schedule")} className="text-[11px] text-dim hover:text-fg whitespace-nowrap">
            +{hidden} more
          </a>
        )}
      </div>
    </div>
  );
}
