import { describe, it, expect } from "vitest";
import { parseDirectAddress } from "../src/agents/direct.js";

describe("parseDirectAddress", () => {
  it("parses @role prefix", () => {
    expect(parseDirectAddress("@architect how should we structure the cache?")).toEqual({
      role: "architect",
      text: "how should we structure the cache?",
    });
  });

  it("parses role: prefix without @", () => {
    expect(parseDirectAddress("researcher: compare sqlite vs duckdb")).toEqual({
      role: "researcher",
      text: "compare sqlite vs duckdb",
    });
  });

  it("is case-insensitive and handles hyphenated roles", () => {
    expect(parseDirectAddress("@Code-Reviewer look at the last diff")).toEqual({
      role: "code-reviewer",
      text: "look at the last diff",
    });
  });

  it("parses the new specialist roles", () => {
    expect(parseDirectAddress("@market-researcher size the meal-kit market in NL")?.role).toBe("market-researcher");
    expect(parseDirectAddress("@ui-ux-designer sketch the onboarding flow")?.role).toBe("ui-ux-designer");
  });

  it("returns undefined for normal moderator messages", () => {
    expect(parseDirectAddress("let's build a new feature")).toBeUndefined();
    expect(parseDirectAddress("@someoneelse hello")).toBeUndefined();
    expect(parseDirectAddress("email architect@company.com about it")).toBeUndefined();
  });

  it("requires text after the role", () => {
    expect(parseDirectAddress("@architect")).toBeUndefined();
  });
});
