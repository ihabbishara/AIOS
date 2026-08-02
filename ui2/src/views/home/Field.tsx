// ui2/src/views/home/Field.tsx — the org as a body (spec 2026-08-02 §6).
// The tide changes scale and label opacity, never structure: every dot stays
// mounted in the same grid slot at every level, so it cannot move when work
// starts. Compression is the same picture drawn smaller, not a second layout.
import { DOT_TOKEN, type Cluster } from "../../lib/field.js";
import type { TideLevel } from "../../lib/tide.js";

const DOT_SIZE: Record<TideLevel, string> = {
  high: "size-2",
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
  return (
    <div
      className={`flex flex-wrap content-start px-5 py-4 transition-all duration-[1400ms] ${
        compact ? "gap-x-4 gap-y-2" : "gap-x-8 gap-y-6"
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
  );
}
