import { describe, it, expect } from "vitest";
import { withinCeiling } from "../src/packs/server.js";

describe("withinCeiling", () => {
  it("permits action types in the ceiling and refuses the rest", () => {
    const actions = ["vault.write", "email.draft"];
    expect(withinCeiling("vault.write", actions)).toBe(true);
    expect(withinCeiling("email.draft", actions)).toBe(true);
    expect(withinCeiling("finance.pay_bill", actions)).toBe(false);
    expect(withinCeiling("email.send", actions)).toBe(false);
  });
  it("refuses everything when the ceiling is empty", () => {
    expect(withinCeiling("vault.write", [])).toBe(false);
  });
});
