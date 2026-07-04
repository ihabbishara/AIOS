// test/goal-scheduler.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { GoalEngine } from "../src/engine/goals.js";
import { SpendGuard } from "../src/engine/budget.js";
import type { Playbook } from "../src/engine/playbook.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "gs-"));
  const eng = join(root, "agents", "engineering");
  mkdirSync(eng, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  for (const n of ["athena", "vulcan", "odin"]) {
    writeFileSync(join(eng, `${n}.yaml`),
      `name: ${n}\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n`);
  }
  return loadRegistry(join(root, "agents"), join(root, "playbooks"));
}

const PB: Playbook = {
  name: "research-report", description: "r", needsProjectDir: false,
  stages: [
    { type: "single", id: "gather", role: "odin", brief: "gather" },
    { type: "single", id: "write", role: "athena", brief: "write" },
  ],
};

function harness(over: {
  run?: SpecialistRunFn;
  maxConcurrentNodes?: number;
  capUsd?: number;
  todayFn?: () => string;
} = {}) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "gs-vault-")), "AIOS");
  const registry = fixtureRegistry();
  const completions: Array<{ ok: boolean }> = [];
  const engine = new GoalEngine({
    store, vault, registry,
    run: over.run ?? (async () => ({ text: "out", costUsd: 0.01, numTurns: 1 })),
    playbooks: new Map([[PB.name, PB]]),
    wallTimeMs: 60_000,
    maxConcurrentNodes: over.maxConcurrentNodes ?? 2,
    mailMaxDepth: 2,
    spendGuard: new SpendGuard({ store, capUsd: over.capUsd, todayFn: over.todayFn }),
    onComplete: async (o) => { completions.push({ ok: o.ok }); },
    resolveDeptFor: () => undefined,
  });
  return { store, vault, engine, completions };
}

const flush = () => new Promise((r) => setTimeout(r, 25));

describe("GoalEngine scheduler", () => {
  it("facade goal runs compiled chain to done, notifies", async () => {
    const { engine, store, completions } = harness();
    const g = engine.createFromPlaybook({
      playbook: "research-report", title: "R", request: "r it", channel: "telegram", chatId: "1",
    });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(store.listNodes(g.id).map((n) => n.status)).toEqual(["done", "done"]);
    expect(completions).toEqual([{ ok: true }]);
  });

  it("independent nodes run in parallel up to maxConcurrentNodes", async () => {
    let inFlight = 0, peak = 0;
    const run: SpecialistRunFn = async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { text: "out", costUsd: 0, numTurns: 1 };
    };
    const { engine, store } = harness({ run, maxConcurrentNodes: 2 });
    // Build a goal whose graph is a diamond: two parallel roots + a join.
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    engine.pauseGoal(g.slug); // stop the compiled chain before it schedules further
    await flush();
    store.skipUnfinishedNodes(g.id);
    store.insertNodes(g.id, [
      { node_key: "p1", type: "run", agent: "odin", critic: null, brief: "b", depends_on: [], max_rounds: 1 },
      { node_key: "p2", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: [], max_rounds: 1 },
      { node_key: "join", type: "run", agent: "athena", critic: null, brief: "b", depends_on: ["p1", "p2"], max_rounds: 1 },
    ]);
    engine.resumeGoal(g.slug);
    await vi.waitFor(() => {
      const byKey = new Map(store.listNodes(g.id).map((n) => [n.node_key, n.status]));
      expect(byKey.get("join")).toBe("done");
    });
    expect(peak).toBe(2);
  });

  it("budget cap pauses scheduling; resumeBudgetPaused resumes next day", async () => {
    let day = "2026-07-02";
    const { engine, store } = harness({ capUsd: 0.01, todayFn: () => day });
    store.budgetAdd("2026-07-02", 1); // already at cap (1 cent = $0.01)
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await flush();
    expect(store.getGoal(g.id)!.status).toBe("paused-budget");
    day = "2026-07-03"; // guard now reads a fresh, unspent day
    expect(engine.resumeBudgetPaused()).toBe(1);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
  });

  it("facade node hard-failure fails the goal and skips the rest", async () => {
    const run: SpecialistRunFn = async (role) => {
      if (role === "odin") throw new Error("boom");
      return { text: "out", costUsd: 0, numTurns: 1 };
    };
    const { engine, store, completions } = harness({ run });
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(store.listNodes(g.id).map((n) => n.status)).toEqual(["failed", "skipped"]);
    expect(completions).toEqual([{ ok: false }]);
  });

  it("createFromPlaybook ports the job gates (unknown playbook)", () => {
    const { engine } = harness();
    expect(() => engine.createFromPlaybook({ playbook: "nope", title: "t", request: "r", channel: "t", chatId: "1" }))
      .toThrow(/Unknown playbook/);
  });

  it("pause/resume/abandon by slug; abandon skips unfinished", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const run: SpecialistRunFn = async () => { await held; return { text: "o", costUsd: 0, numTurns: 1 }; };
    const { engine, store } = harness({ run });
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await flush();
    expect(engine.pauseGoal(g.slug)).toContain("paused");
    expect(store.getGoal(g.id)!.status).toBe("paused-user");
    expect(engine.resumeGoal(g.slug)).toContain("resumed");
    expect(engine.abandonGoal(g.slug)).toContain("abandoned");
    release();
    await flush();
    expect(store.getGoal(g.id)!.status).toBe("abandoned");
    expect(store.listNodes(g.id).some((n) => n.status === "skipped")).toBe(true);
  });

  it("resumeUnfinished resets orphaned running nodes and re-pumps", async () => {
    const { engine, store } = harness();
    // simulate a crash mid-run: a running goal with a running node, no in-memory state
    store.insertGoal({
      id: "g9", slug: "crashy", title: "C", request: "c", department: "engineering",
      lead: "athena", origin_channel: "t", origin_chat_id: "1", status: "running", project_dir: null,
      goal_dir: "2026-07-02-crashy", plan_summary: "playbook:research-report", replans_used: 0, chain_depth: 0, error: null,
    });
    store.insertNodes("g9", [
      { node_key: "a", type: "run", agent: "odin", critic: null, brief: "b", depends_on: [], max_rounds: 1 },
    ]);
    store.updateNodeStatus("g9", "a", "running");
    const n = engine.resumeUnfinished();
    expect(n).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => expect(store.getGoal("g9")!.status).toBe("done"));
  });
});

describe("GoalEngine guards (review fixes)", () => {
  it("wall-time exceeded → goal failed, nodes skipped", async () => {
    const { engine, store } = harness();
    (engine as unknown as { deps: { wallTimeMs: number } }).deps.wallTimeMs = -1000;
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(store.getGoal(g.id)!.error).toMatch(/wall-time/i);
  });

  it("goal whose pending nodes depend on a failed node fails loudly instead of hanging", async () => {
    const { engine, store, completions } = harness();
    store.insertGoal({
      id: "g8", slug: "stuck", title: "S", request: "s", department: "engineering",
      lead: "athena", origin_channel: "t", origin_chat_id: "1", status: "running", project_dir: null,
      goal_dir: "2026-07-03-stuck", plan_summary: "planned", replans_used: 2, chain_depth: 0, error: null,
    });
    store.insertNodes("g8", [
      { node_key: "a", type: "run", agent: "odin", critic: null, brief: "b", depends_on: [], max_rounds: 1 },
      { node_key: "b", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: ["a"], max_rounds: 1 },
    ]);
    store.updateNodeStatus("g8", "a", "failed", "boom");
    engine.pump();
    await vi.waitFor(() => expect(store.getGoal("g8")!.status).toBe("failed"));
    expect(store.getGoal("g8")!.error).toMatch(/stuck/);
    expect(store.listNodes("g8").find((n) => n.node_key === "b")!.status).toBe("skipped");
    expect(completions).toEqual([{ ok: false }]);
  });
});
