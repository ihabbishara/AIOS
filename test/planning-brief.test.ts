import { describe, it, expect } from "vitest";
import { planningBrief } from "../src/engine/plan.js";

describe("planningBrief department doctrine", () => {
  it("omits the doctrine section when the department has none", () => {
    const b = planningBrief("research", "T", "R", "- clio");
    expect(b).not.toContain("# Department doctrine");
  });

  it("appends the doctrine section when present", () => {
    const b = planningBrief("research", "T", "R", "- clio", undefined, "Fan out 2-5 nodes.");
    expect(b).toContain("# Department doctrine\nFan out 2-5 nodes.");
  });

  it("doctrine and retry error can coexist, retry last", () => {
    const b = planningBrief("research", "T", "R", "- clio", "bad graph", "Fan out.");
    expect(b.indexOf("# Department doctrine")).toBeGreaterThan(-1);
    expect(b.indexOf("# Your previous plan was INVALID")).toBeGreaterThan(b.indexOf("# Department doctrine"));
  });
});
