import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPacks } from "../src/packs/loader.js";
import { JobManager } from "../src/engine/jobs.js";

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), "pb-"));
  writeFileSync(join(root, "echo.yaml"), "name: echo\ndescription: echo\nstages:\n  - { type: single, id: s1, role: researcher }\n");
  mkdirSync(join(root, "money"));
  writeFileSync(join(root, "money", "pack.yaml"),
    "pillar: money\npersona: Money specialist.\nmemoDomain: money\ntools: [Read, recall]\nactions: [vault.write]\nroles: [finance]\nplaybooks: [sub-audit]\n");
  writeFileSync(join(root, "money", "sub-audit.yaml"),
    "name: sub-audit\ndescription: audit subs\nstages:\n  - { type: single, id: s1, role: finance }\n");
  return root;
}

describe("loadPacks", () => {
  it("loads flat + pack playbooks into one map and builds the registry", () => {
    const root = scaffold();
    const { playbooks, packs, pillarOf, roleOf } = loadPacks(root);
    expect([...playbooks.keys()].sort()).toEqual(["echo", "sub-audit"]);
    expect(packs.get("money")?.persona).toContain("Money");
    expect(pillarOf.get("sub-audit")).toBe("money");
    expect(pillarOf.get("echo")).toBeUndefined();
    expect(roleOf.get("finance")).toBe("money");
    rmSync(root, { recursive: true, force: true });
  });

  it("skips a pack whose manifest references a missing playbook file (logged, not thrown)", () => {
    const root = mkdtempSync(join(tmpdir(), "pb-"));
    mkdirSync(join(root, "bad"));
    writeFileSync(join(root, "bad", "pack.yaml"),
      "pillar: bad\npersona: x\nmemoDomain: bad\nplaybooks: [does-not-exist]\n");
    const logs: string[] = [];
    const { packs } = loadPacks(root, (l) => logs.push(l));
    expect(packs.has("bad")).toBe(false);
    expect(logs.join(" ")).toMatch(/bad/);
    rmSync(root, { recursive: true, force: true });
  });

  it("skips a duplicate pillar (second one logged, first kept)", () => {
    const root = mkdtempSync(join(tmpdir(), "pb-"));
    for (const d of ["a", "b"]) {
      mkdirSync(join(root, d));
      writeFileSync(join(root, d, "pack.yaml"), "pillar: dup\npersona: x\nmemoDomain: dup\n");
    }
    const logs: string[] = [];
    const { packs } = loadPacks(root, (l) => logs.push(l));
    expect(packs.size).toBe(1);
    expect(logs.join(" ")).toMatch(/dup/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("listPlaybooks pillar grouping", () => {
  it("annotates each playbook with its pillar (or undefined when packless)", () => {
    const root = scaffold();
    const { playbooks, pillarOf } = loadPacks(root);
    const jm = new JobManager({
      store: {} as never, vault: {} as never, run: (async () => ({})) as never,
      playbooks, pillarOf, wallTimeMs: 1, maxConcurrent: 1, onComplete: async () => {},
    });
    const list = jm.listPlaybooks();
    expect(list.find((p) => p.name === "sub-audit")?.pillar).toBe("money");
    expect(list.find((p) => p.name === "echo")?.pillar).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});
