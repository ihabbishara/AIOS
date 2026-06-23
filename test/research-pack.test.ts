// test/research-pack.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { loadPacks, dropPack } from "../src/packs/loader.js";

const PB = join(process.cwd(), "playbooks");

describe("research pack", () => {
  it("registers the research pillar from disk", () => {
    const reg = loadPacks(PB);
    const pack = reg.packs.get("research")!;
    expect(pack).toBeTruthy();
    expect(pack.toolServer).toBe("research");
    expect(pack.actions).toEqual(["vault.write"]);
    expect(pack.sandbox).toBeFalsy();
    expect(pack.memoDomain).toBe("research");
    expect(pack.vaultSection).toBe("knowledge");
    // owns its three playbooks via pillarOf
    for (const pb of ["research-report", "market-research", "product-design"]) {
      expect(reg.pillarOf.get(pb)).toBe("research");
      expect(reg.playbooks.has(pb)).toBe(true);
    }
  });

  it("binds solo roles to research; shared roles (also in code) drop from roleOf", () => {
    const reg = loadPacks(PB);
    expect(reg.roleOf.get("analyst")).toBe("research");
    expect(reg.roleOf.get("market-researcher")).toBe("research");
    expect(reg.roleOf.get("ui-ux-designer")).toBe("research");
    // researcher + reviewer are in BOTH code and research → no single owner → absent from roleOf
    expect(reg.roleOf.has("researcher")).toBe(false);
    expect(reg.roleOf.has("reviewer")).toBe(false);
  });

  it("leaves money + code packs intact", () => {
    const reg = loadPacks(PB);
    expect(reg.packs.get("money")?.toolServer).toBe("money");
    expect(reg.packs.get("code")?.sandbox).toBe(true);
    expect(reg.roleOf.get("cfo")).toBe("money");
    expect(reg.roleOf.get("devops")).toBe("code");
  });

  it("AIOS_RESEARCH_DISABLED drops the research pack + its playbooks + solo roleOf", () => {
    const reg = loadPacks(PB);
    dropPack(reg, "research");
    expect(reg.packs.has("research")).toBe(false);
    expect(reg.playbooks.has("research-report")).toBe(false);
    expect(reg.pillarOf.has("research-report")).toBe(false);
    expect(reg.roleOf.has("analyst")).toBe(false);
    expect(reg.roleOf.has("market-researcher")).toBe(false);
    // code + money survive
    expect(reg.packs.has("code")).toBe(true);
    expect(reg.packs.has("money")).toBe(true);
  });
});
