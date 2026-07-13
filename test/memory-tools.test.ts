import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { teachingDomain } from "../src/moderator/tools.js";

describe("teachingDomain routing", () => {
  it("routes facts to profile, forgets to given/null, prefs to given/general", () => {
    expect(teachingDomain("fact", "money")).toBe(null);
    expect(teachingDomain("preference")).toBe("general");
    expect(teachingDomain("preference", "money")).toBe("money");
    expect(teachingDomain("forget")).toBe(null);
    expect(teachingDomain("forget", "inbox")).toBe("inbox");
  });
});

describe("memory tools registration", () => {
  it("the coordination capability includes recall/remember/forget", () => {
    const src = readFileSync(new URL("../agents/_capabilities.yaml", import.meta.url), "utf8");
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
