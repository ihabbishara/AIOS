// ui2/src/lib/goal-buckets.ts — status → list group + provenance chip (spec §6 Goals).
export type Bucket = "needs" | "running" | "waiting" | "done" | "abandoned";

export const BUCKETS: Array<{ key: Bucket; label: string }> = [
  { key: "needs", label: "Needs attention" },
  { key: "running", label: "Running" },
  { key: "waiting", label: "Waiting" },
  { key: "done", label: "Done" },
  { key: "abandoned", label: "Abandoned" },
];

export function bucketOf(status: string): Bucket {
  if (status === "failed") return "needs";
  if (status === "done") return "done";
  if (status === "abandoned") return "abandoned";
  if (status === "paused-budget" || status === "paused-user" || status === "awaiting-mail") return "waiting";
  return "running"; // planning | running | replanning
}

export function provenance(originChannel: string): "mail" | "speculate" | "chat" {
  if (originChannel === "mail") return "mail";
  if (originChannel === "speculate" || originChannel === "dream") return "speculate";
  return "chat";
}

/** Kanban lanes (Command Deck spec §3): 5 buckets fold into 3 columns.
 *  awaiting-mail is the one status-level exception — it waits on the WORLD,
 *  not the user, so it renders in Running with a chip. */
export type Lane = "needs" | "running" | "done";

export const LANES: Array<{ key: Lane; label: string }> = [
  { key: "needs", label: "Needs you" },
  { key: "running", label: "Running" },
  { key: "done", label: "Done" },
];

const RUNNING_STATUSES = new Set(["planning", "running", "replanning"]);

export function laneOf(status: string): Lane {
  if (status === "awaiting-mail") return "running";
  const bucket = bucketOf(status);
  if (bucket === "needs" || bucket === "waiting") return "needs";
  if (bucket === "done" || bucket === "abandoned") return "done";
  // running bucket, but bucketOf's default also catches UNKNOWN statuses — only the known
  // in-progress ones belong in Running; anything unrecognized surfaces in Needs-you rather than
  // hiding as if healthy (a new backend status shouldn't silently bury a stuck goal).
  return RUNNING_STATUSES.has(status) ? "running" : "needs";
}
