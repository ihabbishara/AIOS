// test/packs-files.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validatePackFile, resolvePackFilePath, isSafePlaybookName } from "../src/web/packs-view.js";

describe("validatePackFile", () => {
  it("validates department.yaml with departmentSchema", () => {
    const ok = validatePackFile("department.yaml", `department: engineering\nmission: Build software.\nmemoDomain: code\n`, "department");
    expect(ok.ok).toBe(true);
    expect(validatePackFile("department.yaml", `mission: p\n`, "department").ok).toBe(false); // missing department
  });
  it("validates a playbook file with playbookSchema", () => {
    const ok = validatePackFile("code-build.yaml",
      `name: code-build\ndescription: d\nstages:\n  - type: single\n    id: x\n    role: maya\n    brief: b\n`, "playbook");
    expect(ok.ok).toBe(true);
    expect(validatePackFile("code-build.yaml", `name: x\n`, "playbook").ok).toBe(false);
  });
  it("rejects a non-yaml or traversal filename", () => {
    expect(validatePackFile("../escape.yaml", `x: 1`, "playbook").ok).toBe(false);
    expect(validatePackFile("notes.txt", `x: 1`, "playbook").ok).toBe(false);
  });
});

// ── Finding 1: pure routing function ─────────────────────────────────────────

describe("resolvePackFilePath", () => {
  const dirs = {
    agentsDir: "/agents",
    playbooksDir: "/playbooks",
    deptPlaybooks: ["code-build", "code-deploy"],
  };

  it("branch 1: department.yaml always routes to agentsDir/<dept>/ (no exists check)", () => {
    // exists always returns false — branch 1 must still fire
    const r = resolvePackFilePath("engineering", "department.yaml", dirs, () => false);
    expect(r).toEqual({ type: "department", absPath: "/agents/engineering/department.yaml" });
  });

  it("branch 2: existing agent file routes to agentsDir/<dept>/<file>", () => {
    const fakeExists = (p: string) => p === "/agents/engineering/maya.yaml";
    const r = resolvePackFilePath("engineering", "maya.yaml", dirs, fakeExists);
    expect(r).toEqual({ type: "agent", absPath: "/agents/engineering/maya.yaml" });
  });

  it("branch 3: playbook in dept subdir routes to playbooksDir/<dept>/<file>", () => {
    const fakeExists = (p: string) => p === "/playbooks/engineering/code-build.yaml";
    const r = resolvePackFilePath("engineering", "code-build.yaml", dirs, fakeExists);
    expect(r).toEqual({ type: "playbook", absPath: "/playbooks/engineering/code-build.yaml" });
  });

  it("branch 4: flat playbook routes when stem is in deptPlaybooks", () => {
    // Only the flat path exists; stem is in the list
    const fakeExists = (p: string) => p === "/playbooks/code-build.yaml";
    const r = resolvePackFilePath("engineering", "code-build.yaml", dirs, fakeExists);
    expect(r).toEqual({ type: "playbook", absPath: "/playbooks/code-build.yaml" });
  });

  it("subdir beats flat: both paths exist → subdir path wins (branch 3 before 4)", () => {
    const fakeExists = (p: string) =>
      p === "/playbooks/engineering/code-build.yaml" || p === "/playbooks/code-build.yaml";
    const r = resolvePackFilePath("engineering", "code-build.yaml", dirs, fakeExists);
    expect(r).toEqual({ type: "playbook", absPath: "/playbooks/engineering/code-build.yaml" });
  });

  it("unknown file returns undefined (→ 404)", () => {
    const r = resolvePackFilePath("engineering", "ghost.yaml", dirs, () => false);
    expect(r).toBeUndefined();
  });

  it("department.yaml wins over everything — is never an agent or playbook", () => {
    // Even if an agent or playbook path for department.yaml somehow existed, branch 1 fires first
    const r = resolvePackFilePath("engineering", "department.yaml", dirs, () => true);
    expect(r?.type).toBe("department");
  });

  // ── Finding 3: flat-level dept membership guard ──────────────────────────

  it("Finding 3: flat file exists but stem NOT in deptPlaybooks → undefined", () => {
    // secret.yaml not in deptPlaybooks list
    const fakeExists = (p: string) => p === "/playbooks/secret.yaml";
    const r = resolvePackFilePath("engineering", "secret.yaml", dirs, fakeExists);
    expect(r).toBeUndefined();
  });

  it("Finding 3: flat file exists AND stem IS in deptPlaybooks → routes correctly", () => {
    const fakeExists = (p: string) => p === "/playbooks/code-deploy.yaml";
    const r = resolvePackFilePath("engineering", "code-deploy.yaml", dirs, fakeExists);
    expect(r).toEqual({ type: "playbook", absPath: "/playbooks/code-deploy.yaml" });
  });

  // ── Real fs integration ──────────────────────────────────────────────────

  it("real fs: playbooks/<dept>/<file> subdir routing works end-to-end", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rpf-"));
    const agentsDir = join(tmp, "agents");
    const playbooksDir = join(tmp, "playbooks");
    mkdirSync(join(agentsDir, "engineering"), { recursive: true });
    mkdirSync(join(playbooksDir, "engineering"), { recursive: true });
    writeFileSync(join(playbooksDir, "engineering", "code-build.yaml"), "name: code-build\n");
    // Use real existsSync (default) via actual on-disk files
    const r = resolvePackFilePath("engineering", "code-build.yaml", {
      agentsDir,
      playbooksDir,
      deptPlaybooks: ["code-build"],
    });
    expect(r).toEqual({
      type: "playbook",
      absPath: join(playbooksDir, "engineering", "code-build.yaml"),
    });
  });
});

// ── Finding 2: playbook name sanitisation ────────────────────────────────────

describe("isSafePlaybookName", () => {
  it("accepts code-build (hyphenated word)", () => expect(isSafePlaybookName("code-build")).toBe(true));
  it("accepts a plain word", () => expect(isSafePlaybookName("deploy")).toBe(true));
  it("accepts underscore names", () => expect(isSafePlaybookName("my_playbook")).toBe(true));
  it("rejects traversal ../x", () => expect(isSafePlaybookName("../x")).toBe(false));
  it("rejects slash a/b", () => expect(isSafePlaybookName("a/b")).toBe(false));
  it("rejects dot a.b", () => expect(isSafePlaybookName("a.b")).toBe(false));
  it("rejects empty string", () => expect(isSafePlaybookName("")).toBe(false));
});
