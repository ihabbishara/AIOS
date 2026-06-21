import { describe, it, expect } from "vitest";
import { dropCodePack } from "../src/packs/loader.js";

describe("kill-switch removes the code pack from the registry", () => {
  it("dropCodePack deletes pillar + its playbooks + roleOf entries", () => {
    const reg = {
      packs: new Map([["code", { pillar: "code", roles: ["devops"], playbooks: ["code-build"] } as any]]),
      pillarOf: new Map([["code-build", "code"]]),
      roleOf: new Map([["devops", "code"]]),
      playbooks: new Map([["code-build", {} as any]]),
    };
    dropCodePack(reg as any);
    expect(reg.packs.has("code")).toBe(false);
    expect(reg.playbooks.has("code-build")).toBe(false);
    expect(reg.pillarOf.has("code-build")).toBe(false);
    expect(reg.roleOf.has("devops")).toBe(false);
  });
});
