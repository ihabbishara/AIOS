// test/registry-boot.test.ts
import { describe, it, expect } from "vitest";
import { testRegistry } from "./fixtures/registry.js";
import { dropDepartment, disabledDepartments } from "../src/agents/registry/loader.js";

describe("boot wiring", () => {
  it("legacy AIOS_CODE_DISABLED drops engineering (agents + playbooks)", () => {
    const reg = testRegistry();
    for (const d of disabledDepartments({ AIOS_CODE_DISABLED: "1" } as NodeJS.ProcessEnv, reg.departments.keys()))
      dropDepartment(reg, d);
    expect(reg.departments.has("engineering")).toBe(false);
    expect(reg.agents.has("maya")).toBe(false);
    expect(reg.playbooks.has("code-build")).toBe(false);
    expect(reg.playbooks.has("code-inplace")).toBe(true);   // packless survives
    expect(reg.departments.has("finance")).toBe(true);
  });
});
