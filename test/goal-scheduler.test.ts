// test/goal-scheduler.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { GoalEngine, type Planner } from "../src/engine/goals.js";
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
  planner?: Planner;
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
    planner: over.planner,
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

describe("GoalEngine re-plan orchestration (onNodeFailure)", () => {
  // Insert a lead-planned goal (non-facade: plan_summary "planned") with one runnable node.
  const plannedGoal = (store: Store, id: string, over: Record<string, unknown> = {}) => {
    store.insertGoal({
      id, slug: id, title: "P", request: "do it", department: "engineering", lead: "athena",
      origin_channel: "t", origin_chat_id: "1", status: "running", project_dir: null,
      goal_dir: `2026-07-04-${id}`, plan_summary: "planned", replans_used: 0, chain_depth: 0, error: null, ...over,
    });
    store.insertNodes(id, [{ node_key: "a", type: "run", agent: "odin", critic: null, brief: "b", depends_on: [], max_rounds: 1 }]);
  };
  // A node fails only after runOnce + its one retry both throw — hence "throw twice, then succeed".
  const throwThenOk = (throws: number): SpecialistRunFn => {
    let calls = 0;
    return async () => {
      calls++;
      if (calls <= throws) throw new Error("boom");
      return { text: "fixed", costUsd: 0, numTurns: 1 };
    };
  };

  it("node fails → engine re-plans, replacement runs, goal completes; replans_used bumped", async () => {
    let store!: Store, replans = 0;
    const planner: Planner = {
      plan: async () => { throw new Error("unused"); },
      planFromMail: async () => { throw new Error("unused"); },
      async replan(goal, failed) {
        replans++;
        // Faithful to production replan: DELETE the failed node + insert a fresh one (same key, pending).
        store.replaceNode(goal.id, failed.node_key,
          { node_key: failed.node_key, type: "run", agent: "odin", critic: null, brief: "retry", depends_on: [], max_rounds: 1 });
      },
    };
    const h = harness({ run: throwThenOk(2), planner });
    store = h.store;
    plannedGoal(store, "gp1");
    h.engine.pump();
    await vi.waitFor(() => expect(store.getGoal("gp1")!.status).toBe("done"));
    expect(replans).toBe(1);
    expect(store.getGoal("gp1")!.replans_used).toBe(1);
    expect(h.completions).toEqual([{ ok: true }]);
  });

  it("re-plan cap exhausted → goal fails without calling the planner", async () => {
    let called = false;
    const planner: Planner = {
      plan: async () => { throw new Error("unused"); },
      planFromMail: async () => { throw new Error("unused"); },
      replan: async () => { called = true; },
    };
    const { engine, store, completions } = harness({ run: throwThenOk(2), planner });
    plannedGoal(store, "gp2", { replans_used: 2 }); // already at the default cap of 2
    engine.pump();
    await vi.waitFor(() => expect(store.getGoal("gp2")!.status).toBe("failed"));
    expect(store.getGoal("gp2")!.error).toMatch(/re-plans exhausted: 2/);
    expect(store.listNodes("gp2")[0].status).toBe("failed");
    expect(called).toBe(false);
    expect(completions).toEqual([{ ok: false }]);
  });

  it("re-plan throws → goal fails 're-planning failed'; the attempt still counts", async () => {
    const planner: Planner = {
      plan: async () => { throw new Error("unused"); },
      planFromMail: async () => { throw new Error("unused"); },
      replan: async () => { throw new Error("lead returned no patch ops"); },
    };
    const { engine, store, completions } = harness({ run: throwThenOk(2), planner });
    plannedGoal(store, "gp3");
    engine.pump();
    await vi.waitFor(() => expect(store.getGoal("gp3")!.status).toBe("failed"));
    expect(store.getGoal("gp3")!.error).toMatch(/re-planning failed: lead returned no patch ops/);
    expect(store.getGoal("gp3")!.replans_used).toBe(1); // bumped before replan threw
    expect(completions).toEqual([{ ok: false }]);
  });

  it("session-limit during a node pauses the goal (paused-user), not re-planned", async () => {
    let called = false;
    const planner: Planner = {
      plan: async () => { throw new Error("unused"); },
      planFromMail: async () => { throw new Error("unused"); },
      replan: async () => { called = true; },
    };
    // Session-limit is signalled by the agent's OUTPUT text, converted to SessionLimitError upstream.
    const run: SpecialistRunFn = async () => ({ text: "You've hit your session limit — resets at 3pm", costUsd: 0, numTurns: 1 });
    const { engine, store, completions } = harness({ run, planner });
    plannedGoal(store, "gp4");
    engine.pump();
    await vi.waitFor(() => expect(store.getGoal("gp4")!.status).toBe("paused-user"));
    expect(called).toBe(false);
    expect(completions).toEqual([]); // paused, not completed
  });
});

describe("GoalEngine mid-goal clarification (park + resume)", () => {
  // A parked asker goal 'g-ask' waits on request 'mQ'; a report answering mQ must resume it.
  // maxConcurrentNodes:0 so pump schedules the resume node but does not launch it (g-ask has no
  // goal_dir in these fixtures) — assertions stay synchronous and deterministic.
  function parkedAsker(store: Store) {
    store.insertGoal({
      id: "g-ask", slug: "g-ask", title: "asker", request: "do the thing", department: "engineering",
      lead: "athena", origin_channel: "telegram", origin_chat_id: "1", status: "running",
      project_dir: null, goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, error: null,
    });
    store.insertNodes("g-ask", [{ node_key: "task", type: "run", agent: "athena", critic: null,
      brief: "b", depends_on: [], max_rounds: 1 }]);
    store.updateNodeStatus("g-ask", "task", "done");
    store.insertMail({ id: "mQ", from_agent: "athena", to_agent: "vulcan", kind: "request",
      body: "which db?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "queued", error: null });
    store.parkGoalAwaiting("g-ask", "mQ");
  }

  it("a report answering the awaited request adds a continuation node and un-parks the goal", async () => {
    const { store, engine } = harness({ maxConcurrentNodes: 0 });
    parkedAsker(store);
    // A recipient goal spawned by mQ completes → mailReport(ok) → resumeFromAnswer.
    store.insertGoal({
      id: "g-rec", slug: "g-rec", title: "rec", request: "which db?", department: "engineering",
      lead: "athena", origin_channel: "telegram", origin_chat_id: "1", status: "running",
      project_dir: null, goal_dir: null, plan_summary: "mail:mQ", replans_used: 0, chain_depth: 1,
      error: null, spawned_by_mail: "mQ",
    });
    store.insertNodes("g-rec", [{ node_key: "task", type: "run", agent: "vulcan", critic: null,
      brief: "answer", depends_on: [], max_rounds: 1 }]);
    store.updateNodeStatus("g-rec", "task", "done");
    await (engine as unknown as { complete: (g: unknown, ok: boolean) => Promise<void> })
      .complete(store.getGoal("g-rec"), true);
    // asker un-parked, a resume node exists, and it got scheduled to run.
    expect(store.getGoal("g-ask")).toMatchObject({ status: "running", awaiting_mail: null });
    const keys = store.listNodes("g-ask").map((n) => n.node_key);
    expect(keys.some((k) => k.startsWith("resume_"))).toBe(true);
    const report = store.mailAnsweringRequest("mQ")!;
    expect(report).toMatchObject({ in_reply_to: "mQ", thread_id: "mQ" });
  });

  it("boot reconcile resumes a parked goal whose answer already landed, leaves others parked", () => {
    const { store, engine } = harness({ maxConcurrentNodes: 0 });
    parkedAsker(store);
    store.insertMail({ id: "rep", from_agent: "vulcan", to_agent: "athena", kind: "report",
      body: "Done: use sqlite", goal_id: "g-rec", origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "unread", error: null, thread_id: "mQ", in_reply_to: "mQ" });
    // second parked goal with NO answer yet
    store.insertGoal({ id: "g2", slug: "g2", title: "t2", request: "r2", department: "engineering",
      lead: "athena", origin_channel: "telegram", origin_chat_id: "1", status: "running",
      project_dir: null, goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, error: null });
    store.parkGoalAwaiting("g2", "mZ");
    engine.resumeUnfinished();
    expect(store.getGoal("g-ask")!.status).toBe("running");
    expect(store.getGoal("g2")!.status).toBe("awaiting-mail");
  });

  it("resume-on-refusal: a parked asker's request refused at sweep resumes with the refusal", () => {
    const { store, engine } = harness({ maxConcurrentNodes: 0 });
    // Fresh parked goal awaiting a request addressed to an unknown recipient — sweepMail refuses
    // it deterministically (no async planner/spawn path involved).
    store.insertGoal({
      id: "g-refused", slug: "g-refused", title: "asker", request: "do the thing", department: "engineering",
      lead: "athena", origin_channel: "telegram", origin_chat_id: "1", status: "running",
      project_dir: null, goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, error: null,
    });
    store.insertMail({ id: "mR", from_agent: "athena", to_agent: "ghost", kind: "request",
      body: "which db?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "queued", error: null });
    store.parkGoalAwaiting("g-refused", "mR");
    engine.pump(); // sweepMail: unknown recipient → refuseMail + resumeFromAnswer
    expect(store.getGoal("g-refused")).toMatchObject({ status: "running", awaiting_mail: null });
    const resumeNode = store.listNodes("g-refused").find((n) => n.node_key.startsWith("resume_"));
    expect(resumeNode).toBeTruthy();
    expect(resumeNode!.brief).toContain("Refused");
  });

  it("resume-on-downgrade: a parked asker's request past the depth cap downgrades and resumes with Declined", () => {
    const { store, engine } = harness({ maxConcurrentNodes: 0 }); // harness mailMaxDepth = 2
    store.insertGoal({
      id: "g-deep", slug: "g-deep", title: "asker", request: "do the thing", department: "engineering",
      lead: "athena", origin_channel: "telegram", origin_chat_id: "1", status: "running",
      project_dir: null, goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, error: null,
    });
    store.insertMail({ id: "mD", from_agent: "athena", to_agent: "vulcan", kind: "request",
      body: "which db?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 3, status: "queued", error: null }); // > mailMaxDepth (2)
    store.parkGoalAwaiting("g-deep", "mD");
    engine.pump(); // sweepMail: depth guard downgrades to note + resumeFromAnswer("Declined: ...")
    expect(store.getGoal("g-deep")).toMatchObject({ status: "running", awaiting_mail: null });
    const resumeNode = store.listNodes("g-deep").find((n) => n.node_key.startsWith("resume_"));
    expect(resumeNode).toBeTruthy();
    expect(resumeNode!.brief).toContain("Declined");
    expect(store.getMail("mD")).toMatchObject({ kind: "note", status: "unread" });
  });

  it("boot reconcile resumes a parked goal whose awaited request was already downgraded to a note (FIX 1)", () => {
    const { store, engine } = harness({ maxConcurrentNodes: 0 });
    store.insertGoal({
      id: "g-boot-note", slug: "g-boot-note", title: "asker", request: "do the thing", department: "engineering",
      lead: "athena", origin_channel: "telegram", origin_chat_id: "1", status: "running",
      project_dir: null, goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, error: null,
    });
    // Simulates a crash between downgradeMailToNote and its resumeFromAnswer at sweep time:
    // the mail already landed as a downgraded note, but the goal is still parked.
    store.insertMail({ id: "mBootNote", from_agent: "athena", to_agent: "vulcan", kind: "note",
      body: "which db?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 3, status: "unread", error: "downgraded: chain too deep (cap 2)" });
    store.parkGoalAwaiting("g-boot-note", "mBootNote");
    engine.resumeUnfinished();
    expect(store.getGoal("g-boot-note")).toMatchObject({ status: "running", awaiting_mail: null });
    const resumeNode = store.listNodes("g-boot-note").find((n) => n.node_key.startsWith("resume_"));
    expect(resumeNode).toBeTruthy();
    expect(resumeNode!.brief).toContain("Declined");
  });
});
