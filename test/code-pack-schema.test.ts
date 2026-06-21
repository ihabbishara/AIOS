import { describe, it, expect } from "vitest";
import { packSchema } from "../src/packs/types.js";

describe("packSchema sandbox flag", () => {
  it("defaults sandbox to false", () => {
    const p = packSchema.parse({ pillar: "x", persona: "p", memoDomain: "x" });
    expect(p.sandbox).toBe(false);
  });
  it("accepts sandbox: true", () => {
    const p = packSchema.parse({ pillar: "code", persona: "p", memoDomain: "code", sandbox: true });
    expect(p.sandbox).toBe(true);
  });
});
