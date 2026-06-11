import { describe, it, expect } from "vitest";
import { parseMembers } from "../src/config.js";

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
