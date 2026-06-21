// test/code-workspace.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allocateWorkspace, validateSource } from "../src/code/workspace.js";
import { resolveReal } from "../src/code/paths.js";

function gitInit(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
}

describe("workspace allocator", () => {
  const home = mkdtempSync(join(tmpdir(), "ws-home-"));
  const wsRoot = join(home, "AIOS-Workspace");
  const projects = join(home, "projects");
  const deps = { workspaceRoot: wsRoot, readRoots: [projects], now: "2026-06-21", id: "abc123" };

  it("greenfield creates a fresh dir under workspaceRoot", () => {
    const { taskDir } = allocateWorkspace({ mode: "greenfield", slug: "new-cli" }, deps);
    expect(taskDir).toBe(join(wsRoot, "2026-06-21-new-cli-abc123"));
    expect(existsSync(taskDir)).toBe(true);
  });

  it("worktree adds a worktree of a source repo without moving its HEAD", () => {
    const repo = join(projects, "myapp");
    gitInit(repo);
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString();
    const { taskDir } = allocateWorkspace({ mode: "worktree", source: repo, slug: "feat-x" }, deps);
    expect(existsSync(join(taskDir, ".git"))).toBe(true);
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString();
    expect(headAfter).toBe(headBefore); // main checkout untouched
  });

  it("validateSource refuses a non-git dir", () => {
    const plain = join(projects, "plain");
    mkdirSync(plain, { recursive: true });
    expect(() => validateSource(plain, deps)).toThrow(/git repo/i);
  });

  it("validateSource refuses a path outside read roots", () => {
    expect(() => validateSource("/etc", deps)).toThrow(/read root/i);
  });

  it("validateSource refuses the workspace root itself", () => {
    mkdirSync(wsRoot, { recursive: true });
    expect(() => validateSource(wsRoot, { ...deps, readRoots: [home] })).toThrow(/workspace|AIOS/i);
  });

  it("validateSource refuses an AIOS repo (secret denylist)", () => {
    const aios = join(projects, "AIOS");
    gitInit(aios);
    expect(() => validateSource(aios, deps)).toThrow(/secret|denylist/i);
  });

  it("analyze mode returns the validated source, no allocation", () => {
    const repo = join(projects, "to-audit");
    gitInit(repo);
    const { taskDir } = allocateWorkspace({ mode: "analyze", source: repo, slug: "audit" }, deps);
    expect(taskDir).toBe(resolveReal(repo)); // analyze returns resolveReal(source), no alloc
  });
});
