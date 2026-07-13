// ui2/src/views/MiniDag.tsx — read-only DAG snapshot; Goals detail reuses it at scale 1.
import { useMemo } from "react";
import type { GoalNodeView } from "../api.js";
import { layoutDag, BOX_W, BOX_H } from "./dag-layout.js";
import { toneOfStatus } from "../components/ui.js";

const STROKE: Record<string, string> = {
  ok: "var(--color-ok)", err: "var(--color-err)", accent: "var(--color-accent)",
  agent: "var(--color-agent)", dim: "var(--color-line)",
};

export function MiniDag({ nodes, failedKey, scale = 0.6, onSelect }: {
  nodes: GoalNodeView[]; failedKey?: string; scale?: number; onSelect?: (key: string) => void;
}) {
  const layout = useMemo(() => layoutDag(nodes.map((n) => ({ key: n.key, deps: n.deps }))), [nodes]);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  return (
    <div className="overflow-x-auto">
      <svg width={layout.width * scale} height={layout.height * scale} viewBox={`0 0 ${layout.width} ${layout.height}`}>
        {layout.edges.map((e) => (
          <path key={`${e.from}-${e.to}`} d={e.path} fill="none"
            stroke={e.to === failedKey ? "var(--color-err)" : "var(--color-line)"} strokeWidth={1.5} />
        ))}
        {layout.boxes.map((b) => {
          const n = byKey.get(b.key)!;
          const tone = b.key === failedKey ? "err" : toneOfStatus(n.status);
          return (
            <g key={b.key} onClick={() => onSelect?.(b.key)} style={onSelect ? { cursor: "pointer" } : undefined}>
              <rect x={b.x} y={b.y} width={BOX_W} height={BOX_H} rx={8}
                fill="var(--color-raised)" stroke={STROKE[tone]} strokeWidth={b.key === failedKey ? 2 : 1} />
              <text x={b.x + 10} y={b.y + 24} fill="var(--color-strong)" fontSize={13}>{b.key}</text>
              <text x={b.x + 10} y={b.y + 44} fill="var(--color-dim)" fontSize={11}>
                {n.agent} · {n.status}{n.costCents ? ` · $${(n.costCents / 100).toFixed(2)}` : ""}
              </text>
              {n.status === "running" && (
                <rect x={b.x} y={b.y + BOX_H - 2} width={BOX_W} height={2} fill="var(--color-ok)" opacity={0.5}>
                  <animate attributeName="opacity" values="0.2;0.7;0.2" dur="1.6s" repeatCount="indefinite" />
                </rect>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
