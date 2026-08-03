// ui2/src/views/Thread.tsx — a goal's nodes as a vertical thread (spec
// 2026-08-03 §2). Replaces the old SVG DAG: 88% of goals are a single node or
// a linear chain, so branch structure is cheaper as text than as geometry.
import { threadOrder, elapsed, showsDeps } from "../lib/thread.js";
import { statusClock, CLOCK_TOKEN, CLOCK_TEXT, isMuted } from "../lib/goal-clock.js";
import { usd } from "../lib/format.js";
import type { GoalNodeView } from "../api.js";

export function Thread({ nodes, failedKey, onSelect }: {
  nodes: GoalNodeView[];
  failedKey?: string;
  onSelect?: (key: string) => void;
}) {
  if (nodes.length === 0) return null;
  const ordered = threadOrder(nodes);
  // A lone node has nothing to thread — drop the spine rather than draw a rule
  // down the side of one row.
  const spine = ordered.length > 1;

  return (
    <div className="flex flex-col">
      {ordered.map((n, i) => {
        const clock = statusClock(n.status);
        const blocked = n.key === failedKey || clock === "blocked";
        const tone = blocked ? "blocked" : clock;
        return (
          <div
            key={n.key}
            data-testid="thread-row"
            data-key={n.key}
            onClick={onSelect ? () => onSelect(n.key) : undefined}
            className={`flex gap-3 py-2 ${spine ? "border-l border-line pl-3" : ""} ${
              onSelect ? "cursor-pointer hover:bg-raised" : ""
            } ${isMuted(n.status) ? "opacity-55" : ""}`}
          >
            <span
              data-testid="thread-dot"
              className={`size-1.5 rounded-full shrink-0 mt-[7px] ${CLOCK_TOKEN[tone]} ${
                clock === "now" ? "breath" : ""
              }`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-[13px] text-strong truncate">{n.key}</span>
                <span className={`font-mono text-[10px] uppercase ${CLOCK_TEXT[tone]}`}>{n.status}</span>
                <span className="text-[11px] text-dim">{n.agent}</span>
                <span className="font-mono text-[10.5px] text-dim ml-auto shrink-0">
                  {elapsed(n.startedAt, n.finishedAt)}
                </span>
                <span className="font-mono text-[10.5px] text-dim shrink-0">{usd(n.costCents)}</span>
              </div>
              {showsDeps(n, ordered[i - 1]) && (
                <div className="text-[10.5px] text-dim mt-0.5">after: {n.deps.join(", ")}</div>
              )}
              {n.artifact && <div className="text-[10.5px] text-info mt-0.5 truncate">{n.artifact}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
