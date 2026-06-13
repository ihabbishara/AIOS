import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("memory tools registration", () => {
  it("session MCP_TOOLS includes recall/remember/forget", () => {
    const src = readFileSync(new URL("../src/moderator/session.ts", import.meta.url), "utf8");
    expect(src).toContain("mcp__aios__recall");
    expect(src).toContain("mcp__aios__remember");
    expect(src).toContain("mcp__aios__forget");
  });
  it("tools.ts registers the three tools in the server", () => {
    const src = readFileSync(new URL("../src/moderator/tools.ts", import.meta.url), "utf8");
    expect(src).toMatch(/"recall"/);
    expect(src).toMatch(/"remember"/);
    expect(src).toMatch(/"forget"/);
  });
});
