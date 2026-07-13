// test/engine-review.test.ts — resolveReview verdict paths on the live engine (spec §4).
import { describe, it, expect, vi } from "vitest";
import { harness } from "./engine-core.test.js";
import { readJournal } from "../src/engine/journal.js";
import type { GoalEngine } from "../src/engine/engine.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";

/** run fn: producer emits drafts, critic always revises with reason "r1" → loop parks at cap. */
const alwaysRevise: SpecialistRunFn = async (role) =>
  role === "minos"
    ? { text: "r", structured: { verdict: "revise", summary: "no", reasons: ["r1"] }, costUsd: 0, numTurns: 1 }
    : { text: "draft", costUsd: 0, numTurns: 1 };

function loopGoal(engine: GoalEngine) {
  return engine.startPlannedGoal({
    title: "L", request: "loop it", department: "engineering", lead: "athena",
    origin: { channel: "t", chatId: "1" }, summary: "planned", needsWorkspace: "none",
    nodes: [{ node_key: "impl", type: "loop", agent: "vulcan", critic: "minos",
              brief: "b", depends_on: [], max_rounds: 2 }],
  });
}

async function parkedGoal(over: { run?: SpecialistRunFn } = {}) {
  const h = harness({ run: over.run ?? alwaysRevise });
  const g = loopGoal(h.engine);
  await vi.waitFor(() => expect(h.store.listNodes(g.id)[0].status).toBe("needs-review"));
  return { ...h, g };
}

describe("GoalEngine.resolveReview", () => {
  it("accept: node completes with waiver frontmatter, goal finishes", async () => {
    const { engine, store, vault, g } = await parkedGoal();
    const msg = engine.resolveReview(g.id, "impl", "accept", { by: "ihab" });
    expect(msg).toContain("accept");
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    const types = readJournal(store, g.id).map((e) => e.type);
    expect(types).toContain("review.resolved");
    expect(types).toContain("node.completed");
    const final = vault.readGoalArtifact(store.getGoal(g.id)!.goal_dir!, "impl.md")!;
    expect(final).toContain("approved-with-waiver: true"); // writeGoalArtifact renders `key: JSON(value)`
    expect(final).toContain("r1"); // objections listed in frontmatter
    expect(final).toContain("draft"); // body carried over, old frontmatter stripped
    expect(final.match(/^---$/gm)!.length).toBe(2); // exactly ONE frontmatter block (open+close), none doubled
  });

  it("retry: one new attempt runs with guidance; approval completes the node", async () => {
    let critiques = 0;
    const run: SpecialistRunFn = async (role, brief) => {
      if (role === "minos") {
        critiques++;
        // attempt 1 (2 rounds at cap): revise; retry attempt: approve
        return critiques <= 2
          ? { text: "r", structured: { verdict: "revise", summary: "no", reasons: ["r1"] }, costUsd: 0, numTurns: 1 }
          : { text: "r", structured: { verdict: "approve", summary: "ok", reasons: [] }, costUsd: 0, numTurns: 1 };
      }
      return { text: `draft(${brief.includes("make it shorter") ? "guided" : "unguided"})`, costUsd: 0, numTurns: 1 };
    };
    const { engine, store, g } = await parkedGoal({ run });
    engine.resolveReview(g.id, "impl", "retry", { by: "ihab", guidance: "make it shorter" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(store.listNodes(g.id)[0].status).toBe("done");
  });

  it("abandon: node fails and the normal failure path takes over", async () => {
    const { engine, store, g } = await parkedGoal();
    engine.resolveReview(g.id, "impl", "abandon", { by: "ihab" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    const types = readJournal(store, g.id).map((e) => e.type);
    expect(types).toContain("node.failed");
  });

  it("rejects a verdict on a node that is not awaiting review", async () => {
    const { engine, g, store } = await parkedGoal();
    expect(engine.resolveReview(g.id, "nope", "accept", { by: "ihab" })).toContain("not awaiting review");
    engine.resolveReview(g.id, "impl", "abandon", { by: "ihab" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(engine.resolveReview(g.id, "impl", "accept", { by: "ihab" })).toContain("not awaiting review");
  });
});
