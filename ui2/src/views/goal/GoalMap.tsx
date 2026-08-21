// ui2/src/views/goal/GoalMap.tsx — a goal's nodes at the fidelity the plan
// earns (spec 2026-08-03 §2). 63% of goals are one node and want no geometry at
// all; a chain wants a spine; only a real branch is worth an SVG. Drawing all
// three the same way is what made the old DAG view feel heavy on the 88% of
// goals that had nothing to branch.
import { buildGoalGraph, cardXY, edgePath, edgeToken, CARD } from "../../lib/goal-graph.js";
import { NodeCard } from "./NodeCard.js";
import type { GoalNodeView } from "../../api.js";

export function GoalMap({ nodes, failedKey, selectedKey, onSelect, live }: {
  nodes: GoalNodeView[];
  failedKey?: string;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  live?: boolean;
}) {
  if (nodes.length === 0) return null;
  const graph = buildGoalGraph(nodes);
  const card = (n: GoalNodeView, fixed?: boolean) => (
    <NodeCard
      node={n} blocked={n.key === failedKey} selected={n.key === selectedKey}
      onSelect={onSelect} live={live} fixed={fixed}
    />
  );

  if (graph.shape === "single") {
    return <div className="max-w-sm">{card(graph.ranks[0][0])}</div>;
  }

  if (graph.shape === "chain") {
    const line = graph.ranks.map((r) => r[0]);
    return (
      <div className="flex flex-col max-w-sm">
        {line.map((n, i) => (
          <div key={n.key} className="flex flex-col">
            {i > 0 && <Link child={n} gapDays={graph.gaps.find((g) => g.afterRank === i - 1)?.days} />}
            {card(n)}
          </div>
        ))}
      </div>
    );
  }

  const lanes = Math.max(...graph.ranks.map((r) => r.length));
  const width = lanes * CARD.w + (lanes - 1) * CARD.gapX;
  const height = graph.ranks.length * CARD.h + (graph.ranks.length - 1) * CARD.gapY;
  const xy = (key: string) => {
    const p = graph.pos.get(key)!;
    return cardXY(p, graph.ranks[p.rank].length, width);
  };
  const byKey = new Map(nodes.map((n) => [n.key, n]));

  return (
    <div className="overflow-x-auto">
      <div className="relative" style={{ width, height }}>
        {/* Under the cards, and inert: the geometry is the one thing here that
            is decoration, so it must never intercept a click meant for a card. */}
        <svg aria-hidden className="absolute inset-0 pointer-events-none" width={width} height={height}>
          {graph.edges.map((e) => {
            const from = xy(e.from);
            const to = xy(e.to);
            return (
              <path
                key={`${e.from}→${e.to}`}
                d={edgePath(
                  { x: from.x + CARD.w / 2, y: from.y + CARD.h },
                  { x: to.x + CARD.w / 2, y: to.y },
                )}
                stroke={edgeToken(byKey.get(e.to)!)}
                strokeWidth={1.25}
                fill="none"
              />
            );
          })}
        </svg>
        {graph.gaps.map((g) => (
          // A band between two ranks, not a badge on an edge: the whole plan
          // waited, and the row says so across the full width.
          <div
            key={g.afterRank}
            className="absolute left-0 right-0 text-center font-mono text-[10px] text-dim"
            style={{ top: (g.afterRank + 1) * (CARD.h + CARD.gapY) - CARD.gapY / 2 - 7 }}
          >
            {/* Sits on the page ground so the edges pass behind it rather than
                through the words. */}
            <span className="bg-bg px-2">{days(g.days)}</span>
          </div>
        ))}
        {nodes.map((n) => {
          const { x, y } = xy(n.key);
          return (
            <div key={n.key} className="absolute" style={{ left: x, top: y }}>
              {card(n, true)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The spine between two cards in a chain, coloured by the node it feeds. */
function Link({ child, gapDays }: { child: GoalNodeView; gapDays?: number }) {
  return (
    <div className="flex flex-col items-center">
      {gapDays !== undefined && (
        <div className="font-mono text-[10px] text-dim py-1">{days(gapDays)}</div>
      )}
      <span data-testid="map-link" className="w-px h-7" style={{ background: edgeToken(child) }} />
    </div>
  );
}

const days = (n: number): string => `${n} ${n === 1 ? "day" : "days"} later`;
