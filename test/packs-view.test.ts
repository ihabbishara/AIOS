// test/packs-view.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { buildPacksView, validatePackFile } from "../src/web/packs-view.js";

function fixtureConfig(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "pv-"));
  const agentsDir = join(root, "agents");
  const playbooksDir = join(root, "playbooks");
  const engDir = join(agentsDir, "engineering");
  const pbEngDir = join(playbooksDir, "engineering");
  mkdirSync(engDir, { recursive: true });
  mkdirSync(pbEngDir, { recursive: true });
  writeFileSync(join(engDir, "department.yaml"),
    `department: engineering\nmission: "Build software."\nmemoDomain: code\nsandbox: true\nactions: [vault.write]\nplaybooks: [code-build]\n`);
  writeFileSync(join(engDir, "maya.yaml"),
    `name: maya\ntitle: Senior Engineer\ndepartment: engineering\ncharter: Owns code changes.\npersona: Terse.\nprompt: You are maya.\ntools: [Read, Edit, Write]\npermissionMode: bypassPermissions\nmaxTurns: 80\naliases: [developer]\n`);
  writeFileSync(join(pbEngDir, "code-build.yaml"),
    `name: code-build\ndescription: build\nneedsProjectDir: false\nstages:\n  - type: single\n    id: implement\n    role: maya\n    brief: do it\n`);
  const finDir = join(agentsDir, "finance");
  mkdirSync(finDir, { recursive: true });
  writeFileSync(join(finDir, "department.yaml"),
    `department: finance\nmission: "Money visibility."\nmemoDomain: money\nactions: []\nplaybooks: []\n`);
  writeFileSync(join(finDir, "faris.yaml"),
    `name: faris\ntitle: CFO\ndepartment: finance\ncharter: Manages money.\npersona: Precise.\nprompt: You are CFO.\ntools: []\nmaxTurns: 20\n`);
  return { agentsDir, playbooksDir, workspaceRoot: join(root, "ws"), projectsRoot: root, ...overrides } as any;
}

describe("buildPacksView", () => {
  it("returns one card per department on disk, with config", () => {
    const view = buildPacksView(fixtureConfig(), new Store(":memory:"));
    const eng = view.find((p) => p.pillar === "engineering")!;
    expect(eng.sandbox).toBe(true);
    expect(eng.actions).toEqual(["vault.write"]);
    expect(eng.tools).toContain("Read");
    expect(eng.enabled).toBe(true);
    expect(eng.playbooks[0].name).toBe("code-build");
    expect(eng.playbooks[0].stages[0]).toMatchObject({ id: "implement", type: "single", role: "maya" });
    // sandbox dept → roles flagged advisoryInDirect
    expect(eng.roles.find((r) => r.name === "maya")!.advisoryInDirect).toBe(true);
    const fin = view.find((p) => p.pillar === "finance")!;
    expect(fin.playbooks).toEqual([]);
    expect(fin.sandbox).toBe(false);
  });

  it("marks a department disabled via AIOS_ENGINEERING_DISABLED but still returns it", () => {
    process.env.AIOS_ENGINEERING_DISABLED = "1";
    try {
      const view = buildPacksView(fixtureConfig(), new Store(":memory:"));
      const eng = view.find((p) => p.pillar === "engineering")!;
      expect(eng.enabled).toBe(false);
      expect(eng.pillar).toBe("engineering");
    } finally {
      delete process.env.AIOS_ENGINEERING_DISABLED;
    }
  });

  it("marks a department disabled via legacy AIOS_CODE_DISABLED env key", () => {
    process.env.AIOS_CODE_DISABLED = "1";
    try {
      const view = buildPacksView(fixtureConfig(), new Store(":memory:"));
      const eng = view.find((p) => p.pillar === "engineering")!;
      expect(eng.enabled).toBe(false);
    } finally {
      delete process.env.AIOS_CODE_DISABLED;
    }
  });

  it("joins live jobs + workspaces + memo count", () => {
    const config = fixtureConfig();
    const store = new Store(":memory:");
    const taskDir = join(config.workspaceRoot, "2026-06-22-x-ab12");
    store.insertGoal({ id: "j1", slug: "x", title: "build x", request: "r", department: "engineering",
      lead: "athena", origin_channel: "web", origin_chat_id: "packs-view", status: "running",
      project_dir: taskDir, goal_dir: null, plan_summary: "playbook:code-build", replans_used: 0, chain_depth: 0, error: null });
    store.updateGoalStatus("j1", "done");
    const view = buildPacksView(config, store);
    const eng = view.find((p) => p.pillar === "engineering")!;
    expect(eng.recentJobs.map((j) => j.id)).toContain("j1");
    expect(eng.workspaces.map((w) => w.taskDir)).toContain(taskDir);
    expect(eng.workspaces[0].exists).toBe(false);
    expect(typeof eng.memoCount).toBe("number");
  });
});

describe("validatePackFile schema routing", () => {
  const agentYaml = `name: maya\ntitle: Senior Engineer\ndepartment: engineering\ncharter: Owns code.\npersona: Terse.\nprompt: You are maya.\ntools: []\nmaxTurns: 80\n`;
  const playbookYaml = `name: code-build\ndescription: build\nneedsProjectDir: false\nstages:\n  - type: single\n    id: implement\n    role: maya\n    brief: do it\n`;

  it("(a) valid agent manifest passes as agent", () => {
    expect(validatePackFile("maya.yaml", agentYaml, "agent", "engineering")).toMatchObject({ ok: true });
  });

  it("(b) playbook-shaped YAML to agent filename is rejected", () => {
    expect(validatePackFile("maya.yaml", playbookYaml, "agent", "engineering").ok).toBe(false);
  });

  it("(c) playbook YAML passes as playbook", () => {
    expect(validatePackFile("code-build.yaml", playbookYaml, "playbook")).toMatchObject({ ok: true });
  });

  it("(d) agent dept mismatch rejected", () => {
    const wrongDeptYaml = agentYaml.replace("department: engineering", "department: finance");
    expect(validatePackFile("maya.yaml", wrongDeptYaml, "agent", "engineering").ok).toBe(false);
  });

  it("(d) agent name/filename mismatch rejected", () => {
    expect(validatePackFile("other.yaml", agentYaml, "agent", "engineering").ok).toBe(false);
  });
});
