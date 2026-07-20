// test/dept-walls.test.ts
import { describe, it, expect } from "vitest";
import { deptWallViolations } from "../src/agents/registry/walls.js";
import { toolsFromCaps, type CapabilityDef } from "../src/agents/registry/capabilities.js";

describe("deptWallViolations", () => {
  it("flags exact banned tools for life", () => {
    expect(deptWallViolations("life", ["mcp__aios-pack__vault_write", "WebSearch"]))
      .toEqual(["mcp__aios-pack__vault_write"]);
  });
  it("flags pattern-banned tools for life", () => {
    expect(deptWallViolations("life", ["mcp__gcal__calendar_list"]))
      .toEqual(["mcp__gcal__calendar_list"]);
  });
  it("clean life toolset passes", () => {
    expect(deptWallViolations("life", [
      "mcp__lifeops__add_task", "WebSearch", "WebFetch",
      "mcp__aios-pack__recall", "mcp__aios-pack__vault_read",
    ])).toEqual([]);
  });
  it("unwalled dept always passes", () => {
    expect(deptWallViolations("engineering", ["mcp__aios-pack__vault_write"])).toEqual([]);
  });
});

describe("toolsFromCaps", () => {
  it("dedupes and fully qualifies aios-pack bare tools", () => {
    const caps = new Map<string, CapabilityDef>([
      ["memory", { tools: ["recall", "vault_read"] } as CapabilityDef],
      ["vault-read", { tools: ["vault_read"] } as CapabilityDef],
      ["web", { tools: ["WebSearch", "WebFetch"] } as CapabilityDef],
    ]);
    expect(toolsFromCaps(caps, ["memory", "vault-read", "web"]).sort()).toEqual([
      "WebFetch", "WebSearch", "mcp__aios-pack__recall", "mcp__aios-pack__vault_read",
    ]);
  });
  it("unknown capability contributes no tools", () => {
    expect(toolsFromCaps(new Map(), ["ghost"])).toEqual([]);
  });
});
