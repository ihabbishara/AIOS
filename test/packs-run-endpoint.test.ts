// test/packs-run-endpoint.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateRunRequest } from "../src/web/packs-view.js";

function cfg() {
  const root = mkdtempSync(join(tmpdir(), "run-"));
  const codeDir = join(root, "playbooks", "code");
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(join(codeDir, "pack.yaml"),
    `pillar: code\nsandbox: true\npersona: p\nmemoDomain: code\nactions: []\nroles: []\ntools: []\nplaybooks: [code-build, code-analyze]\n`);
  return { playbooksDir: join(root, "playbooks"), projectsRoot: root } as any;
}

describe("validateRunRequest", () => {
  it("accepts a known pillar+playbook with a project_dir under projectsRoot", () => {
    const c = cfg();
    const r = validateRunRequest(c, "code", "code-build", join(c.projectsRoot, "app"));
    expect(r.ok).toBe(true);
  });
  it("rejects an unknown pillar", () => {
    expect(validateRunRequest(cfg(), "nope", "code-build", undefined).ok).toBe(false);
  });
  it("rejects a playbook not in the pillar", () => {
    expect(validateRunRequest(cfg(), "code", "software-feature", undefined).ok).toBe(false);
  });
  it("rejects a project_dir outside projectsRoot", () => {
    expect(validateRunRequest(cfg(), "code", "code-build", "/etc").ok).toBe(false);
  });
});
