import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

describe("Store.setGoalProjectDir", () => {
  it("updates project_dir on a goal row", () => {
    const store = new Store(":memory:");
    store.insertGoal({
      id: "g1", slug: "s", title: "t", request: "r", department: "engineering", lead: "athena",
      origin_channel: "c", origin_chat_id: "ch", status: "running", project_dir: null,
      goal_dir: null, plan_summary: "playbook:code-build", replans_used: 0, error: null,
    });
    store.setGoalProjectDir("g1", "/ws/task");
    expect(store.getGoal("g1")!.project_dir).toBe("/ws/task");
  });
});
