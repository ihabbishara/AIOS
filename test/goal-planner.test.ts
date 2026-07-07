// test/goal-planner.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import type { MailRow } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { GoalEngine } from "../src/engine/goals.js";
import { SpendGuard } from "../src/engine/budget.js";
import { makePlanner, renderPlanPreview } from "../src/engine/plan.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "gp-"));
  const eng = join(root, "agents", "engineering");
  mkdirSync(eng, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  for (const [n, extra] of [["athena", ""], ["vulcan", ""], ["odin", ""], ["minos-eng", "outputSchema: verdict\n"]] as const) {
    writeFileSync(join(eng, `${n}.yaml`),
      `name: ${n}\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n${extra}`);
  }
  return loadRegistry(join(root, "agents"), join(root, "playbooks"));
}

const GOOD_PLAN = {
  summary: "two-step plan",
  needsWorkspace: "none",
  nodes: [
    { key: "research", type: "run", agent: "odin", brief: "look", deps: [] },
    { key: "build", type: "loop", agent: "vulcan", critic: "minos-eng", brief: "make", deps: ["research"] },
  ],
};

function harness(planOutputs: unknown[]) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "gp-vault-")), "AIOS");
  const registry = fixtureRegistry();
  const previews: string[] = [];
  let planCalls = 0;
  const run: SpecialistRunFn = async (role) => {
    if (role === "athena" && planCalls < planOutputs.length) {
      return { text: "plan", structured: planOutputs[planCalls++], costUsd: 0.02, numTurns: 1 };
    }
    return { text: "node out", costUsd: 0.01, numTurns: 1 };
  };
  const planner = makePlanner({
    registry, store, run,
    resolveDeptFor: () => undefined,
    primaryChat: { channel: "telegram", chatId: "1" },
    projectsRoot: "/tmp/projects",
    postPreview: async (_o, text) => { previews.push(text); },
  });
  const engine = new GoalEngine({
    store, vault, registry, run,
    playbooks: new Map(), wallTimeMs: 60_000, maxConcurrentNodes: 2, mailMaxDepth: 2,
    spendGuard: new SpendGuard({ store }),
    onComplete: async () => {},
    resolveDeptFor: () => undefined,
    planner,
  });
  return { store, engine, previews, planCallsRef: () => planCalls };
}

describe("lead planner", () => {
  it("plans, previews, starts, and the graph runs to done", async () => {
    const { engine, store, previews } = harness([GOOD_PLAN]);
    const g = await engine.planGoal({ department: "engineering", title: "Do X", request: "do x", channel: "telegram", chatId: "1" });
    expect(previews[0]).toContain("research");
    expect(previews[0]).toContain("vulcan");
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(store.listNodes(g.id)).toHaveLength(2);
  });

  it("invalid plan retries once with the error, then succeeds", async () => {
    const bad = { ...GOOD_PLAN, nodes: [{ key: "a", type: "run", agent: "midas", brief: "x", deps: [] }] };
    const { engine, planCallsRef } = harness([bad, GOOD_PLAN]);
    await engine.planGoal({ department: "engineering", title: "Do X", request: "do x", channel: "telegram", chatId: "1" });
    expect(planCallsRef()).toBe(2);
  });

  it("invalid twice → throws planning failed, nothing persisted", async () => {
    const bad = { ...GOOD_PLAN, nodes: [{ key: "a", type: "run", agent: "nobody", brief: "x", deps: [] }] };
    const { engine, store } = harness([bad, bad]);
    await expect(engine.planGoal({ department: "engineering", title: "Do X", request: "x", channel: "telegram", chatId: "1" }))
      .rejects.toThrow(/planning failed/);
    expect(store.listGoals()).toHaveLength(0);
  });

  it("unknown department throws a helpful error", async () => {
    const { engine } = harness([]);
    await expect(engine.planGoal({ department: "nope", title: "t", request: "r", channel: "t", chatId: "1" }))
      .rejects.toThrow(/unknown department/i);
  });

  it("renderPlanPreview lists nodes with agents and deps", () => {
    const out = renderPlanPreview("Do X", "two-step",
      GOOD_PLAN.nodes.map((n) => ({ ...n, type: n.type as "run" | "loop", deps: n.deps })));
    expect(out).toContain("Do X");
    expect(out).toContain("build (loop) — vulcan ⇄ minos-eng — after: research");
  });
});

describe("planFromMail", () => {
  const mail = (over: Partial<MailRow> = {}): MailRow => ({
    id: "m1", from_agent: "odin", to_agent: "athena", kind: "request", body: "do x",
    goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1,
    status: "planning", error: null, created_at: "", read_at: null, ...over,
  });

  it("plans a graph with no preview and no workspace, stamped to the mail", async () => {
    const { engine, store, previews } = harness([GOOD_PLAN]);
    const g = await engine["deps"].planner!.planFromMail(engine, {
      department: "engineering", title: "Do X", request: "do x", channel: "telegram", chatId: "1",
    }, mail());
    expect(previews).toEqual([]);          // no chat preview for mail-origin
    expect(g.spawned_by_mail).toBe("m1");
    expect(g.project_dir).toBeNull();      // no workspace
    expect(g.chain_depth).toBe(1);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(store.listNodes(g.id)).toHaveLength(2);
  });

  it("forces no workspace even when the plan proposes a worktree", async () => {
    const WORKTREE_PLAN = { ...GOOD_PLAN, needsWorkspace: "worktree", projectDir: "/tmp/projects/x" };
    const { engine, store } = harness([WORKTREE_PLAN]);
    const g = await engine["deps"].planner!.planFromMail(engine, {
      department: "engineering", title: "Do X", request: "do x", channel: "telegram", chatId: "1",
    }, mail());
    expect(g.project_dir).toBeNull();
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
  });

  const insertUserMail = (store: Store) => {
    store.insertMail({
      id: "mu1", from_agent: "user", to_agent: "athena", kind: "request", body: "do x",
      goal_id: null, origin_channel: "web", origin_chat_id: "ui", chain_depth: 0,
      status: "planning", error: null, thread_id: null, in_reply_to: null,
    } as Omit<MailRow, "created_at" | "read_at">);
    return store.getMail("mu1")!;
  };

  it("user mail passes a validated workspace through to the goal", async () => {
    const WORKTREE_PLAN = { ...GOOD_PLAN, needsWorkspace: "worktree", projectDir: "/tmp/projects/x" };
    const { engine, store } = harness([WORKTREE_PLAN]);
    const m = insertUserMail(store);
    const g = await engine["deps"].planner!.planFromMail(engine, {
      department: "engineering", title: "Do X", request: "do x", channel: "web", chatId: "ui",
    }, m);
    expect(g.project_dir).toBe("/tmp/projects/x"); // no prepareSandbox in this harness — raw dir survives
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
  });

  it("user mail with a projectDir outside projectsRoot fails planning", async () => {
    const BAD_PLAN = { ...GOOD_PLAN, needsWorkspace: "worktree", projectDir: "/etc" };
    const { engine, store } = harness([BAD_PLAN]);
    const m = insertUserMail(store);
    await expect(engine["deps"].planner!.planFromMail(engine, {
      department: "engineering", title: "Do X", request: "do x", channel: "web", chatId: "ui",
    }, m)).rejects.toThrow(/projectDir under/);
    expect(store.listGoals()).toHaveLength(0);
  });

  it("user mail with needsWorkspace none stays workspace-less", async () => {
    const { engine, store } = harness([GOOD_PLAN]);
    const m = insertUserMail(store);
    const g = await engine["deps"].planner!.planFromMail(engine, {
      department: "engineering", title: "Do X", request: "do x", channel: "web", chatId: "ui",
    }, m);
    expect(g.project_dir).toBeNull();
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
  });

  it("planner failure propagates (caller refuses the mail)", async () => {
    const bad = { ...GOOD_PLAN, nodes: [{ key: "a", type: "run", agent: "nobody", brief: "x", deps: [] }] };
    const { engine } = harness([bad, bad]);
    await expect(engine["deps"].planner!.planFromMail(engine, {
      department: "engineering", title: "t", request: "r", channel: "t", chatId: "1",
    }, mail())).rejects.toThrow(/planning failed/);
  });
});

describe("replan guards (review fixes)", () => {
  it("a patch replacing a DONE node is rejected — done nodes are immutable", async () => {
    const { engine, store } = harness([GOOD_PLAN]);
    const g = await engine.planGoal({ department: "engineering", title: "Do X", request: "do x", channel: "telegram", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    // Build a planner whose lead returns a replace-done patch, then call replan directly.
    const { makePlanner } = await import("../src/engine/plan.js");
    const planner = makePlanner({
      registry: (engine as unknown as { deps: { registry: import("../src/agents/registry/loader.js").LoadedRegistry } }).deps.registry,
      store,
      run: async () => ({
        text: "patch",
        structured: { ops: [{ op: "replace", key: "research", node: { key: "research", type: "run", agent: "odin", brief: "redo", deps: [] } }] },
        costUsd: 0, numTurns: 1,
      }),
      resolveDeptFor: () => undefined,
      primaryChat: { channel: "telegram", chatId: "1" },
      projectsRoot: "/tmp/projects",
      postPreview: async () => {},
    });
    const failed = store.listNodes(g.id)[1];
    await expect(planner.replan(store.getGoal(g.id)!, failed, "boom"))
      .rejects.toThrow(/done nodes are immutable/);
  });
});
