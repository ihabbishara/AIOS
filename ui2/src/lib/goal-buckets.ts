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
