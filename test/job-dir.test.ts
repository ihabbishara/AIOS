// test/job-dir.test.ts — goal_dir persistence (ported from the jobs engine).
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

function insertGoal(s: Store, id: string, slug: string) {
  s.insertGoal({
    id, slug, title: slug, request: "r", department: "engineering", lead: "athena",
    origin_channel: "cli", origin_chat_id: "t", status: "running", project_dir: null,
    goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, error: null,
  });
}

describe("goal_dir persistence", () => {
  it("setGoalDir stores the dir and getGoal returns it; null until set", () => {
    const s = new Store(":memory:");
    insertGoal(s, "g1", "alpha");
    expect(s.getGoal("g1")!.goal_dir).toBeNull();
    s.setGoalDir("g1", "2026-06-20-alpha");
    expect(s.getGoal("g1")!.goal_dir).toBe("2026-06-20-alpha");
  });
});
