// ui2/src/views/home/Field.tsx — the org as a body (spec 2026-08-02 §6).
// The tide changes scale and label opacity, never structure: every dot stays
// mounted in the same grid slot at every level, so it cannot move when work
// starts. Compression is the same picture drawn smaller, not a second layout.
import { DOT_TOKEN, type Cluster } from "../../lib/field.js";
import type { TideLevel } from "../../lib/tide.js";

const DOT_SIZE: Record<TideLevel, string> = {
  high: "size-2.5",
  mid: "size-2",
  low: "size-[5px]",
};

export function Field({ clusters, level, live }: {
  clusters: Cluster[];
  level: TideLevel;
  /** SSE connected. False freezes every animation — motion on stale data is a lie. */
  live: boolean;
}) {
  const compact = level === "low";
  // What the working agents are actually doing, in words. The dots say how many;
  // this says what — and it is the only thing on screen that fills the field with
  // information rather than padding.
  const busy = clusters.flatMap((c) =>
    c.dots.filter((d) => d.state === "now" && d.currentTask).map((d) => ({ name: d.name, task: d.currentTask! })),
  );
  return (
    // content-center, not content-start: the field owns most of the height at high
    // tide, and top-aligning a few clusters inside it reads as a broken layout
    // rather than as air.
    <div className="h-full flex flex-col justify-center gap-7 px-5 py-4">
    <div
      className={`flex flex-wrap content-center transition-all duration-[1400ms] ${
        compact ? "gap-x-4 gap-y-2" : "gap-x-10 gap-y-7"
      }`}
    >
      {clusters.map((c) => (
        <div key={c.department} className="flex flex-col">
          <div
            data-labels
            className={`label mb-2 transition-opacity duration-[1400ms] ${
              compact ? "opacity-0 h-0 mb-0 overflow-hidden" : "opacity-100"
            }`}
          >
            {c.department}
          </div>
          <div
            className="grid transition-all duration-[1400ms]"
            style={{
              gridTemplateColumns: "repeat(4, min-content)",
              columnGap: compact ? "6px" : "20px",
              rowGap: compact ? "6px" : "16px",
            }}
          >
            {c.dots.map((d) => (
              <div
                key={d.name}
                style={{ gridColumn: d.col + 1, gridRow: d.row + 1 }}
                className="text-center"
              >
                <div
                  data-dot={d.name}
                  title={d.currentTask ?? d.title}
                  className={`${DOT_SIZE[level]} rounded-full mx-auto transition-all duration-[1400ms] ${
                    DOT_TOKEN[d.state]
                  } ${live && d.state === "now" ? "breath" : ""}`}
                />
                <div
                  className={`text-[9px] mt-1.5 transition-opacity duration-[1400ms] ${
                    compact ? "opacity-0 h-0 overflow-hidden" : d.state === "rest" ? "text-dim" : "text-fg"
                  }`}
                >
                  {d.name}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>

    {/* Hidden at low tide because there is nothing running to describe. */}
    {!compact && busy.length > 0 && (
      <div className="flex flex-col gap-1.5 text-[13px] leading-relaxed">
        {busy.map((b) => (
          <div key={b.name} className="flex items-baseline gap-2">
            <span className={`size-1.5 rounded-full shrink-0 translate-y-[-1px] bg-now ${live ? "breath" : ""}`} />
            <span className="text-strong">{b.name}</span>
            <span className="text-fg">{b.task}</span>
          </div>
        ))}
      </div>
    )}
    </div>
  );
}
