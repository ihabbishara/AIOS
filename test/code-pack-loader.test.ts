// test/code-pack-loader.test.ts
import { describe, it, expect } from "vitest";
import { testRegistry } from "./fixtures/registry.js";

describe("engineering department loads (registry)", () => {
  const reg = testRegistry();
  it("registers the engineering department with sandbox + vault.write ceiling", () => {
    const dept = reg.departments.get("engineering");
    expect(dept?.sandbox).toBe(true);
    expect(dept?.actions).toEqual(["vault.write"]);
    expect(dept?.toolsUnion).toContain("Bash");
  });
  it("owns code-build and code-analyze", () => {
    expect(reg.playbooks.has("code-build")).toBe(true);
    expect(reg.playbooks.has("code-analyze")).toBe(true);
    expect(reg.ownerOfPlaybook.get("code-build")).toBe("engineering");
  });
  it("maps devops alias uniquely to omar in engineering", () => {
    expect(reg.agentOf.get("devops")).toBe("omar");
    expect(reg.agents.get("omar")?.department).toBe("engineering");
  });
});
