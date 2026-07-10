import { describe, it, expect } from "vitest";
import { roleOf } from "./fixtures/registry.js";
import { roleQueryOptions, packRunOptions } from "../src/agents/runner.js";
import type { ResolvedPack } from "../src/packs/resolve.js";
import { DirectChats } from "../src/agents/direct.js";
import { testRegistry } from "./fixtures/registry.js";

const fakePack: ResolvedPack = {
  pillar: "money",
  contextBlock: "## Pillar: money\nBe numerate.",
  tools: ["Read", "mcp__aios-pack__recall"],
  mcpServers: { "aios-pack": { __fake: true } as never },
};

describe("packRunOptions", () => {
  it("appends the pack context to systemPrompt, replaces allowedTools, adds mcpServers", () => {
    const base = roleQueryOptions(roleOf("researcher"), { cwd: "/tmp" });
    const merged = packRunOptions(base, fakePack);
    expect(String(merged.systemPrompt)).toContain("Be numerate.");
    expect(String(merged.systemPrompt)).toContain(roleOf("researcher").systemPrompt.slice(0, 20)); // role prompt kept
    expect(merged.allowedTools).toEqual(["Read", "mcp__aios-pack__recall"]);
    expect(Object.keys(merged.mcpServers ?? {})).toContain("aios-pack");
  });
  it("is a pure function (does not mutate base)", () => {
    const base = roleQueryOptions(roleOf("researcher"), { cwd: "/tmp" });
    const beforeTools = [...(base.allowedTools ?? [])];
    packRunOptions(base, fakePack);
    expect(base.allowedTools).toEqual(beforeTools);
  });
});

describe("direct chat pack resolver", () => {
  it("DirectChats accepts an optional resolvePackFor dep without breaking construction", () => {
    const calls: string[] = [];
    const dc = new DirectChats({
      store: {} as never, bus: { emit() {} } as never, projectsRoot: "/tmp",
      registry: testRegistry(),
      resolvePackFor: (role) => { calls.push(role); return undefined; },
    });
    expect(dc).toBeTruthy();
  });
});
