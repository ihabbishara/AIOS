// test/goal-endpoints.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { SpendGuard } from "../src/engine/budget.js";
import { buildGoalsView, buildGoalDetail, buildBudgetView } from "../src/web/goals-view.js";

function seeded() {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "ge-")), "AIOS");
  store.insertGoal({
    id: "g1", slug: "build-x", title: "Build X", request: "r", department: "engineering", lead: "athena",
    origin_channel: "t", origin_chat_id: "1", status: "running", project_dir: null,
    goal_dir: "2026-07-02-build-x", plan_summary: "s", replans_used: 1, error: null,
  });
  store.insertNodes("g1", [
    { node_key: "a", type: "run", agent: "odin", critic: null, brief: "b", depends_on: [], max_rounds: 1 },
    { node_key: "b", type: "loop", agent: "vulcan", critic: "minos-eng", brief: "b", depends_on: ["a"], max_rounds: 3 },
  ]);
  store.updateNodeStatus("g1", "a", "done");
  store.setNodeArtifact("g1", "a", "a.md");
  vault.writeGoalArtifact("2026-07-02-build-x", "a.md", "artifact body");
  return { store, vault };
}

describe("goals view builders", () => {
  it("buildGoalsView lists goals with parsed node deps", () => {
    const { store } = seeded();
    const [g] = buildGoalsView(store);
    expect(g.slug).toBe("build-x");
    expect(g.nodes[1].deps).toEqual(["a"]);
    expect(g.nodes[0].status).toBe("done");
  });

  it("node views carry the brief for the UI side panel", () => {
    const { store } = seeded();
    const [g] = buildGoalsView(store);
    expect(g.nodes[0].brief).toBe("b");
    expect(g.nodes[1].brief).toBe("b");
  });

  it("buildGoalDetail resolves by slug and includes artifacts; null for unknown", () => {
    const { store, vault } = seeded();
    const d = buildGoalDetail(store, vault, "build-x")!;
    expect(d.artifacts).toEqual([{ file: "a.md", content: expect.stringContaining("artifact body") }]);
    expect(buildGoalDetail(store, vault, "nope")).toBeNull();
  });

  it("buildBudgetView reports spend and cap", () => {
    const { store } = seeded();
    store.budgetAdd("2026-07-02", 42);
    const v = buildBudgetView(new SpendGuard({ store, capUsd: 5, todayFn: () => "2026-07-02" }), () => "2026-07-02");
    expect(v).toEqual({ date: "2026-07-02", spentCents: 42, capCents: 500 });
  });
});
