// test/turns-factor.test.ts — maxTurnsFactor multiplies the manifest cap (failure-class spec §B1).
import { describe, it, expect } from "vitest";
import { roleQueryOptions } from "../src/agents/runner.js";
import type { RoleDef } from "../src/agents/roles/index.js";

const ROLE: RoleDef = {
  name: "t", description: "d", systemPrompt: "p",
  allowedTools: ["Read"], permissionMode: "dontAsk", maxTurns: 30,
};

describe("roleQueryOptions.maxTurnsFactor", () => {
  it("multiplies role.maxTurns; absent factor leaves the cap alone", () => {
    expect(roleQueryOptions(ROLE, { cwd: "/tmp" }).maxTurns).toBe(30);
    expect(roleQueryOptions(ROLE, { cwd: "/tmp", maxTurnsFactor: 2 }).maxTurns).toBe(60);
  });
});
