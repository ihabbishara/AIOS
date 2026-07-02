import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { roles } from "../src/agents/roles/index.js";

const reg = loadRegistry(
  join(process.cwd(), "agents"),
  join(process.cwd(), "playbooks"),
  buildExtras({ vaultPath: "/tmp/v", vaultSubdir: "AIOS", financeCompany: "IDAMA", financeMembers: [{ name: "Ihab" }] }),
);

describe("live agents/ tree", () => {
  it("loads 6 departments and 15 agents", () => {
    expect([...reg.departments.keys()].sort()).toEqual(
      ["clients", "engineering", "finance", "life", "operations", "research"]);
    expect(reg.agents.size).toBe(15);
  });

  it("legacy @role aliases resolve", () => {
    for (const [alias, name] of Object.entries({
      developer: "maya", architect: "kai", tester: "tarek", "code-reviewer": "nadia",
      devops: "omar", researcher: "ziad", analyst: "lina", "market-researcher": "sami",
      "ui-ux-designer": "dalia", reviewer: "yara", cfo: "faris", finance: "salim",
    })) expect(reg.agentOf.get(alias), alias).toBe(name);
  });

  it("compiled roles preserve the legacy security surface", () => {
    const pin: Array<[string, string]> = [
      ["maya", "developer"], ["kai", "architect"], ["tarek", "tester"],
      ["nadia", "code-reviewer"], ["omar", "devops"], ["ziad", "researcher"],
      ["sami", "market-researcher"], ["dalia", "ui-ux-designer"], ["yara", "reviewer"],
      ["lina", "analyst"], ["faris", "cfo"], ["jasmine", "jasmine"], ["halalo", "halalo"],
    ];
    for (const [agent, legacy] of pin) {
      const compiled = reg.agents.get(agent)!.role;
      const old = roles[legacy];
      expect(compiled.permissionMode, agent).toBe(old.permissionMode);
      expect(compiled.maxTurns, agent).toBe(old.maxTurns);
      expect([...compiled.allowedTools].sort(), agent).toEqual([...old.allowedTools].sort());
      expect(!!compiled.privateOnly, agent).toBe(!!old.privateOnly);
      expect(!!compiled.outputSchema, agent).toBe(!!old.outputSchema);
    }
  });

  it("halalo extras wire the deterministic guard", () => {
    const h = reg.agents.get("halalo")!.role;
    expect(h.toolCheckFallback).toBe("deny");
    expect(h.toolChecks?.Bash).toBeDefined();
    expect(h.systemPrompt).toContain("Exports directory");
    expect(h.systemPrompt).not.toMatch(/ABSOLUTE path under data\/downloads/);
  });

  it("jasmine prompt has unbroken tool chain", () => {
    expect(reg.agents.get("jasmine")!.role.systemPrompt).toContain("update_task/complete_task/dismiss_task");
  });

  it("private agents are faris and jasmine only", () => {
    const priv = [...reg.agents.values()].filter((a) => a.role.privateOnly).map((a) => a.manifest.name).sort();
    expect(priv).toEqual(["faris", "jasmine"]);
  });
});
