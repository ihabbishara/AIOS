import { describe, it, expect } from "vitest";
import { packSchema } from "../src/packs/types.js";

const valid = {
  pillar: "money",
  persona: "You are the Money specialist.",
  memoDomain: "money",
  vaultSection: "money",
  tools: ["Read", "recall", "vault_write"],
  actions: ["vault.write", "email.draft"],
  roles: ["finance"],
  playbooks: ["subscription-audit"],
};

describe("packSchema", () => {
  it("parses a valid manifest", () => {
    const p = packSchema.parse(valid);
    expect(p.pillar).toBe("money");
    expect(p.tools).toContain("recall");
  });
  it("defaults vaultSection to the pillar and lists to empty", () => {
    const p = packSchema.parse({ pillar: "code", persona: "x", memoDomain: "code" });
    expect(p.vaultSection).toBe("code");
    expect(p.tools).toEqual([]);
    expect(p.actions).toEqual([]);
    expect(p.roles).toEqual([]);
    expect(p.playbooks).toEqual([]);
  });
  it("rejects a manifest missing pillar/persona/memoDomain", () => {
    expect(() => packSchema.parse({ pillar: "x", persona: "y" })).toThrow();
  });
});
