import { describe, it, expect } from "vitest";
import { parseDirectAddress, findAgentMention } from "../src/agents/direct.js";
import { testRegistry } from "./fixtures/registry.js";

// Snapshot the registry names once so every assertion uses the live agent tree.
const registryNames = [...testRegistry().agentOf.keys()];

describe("findAgentMention", () => {
  const agents = ["finance", "halalo"];

  it("matches a prefix mention", () => {
    expect(findAgentMention("@finance I paid 30 for hosting", agents)).toEqual({
      role: "finance",
      text: "I paid 30 for hosting",
    });
  });

  it("matches a mention on a later line (greeting first)", () => {
    const res = findAgentMention("جامد فشخ \n@halalo give me customer name of last order", agents);
    expect(res?.role).toBe("halalo");
    expect(res?.text).toContain("give me customer name of last order");
    expect(res?.text).not.toContain("@halalo");
  });

  it("matches mid-sentence mentions", () => {
    expect(findAgentMention("hey @finance what did we spend this month?", agents)?.role).toBe("finance");
  });

  it("ignores messages without a mention", () => {
    expect(findAgentMention("let's grab lunch at 1pm", agents)).toBeUndefined();
    expect(findAgentMention("email finance@idama.com about it", agents)).toBeUndefined();
  });
});

describe("parseDirectAddress", () => {
  it("parses @role prefix", () => {
    expect(parseDirectAddress("@architect how should we structure the cache?", registryNames)).toEqual({
      role: "architect",
      text: "how should we structure the cache?",
    });
  });

  it("parses role: prefix without @", () => {
    expect(parseDirectAddress("researcher: compare sqlite vs duckdb", registryNames)).toEqual({
      role: "researcher",
      text: "compare sqlite vs duckdb",
    });
  });

  it("is case-insensitive and handles hyphenated roles", () => {
    expect(parseDirectAddress("@Code-Reviewer look at the last diff", registryNames)).toEqual({
      role: "code-reviewer",
      text: "look at the last diff",
    });
  });

  it("parses the new specialist roles", () => {
    expect(parseDirectAddress("@market-researcher size the meal-kit market in NL", registryNames)?.role).toBe("market-researcher");
    expect(parseDirectAddress("@ui-ux-designer sketch the onboarding flow", registryNames)?.role).toBe("ui-ux-designer");
  });

  it("returns undefined for normal moderator messages", () => {
    expect(parseDirectAddress("let's build a new feature", registryNames)).toBeUndefined();
    expect(parseDirectAddress("@someoneelse hello", registryNames)).toBeUndefined();
    expect(parseDirectAddress("email architect@company.com about it", registryNames)).toBeUndefined();
  });

  it("requires text after the role", () => {
    expect(parseDirectAddress("@architect", registryNames)).toBeUndefined();
  });
});
