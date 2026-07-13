// ui/src/views/dag-layout.ts — pure topological layout for goal DAGs (≤12 nodes; spec §9).
// No React/DOM imports: the root test suite exercises this file directly.
export interface DagNodeIn { key: string; deps: string[] }
export interface DagBox { key: string; layer: number; row: number; x: number; y: number }
export interface DagEdge { from: string; to: string; path: string }
export interface DagLayout { boxes: DagBox[]; edges: DagEdge[]; width: number; height: number }

export const BOX_W = 168;
export const BOX_H = 64;
export const GAP_X = 72;
export const GAP_Y = 20;
export const PAD = 12;

/** Layer = longest dependency path from a root; row = arrival order within the layer. */
export function layoutDag(nodes: DagNodeIn[]): DagLayout {
  const known = new Map(nodes.map((n) => [n.key, n]));
  const memo = new Map<string, number>();
  const layerOf = (key: string, trail: Set<string>): number => {
    if (memo.has(key)) return memo.get(key)!;
    if (trail.has(key)) return 0; // defensive: validateGraph rejects cycles upstream
    trail.add(key);
    const deps = (known.get(key)?.deps ?? []).filter((d) => known.has(d));
    const layer = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => layerOf(d, trail)));
    trail.delete(key);
    memo.set(key, layer);
    return layer;
  };

  const rowCounter = new Map<number, number>();
  const boxes: DagBox[] = nodes.map((n) => {
    const layer = layerOf(n.key, new Set());
    const row = rowCounter.get(layer) ?? 0;
    rowCounter.set(layer, row + 1);
    return { key: n.key, layer, row, x: PAD + layer * (BOX_W + GAP_X), y: PAD + row * (BOX_H + GAP_Y) };
  });

  const byKey = new Map(boxes.map((b) => [b.key, b]));
  const edges: DagEdge[] = [];
  for (const n of nodes) {
    for (const d of n.deps) {
      const from = byKey.get(d);
      const to = byKey.get(n.key);
      if (!from || !to) continue;
      const x1 = from.x + BOX_W, y1 = from.y + BOX_H / 2;
      const x2 = to.x, y2 = to.y + BOX_H / 2;
      const bend = Math.max((x2 - x1) / 2, GAP_X / 2);
      edges.push({ from: d, to: n.key, path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` });
    }
  }

  const layers = Math.max(0, ...boxes.map((b) => b.layer)) + 1;
  const rows = Math.max(1, ...rowCounter.values());
  return {
    boxes, edges,
    width: PAD * 2 + layers * BOX_W + (layers - 1) * GAP_X,
    height: PAD * 2 + rows * BOX_H + (rows - 1) * GAP_Y,
  };
}
