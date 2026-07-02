// test/research-pack.test.ts
import { describe, it, expect } from "vitest";
import { testRegistry } from "./fixtures/registry.js";
import { dropDepartment } from "../src/agents/registry/loader.js";

describe("research department (registry)", () => {
  it("registers the research department from disk", () => {
    const reg = testRegistry();
    const dept = reg.departments.get("research")!;
    expect(dept).toBeTruthy();
    expect(dept.toolServer).toBe("research");
    expect(dept.actions).toEqual(["vault.write"]);
    expect(dept.sandbox).toBeFalsy();
    expect(dept.memoDomain).toBe("research");
    expect(dept.vaultSection).toBe("knowledge");
    for (const pb of ["research-report", "market-research", "product-design"]) {
      expect(reg.ownerOfPlaybook.get(pb)).toBe("research");
      expect(reg.playbooks.has(pb)).toBe(true);
    }
  });

  it("binds research agents by canonical name; aliases resolve via agentOf", () => {
    const reg = testRegistry();
    expect(reg.agentOf.get("analyst")).toBe("clio");
    expect(reg.agentOf.get("market-researcher")).toBe("janus");
    expect(reg.agentOf.get("ui-ux-designer")).toBe("venus");
    expect(reg.agents.get("clio")?.department).toBe("research");
  });

  it("leaves finance + engineering departments intact", () => {
    const reg = testRegistry();
    expect(reg.departments.get("finance")?.toolServer).toBe("money");
    expect(reg.departments.get("engineering")?.sandbox).toBe(true);
  });

  it("AIOS_RESEARCH_DISABLED drops the research department + its playbooks", () => {
    const reg = testRegistry();
    dropDepartment(reg, "research");
    expect(reg.departments.has("research")).toBe(false);
    expect(reg.playbooks.has("research-report")).toBe(false);
    expect(reg.ownerOfPlaybook.has("research-report")).toBe(false);
    expect(reg.agents.has("clio")).toBe(false);
    // engineering + finance survive
    expect(reg.departments.has("engineering")).toBe(true);
    expect(reg.departments.has("finance")).toBe(true);
  });
});
