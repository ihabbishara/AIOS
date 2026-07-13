// test/code-pack-loader.test.ts — engineering department pins (capability era).
import { describe, it, expect } from "vitest";
import { testRegistry } from "./fixtures/registry.js";
import { capabilityTools, departmentActions } from "../src/agents/registry/loader.js";

describe("engineering department loads (registry)", () => {
  const reg = testRegistry();
  it("registers the engineering department with sandbox + vault.write ceiling", () => {
    const dept = reg.departments.get("engineering");
    expect(dept?.sandbox).toBe(true);
    expect(departmentActions(reg, "engineering")).toEqual(["vault.write"]);
    expect(capabilityTools(reg, "vulcan")).toContain("Bash");
  });
  it("owns code-build and code-analyze", () => {
    expect(reg.playbooks.has("code-build")).toBe(true);
    expect(reg.playbooks.has("code-analyze")).toBe(true);
    expect(reg.ownerOfPlaybook.get("code-build")).toBe("engineering");
  });
  it("maps devops alias uniquely to atlas in engineering", () => {
    expect(reg.agentOf.get("devops")).toBe("atlas");
    expect(reg.agents.get("atlas")?.department).toBe("engineering");
  });
});
