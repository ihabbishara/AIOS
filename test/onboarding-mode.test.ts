// test/onboarding-mode.test.ts — bootMode: token presence × org presence (spec §1).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootMode, countAgentManifests } from "../src/onboarding/mode.js";

function orgDir(withAgent: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "mode-"));
  mkdirSync(join(dir, "ops"));
  writeFileSync(join(dir, "ops", "department.yaml"), "department: ops\n");
  writeFileSync(join(dir, "_capabilities.yaml"), "web: { tools: [WebSearch] }\n");
  mkdirSync(join(dir, "_retired"));
  writeFileSync(join(dir, "_retired", "old.yaml"), "name: old\n");
  if (withAgent) writeFileSync(join(dir, "ops", "neo.yaml"), "name: neo\n");
  return dir;
}
const TOKEN = { CLAUDE_CODE_OAUTH_TOKEN: "tok" } as NodeJS.ProcessEnv;
const NO_TOKEN = {} as NodeJS.ProcessEnv;

describe("countAgentManifests", () => {
  it("counts agent yamls only — not department.yaml, _capabilities.yaml, or _retired/", () => {
    expect(countAgentManifests(orgDir(true))).toBe(1);
    expect(countAgentManifests(orgDir(false))).toBe(0);
    expect(countAgentManifests(join(tmpdir(), "does-not-exist-xyz"))).toBe(0);
  });
});

describe("bootMode", () => {
  it("setup when token missing, regardless of org", () => {
    expect(bootMode(NO_TOKEN, orgDir(true))).toBe("setup");
  });
  it("setup when org empty, despite token", () => {
    expect(bootMode(TOKEN, orgDir(false))).toBe("setup");
  });
  it("normal when token present and org non-empty", () => {
    expect(bootMode(TOKEN, orgDir(true))).toBe("normal");
  });
  it("ANTHROPIC_API_KEY also counts as auth (matches assertAuth)", () => {
    expect(bootMode({ ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv, orgDir(true))).toBe("normal");
  });
});
