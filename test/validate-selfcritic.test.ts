// test/validate-selfcritic.test.ts — producer≠critic / runner≠fixer (verification-hardening §5).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { validateGraph } from "../src/engine/plan.js";
import type { GraphNodeSpec } from "../src/engine/compile.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "vsc-"));
  const eng = join(root, "agents", "engineering");
  mkdirSync(eng, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  const agents: Array<[string, string]> = [
    ["athena", "kind: coordinator\n"],
    ["vulcan", ""],
    ["minos", "outputSchema: verdict\n"],
    ["janus", "outputSchema: verdict\naliases: [two-face]\n"],
    ["argus", "outputSchema: test-report\n"],
  ];
  for (const [n, extra] of agents) {
    writeFileSync(join(eng, `${n}.yaml`),
      `name: ${n}\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n${extra}`);
  }
  return loadRegistry(join(root, "agents"), join(root, "playbooks"));
}

const registry = fixtureRegistry();
const ctx = { registry, department: "engineering", origin: { channel: "telegram", chatId: "1" } };
const N = (over: Partial<GraphNodeSpec>): GraphNodeSpec =>
  ({ key: "a", type: "run", agent: "vulcan", brief: "b", deps: [], ...over });

describe("validateGraph — no self-approval (spec §5)", () => {
  it("rejects a loop whose producer is its own critic", () => {
    const r = validateGraph([N({ type: "loop", agent: "minos", critic: "minos" })], ctx);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("no self-approval");
  });

  it("catches self-approval hidden behind an alias", () => {
    const r = validateGraph([N({ type: "loop", agent: "janus", critic: "two-face" })], ctx);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("no self-approval");
  });

  it("rejects a verify whose runner is its own fixer", () => {
    const r = validateGraph([N({ type: "verify", agent: "argus", critic: "argus" })], ctx);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("no self-verification");
  });

  it("accepts a loop with a distinct (foreign) critic and a verify with a distinct fixer", () => {
    expect(validateGraph([N({ type: "loop", agent: "vulcan", critic: "minos" })], ctx)).toMatchObject({ ok: true });
    expect(validateGraph([N({ type: "verify", agent: "argus", critic: "vulcan" })], ctx)).toMatchObject({ ok: true });
  });
});
