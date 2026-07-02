import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { GoalEngine } from "../src/engine/goals.js";

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "pb-"));
  const agents = join(root, "agents");
  const pbs = join(root, "playbooks");
  mkdirSync(join(agents, "finance"), { recursive: true });
  mkdirSync(pbs, { recursive: true });
  writeFileSync(join(pbs, "echo.yaml"),
    "name: echo\ndescription: echo\nstages:\n  - { type: single, id: s1, role: ziad }\n");
  writeFileSync(join(agents, "finance", "department.yaml"),
    "department: finance\nmission: Money specialist.\nmemoDomain: money\nplaybooks: [sub-audit]\n");
  writeFileSync(join(agents, "finance", "faris.yaml"),
    "name: faris\ntitle: CFO\ndepartment: finance\ncharter: Manages money.\npersona: Precise.\nprompt: You are the CFO.\ntools: [Read]\nmaxTurns: 20\n");
  writeFileSync(join(pbs, "sub-audit.yaml"),
    "name: sub-audit\ndescription: audit subs\nstages:\n  - { type: single, id: s1, role: faris }\n");
  return { root, agents, pbs };
}

describe("loadRegistry (replaces loadPacks)", () => {
  it("loads flat + department playbooks into one map and builds the registry", () => {
    const { root, agents, pbs } = scaffold();
    const reg = loadRegistry(agents, pbs);
    expect([...reg.playbooks.keys()].sort()).toEqual(["echo", "sub-audit"]);
    expect(reg.departments.get("finance")?.mission).toContain("Money");
    expect(reg.ownerOfPlaybook.get("sub-audit")).toBe("finance");
    expect(reg.ownerOfPlaybook.get("echo")).toBeUndefined();
    expect(reg.agentOf.get("faris")).toBe("faris");
    rmSync(root, { recursive: true, force: true });
  });

  it("skips a department whose manifest references a missing playbook file (logged, not thrown)", () => {
    const root = mkdtempSync(join(tmpdir(), "pb-"));
    const agents = join(root, "agents");
    const pbs = join(root, "playbooks");
    mkdirSync(join(agents, "bad"), { recursive: true });
    mkdirSync(pbs, { recursive: true });
    writeFileSync(join(agents, "bad", "department.yaml"),
      "department: bad\nmission: x\nmemoDomain: bad\nplaybooks: [does-not-exist]\n");
    const logs: string[] = [];
    const reg = loadRegistry(agents, pbs, {}, (l) => logs.push(l));
    expect(reg.departments.has("bad")).toBe(false);
    expect(logs.join(" ")).toMatch(/bad/);
    rmSync(root, { recursive: true, force: true });
  });

  it("skips a broken symlink entry without aborting the load", () => {
    const { root, agents, pbs } = scaffold();
    symlinkSync(join(root, "does-not-exist-target"), join(agents, "broken-link"));
    const logs: string[] = [];
    const reg = loadRegistry(agents, pbs, {}, (l) => logs.push(l));
    expect([...reg.playbooks.keys()].sort()).toEqual(["echo", "sub-audit"]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("listPlaybooks department grouping", () => {
  it("annotates each playbook with its department (or undefined when packless)", () => {
    const { root, agents, pbs } = scaffold();
    const reg = loadRegistry(agents, pbs);
    const jm = new GoalEngine({
      store: {} as never, vault: {} as never, run: (async () => ({})) as never, registry: reg,
      playbooks: reg.playbooks, wallTimeMs: 1, maxConcurrentNodes: 0,
      spendGuard: {} as never, onComplete: async () => {}, resolveDeptFor: () => undefined,
    });
    const list = jm.listPlaybooks();
    expect(list.find((p) => p.name === "sub-audit")?.pillar).toBe("finance");
    expect(list.find((p) => p.name === "echo")?.pillar).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});
