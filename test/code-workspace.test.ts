// test/code-workspace.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allocateWorkspace, validateSource, deliverBranch } from "../src/code/workspace.js";
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

  it("a source under selfRoot is served as a self-contained CLONE, not a worktree", () => {
    const self = join(projects, "AIOS");
    if (!existsSync(join(self, ".git"))) gitInit(self);
    const d = { ...deps, selfRoot: self, id: "clone01" };
    const { taskDir } = allocateWorkspace({ mode: "worktree", source: self, slug: "self-work" }, d);
    // a clone has a real .git DIRECTORY; a worktree has a .git FILE pointing back at the source
    expect(statSync(join(taskDir, ".git")).isDirectory()).toBe(true);
    // and git works inside it without reaching the source repo
    expect(() => execFileSync("git", ["log", "--oneline", "-1"], { cwd: taskDir })).not.toThrow();
  });

  it("a normal project is still a worktree (.git is a file)", () => {
    const repo = join(projects, "otherapp");
    gitInit(repo);
    const d = { ...deps, selfRoot: join(projects, "AIOS"), id: "wt01" };
    const { taskDir } = allocateWorkspace({ mode: "worktree", source: repo, slug: "other" }, d);
    expect(statSync(join(taskDir, ".git")).isFile()).toBe(true);
  });

  it("validateSource accepts the self root but still refuses other secret paths", () => {
    const self = join(projects, "AIOS");
    if (!existsSync(join(self, ".git"))) gitInit(self);
    expect(() => validateSource(self, { ...deps, selfRoot: self })).not.toThrow();
    expect(() => validateSource(join(projects, ".ssh"), { ...deps, selfRoot: self })).toThrow(/denylist|Not a git repo/i);
  });

  it("analyze mode returns the validated source, no allocation", () => {
    const repo = join(projects, "to-audit");
    gitInit(repo);
    const { taskDir } = allocateWorkspace({ mode: "analyze", source: repo, slug: "audit" }, deps);
    expect(taskDir).toBe(resolveReal(repo)); // analyze returns resolveReal(source), no alloc
  });
});

describe("clone-branch delivery", () => {
  const home = mkdtempSync(join(tmpdir(), "ws-deliver-"));
  const wsRoot = join(home, "AIOS-Workspace");
  const projects = join(home, "projects");
  const self = join(projects, "AIOS");
  const deps = { workspaceRoot: wsRoot, readRoots: [projects], now: "2026-07-26", id: "d00001", selfRoot: self };
  const gitOut = (args: string[], cwd: string) => execFileSync("git", args, { cwd }).toString().trim();
  const commitIn = (dir: string, msg: string) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", msg], { cwd: dir });

  it("fetches the agent branch into the real repo without merging or moving it", () => {
    gitInit(self);
    const headBefore = gitOut(["rev-parse", "HEAD"], self);
    const checkoutBefore = gitOut(["rev-parse", "--abbrev-ref", "HEAD"], self);
    const { taskDir } = allocateWorkspace({ mode: "worktree", source: self, slug: "self-work" }, deps);
    commitIn(taskDir, "agent work");

    expect(deliverBranch({ taskDir, selfRoot: self })).toBe("aios/self-work-d00001");

    // the ref landed, pointing at the agent's commit…
    expect(gitOut(["rev-parse", "--verify", "aios/self-work-d00001"], self)).toBe(gitOut(["rev-parse", "HEAD"], taskDir));
    // …and the real checkout never moved
    expect(gitOut(["rev-parse", "HEAD"], self)).toBe(headBefore);
    expect(gitOut(["rev-parse", "--abbrev-ref", "HEAD"], self)).toBe(checkoutBefore);
  });

  it("delivers nothing when the agent never committed (no ref noise)", () => {
    const { taskDir } = allocateWorkspace({ mode: "worktree", source: self, slug: "idle" }, { ...deps, id: "d00002" });
    expect(deliverBranch({ taskDir, selfRoot: self })).toBeNull();
    expect(() => gitOut(["rev-parse", "--verify", "aios/idle-d00002"], self)).toThrow();
  });

  it("delivers nothing from another project's worktree", () => {
    const repo = join(projects, "otherapp");
    gitInit(repo);
    const { taskDir } = allocateWorkspace({ mode: "worktree", source: repo, slug: "other" }, { ...deps, id: "d00003" });
    commitIn(taskDir, "work");
    expect(deliverBranch({ taskDir, selfRoot: self })).toBeNull();
  });

  it("delivers nothing from a greenfield dir", () => {
    const { taskDir } = allocateWorkspace({ mode: "greenfield", slug: "green" }, { ...deps, id: "d00004" });
    expect(deliverBranch({ taskDir, selfRoot: self })).toBeNull();
  });

  it("never reads a remote URL as a path under selfRoot", () => {
    // resolveReal() resolves a non-path relative to cwd — and the daemon's cwd IS the AIOS root,
    // so a bare isUnder() would call every github remote self-work. Fake git: no real fetch.
    const calls: string[][] = [];
    const fakeGit = (args: string[]) => {
      calls.push(args);
      if (args[0] === "remote") return "https://github.com/someone/other.git\n";
      if (args[1] === "--abbrev-ref") return "aios/urlcase-d00005\n";
      if (args[0] === "rev-list") return "3\n";
      return "";
    };
    const { taskDir } = allocateWorkspace({ mode: "worktree", source: self, slug: "urlcase" }, { ...deps, id: "d00005" });
    expect(deliverBranch({ taskDir, selfRoot: process.cwd() }, fakeGit)).toBeNull();
    expect(calls.some((a) => a[0] === "fetch")).toBe(false);
  });
});
