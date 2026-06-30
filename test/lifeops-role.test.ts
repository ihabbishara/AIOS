import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { roles } from "../src/agents/roles/index.js";
import { loadPacks } from "../src/packs/loader.js";

const PB = join(process.cwd(), "playbooks");

describe("jasmine role", () => {
  it("exists, is privateOnly, and carries no write tools", () => {
    const j = roles.jasmine;
    expect(j).toBeDefined();
    expect(j.privateOnly).toBe(true);
    expect(j.permissionMode).toBe("dontAsk");
    // no Bash/Edit/Write on the base role (pack manifest replaces allowedTools at resolve time)
    expect(j.allowedTools).not.toContain("Bash");
    expect(j.allowedTools).not.toContain("Edit");
    expect(j.allowedTools).not.toContain("Write");
  });
});

describe("lifeops pack manifest", () => {
  it("loads, binds jasmine solo to lifeops, actions empty, not sandboxed", () => {
    const reg = loadPacks(PB);
    const lifeops = reg.packs.get("lifeops");
    expect(lifeops).toBeDefined();
    expect(lifeops!.actions).toEqual([]);
    expect(lifeops!.sandbox ?? false).toBe(false);
    expect(lifeops!.toolServer).toBe("lifeops");
    expect(reg.roleOf.get("jasmine")).toBe("lifeops");
  });
});
