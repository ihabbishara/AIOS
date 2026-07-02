import { describe, it, expect } from "vitest";
import { agentSchema, departmentSchema } from "../src/agents/registry/types.js";

describe("agentSchema", () => {
  it("parses a minimal manifest with defaults", () => {
    const a = agentSchema.parse({
      name: "maya", title: "Senior Engineer", department: "engineering",
      charter: "Owns code changes.", persona: "Terse.", prompt: "You are an engineer.",
    });
    expect(a.visibility).toBe("shared");
    expect(a.aliases).toEqual([]);
    expect(a.tools).toEqual([]);
    expect(a.permissionMode).toBe("dontAsk");
    expect(a.maxTurns).toBe(25);
  });
  it("rejects a bad permissionMode and bad visibility", () => {
    expect(() => agentSchema.parse({ name: "x", title: "t", department: "d", charter: "c", persona: "p", prompt: "s", permissionMode: "yolo" })).toThrow();
    expect(() => agentSchema.parse({ name: "x", title: "t", department: "d", charter: "c", persona: "p", prompt: "s", visibility: "public" })).toThrow();
  });
  it("rejects uppercase / spaced names", () => {
    expect(() => agentSchema.parse({ name: "Maya B", title: "t", department: "d", charter: "c", persona: "p", prompt: "s" })).toThrow();
  });
});

describe("departmentSchema", () => {
  it("parses and defaults vaultSection to department", () => {
    const d = departmentSchema.parse({ department: "engineering", mission: "Build software.", memoDomain: "code" });
    expect(d.vaultSection).toBe("engineering");
    expect(d.actions).toEqual([]);
    expect(d.playbooks).toEqual([]);
    expect(d.sandbox).toBe(false);
  });
  it("keeps explicit vaultSection", () => {
    const d = departmentSchema.parse({ department: "research", mission: "m", memoDomain: "research", vaultSection: "knowledge" });
    expect(d.vaultSection).toBe("knowledge");
  });
});
