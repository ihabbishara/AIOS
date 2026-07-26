// test/goal-store.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type GoalRow } from "../src/store/db.js";

function goal(over: Partial<GoalRow> = {}): Omit<GoalRow, "created_at" | "updated_at"> {
  return {
    id: over.id ?? "g1", slug: over.slug ?? "build-x", title: "Build X", request: "build x please",
    department: "engineering", lead: "athena", origin_channel: "telegram", origin_chat_id: "42",
    status: over.status ?? "planning", project_dir: null, goal_dir: null,
    plan_summary: "", replans_used: 0, chain_depth: 0, error: null, ...over,
  } as Omit<GoalRow, "created_at" | "updated_at">;
}

const NODES = [
  { node_key: "design", type: "run" as const, agent: "athena", critic: null, brief: "design it", depends_on: [], max_rounds: 1 },
  { node_key: "implement", type: "loop" as const, agent: "vulcan", critic: "minos", brief: "build it", depends_on: ["design"], max_rounds: 3 },
];

describe("goal store", () => {
  it("round-trips a goal with nodes", () => {
    const s = new Store(":memory:");
    s.insertGoal(goal());
    s.insertNodes("g1", NODES);
    const g = s.getGoal("g1")!;
    expect(g.status).toBe("planning");
    const nodes = s.listNodes("g1");
    expect(nodes.map((n) => n.node_key)).toEqual(["design", "implement"]);
    expect(JSON.parse(nodes[1].depends_on)).toEqual(["design"]);
    expect(nodes[1].max_rounds).toBe(3);
  });

  it("node status transitions stamp timestamps", () => {
    const s = new Store(":memory:");
    s.insertGoal(goal());
    s.insertNodes("g1", NODES);
    s.updateNodeStatus("g1", "design", "running");
    expect(s.listNodes("g1")[0].started_at).toBeTruthy();
    s.updateNodeStatus("g1", "design", "done");
    expect(s.listNodes("g1")[0].finished_at).toBeTruthy();
    s.updateNodeStatus("g1", "implement", "failed", "boom");
    expect(s.listNodes("g1")[1].error).toBe("boom");
  });

  it("cost, rounds, artifact accumulate", () => {
    const s = new Store(":memory:");
    s.insertGoal(goal());
    s.insertNodes("g1", NODES);
    s.addNodeCost("g1", "design", 120);
    s.addNodeCost("g1", "design", 30);
    s.setNodeRounds("g1", "implement", 2);
    s.setNodeArtifact("g1", "design", "design.md");
    const [d, i] = s.listNodes("g1");
    expect(d.cost_cents).toBe(150);
    expect(d.artifact).toBe("design.md");
    expect(i.rounds_used).toBe(2);
  });

  it("replaceNode swaps and resets to pending", () => {
    const s = new Store(":memory:");
    s.insertGoal(goal());
    s.insertNodes("g1", NODES);
    s.updateNodeStatus("g1", "implement", "failed", "boom");
    s.replaceNode("g1", "implement", { ...NODES[1], agent: "odin" });
    const n = s.listNodes("g1").find((x) => x.node_key === "implement")!;
    expect(n.agent).toBe("odin");
    expect(n.status).toBe("pending");
    expect(n.error).toBeNull();
  });

  it("skipUnfinishedNodes", () => {
    const s = new Store(":memory:");
    s.insertGoal(goal());
    s.insertNodes("g1", NODES);
    s.updateNodeStatus("g1", "design", "done");
    s.skipUnfinishedNodes("g1");
    expect(s.listNodes("g1").map((n) => n.status)).toEqual(["done", "skipped"]);
  });

  it("goal queries: bySlug newest-first, unfinished, paused-budget, bumpReplans", () => {
    const s = new Store(":memory:");
    s.insertGoal(goal({ id: "g1", status: "running" }));
    s.insertGoal(goal({ id: "g2", slug: "other", status: "paused-budget" }));
    expect(s.getGoalBySlug("build-x")!.id).toBe("g1");
    expect(s.unfinishedGoals().map((g) => g.id)).toEqual(["g1"]);
    expect(s.pausedBudgetGoals().map((g) => g.id)).toEqual(["g2"]);
    s.insertGoal(goal({ id: "g3", slug: "api-down", status: "paused-api" }));
    expect(s.pausedApiGoals().map((g) => g.id)).toEqual(["g3"]);   // only api-paused, not g2
    expect(s.pausedBudgetGoals().map((g) => g.id)).toEqual(["g2"]); // and the reverse holds
    s.bumpReplans("g1");
    s.bumpReplans("g1");
    expect(s.getGoal("g1")!.replans_used).toBe(2);
  });

  it("budget ledger accumulates integer cents per date", () => {
    const s = new Store(":memory:");
    s.budgetAdd("2026-07-02", 150);
    s.budgetAdd("2026-07-02", 25);
    s.budgetAdd("2026-07-03", 10);
    expect(s.budgetSpentCents("2026-07-02")).toBe(175);
    expect(s.budgetSpentCents("2026-07-03")).toBe(10);
    expect(s.budgetSpentCents("2026-07-04")).toBe(0);
  });

  it("insertGoal round-trips spawned_by_mail (defaults null when omitted)", () => {
    const s = new Store(":memory:");
    s.insertGoal({
      id: "g1", slug: "x", title: "X", request: "r", department: "engineering", lead: "athena",
      origin_channel: "t", origin_chat_id: "1", status: "running", project_dir: null, goal_dir: null,
      plan_summary: "", replans_used: 0, chain_depth: 0, error: null,
    });
    expect(s.getGoal("g1")!.spawned_by_mail).toBeNull();
    s.insertGoal({
      id: "g2", slug: "y", title: "Y", request: "r", department: "engineering", lead: "athena",
      origin_channel: "t", origin_chat_id: "1", status: "running", project_dir: null, goal_dir: null,
      plan_summary: "graph", replans_used: 0, chain_depth: 1, error: null, spawned_by_mail: "m9",
    });
    expect(s.getGoal("g2")!.spawned_by_mail).toBe("m9");
  });

  it("migration backfills spawned_by_mail from the mail: plan_summary prefix", () => {
    const f = join(mkdtempSync(join(tmpdir(), "gs-mig-")), "t.db");
    const s1 = new Store(f);
    s1.insertGoal({
      id: "g1", slug: "x", title: "X", request: "r", department: "engineering", lead: "athena",
      origin_channel: "t", origin_chat_id: "1", status: "running", project_dir: null, goal_dir: null,
      plan_summary: "mail:abc", replans_used: 0, chain_depth: 0, error: null, // spawned_by_mail omitted -> NULL
    });
    expect(s1.getGoal("g1")!.spawned_by_mail).toBeNull(); // pre-upgrade state
    const s2 = new Store(f); // reopen -> constructor re-runs the migration + backfill
    expect(s2.getGoal("g1")!.spawned_by_mail).toBe("abc");
  });
});
