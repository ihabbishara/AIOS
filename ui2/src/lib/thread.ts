// ui2/src/lib/thread.ts — how a goal's nodes are ordered and timed for the
// thread (spec 2026-08-03 §2). Pure: the view is assembly only.
import type { GoalNodeView } from "../api.js";

/** Topological order, ties broken by the node's original array index so the
 *  same payload always renders the same way. A dep naming a node outside the
 *  set is treated as already satisfied — canvas views render node arrays
 *  directly and must not lose rows to a dangling reference. */
export function threadOrder(nodes: GoalNodeView[]): GoalNodeView[] {
  const index = new Map(nodes.map((n, i) => [n.key, i]));
  const byIndex = (a: string, b: string) => index.get(a)! - index.get(b)!;
  const remaining = new Set(nodes.map((n) => n.key));
  const out: GoalNodeView[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining].filter((k) =>
      nodes[index.get(k)!].deps.every((d) => !remaining.has(d)),
    );
    // A cycle leaves nothing ready. The engine plans DAGs, but a bad payload
    // must not spin the UI — emit the lowest-index survivor and carry on.
    const batch = (ready.length > 0 ? ready : [[...remaining].sort(byIndex)[0]]).sort(byIndex);
    for (const k of batch) {
      out.push(nodes[index.get(k)!]);
      remaining.delete(k);
    }
  }
  return out;
}

/** Wall-clock duration, or an em dash when it cannot be known. */
export function elapsed(
  startedAt: string | null,
  finishedAt: string | null,
  now: number = Date.now(),
): string {
  if (!startedAt) return "—";
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";
  // Floor, not round: "Xm" should mean "at least X minutes have passed."
  // Rounding lets a still-running node overstate itself — 1h59m59s would
  // read as "2h 0m", a duration that has not been reached yet. That is a
  // small lie the rest of this design goes out of its way to avoid.
  const minutes = Math.floor((end - start) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Whether a row must spell out its dependencies. Only when reading the thread
 *  top-to-bottom would otherwise mislead: more than one parent, or a single
 *  parent that is not the row directly above. This is what lets the thread
 *  carry arbitrary DAGs without drawing any geometry. */
export function showsDeps(node: GoalNodeView, previous: GoalNodeView | undefined): boolean {
  if (node.deps.length === 0) return false;
  if (node.deps.length > 1) return true;
  return node.deps[0] !== previous?.key;
}
