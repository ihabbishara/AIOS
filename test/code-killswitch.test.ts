import { describe, it, expect } from "vitest";
import { dropDepartment } from "../src/agents/registry/loader.js";
import type { LoadedRegistry } from "../src/agents/registry/loader.js";

describe("kill-switch removes the engineering department from the registry", () => {
  it("dropDepartment('engineering') deletes dept + its agents + aliases + playbooks", () => {
    const maya = {
      manifest: { name: "maya", title: "t", department: "engineering", charter: "c", persona: "p", prompt: "s",
        tools: [], guards: [], skills: [], capabilities: [], kind: "coordinator" as const, maxTurns: 80, permissionMode: "bypassPermissions" as const, visibility: "shared" as const, aliases: ["developer"] },
      role: { name: "maya", description: "d", systemPrompt: "s", allowedTools: [], permissionMode: "bypassPermissions" as const, maxTurns: 80 },
      department: "engineering",
      kind: "coordinator" as const, capabilities: [],
    };
    const reg: LoadedRegistry = {
      agents: new Map([["maya", maya]]),
      departments: new Map([["engineering", {
        department: "engineering", mission: "m", memoDomain: "code", vaultSection: "code",
        tools: [], sandbox: true, actions: ["vault.write"], capabilities: [], playbooks: ["code-build"], toolServers: [], toolsUnion: [], privateMemo: false,
      }]]),
      agentOf: new Map([["maya", "maya"], ["developer", "maya"]]),
      ownerOfPlaybook: new Map([["code-build", "engineering"]]),
      playbooks: new Map([["code-build", {} as any]]),
      capabilities: new Map(), coordinator: "maya",
    };
    dropDepartment(reg, "engineering");
    expect(reg.departments.has("engineering")).toBe(false);
    expect(reg.agents.has("maya")).toBe(false);
    expect(reg.agentOf.has("developer")).toBe(false);
    expect(reg.playbooks.has("code-build")).toBe(false);
    expect(reg.ownerOfPlaybook.has("code-build")).toBe(false);
  });
});
