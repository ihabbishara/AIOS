// test/packs-view.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { buildPacksView } from "../src/web/packs-view.js";

function fixtureConfig(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "pv-"));
  const playbooksDir = join(root, "playbooks");
  const codeDir = join(playbooksDir, "code");
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(join(codeDir, "pack.yaml"),
    `pillar: code\nsandbox: true\npersona: "engineer"\nmemoDomain: code\nactions: [vault.write]\n` +
    `roles: [developer, devops]\ntools: [Read, mcp__code__sh]\nplaybooks: [code-build]\n`);
  writeFileSync(join(codeDir, "code-build.yaml"),
    `name: code-build\ndescription: build\nneedsProjectDir: false\nstages:\n  - type: single\n    id: implement\n    role: developer\n    brief: do it\n`);
  const moneyDir = join(playbooksDir, "money");
  mkdirSync(moneyDir, { recursive: true });
  writeFileSync(join(moneyDir, "pack.yaml"),
    `pillar: money\npersona: "cfo"\nmemoDomain: money\nactions: []\nroles: [cfo]\ntools: [mcp__money__x]\nplaybooks: []\n`);
  return { playbooksDir, workspaceRoot: join(root, "ws"), projectsRoot: root, ...overrides } as any;
}

describe("buildPacksView", () => {
  it("returns one card per pack on disk, with config", () => {
    const view = buildPacksView(fixtureConfig(), new Store(":memory:"));
    const code = view.find((p) => p.pillar === "code")!;
    expect(code.sandbox).toBe(true);
    expect(code.actions).toEqual(["vault.write"]);
    expect(code.tools).toContain("mcp__code__sh");
    expect(code.enabled).toBe(true);
    expect(code.playbooks[0].name).toBe("code-build");
    expect(code.playbooks[0].stages[0]).toMatchObject({ id: "implement", type: "single", role: "developer" });
    // sandbox pack → roles flagged advisoryInDirect
    expect(code.roles.find((r) => r.name === "developer")!.advisoryInDirect).toBe(true);
    const money = view.find((p) => p.pillar === "money")!;
    expect(money.playbooks).toEqual([]);
    expect(money.sandbox).toBe(false);
  });

  it("marks a pack disabled via AIOS_<PILLAR>_DISABLED but still returns it", () => {
    process.env.AIOS_CODE_DISABLED = "1";
    try {
      const view = buildPacksView(fixtureConfig(), new Store(":memory:"));
      const code = view.find((p) => p.pillar === "code")!;
      expect(code.enabled).toBe(false);
      expect(code.pillar).toBe("code"); // still present → re-enableable
    } finally {
      delete process.env.AIOS_CODE_DISABLED;
    }
  });

  it("joins live jobs + workspaces + memo count", () => {
    const config = fixtureConfig();
    const store = new Store(":memory:");
    const taskDir = join(config.workspaceRoot, "2026-06-22-x-ab12");
    store.insertJob({ id: "j1", slug: "x", title: "build x", playbook: "code-build", request: "r",
      project_dir: taskDir, channel: "web", chat_id: "packs-view", status: "queued", error: null } as any);
    store.updateJobStatus("j1", "done");
    const view = buildPacksView(config, store);
    const code = view.find((p) => p.pillar === "code")!;
    expect(code.recentJobs.map((j) => j.id)).toContain("j1");
    expect(code.workspaces.map((w) => w.taskDir)).toContain(taskDir);
    expect(code.workspaces[0].exists).toBe(false); // never created on disk
    expect(typeof code.memoCount).toBe("number");
  });

  it("degrades a manifest role missing from the roles record, not throws", () => {
    const root = mkdtempSync(join(tmpdir(), "pv-missing-"));
    const playbooksDir = join(root, "playbooks");
    const codeDir = join(playbooksDir, "code");
    mkdirSync(codeDir, { recursive: true });
    // code pack references "developer" (exists) AND "ghost_role_xyz" (does NOT exist in roles)
    writeFileSync(join(codeDir, "pack.yaml"),
      `pillar: code\nsandbox: false\npersona: "engineer"\nmemoDomain: code\nactions: []\n` +
      `roles: [developer, ghost_role_xyz]\ntools: []\nplaybooks: []\n`);
    const config = { playbooksDir, workspaceRoot: join(root, "ws"), projectsRoot: root } as any;
    let view: ReturnType<typeof buildPacksView>;
    expect(() => { view = buildPacksView(config, new Store(":memory:")); }).not.toThrow();
    const code = view!.find((p) => p.pillar === "code")!;
    // ghost_role_xyz is not in the roles registry → degraded to "(missing role def)"
    const ghost = code.roles.find((r) => r.name === "ghost_role_xyz")!;
    expect(ghost).toBeDefined();
    expect(ghost.description).toBe("(missing role def)");
    // existing role still resolves normally
    expect(code.roles.every((r) => typeof r.description === "string")).toBe(true);
  });
});
