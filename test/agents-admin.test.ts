// test/agents-admin.test.ts — hire/fire builders + loader archive-skip (spec 2026-07-20).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { loadConfig } from "../src/config.js";

function extras() {
  const config = loadConfig(process.cwd());
  return buildExtras({
    vaultPath: config.vaultPath, vaultSubdir: config.vaultSubdir,
    financeCompany: config.financeCompany, financeMembers: config.financeMembers,
  });
}

describe("loader skips _-prefixed dirs (the _retired/ archive)", () => {
  it("a manifest inside agents/_retired/ is not registered", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agents-"));
    cpSync("agents", tmp, { recursive: true });
    mkdirSync(join(tmp, "_retired"), { recursive: true });
    writeFileSync(join(tmp, "_retired", "zz-ghost.yaml"), [
      "name: zz-ghost", "title: Ghost", "department: engineering",
      "charter: >\n  ghost charter", "persona: >\n  ghost persona", "prompt: >\n  ghost prompt",
      "kind: worker", "capabilities: [files-ro]",
    ].join("\n"));
    const reg = loadRegistry(tmp, "playbooks", extras(), () => {});
    expect(reg.agents.has("zz-ghost")).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });
});
