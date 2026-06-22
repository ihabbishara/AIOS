// test/packs-files.test.ts
import { describe, it, expect } from "vitest";
import { validatePackFile } from "../src/web/packs-view.js";

describe("validatePackFile", () => {
  it("validates pack.yaml with packSchema", () => {
    const ok = validatePackFile("pack.yaml", `pillar: code\npersona: p\nmemoDomain: code\n`);
    expect(ok.ok).toBe(true);
    expect(validatePackFile("pack.yaml", `persona: p\n`).ok).toBe(false); // missing pillar
  });
  it("validates a playbook file with playbookSchema", () => {
    const ok = validatePackFile("code-build.yaml",
      `name: code-build\ndescription: d\nstages:\n  - type: single\n    id: x\n    role: developer\n    brief: b\n`);
    expect(ok.ok).toBe(true);
    expect(validatePackFile("code-build.yaml", `name: x\n`).ok).toBe(false); // no stages
  });
  it("rejects a non-yaml or traversal filename", () => {
    expect(validatePackFile("../escape.yaml", `x: 1`).ok).toBe(false);
    expect(validatePackFile("notes.txt", `x: 1`).ok).toBe(false);
  });
});
