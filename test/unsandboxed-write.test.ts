import { describe, it, expect } from "vitest";
import { isUnsandboxedWrite, stageRoles } from "../src/engine/jobs.js";
import type { Playbook } from "../src/engine/playbook.js";
import { testRegistry } from "./fixtures/registry.js";

const inplacePb: Playbook = {
  name: "code-inplace",
  description: "x",
  needsProjectDir: true,
  stages: [
    { type: "single", id: "research", role: "researcher" },
    { type: "loop", id: "design", producer: "architect", critic: "reviewer", maxRounds: 3 },
    { type: "single", id: "implement", role: "developer" },
    { type: "verify", id: "test", runner: "tester", fixer: "developer", maxRounds: 2 },
    { type: "single", id: "code-review", role: "code-reviewer" },
  ],
};

describe("stageRoles", () => {
  it("extracts roles from every stage shape", () => {
    expect(stageRoles({ type: "single", id: "a", role: "developer" })).toEqual(["developer"]);
    expect(stageRoles({ type: "loop", id: "b", producer: "architect", critic: "reviewer", maxRounds: 3 }))
      .toEqual(["architect", "reviewer"]);
    expect(stageRoles({ type: "verify", id: "c", runner: "tester", fixer: "developer", maxRounds: 2 }))
      .toEqual(["tester", "developer"]);
  });
});

describe("isUnsandboxedWrite", () => {
  it("flags a packless playbook that uses a bypassPermissions write role", () => {
    expect(isUnsandboxedWrite(inplacePb, new Map(), testRegistry())).toBe(true);
    expect(isUnsandboxedWrite(inplacePb, undefined, testRegistry())).toBe(true);
  });

  it("does NOT flag a playbook that has a pack pillar", () => {
    expect(isUnsandboxedWrite(inplacePb, new Map([["code-inplace", "code"]]), testRegistry())).toBe(false);
  });

  it("does NOT flag a packless playbook with only read/dontAsk roles", () => {
    const readOnly: Playbook = {
      name: "echo", description: "x", needsProjectDir: false,
      stages: [{ type: "single", id: "a", role: "researcher" }],
    };
    expect(isUnsandboxedWrite(readOnly, new Map(), testRegistry())).toBe(false);
  });

  it("pin: canonical name 'maya' (bypassPermissions) is classified as unsandboxed write via registry", () => {
    const canonicalPb: Playbook = {
      name: "canonical-test", description: "x", needsProjectDir: false,
      stages: [{ type: "single", id: "impl", role: "maya" }],
    };
    expect(isUnsandboxedWrite(canonicalPb, new Map(), testRegistry())).toBe(true);
  });

  it("throws when called without registry (fail-closed)", () => {
    expect(() => isUnsandboxedWrite(inplacePb, new Map())).toThrow(/registry is required/);
  });
});
