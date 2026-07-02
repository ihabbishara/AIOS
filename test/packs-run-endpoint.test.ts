// test/packs-run-endpoint.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateRunRequest } from "../src/web/packs-view.js";

function cfg() {
  const root = mkdtempSync(join(tmpdir(), "run-"));
  const agentsDir = join(root, "agents");
  const engDir = join(agentsDir, "engineering");
  mkdirSync(engDir, { recursive: true });
  writeFileSync(join(engDir, "department.yaml"),
    `department: engineering\nmission: Build software.\nmemoDomain: code\nplaybooks: [code-build, code-analyze]\n`);
  return { agentsDir, playbooksDir: join(root, "playbooks"), projectsRoot: root } as any;
}

describe("validateRunRequest", () => {
  it("accepts a known department+playbook with a project_dir under projectsRoot", () => {
    const c = cfg();
    const r = validateRunRequest(c, "engineering", "code-build", join(c.projectsRoot, "app"));
    expect(r.ok).toBe(true);
  });
  it("rejects an unknown department", () => {
    expect(validateRunRequest(cfg(), "nope", "code-build", undefined).ok).toBe(false);
  });
  it("rejects a playbook not in the department", () => {
    expect(validateRunRequest(cfg(), "engineering", "code-inplace", undefined).ok).toBe(false);
  });
  it("rejects a project_dir outside projectsRoot", () => {
    expect(validateRunRequest(cfg(), "engineering", "code-build", "/etc").ok).toBe(false);
  });
});
