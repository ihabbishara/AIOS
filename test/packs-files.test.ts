// test/packs-files.test.ts
import { describe, it, expect } from "vitest";
import { validatePackFile } from "../src/web/packs-view.js";

describe("validatePackFile", () => {
  it("validates department.yaml with departmentSchema", () => {
    const ok = validatePackFile("department.yaml", `department: engineering\nmission: Build software.\nmemoDomain: code\n`);
    expect(ok.ok).toBe(true);
    expect(validatePackFile("department.yaml", `mission: p\n`).ok).toBe(false); // missing department
  });
  it("validates a playbook file with playbookSchema", () => {
    const ok = validatePackFile("code-build.yaml",
      `name: code-build\ndescription: d\nstages:\n  - type: single\n    id: x\n    role: maya\n    brief: b\n`);
    expect(ok.ok).toBe(true);
    expect(validatePackFile("code-build.yaml", `name: x\n`).ok).toBe(false);
  });
  it("rejects a non-yaml or traversal filename", () => {
    expect(validatePackFile("../escape.yaml", `x: 1`).ok).toBe(false);
    expect(validatePackFile("notes.txt", `x: 1`).ok).toBe(false);
  });
});
