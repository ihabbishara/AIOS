// test/code-pack-loader.test.ts
import { describe, it, expect } from "vitest";
import { loadPacks } from "../src/packs/loader.js";
import { join } from "node:path";

describe("code pack loads", () => {
  const reg = loadPacks(join(process.cwd(), "playbooks"));
  it("registers the code pillar with sandbox + vault.write ceiling", () => {
    const pack = reg.packs.get("code");
    expect(pack?.sandbox).toBe(true);
    expect(pack?.actions).toEqual(["vault.write"]);
    expect(pack?.tools).toContain("mcp__code__sh");
    expect(pack?.tools).not.toContain("Bash");
  });
  it("owns code-build and code-analyze", () => {
    expect(reg.playbooks.has("code-build")).toBe(true);
    expect(reg.playbooks.has("code-analyze")).toBe(true);
    expect(reg.pillarOf.get("code-build")).toBe("code");
  });
  it("maps devops uniquely to code (roleOf)", () => {
    expect(reg.roleOf.get("devops")).toBe("code");
  });
});
