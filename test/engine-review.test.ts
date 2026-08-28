// test/engine-review.test.ts — resolveReview verdict paths on the live engine (spec §4).
import { describe, it, expect, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
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

  // The accept-turnstile. Both signals below were observed completing empty goals as "done"
  // (2026-08): a runner report of passed:false whose summary read "the central deliverable is
  // absent", and an artifact that could not be read at all.
  describe("accept turnstile", () => {
    /** verify stage: runner always reports FAILING, fixer never fixes → parks at cap. */
    const alwaysFail: SpecialistRunFn = async (role) =>
      role === "argus"
        ? { text: "ran", structured: { passed: false, summary: "the central deliverable is absent", failures: ["no manifest created"] }, costUsd: 0, numTurns: 1 }
        : { text: "fix attempt", costUsd: 0, numTurns: 1 };

    async function parkedVerify() {
      const h = harness({ run: alwaysFail });
      const g = h.engine.startPlannedGoal({
        title: "V", request: "verify it", department: "engineering", lead: "athena",
        origin: { channel: "t", chatId: "1" }, summary: "planned", needsWorkspace: "none",
        nodes: [{ node_key: "check", type: "verify", agent: "argus", critic: "vulcan",
                  brief: "b", depends_on: [], max_rounds: 2 }],
      });
      await vi.waitFor(() => expect(h.store.listNodes(g.id)[0].status).toBe("needs-review"));
      return { ...h, g };
    }

    it("refuses accept when the last verification report is failing", async () => {
      const { engine, store, g } = await parkedVerify();
      const msg = engine.resolveReview(g.id, "check", "accept", { by: "ihab" });
      expect(msg).toContain("Refused:");
      expect(msg).toContain("the central deliverable is absent"); // the reason is shown, not hidden
      // Refusal is inert: the node stays parked, nothing is journalled, no artifact is written.
      expect(store.listNodes(g.id)[0].status).toBe("needs-review");
      expect(readJournal(store, g.id).map((e) => e.type)).not.toContain("review.resolved");
    });

    it("force waives it and records the override in frontmatter", async () => {
      const { engine, store, vault, g } = await parkedVerify();
      expect(engine.resolveReview(g.id, "check", "accept", { by: "ihab", force: true })).toContain("accept");
      await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
      const final = vault.readGoalArtifact(store.getGoal(g.id)!.goal_dir!, "check.md")!;
      expect(final).toContain("waived-failing-verification: true");
      expect(final).toContain("the central deliverable is absent");
    });

    it("retry and abandon are never gated — the honest verdicts stay one click", async () => {
      const { engine, store, g } = await parkedVerify();
      expect(engine.resolveReview(g.id, "check", "retry", { by: "ihab" })).not.toContain("Refused:");
      await vi.waitFor(() => expect(store.listNodes(g.id)[0].status).not.toBe("needs-review"));
    });

    it("refuses accept when the artifact cannot be read, instead of shipping a placeholder", async () => {
      const { engine, store, vault, g } = await parkedGoal();
      const dir = store.getGoal(g.id)!.goal_dir!;
      const ref = store.listNodes(g.id)[0].artifact ?? "impl-a1-v2.md";
      // Assert-then-delete: rmSync(force) is a no-op on a wrong path, which would make this
      // test pass for the wrong reason.
      expect(vault.readGoalArtifact(dir, ref)).toBeDefined();
      rmSync(join(vault.root, "goals", dir, ref), { force: true });
      expect(vault.readGoalArtifact(dir, ref)).toBeUndefined();
      const msg = engine.resolveReview(g.id, "impl", "accept", { by: "ihab" });
      expect(msg).toContain("Refused:");
      expect(msg).toContain("no readable artifact");
      expect(store.listNodes(g.id)[0].status).toBe("needs-review");
    });
  });

  it("rejects a verdict on a node that is not awaiting review", async () => {
    const { engine, g, store } = await parkedGoal();
    expect(engine.resolveReview(g.id, "nope", "accept", { by: "ihab" })).toContain("not awaiting review");
    engine.resolveReview(g.id, "impl", "abandon", { by: "ihab" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(engine.resolveReview(g.id, "impl", "accept", { by: "ihab" })).toContain("not awaiting review");
  });
});
