// ui2/src/lib/goal-graph.ts — the geometry a goal's node set needs, and the
// decision of whether it needs any at all (spec 2026-08-03 §2, adaptive
// fidelity). Pure: GoalMap is assembly only.
//
// Sibling of lib/thread.ts. The ready-batch walk below is deliberately the same
// algorithm as threadOrder's, re-stated here rather than imported: thread.ts is
// shared with the read-only canvas thread and its exported surface is pinned by
// test/thread.test.ts. The two must never disagree, so
// test/goal-graph.test.ts asserts ranks.flat() is order-equal to threadOrder()
// for every shape — that assertion, not a shared function, is the contract.
import { statusClock } from "./goal-clock.js";
import type { GoalNodeView } from "../api.js";

export type GraphShape = "single" | "chain" | "dag";

export interface GoalGraph {
  /** How much drawing this goal has earned. */
  shape: GraphShape;
  /** Ready-batches: everything in ranks[i] can run once ranks[<i] is done. */
  ranks: GoalNodeView[][];
  pos: Map<string, { rank: number; lane: number }>;
  /** Dep edges, restricted to the node set — a dangling dep draws nothing. */
  edges: Array<{ from: string; to: string }>;
  /** Where the plan sat idle: ≥24h between a rank finishing and the next starting. */
  gaps: Array<{ afterRank: number; days: number }>;
}

/** Card box and the space between cards, in px. Shared by the layout and the
 *  cards themselves so the SVG underneath lands on the same grid. */
export const CARD = { w: 176, h: 78, gapX: 24, gapY: 56 };

const DAY_MS = 86_400_000;

/** Topological ready-batches, ties broken by original array index. A dep naming
 *  a node outside the set counts as already satisfied, and a cycle emits its
 *  lowest-index survivor rather than spinning — both exactly as threadOrder. */
function readyBatches(nodes: GoalNodeView[]): GoalNodeView[][] {
  const index = new Map(nodes.map((n, i) => [n.key, i]));
  const byIndex = (a: string, b: string) => index.get(a)! - index.get(b)!;
  const remaining = new Set(nodes.map((n) => n.key));
  const out: GoalNodeView[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining].filter((k) =>
      nodes[index.get(k)!].deps.every((d) => !remaining.has(d)),
    );
    const batch = (ready.length > 0 ? ready : [[...remaining].sort(byIndex)[0]]).sort(byIndex);
    out.push(batch.map((k) => nodes[index.get(k)!]));
    for (const k of batch) remaining.delete(k);
  }
  return out;
}

/** Latest parse-able stamp in a rank, or null when the rank has none. */
function extreme(stamps: Array<string | null>, pick: (a: number, b: number) => number): number | null {
  const times = stamps.map((s) => (s ? Date.parse(s) : NaN)).filter((t) => !Number.isNaN(t));
  return times.length > 0 ? times.reduce((a, b) => pick(a, b)) : null;
}

export function buildGoalGraph(nodes: GoalNodeView[]): GoalGraph {
  const ranks = readyBatches(nodes);
  const present = new Set(nodes.map((n) => n.key));

  const pos = new Map<string, { rank: number; lane: number }>();
  ranks.forEach((rank, r) => rank.forEach((n, lane) => pos.set(n.key, { rank: r, lane })));

  const edges = nodes.flatMap((n) =>
    n.deps.filter((d) => present.has(d)).map((d) => ({ from: d, to: n.key })),
  );

  const gaps: GoalGraph["gaps"] = [];
  for (let i = 0; i < ranks.length - 1; i++) {
    const done = extreme(ranks[i].map((n) => n.finishedAt), Math.max);
    const next = extreme(ranks[i + 1].map((n) => n.startedAt), Math.min);
    if (done === null || next === null) continue;
    // Floor, like elapsed(): "5 days later" must mean at least five days passed.
    const days = Math.floor((next - done) / DAY_MS);
    if (days >= 1) gaps.push({ afterRank: i, days });
  }

  return { shape: shapeOf(nodes, ranks, present), ranks, pos, edges, gaps };
}

/** A chain is a plan you can read top-to-bottom without losing anything: one
 *  node per rank, and every node waiting only on the one directly above it.
 *  Deps outside the set are ignored here for the same reason they draw no edge
 *  — the view cannot show what it does not have, so it must not claim a branch. */
function shapeOf(nodes: GoalNodeView[], ranks: GoalNodeView[][], present: Set<string>): GraphShape {
  if (nodes.length === 1) return "single";
  if (!ranks.every((r) => r.length === 1)) return "dag";
  const linear = ranks.map((r) => r[0]);
  return linear.every((n, i) => {
    const inSet = n.deps.filter((d) => present.has(d));
    return inSet.every((d) => d === linear[i - 1]?.key);
  })
    ? "chain"
    : "dag";
}

/** Top-left of a card. Lanes are centred inside the rank so a narrow rank sits
 *  under the middle of a wide one instead of hugging the left edge. */
export function cardXY(
  pos: { rank: number; lane: number },
  laneCount: number,
  containerW: number,
): { x: number; y: number } {
  const rowW = laneCount * CARD.w + (laneCount - 1) * CARD.gapX;
  // Never negative: a container narrower than its widest rank scrolls, it does
  // not push the first lane off its own left edge.
  const left = Math.max(0, (containerW - rowW) / 2);
  return { x: left + pos.lane * (CARD.w + CARD.gapX), y: pos.rank * (CARD.h + CARD.gapY) };
}

/** A cubic between two anchor points, leaving and arriving vertically so the
 *  curve reads as flow-down rather than as a wire. */
export function edgePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const bend = (to.y - from.y) / 2;
  const r = (v: number) => Math.round(v * 10) / 10;
  return `M ${r(from.x)} ${r(from.y)} C ${r(from.x)} ${r(from.y + bend)}, ${r(to.x)} ${r(to.y - bend)}, ${r(to.x)} ${r(to.y)}`;
}

/** An edge is coloured by what it leads TO, on the clock axis — the line into a
 *  running node is the live one. Returned as a CSS var, never a hex: SVG
 *  strokes cannot use Tailwind utilities but must still follow the theme.
 *  "next" deliberately falls to --color-line: an edge that has not carried
 *  anything yet is structure, not news. */
export function edgeToken(child: GoalNodeView): string {
  const clock = statusClock(child.status);
  if (clock === "now") return "var(--color-now)";
  if (clock === "blocked") return "var(--color-accent)";
  if (clock === "past") return "var(--color-past)";
  return "var(--color-line)";
}
