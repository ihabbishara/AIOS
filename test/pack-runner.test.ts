import { describe, it, expect } from "vitest";
import { roles } from "../src/agents/roles/index.js";
import { roleQueryOptions, packRunOptions } from "../src/agents/runner.js";
import type { ResolvedPack } from "../src/packs/resolve.js";

const fakePack: ResolvedPack = {
  pillar: "money",
  contextBlock: "## Pillar: money\nBe numerate.",
  tools: ["Read", "mcp__aios-pack__recall"],
  mcpServers: { "aios-pack": { __fake: true } as never },
};

describe("packRunOptions", () => {
  it("appends the pack context to systemPrompt, replaces allowedTools, adds mcpServers", () => {
    const base = roleQueryOptions(roles.researcher, { cwd: "/tmp" });
    const merged = packRunOptions(base, fakePack);
    expect(String(merged.systemPrompt)).toContain("Be numerate.");
    expect(String(merged.systemPrompt)).toContain(roles.researcher.systemPrompt.slice(0, 20)); // role prompt kept
    expect(merged.allowedTools).toEqual(["Read", "mcp__aios-pack__recall"]);
    expect(Object.keys(merged.mcpServers ?? {})).toContain("aios-pack");
  });
  it("is a pure function (does not mutate base)", () => {
    const base = roleQueryOptions(roles.researcher, { cwd: "/tmp" });
    const beforeTools = [...(base.allowedTools ?? [])];
    packRunOptions(base, fakePack);
    expect(base.allowedTools).toEqual(beforeTools);
  });
});
