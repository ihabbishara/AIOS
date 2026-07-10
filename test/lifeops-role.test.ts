import { describe, it, expect } from "vitest";
import { roleOf } from "./fixtures/registry.js";
import { testRegistry } from "./fixtures/registry.js";

describe("jasmine role", () => {
  it("exists, is privateOnly, and carries no write tools", () => {
    const j = roleOf("jasmine");
    expect(j).toBeDefined();
    expect(j.privateOnly).toBe(true);
    expect(j.permissionMode).toBe("dontAsk");
    expect(j.allowedTools).not.toContain("Bash");
    expect(j.allowedTools).not.toContain("Edit");
    expect(j.allowedTools).not.toContain("Write");
  });
});

describe("life department manifest (registry)", () => {
  it("loads, jasmine is the sole agent, actions empty, not sandboxed", () => {
    const reg = testRegistry();
    const life = reg.departments.get("life")!;
    expect(life).toBeDefined();
    expect(life.actions).toEqual([]);
    expect(life.sandbox).toBe(false);
    expect(life.toolServer).toBe("lifeops");
    expect(reg.agentOf.get("jasmine")).toBe("jasmine");
    expect(reg.agents.get("jasmine")?.department).toBe("life");
  });
});
