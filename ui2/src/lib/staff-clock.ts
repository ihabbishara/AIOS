// ui2/src/lib/staff-clock.ts — Staff's axis: how recently an agent did anything.
//
// The org chart stays the frame (departments are the one structure the registry
// actually asserts), but a card's colour answers "is this agent alive?" rather
// than "what did it cost today" — which is $0 for nearly everyone, nearly always.
//
// This is the same TIME axis as goal-clock.ts, measured over a different unit:
// there, a status; here, a date. Deliberately NOT reusing Clock — an agent has
// no "next" state, and conflating "hired but never run" with "queued" would say
// something false about an empty department.

export type AgentClock = "recent" | "stale" | "never";

/** Longer than a working week, so a Friday-only agent still reads alive on the
 *  following Thursday. Against the real roster this splits 9 / 4 / 2; at 3 days
 *  only 4 agents survive, and at 30 nothing is ever stale. */
export const RECENT_DAYS = 7;

export const STAFF_TOKEN: Record<AgentClock, string> = {
  recent: "bg-now", stale: "bg-past", never: "bg-line",
};

export const STAFF_TEXT: Record<AgentClock, string> = {
  recent: "text-now", stale: "text-past", never: "text-dim",
};

/** Whole days between two YYYY-MM-DD dates. Both parse as UTC midnight, so the
 *  difference is always an exact multiple of a day — no DST drift. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export function agentClock(lastActiveAt: string | null, today: string): AgentClock {
  if (!lastActiveAt) return "never";
  // A future date can only mean clock skew between the writer and the reader.
  // Treat it as active rather than as a negative age.
  return daysBetween(lastActiveAt, today) <= RECENT_DAYS ? "recent" : "stale";
}

export function lastActiveText(lastActiveAt: string | null, today: string): string {
  if (!lastActiveAt) return "never run";
  const d = daysBetween(lastActiveAt, today);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}
