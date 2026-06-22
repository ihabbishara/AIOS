// test/pack-killswitch.test.ts
import { describe, it, expect } from "vitest";
import type { LoadedPacks } from "../src/packs/loader.js";
import { dropPack, dropCodePack } from "../src/packs/loader.js";

function reg(): LoadedPacks {
  return {
    packs: new Map([
      ["code", { pillar: "code", roles: ["devops", "developer"], playbooks: ["code-build"] } as any],
      ["money", { pillar: "money", roles: ["cfo"], playbooks: [] } as any],
    ]),
    pillarOf: new Map([["code-build", "code"]]),
    roleOf: new Map([["devops", "code"], ["developer", "code"], ["cfo", "money"]]),
    playbooks: new Map([["code-build", {} as any]]),
  };
}

describe("dropPack", () => {
  it("drops a named pillar's pack, playbooks, and roleOf entries; leaves others", () => {
    const r = reg();
    dropPack(r, "code");
    expect(r.packs.has("code")).toBe(false);
    expect(r.playbooks.has("code-build")).toBe(false);
    expect(r.pillarOf.has("code-build")).toBe(false);
    expect(r.roleOf.has("devops")).toBe(false);
    expect(r.roleOf.has("developer")).toBe(false);
    // money untouched
    expect(r.packs.has("money")).toBe(true);
    expect(r.roleOf.get("cfo")).toBe("money");
  });

  it("drops money independently", () => {
    const r = reg();
    dropPack(r, "money");
    expect(r.packs.has("money")).toBe(false);
    expect(r.roleOf.has("cfo")).toBe(false);
    expect(r.packs.has("code")).toBe(true);
  });

  it("is a no-op for an absent pillar", () => {
    const r = reg();
    expect(() => dropPack(r, "nope")).not.toThrow();
    expect(r.packs.size).toBe(2);
  });

  it("dropCodePack is dropPack(reg,'code')", () => {
    const r = reg();
    dropCodePack(r);
    expect(r.packs.has("code")).toBe(false);
    expect(r.packs.has("money")).toBe(true);
  });
});
