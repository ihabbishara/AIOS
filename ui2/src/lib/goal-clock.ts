// ui2/src/lib/goal-clock.ts — the single status → TIME RELATIONSHIP mapping
// (spec 2026-08-03 §1; the axis is defined in 2026-08-02 §2).
//
// Distinct from toneOfStatus, which encodes SEVERITY for Command Deck views.
// Both exist on purpose; this one is the Organism axis.
//
// Goal statuses come from src/store/db.ts:7, node statuses from
// src/engine/reduce.ts:20 and :84. No string means different things in the two
// vocabularies, so one function serves both.

export type Clock = "now" | "past" | "next" | "blocked";

export const CLOCK_TOKEN: Record<Clock, string> = {
  now: "bg-now", past: "bg-past", next: "bg-next", blocked: "bg-accent",
};

export const CLOCK_TEXT: Record<Clock, string> = {
  now: "text-now", past: "text-past", next: "text-next", blocked: "text-accent",
};

/** awaiting-mail waits on the WORLD, not the user, so it is in flight — the
 *  same call laneOf made, back when goal-buckets.ts still carried lane logic. */
const NOW = new Set(["planning", "running", "replanning", "awaiting-mail", "working", "executing"]);
const PAST = new Set(["done", "abandoned", "skipped"]);
const NEXT = new Set(["pending", "ready"]);
const BLOCKED = new Set([
  "failed", "needs-review",
  "paused-user", "paused-budget", "paused-api", "paused-session",
]);

export function statusClock(status: string): Clock {
  if (NOW.has(status)) return "now";
  if (PAST.has(status)) return "past";
  if (NEXT.has(status)) return "next";
  if (BLOCKED.has(status)) return "blocked";
  // An unrecognised status must surface as needing attention rather than hide
  // as if healthy. laneOf documented this before goal-buckets.ts was pared
  // down to provenance, and the property survives the rewrite.
  return "blocked";
}

/** Ended, but not well. Same colour as past, rendered quieter. */
const MUTED = new Set(["abandoned", "skipped"]);

export function isMuted(status: string): boolean {
  return MUTED.has(status);
}
