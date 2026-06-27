import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertInplaceTarget } from "../src/code/paths.js";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "inplace-"));
  const projectsRoot = join(base, "projects");
  const selfRoot = join(projectsRoot, "AIOS");        // the daemon's own tree
  const workspaceRoot = join(projectsRoot, "AIOS-Workspace");
  const repo = join(projectsRoot, "app");             // a legit target
  for (const d of [projectsRoot, selfRoot, workspaceRoot, repo]) mkdirSync(d, { recursive: true });
  return { base, projectsRoot, selfRoot, workspaceRoot, repo };
}

describe("assertInplaceTarget", () => {
  it("allows a normal repo dir under projectsRoot", () => {
    const s = setup();
    expect(() => assertInplaceTarget(s.repo, s)).not.toThrow();
  });

  it("refuses the AIOS self root and anything containing/under it", () => {
    const s = setup();
    expect(() => assertInplaceTarget(s.selfRoot, s)).toThrow(/AIOS source/);
    expect(() => assertInplaceTarget(join(s.selfRoot, "src"), s)).toThrow(/AIOS source/);
    // self under target: target is an ancestor of selfRoot
    expect(() => assertInplaceTarget(s.projectsRoot, s)).toThrow(/AIOS source/);
  });

  it("refuses a secret path", () => {
    const s = setup();
    const secret = join(s.projectsRoot, "my-token-store");
    mkdirSync(secret, { recursive: true });
    expect(() => assertInplaceTarget(secret, s)).toThrow(/secret/);
  });

  it("refuses a target inside the sandbox workspace", () => {
    const s = setup();
    const ws = join(s.workspaceRoot, "task1");
    mkdirSync(ws, { recursive: true });
    expect(() => assertInplaceTarget(ws, s)).toThrow(/workspace/);
  });

  it("refuses a target outside projectsRoot", () => {
    const s = setup();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    expect(() => assertInplaceTarget(outside, s)).toThrow(/under/);
  });

  it("refuses a non-existent target and a file", () => {
    const s = setup();
    expect(() => assertInplaceTarget(join(s.projectsRoot, "ghost"), s)).toThrow(/directory/);
    const f = join(s.repo, "file.txt");
    writeFileSync(f, "x");
    expect(() => assertInplaceTarget(f, s)).toThrow(/directory/);
  });
});
