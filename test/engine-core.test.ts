// test/engine-core.test.ts — ports of goal-scheduler intents onto the journaled engine.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { GoalEngine, type Planner } from "../src/engine/engine.js";
import { readJournal, appendEvents } from "../src/engine/journal.js";
import { SpendGuard } from "../src/engine/budget.js";
import type { Playbook } from "../src/engine/playbook.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";

export function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "en-"));
  const eng = join(root, "agents", "engineering");
  mkdirSync(eng, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  for (const n of ["athena", "vulcan", "odin", "minos", "argus"]) {
    // athena doubles as the fixture's kind: coordinator (loader v2 requires exactly one at boot)
    writeFileSync(join(eng, `${n}.yaml`),
      `name: ${n}\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n${n === "athena" ? "kind: coordinator\n" : ""}`);
  }
  return loadRegistry(join(root, "agents"), join(root, "playbooks"));
}

export const PB: Playbook = {
  name: "research-report", description: "r", needsProjectDir: false,
  stages: [
    { type: "single", id: "gather", role: "odin", brief: "gather" },
    { type: "single", id: "write", role: "athena", brief: "write" },
  ],
};

export function harness(over: {
  run?: SpecialistRunFn; maxConcurrentNodes?: number; capUsd?: number;
  todayFn?: () => string; planner?: Planner; replanCap?: number;
  wallTimeMs?: number; nodeTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "en-vault-")), "AIOS");
  const registry = fixtureRegistry();
  const completions: Array<{ ok: boolean }> = [];
  const engine = new GoalEngine({
    store, vault, registry,
    run: over.run ?? (async () => ({ text: "out", costUsd: 0.01, numTurns: 1 })),
    playbooks: new Map([[PB.name, PB]]),
    wallTimeMs: over.wallTimeMs ?? 60_000,
    maxConcurrentNodes: over.maxConcurrentNodes ?? 2,
    mailMaxDepth: 2,
    spendGuard: new SpendGuard({ store, capUsd: over.capUsd, todayFn: over.todayFn }),
    onComplete: async (o) => { completions.push({ ok: o.ok }); },
    planner: over.planner,
    replanCap: over.replanCap,
    nodeTimeoutMs: over.nodeTimeoutMs,
    sleep: over.sleep,
  });
  return { store, vault, engine, completions };
}

/** Seed a planned (non-facade) goal through the public API — raw insertGoal rows have
 *  no journal and the new engine (correctly) ignores them. */
export function plannedGoal(engine: GoalEngine, nodes: Array<{ key: string; agent?: string; deps?: string[] }>) {
  return engine.startPlannedGoal({
    title: "P", request: "do it", department: "engineering", lead: "athena",
    origin: { channel: "t", chatId: "1" }, summary: "planned", needsWorkspace: "none",
    nodes: nodes.map((n) => ({
      node_key: n.key, type: "run" as const, agent: n.agent ?? "odin", critic: null,
      brief: "b", depends_on: n.deps ?? [], max_rounds: 1,
    })),
  });
}

describe("engine core (ports of goal-scheduler intents)", () => {
  it("gives an unclaimed playbook's goal to the org's own coordinator", () => {
    // Onboarding writes every department with `playbooks: []`, so an unclaimed playbook is the
    // NORMAL case for a provisioned org — and the old fallback handed the goal to department
    // "operations" under lead "neo", two names that exist only on the author's install. The
    // fixture's coordinator is athena in engineering, and neither literal appears here.
    const { engine, store } = harness();
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    const row = store.getGoal(g.id)!;
    expect(row.department).toBe("engineering");
    expect(row.lead).toBe("athena");
  });

  it("facade goal runs compiled chain to done, notifies", async () => {
    const { engine, store, completions } = harness();
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r it", channel: "telegram", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(store.listNodes(g.id).map((n) => n.status)).toEqual(["done", "done"]);
    expect(completions).toEqual([{ ok: true }]);
    // the journal is the truth: full lifecycle recorded
    const types = readJournal(store, g.id).map((e) => e.type);
    for (const t of ["goal.created", "plan.recorded", "workspace.prepared", "attempt.started", "attempt.finished", "node.completed", "goal.completed"] as const) {
      expect(types).toContain(t);
    }
  });

  it("independent nodes run in parallel up to maxConcurrentNodes (diamond)", async () => {
    let inFlight = 0, peak = 0;
    const run: SpecialistRunFn = async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { text: "out", costUsd: 0, numTurns: 1 };
    };
    const { engine, store } = harness({ run, maxConcurrentNodes: 2 });
    const g = plannedGoal(engine, [
      { key: "p1" }, { key: "p2", agent: "vulcan" }, { key: "join", agent: "athena", deps: ["p1", "p2"] },
    ]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(peak).toBe(2);
  });

  it("budget cap parks scheduling; resumeBudgetPaused resumes next day", async () => {
    let day = "2026-07-02";
    const { engine, store } = harness({ capUsd: 0.01, todayFn: () => day });
    store.budgetAdd("2026-07-02", 1);
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("paused-budget"));
    day = "2026-07-03";
    expect(engine.resumeBudgetPaused()).toBe(1);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
  });

  it("an unreachable API pauses the goal instead of failing it", async () => {
    const { engine, store } = harness({
      run: async () => ({ text: "API Error: Unable to connect to API (ConnectionRefused)", costUsd: 0, numTurns: 0 }),
      sleep: async () => {},
    });
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("paused-api"));
    expect(store.getGoal(g.id)!.error).toContain("Unable to connect");
  });

  it("resumeApiPaused un-pauses api-paused goals when connectivity returns", async () => {
    let down = true;
    const { engine, store } = harness({
      run: async () => (down
        ? { text: "API Error: Unable to connect to API (ConnectionRefused)", costUsd: 0, numTurns: 0 }
        : { text: "out", costUsd: 0.01, numTurns: 1 }),
      sleep: async () => {},
    });
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("paused-api"));

    down = false;
    expect(engine.resumeApiPaused()).toBe(1);
    // the attempt was never counted, so the node still has budget to finish
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
  });

  it("hard node failure: visible retry (attempt 2), then goal failed + rest skipped", async () => {
    let calls = 0;
    const run: SpecialistRunFn = async (role) => {
      if (role === "odin") { calls++; throw new Error("boom"); }
      return { text: "out", costUsd: 0, numTurns: 1 };
    };
    const { engine, store, completions } = harness({ run });
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(calls).toBe(2); // maxAttempts default 2 — every retry a journaled attempt
    const attempts = readJournal(store, g.id).filter((e) => e.type === "attempt.finished");
    expect(attempts.map((a) => a.payload.attempt)).toEqual([1, 2]);
    expect(store.listNodes(g.id).map((n) => n.status)).toEqual(["failed", "skipped"]);
    expect(completions).toEqual([{ ok: false }]);
  });

  it("createFromPlaybook gates: unknown playbook throws", () => {
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
    await new Promise((r) => setTimeout(r, 25));
    expect(engine.pauseGoal(g.slug)).toContain("paused");
    expect(store.getGoal(g.id)!.status).toBe("paused-user");
    expect(engine.resumeGoal(g.slug)).toContain("resumed");
    expect(engine.abandonGoal(g.slug)).toContain("abandoned");
    release();
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("abandoned"));
    expect(store.listNodes(g.id).some((n) => n.status === "skipped")).toBe(true);
  });

  it("wall-time exceeded → goal failed, nodes skipped", async () => {
    const { engine, store } = harness({ wallTimeMs: -1000 });
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(store.getGoal(g.id)!.error).toMatch(/wall-time/i);
  });

  it("re-plan: planner returns a patch, engine records it, replacement runs, goal completes", async () => {
    let calls = 0, replans = 0;
    const run: SpecialistRunFn = async () => {
      calls++;
      if (calls <= 2) throw new Error("boom"); // attempt 1 + retry both fail
      return { text: "fixed", costUsd: 0, numTurns: 1 };
    };
    const planner: Planner = {
      plan: async () => { throw new Error("unused"); },
      planFromMail: async () => { throw new Error("unused"); },
      async replan(_goal, failed) {
        replans++;
        return { replaced: [{ key: failed.node_key, type: "run", agent: "odin", brief: "retry", deps: [] }], added: [] };
      },
    };
    const { engine, store, completions } = harness({ run, planner });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(replans).toBe(1);
    expect(store.getGoal(g.id)!.replans_used).toBe(1);
    expect(completions).toEqual([{ ok: true }]);
  });

  it("re-plan cap exhausted → goal fails without calling the planner", async () => {
    let called = false;
    const planner: Planner = {
      plan: async () => { throw new Error("unused"); },
      planFromMail: async () => { throw new Error("unused"); },
      replan: async () => { called = true; return { replaced: [], added: [] }; },
    };
    const { engine, store, completions } = harness({
      run: async () => { throw new Error("boom"); }, planner, replanCap: 0,
    });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(store.getGoal(g.id)!.error).toMatch(/re-plans exhausted: 0/);
    expect(called).toBe(false);
    expect(completions).toEqual([{ ok: false }]);
  });

  it("re-plan throws → goal fails 're-planning failed'", async () => {
    const planner: Planner = {
      plan: async () => { throw new Error("unused"); },
      planFromMail: async () => { throw new Error("unused"); },
      replan: async () => { throw new Error("lead returned no patch ops"); },
    };
    const { engine, store } = harness({ run: async () => { throw new Error("boom"); }, planner });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(store.getGoal(g.id)!.error).toMatch(/re-planning failed: lead returned no patch ops/);
  });

  it("session-limit output pauses the goal (paused-session), planner untouched", async () => {
    const run: SpecialistRunFn = async () => ({ text: "You've hit your session limit — resets at 3pm", costUsd: 0, numTurns: 1 });
    const { engine, store, completions } = harness({ run });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("paused-session"));
    expect(completions).toEqual([]);
  });

  it("resumeSessionPaused probes only after 30 min; a reset quota lets the goal finish", async () => {
    let limited = true;
    const { engine, store } = harness({
      run: async () => (limited
        ? { text: "You've hit your session limit — resets at 3pm", costUsd: 0, numTurns: 1 }
        : { text: "out", costUsd: 0.01, numTurns: 1 }),
    });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("paused-session"));

    expect(engine.resumeSessionPaused()).toBe(0); // just paused — the 30-min gate holds
    limited = false;
    expect(engine.resumeSessionPaused(() => Date.now() + 31 * 60_000)).toBe(1);
    // the limited attempt was never counted, so the node still has budget to finish
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
  });

  it("per-node timeout: a hung attempt is aborted on tick and retried/failed visibly", async () => {
    const run: SpecialistRunFn = (_r, _b, opts) =>
      new Promise((_res, rej) => opts.signal?.addEventListener("abort", () => rej(new Error("hung"))));
    const { engine, store } = harness({ run, nodeTimeoutMs: 1 });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await new Promise((r) => setTimeout(r, 20));
    engine.tick(); // clock tick sweeps past-deadline attempts
    await vi.waitFor(() => {
      const outcomes = readJournal(store, g.id)
        .filter((e) => e.type === "attempt.finished").map((e) => e.payload.outcome);
      expect(outcomes).toContain("timeout");
    });
    engine.tick();
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed")); // both attempts time out
  });

  it("crossing the budget cap mid-attempt aborts in-flight work and parks the goal", async () => {
    const day = "2026-07-02";
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const run: SpecialistRunFn = (_r, _b, opts) => new Promise((res, rej) => {
      opts.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      void held.then(() => res({ text: "o", costUsd: 0, numTurns: 1 }));
    });
    const { engine, store } = harness({ run, capUsd: 0.5, todayFn: () => day });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await new Promise((r) => setTimeout(r, 20));
    store.budgetAdd(day, 100); // cap crossed while the attempt is in flight
    engine.tick();
    await vi.waitFor(() => {
      const outcomes = readJournal(store, g.id)
        .filter((e) => e.type === "attempt.finished").map((e) => e.payload.outcome);
      expect(outcomes).toContain("aborted");
    });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("paused-budget"));
    release();
  });

  it("boot recovery: dangling attempt orphaned, goal still terminates (replay, no resets)", async () => {
    // maxConcurrentNodes 0 → nothing schedules; we hand-seed a crash-window journal:
    // attempt.started with no attempt.finished (daemon died mid-attempt).
    const seeded = harness({ maxConcurrentNodes: 0 });
    const g = plannedGoal(seeded.engine, [{ key: "a" }]);
    appendEvents(seeded.store, g.id, [
      { type: "workspace.prepared", payload: { taskDir: null, mode: null } },
      { type: "attempt.started", payload: { node: "a", attempt: 1, agent: "odin", deadlineTs: 9e12, idempotencyKey: `${g.id}:a:1` } },
    ]);
    // "reboot": a fresh engine over the same store (same journal), now with worker slots.
    const rebooted = new GoalEngine({
      ...(seeded.engine as unknown as { deps: ConstructorParameters<typeof GoalEngine>[0] }).deps,
      maxConcurrentNodes: 2,
    });
    const n = rebooted.resumeUnfinished();
    expect(n).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => expect(seeded.store.getGoal(g.id)!.status).toBe("done"));
    const outcomes = readJournal(seeded.store, g.id)
      .filter((e) => e.type === "attempt.finished").map((e) => e.payload.outcome);
    expect(outcomes).toContain("orphaned");   // dangling attempt closed by recovery
    expect(outcomes).toContain("ok");         // retry (attempt 2) completed the node
  });
});
