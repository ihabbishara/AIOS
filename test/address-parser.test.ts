// test/address-parser.test.ts — THE one address parser (org-model spec §8), table-driven.
import { describe, it, expect } from "vitest";
import { parseAddress } from "../src/agents/direct.js";

const names = ["halalo", "market-researcher", "cfo"];

describe("parseAddress", () => {
  const cases: Array<[string, { requireAt?: boolean } | undefined, string | undefined, string?]> = [
    // [input, opts, expected role, expected remaining text]
    ["@halalo how are sales?", undefined, "halalo", "how are sales?"],
    ["halalo: how are sales?", undefined, "halalo", "how are sales?"],
    ["halalo, how are sales?", undefined, "halalo", "how are sales?"],
    ["Hey team\n@halalo status?", undefined, "halalo", "Hey team\n status?"],
    ["@Market-Researcher: sizing please", undefined, "market-researcher", "sizing please"],
    ["finance: revenue up 10%", undefined, undefined],            // not a known name
    ["email halalo@example.com about it", undefined, undefined],  // emails never match
    ["@halalo", undefined, undefined],                            // bare mention, no message
    // bound groups: @ required — bare prefix no longer hijacks ordinary text
    ["halalo: how are sales?", { requireAt: true }, undefined],
    ["@halalo how are sales?", { requireAt: true }, "halalo", "how are sales?"],
    ["quick one @cfo runway?", { requireAt: true }, "cfo", "quick one  runway?"],
  ];
  for (const [input, opts, role, text] of cases) {
    it(`${JSON.stringify(input)}${opts?.requireAt ? " (bound)" : ""} → ${role ?? "no match"}`, () => {
      const r = parseAddress(input, names, opts);
      if (!role) expect(r).toBeUndefined();
      else {
        expect(r!.role).toBe(role);
        if (text !== undefined) expect(r!.text).toBe(text);
      }
    });
  }

  it("empty names list never matches", () => {
    expect(parseAddress("@halalo hi", [])).toBeUndefined();
  });
});
