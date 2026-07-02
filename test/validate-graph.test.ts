// test/validate-graph.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { validateGraph } from "../src/engine/plan.js";
import type { GraphNodeSpec } from "../src/engine/compile.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "vg-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  const fin = join(agentsDir, "finance");
  mkdirSync(eng, { recursive: true });
  mkdirSync(fin, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  const agent = (name: string, extra = "") =>
    `name: ${name}\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n${extra}`;
  writeFileSync(join(eng, "athena.yaml"), agent("athena"));
  writeFileSync(join(eng, "vulcan.yaml"), agent("vulcan", "aliases: [developer]\n"));
  writeFileSync(join(eng, "argus.yaml"), agent("argus", "outputSchema: test-report\n"));
  writeFileSync(join(eng, "themis.yaml"), agent("themis")); // free-text reviewer — NOT a valid loop critic
  writeFileSync(join(fin, "department.yaml"),
    "department: finance\nmission: Money.\nlead: midas\nmemoDomain: money\nplaybooks: []\nprivateMemo: true\n");
  writeFileSync(join(fin, "midas.yaml"),
    "name: midas\ntitle: CFO\ndepartment: finance\ncharter: c.\npersona: p.\nprompt: x.\ntools: []\nvisibility: private\n");
  // verdict critic in engineering for loop tests
  writeFileSync(join(eng, "minos-eng.yaml"), agent("minos-eng", "outputSchema: verdict\n"));
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();
const PRIMARY = { channel: "telegram", chatId: "1" };
const ctx = (over = {}) => ({
  registry, department: "engineering",
  origin: { channel: "telegram", chatId: "1" }, primaryChat: PRIMARY, ...over,
});
const run = (key: string, deps: string[] = [], agent = "vulcan"): GraphNodeSpec =>
  ({ key, type: "run", agent, brief: "b", deps });

describe("validateGraph", () => {
  it("accepts a valid DAG and returns topological order", () => {
    const r = validateGraph([run("a"), run("b", ["a"]), run("c", ["a"])], ctx());
    expect(r).toEqual({ ok: true, order: ["a", "b", "c"] });
  });

  it("rejects cycles", () => {
    const r = validateGraph([run("a", ["b"]), run("b", ["a"])], ctx());
    expect(r.ok).toBe(false);
  });

  it("rejects unknown dep, dup key, bad key, node cap", () => {
    expect(validateGraph([run("a", ["nope"])], ctx()).ok).toBe(false);
    expect(validateGraph([run("a"), run("a")], ctx()).ok).toBe(false);
    expect(validateGraph([run("BadKey")], ctx()).ok).toBe(false);
    const many = Array.from({ length: 13 }, (_, i) => run(`n${i}`));
    expect(validateGraph(many, ctx()).ok).toBe(false);
  });

  it("rejects foreign-department agents; aliases canonicalize", () => {
    expect(validateGraph([run("a", [], "midas")], ctx()).ok).toBe(false);
    expect(validateGraph([run("a", [], "developer")], ctx()).ok).toBe(true);
  });

  it("loop needs a verdict critic; verify needs a test-report runner + fixer", () => {
    const loopOk: GraphNodeSpec = { key: "l", type: "loop", agent: "vulcan", critic: "minos-eng", brief: "b", deps: [] };
    const loopBad: GraphNodeSpec = { key: "l", type: "loop", agent: "vulcan", critic: "themis", brief: "b", deps: [] };
    const verifyOk: GraphNodeSpec = { key: "v", type: "verify", agent: "argus", critic: "vulcan", brief: "b", deps: [] };
    const verifyBadRunner: GraphNodeSpec = { key: "v", type: "verify", agent: "vulcan", critic: "vulcan", brief: "b", deps: [] };
    const verifyNoFixer: GraphNodeSpec = { key: "v", type: "verify", agent: "argus", brief: "b", deps: [] };
    expect(validateGraph([loopOk], ctx()).ok).toBe(true);
    expect(validateGraph([loopBad], ctx()).ok).toBe(false);
    expect(validateGraph([verifyOk], ctx()).ok).toBe(true);
    expect(validateGraph([verifyBadRunner], ctx()).ok).toBe(false);
    expect(validateGraph([verifyNoFixer], ctx()).ok).toBe(false);
  });

  it("private agents require a private origin, fail-closed", () => {
    const fin = ctx({ department: "finance" });
    expect(validateGraph([run("a", [], "midas")], fin).ok).toBe(true); // origin IS primary
    const finGroup = ctx({ department: "finance", origin: { channel: "telegram", chatId: "999" } });
    expect(validateGraph([run("a", [], "midas")], finGroup).ok).toBe(false);
    const noPrimary = ctx({ department: "finance", primaryChat: undefined });
    expect(validateGraph([run("a", [], "midas")], noPrimary).ok).toBe(false);
  });
});
