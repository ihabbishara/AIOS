// ui2/src/lib/goal-recency.ts — which band a goal falls in (spec 2026-08-03 §1).
// Recency is the organising axis because status is near-constant across the
// corpus: 51 of 57 goals are done, so status carries almost no information.
import type { GoalView } from "../api.js";
import { statusClock } from "./goal-clock.js";

export type Band = "live" | "needs" | "today" | "week" | "earlier";

export const BANDS: Array<{ key: Band; label: string }> = [
  { key: "live", label: "Live" },
  { key: "needs", label: "Needs you" },
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "earlier", label: "Earlier" },
];

const DAY_MS = 86_400_000;

export function bandOf(goal: GoalView, now: Date): Band {
  // LIVE and NEEDS both ignore age no matter how old the goal is — a failed
  // goal from March still wants the user; burying it under EARLIER hides the
  // row that most needs them. They are kept as two bands, not one, so a
  // header is always true by construction: LIVE never claims something is
  // running when the only thing up top is an old failure, and NEEDS never
  // claims something needs the user when it's actually still in flight.
  const clock = statusClock(goal.status);
  if (clock === "now") return "live";
  if (clock === "blocked") return "needs";

  const created = Date.parse(goal.createdAt);
  if (Number.isNaN(created)) return "earlier";

  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  // A future stamp means clock skew between the daemon host and the browser.
  // Show it at the top rather than letting it fall off the axis.
  if (created >= midnight.getTime()) return "today";
  if (created >= midnight.getTime() - 7 * DAY_MS) return "week";
  return "earlier";
}

/** Bands in display order, newest first inside each, empty bands omitted —
 *  an empty band is a standing claim about the org that is not true. */
export function groupByBand(
  goals: GoalView[],
  now: Date,
): Array<{ key: Band; label: string; items: GoalView[] }> {
  return BANDS.map(({ key, label }) => ({
    key,
    label,
    items: goals
      .filter((g) => bandOf(g, now) === key)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  })).filter((b) => b.items.length > 0);
}
