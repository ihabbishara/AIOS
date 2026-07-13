// test/attention-review.test.ts — review kind in the needs-you queue (spec §4.3).
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { appendEvents } from "../src/engine/journal.js";
import { buildAttentionView } from "../src/web/attention-view.js";

function parkedStore() {
  const store = new Store(":memory:");
  appendEvents(store, "g1", [
    { type: "goal.created", payload: {
      slug: "build-x", title: "Build X", request: "r", department: "engineering", lead: "athena",
      origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
      planSummary: "planned", goalDir: "d", projectDir: null } },
    { type: "plan.recorded", payload: { summary: "s", needsWorkspace: "none", nodes: [
      { key: "impl", kind: "loop", agent: "vulcan", critic: "minos", brief: "b", dependsOn: [], maxRounds: 2 },
    ] } },
    { type: "workspace.prepared", payload: { taskDir: null, mode: null } },
    { type: "review.requested", payload: { node: "impl", lastArtifactRef: "impl-v2.md", objections: ["r1", "r2"] } },
  ]);
  return store;
}

describe("attention — review kind", () => {
  it("a parked node surfaces as kind review with verdict actions and goal/node refs", () => {
    const items = buildAttentionView(parkedStore());
    const review = items.find((i) => i.kind === "review")!;
    expect(review).toMatchObject({
      severity: 2,
      actions: ["accept", "retry", "abandon", "open"],
      ref: { goalId: "g1", node: "impl", slug: "build-x", artifact: "impl-v2.md" },
    });
    expect(review.title).toContain("Build X");
    expect(review.meta).toContain("r1");
  });

  it("resolving the review removes the item", () => {
    const store = parkedStore();
    appendEvents(store, "g1", [
      { type: "review.resolved", payload: { node: "impl", verdict: "accept", by: "ihab" } },
      { type: "node.completed", payload: { node: "impl", artifactRef: "impl.md", roundsUsed: 2 } },
    ]);
    expect(buildAttentionView(store).filter((i) => i.kind === "review")).toHaveLength(0);
  });
});
