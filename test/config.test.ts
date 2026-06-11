import { describe, it, expect } from "vitest";
import { parseMembers, parseBindings } from "../src/config.js";

describe("parseBindings", () => {
  it("parses default agent plus @-addressable extras", () => {
    const map = parseBindings("telegram:-5137644671=finance|halalo, slack:C123=finance");
    expect(map.get("telegram:-5137644671")).toEqual({ agents: ["finance", "halalo"], mentionOnly: false });
    expect(map.get("slack:C123")).toEqual({ agents: ["finance"], mentionOnly: false });
  });

  it("parses mention-only bindings (@-prefixed)", () => {
    const map = parseBindings("telegram:-5137644671=@finance|@halalo");
    expect(map.get("telegram:-5137644671")).toEqual({ agents: ["finance", "halalo"], mentionOnly: true });
  });

  it("returns empty for unset", () => {
    expect(parseBindings(undefined).size).toBe(0);
  });
});

describe("parseMembers", () => {
  it("parses name:handle pairs and bare names", () => {
    expect(parseMembers("Ihab:theAmsterdamer, Amr:amr_tg, Sara")).toEqual([
      { name: "Ihab", handle: "theAmsterdamer" },
      { name: "Amr", handle: "amr_tg" },
      { name: "Sara" },
    ]);
  });

  it("strips @ prefix from handles", () => {
    expect(parseMembers("Akram:@iAZak")).toEqual([{ name: "Akram", handle: "iAZak" }]);
  });

  it("returns empty for unset", () => {
    expect(parseMembers(undefined)).toEqual([]);
    expect(parseMembers("")).toEqual([]);
  });
});
