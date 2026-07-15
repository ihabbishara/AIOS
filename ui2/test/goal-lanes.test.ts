// ui2/test/goal-lanes.test.ts — status→lane mapping for the kanban Goals page.
import { describe, it, expect } from "vitest";
import { laneOf, LANES } from "../src/lib/goal-buckets.js";

describe("laneOf", () => {
  it("failed and paused land in needs-you", () => {
    expect(laneOf("failed")).toBe("needs");
    expect(laneOf("paused-budget")).toBe("needs");
    expect(laneOf("paused-user")).toBe("needs");
  });
  it("awaiting-mail renders in running despite the waiting bucket", () => {
    expect(laneOf("awaiting-mail")).toBe("running");
  });
  it("active statuses are running", () => {
    for (const s of ["planning", "running", "replanning"]) expect(laneOf(s)).toBe("running");
  });
  it("done and abandoned share the done lane", () => {
    expect(laneOf("done")).toBe("done");
    expect(laneOf("abandoned")).toBe("done");
  });
  it("lane order is needs, running, done", () => {
    expect(LANES.map((l) => l.key)).toEqual(["needs", "running", "done"]);
  });
});
