import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { JobManager } from "../src/engine/jobs.js";
import type { Playbook } from "../src/engine/playbook.js";

// A packless playbook that uses a bypassPermissions role → isUnsandboxedWrite = true
const inplacePb: Playbook = {
  name: "code-inplace",
  description: "In-place coding",
  needsProjectDir: true,
  stages: [
    { type: "single", id: "implement", role: "developer" },
  ],
};

// A playbook with only read/dontAsk roles → isUnsandboxedWrite = false
const safePb: Playbook = {
  name: "research-report",
  description: "Research",
  needsProjectDir: false,
  stages: [
    { type: "single", id: "report", role: "researcher" },
  ],
};

function makeRoots() {
  const base = mkdtempSync(join(tmpdir(), "aios-inplace-jm-"));
  const projectsRoot = join(base, "projects");
  const workspaceRoot = join(base, "workspace");
  const repo = join(projectsRoot, "myapp");
  mkdirSync(projectsRoot, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(repo, { recursive: true });
  return { projectsRoot, workspaceRoot, repo };
}

function makeManager(
  playbooks: Map<string, Playbook>,
  opts: { projectsRoot?: string; workspaceRoot?: string; pillarOf?: Map<string, string> } = {},
) {
  const store = new Store(":memory:");
  const root = mkdtempSync(join(tmpdir(), "aios-vault-"));
  const vault = new VaultWriter(root, "AIOS");
  vault.init();
  return new JobManager({
    store,
    vault,
    run: (async () => ({ text: "ok", costUsd: 0, numTurns: 1 })) as never,
    playbooks,
    wallTimeMs: 60_000,
    // maxConcurrent: 0 → pump() returns immediately; job is enqueued but never executed.
    // createJob returns the row synchronously. Refusals throw BEFORE insert, so run/vault
    // stubs are never invoked.
    maxConcurrent: 0,
    onComplete: async () => {},
    ...opts,
  });
}

describe("createJob inplace gate", () => {
  it("allows an unsandboxed-write playbook when inplace:true and target is valid", () => {
    const { projectsRoot, workspaceRoot, repo } = makeRoots();
    const jm = makeManager(new Map([["code-inplace", inplacePb]]), {
      projectsRoot,
      workspaceRoot,
    });
    expect(() =>
      jm.createJob({
        playbook: "code-inplace",
        title: "Fix bug",
        request: "fix the bug",
        projectDir: repo,
        channel: "cli",
        chatId: "x",
        inplace: true,
      })
    ).not.toThrow();
  });

  it("refuses an unsandboxed-write playbook when inplace is not set", () => {
    const { projectsRoot, workspaceRoot, repo } = makeRoots();
    const jm = makeManager(new Map([["code-inplace", inplacePb]]), {
      projectsRoot,
      workspaceRoot,
    });
    expect(() =>
      jm.createJob({
        playbook: "code-inplace",
        title: "Fix bug",
        request: "fix the bug",
        projectDir: repo,
        channel: "cli",
        chatId: "x",
      })
    ).toThrow(/Refused/);
  });

  it("refuses an unsandboxed-write playbook when inplace:false", () => {
    const { projectsRoot, workspaceRoot, repo } = makeRoots();
    const jm = makeManager(new Map([["code-inplace", inplacePb]]), {
      projectsRoot,
      workspaceRoot,
    });
    expect(() =>
      jm.createJob({
        playbook: "code-inplace",
        title: "Fix bug",
        request: "fix the bug",
        projectDir: repo,
        channel: "cli",
        chatId: "x",
        inplace: false,
      })
    ).toThrow(/Refused/);
  });

  it("refuses an unsandboxed-write playbook with inplace:true but invalid target", () => {
    const { projectsRoot, workspaceRoot } = makeRoots();
    const jm = makeManager(new Map([["code-inplace", inplacePb]]), {
      projectsRoot,
      workspaceRoot,
    });
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    expect(() =>
      jm.createJob({
        playbook: "code-inplace",
        title: "Fix bug",
        request: "fix the bug",
        projectDir: outside,
        channel: "cli",
        chatId: "x",
        inplace: true,
      })
    ).toThrow(/Refused/);
  });

  it("does NOT gate a pack-pillar playbook (code-build has a pillar)", () => {
    const { projectsRoot, workspaceRoot } = makeRoots();
    const codeBuildPb: Playbook = {
      name: "code-build",
      description: "Build with sandbox",
      needsProjectDir: false,
      stages: [{ type: "single", id: "build", role: "developer" }],
    };
    // code-build is pillar-mapped → isUnsandboxedWrite = false → gate does not fire
    const jm = makeManager(
      new Map([["code-build", codeBuildPb]]),
      {
        projectsRoot,
        workspaceRoot,
        pillarOf: new Map([["code-build", "code"]]),
      },
    );
    expect(() =>
      jm.createJob({
        playbook: "code-build",
        title: "Build",
        request: "build it",
        channel: "cli",
        chatId: "x",
      })
    ).not.toThrow();
  });

  it("does NOT gate a safe (read-only role) packless playbook", () => {
    const { projectsRoot, workspaceRoot } = makeRoots();
    const jm = makeManager(new Map([["research-report", safePb]]), {
      projectsRoot,
      workspaceRoot,
    });
    expect(() =>
      jm.createJob({
        playbook: "research-report",
        title: "Research",
        request: "research it",
        channel: "cli",
        chatId: "x",
      })
    ).not.toThrow();
  });

  it("is fail-closed when projectsRoot is undefined (refuses even with inplace:true)", () => {
    const { workspaceRoot, repo } = makeRoots();
    // No projectsRoot provided → roots.projectsRoot will be empty string → assertInplaceTarget will refuse
    const jm = makeManager(new Map([["code-inplace", inplacePb]]), {
      workspaceRoot,
      // projectsRoot: undefined
    });
    expect(() =>
      jm.createJob({
        playbook: "code-inplace",
        title: "Fix bug",
        request: "fix the bug",
        projectDir: repo,
        channel: "cli",
        chatId: "x",
        inplace: true,
      })
    ).toThrow(/Refused/);
  });
});
