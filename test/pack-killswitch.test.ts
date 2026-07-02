// test/pack-killswitch.test.ts
import { describe, it, expect } from "vitest";
import { loadRegistry, dropDepartment } from "../src/agents/registry/loader.js";
import type { LoadedRegistry } from "../src/agents/registry/loader.js";

function reg(): LoadedRegistry {
  const engineering = {
    department: "engineering", mission: "Build software.", memoDomain: "code",
    vaultSection: "code", tools: [], sandbox: true, actions: ["vault.write"], playbooks: ["code-build"],
    toolServer: undefined, toolServers: [], toolsUnion: [],
  };
  const finance = {
    department: "finance", mission: "Money.", memoDomain: "money",
    vaultSection: "money", tools: [], sandbox: false, actions: [], playbooks: [],
    toolServer: undefined, toolServers: [], toolsUnion: [],
  };
  const maya = {
    manifest: { name: "maya", title: "Engineer", department: "engineering", charter: "c", persona: "p", prompt: "s",
      tools: [], guards: [], skills: [], maxTurns: 80, permissionMode: "bypassPermissions" as const, visibility: "shared" as const, aliases: ["developer"] },
    role: { name: "maya", description: "d", systemPrompt: "s", allowedTools: [], permissionMode: "bypassPermissions" as const, maxTurns: 80 },
    department: "engineering",
  };
  const faris = {
    manifest: { name: "faris", title: "CFO", department: "finance", charter: "c", persona: "p", prompt: "s",
      tools: [], guards: [], skills: [], maxTurns: 20, permissionMode: "dontAsk" as const, visibility: "shared" as const, aliases: ["cfo"] },
    role: { name: "faris", description: "d", systemPrompt: "s", allowedTools: [], permissionMode: "dontAsk" as const, maxTurns: 20 },
    department: "finance",
  };
  return {
    agents: new Map<string, any>([["maya", maya], ["faris", faris]]),
    departments: new Map([["engineering", engineering], ["finance", finance]]),
    agentOf: new Map([["maya", "maya"], ["developer", "maya"], ["faris", "faris"], ["cfo", "faris"]]),
    ownerOfPlaybook: new Map([["code-build", "engineering"]]),
    playbooks: new Map([["code-build", {} as any]]),
  };
}

describe("dropDepartment", () => {
  it("drops engineering: agents, aliases, playbooks; leaves finance", () => {
    const r = reg();
    dropDepartment(r, "engineering");
    expect(r.departments.has("engineering")).toBe(false);
    expect(r.agents.has("maya")).toBe(false);
    expect(r.agentOf.has("developer")).toBe(false);
    expect(r.playbooks.has("code-build")).toBe(false);
    expect(r.ownerOfPlaybook.has("code-build")).toBe(false);
    // finance untouched
    expect(r.departments.has("finance")).toBe(true);
    expect(r.agents.has("faris")).toBe(true);
    expect(r.agentOf.get("cfo")).toBe("faris");
  });

  it("drops finance independently", () => {
    const r = reg();
    dropDepartment(r, "finance");
    expect(r.departments.has("finance")).toBe(false);
    expect(r.agents.has("faris")).toBe(false);
    expect(r.departments.has("engineering")).toBe(true);
  });

  it("is a no-op for an absent department", () => {
    const r = reg();
    expect(() => dropDepartment(r, "nope")).not.toThrow();
    expect(r.departments.size).toBe(2);
  });
});
