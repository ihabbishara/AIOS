// ui2/src/lib/goal-buckets.ts — provenance chip for the Goals list.
//
// LANES/laneOf and BUCKETS/bucketOf lived here for the Command Deck kanban.
// Recency bands replaced the lanes (spec 2026-08-03 §1), and BUCKETS was
// exported and unit-tested but rendered by no view. The one surviving
// property of laneOf -- an unknown status must surface, never hide as
// healthy -- moved to statusClock in goal-clock.ts.
export function provenance(originChannel: string): "mail" | "speculate" | "chat" {
  if (originChannel === "mail") return "mail";
  if (originChannel === "speculate" || originChannel === "dream") return "speculate";
  return "chat";
}
