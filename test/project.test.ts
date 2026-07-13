// test/project.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { appendEvents, readJournal, type JournalEventType } from "../src/engine/journal.js";
import { reduce, nodeStatus } from "../src/engine/reduce.js";

const created = (over: Record<string, unknown> = {}) => ({
  type: "goal.created" as JournalEventType,
  payload: {
    slug: "x", title: "X", request: "do x", department: "engineering", lead: "athena",
    origin: { channel: "t", chatId: "1" }, chainDepth: 2, spawnedByMail: "m9",
    planSummary: "planned", goalDir: "2026-07-13-x", projectDir: "/p", ...over,
  },
});
const node = (key: string, dependsOn: string[] = []) =>
  ({ key, kind: "run", agent: "vulcan", critic: null, brief: "b", dependsOn, maxRounds: 1 });
const plan = (...keys: string[]) =>
  ({ type: "plan.recorded" as JournalEventType, payload: { summary: "s", needsWorkspace: "none", nodes: keys.map((k) => node(k)) } });

describe("projections", () => {
  it("goal.created + plan.recorded materialize goals/task_nodes rows (legacy=0)", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [created(), plan("a", "b")]);
    const g = store.getGoal("g1")!;
    expect(g).toMatchObject({
      slug: "x", title: "X", status: "running", department: "engineering", lead: "athena",
      plan_summary: "planned", chain_depth: 2, spawned_by_mail: "m9",
      goal_dir: "2026-07-13-x", project_dir: "/p",
    });
    expect(g.legacy ?? 0).toBe(0);
    const nodes = store.listNodes("g1");
    expect(nodes.map((n) => [n.node_key, n.status])).toEqual([["a", "ready"], ["b", "ready"]]);
  });

  it("full lifecycle keeps projected rows ≡ reduced state after EVERY event", () => {
    const store = new Store(":memory:");
    const steps: Array<{ type: JournalEventType; payload: Record<string, unknown> }> = [
      created({ spawnedByMail: null, chainDepth: 0, projectDir: null }),
      { type: "plan.recorded", payload: { summary: "s", needsWorkspace: "none", nodes: [node("a"), node("b", ["a"])] } },
      { type: "workspace.prepared", payload: { taskDir: "/ws/t", mode: "build" } },
      { type: "attempt.started", payload: { node: "a", attempt: 1, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:a:1" } },
      { type: "round.recorded", payload: { node: "a", attempt: 1, round: 1, role: "critic", verdict: { verdict: "approve", summary: "ok", reasons: [] }, feedback: "", artifactRef: "a-v1.md" } },
      { type: "attempt.finished", payload: { node: "a", attempt: 1, outcome: "ok", costCents: 25, turns: 4 } },
      { type: "node.completed", payload: { node: "a", artifactRef: "a.md", roundsUsed: 1 } },
      { type: "attempt.started", payload: { node: "b", attempt: 1, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:b:1" } },
      { type: "attempt.finished", payload: { node: "b", attempt: 1, outcome: "error", costCents: 5, turns: 1, error: "boom" } },
      { type: "attempt.started", payload: { node: "b", attempt: 2, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:b:2" } },
      { type: "attempt.finished", payload: { node: "b", attempt: 2, outcome: "error", costCents: 5, turns: 1, error: "boom" } },
      { type: "node.failed", payload: { node: "b", error: "boom" } },
      { type: "goal.failed", payload: { error: "node b failed: boom" } },
    ];
    for (const step of steps) {
      appendEvents(store, "g1", [step]);
      const state = reduce(readJournal(store, "g1"));
      const row = store.getGoal("g1")!;
      expect(row.status, step.type).toBe(state.phase === "awaiting-mail" ? "awaiting-mail" : state.phase);
      for (const key of state.order) {
        const nodeRow = store.listNodes("g1").find((n) => n.node_key === key)!;
        expect(nodeRow.status, `${step.type}/${key}`).toBe(nodeStatus(state, key));
        expect(nodeRow.cost_cents, `${step.type}/${key}`).toBe(state.nodes.get(key)!.costCents);
        expect(nodeRow.artifact, `${step.type}/${key}`).toBe(state.nodes.get(key)!.artifact);
      }
    }
    expect(store.getGoal("g1")!.error).toBe("node b failed: boom");
    expect(store.listNodes("g1").find((n) => n.node_key === "b")!.rounds_used).toBe(0);
    expect(store.listNodes("g1").find((n) => n.node_key === "a")!.rounds_used).toBe(1);
  });

  it("replan.recorded projects replace/add/retarget + bumps replans_used (replan kind only)", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [created(), plan("a", "b")]);
    appendEvents(store, "g1", [{ type: "node.failed", payload: { node: "a", error: "x" } }]);
    appendEvents(store, "g1", [{ type: "replan.recorded", payload: {
      kind: "replan", forNode: "a", replaced: [node("a")], added: [node("c")],
      retargets: [{ node: "b", dependsOn: ["c"] }], reason: "x",
    } }]);
    expect(store.getGoal("g1")!.replans_used).toBe(1);
    const rows = store.listNodes("g1");
    expect(rows.find((n) => n.node_key === "a")!.status).toBe("ready"); // replaced + no deps
    expect(JSON.parse(rows.find((n) => n.node_key === "b")!.depends_on)).toEqual(["c"]);
    expect(rows.some((n) => n.node_key === "c")).toBe(true);
    appendEvents(store, "g1", [{ type: "replan.recorded", payload: {
      kind: "resume", forNode: null, replaced: [], added: [node("resume_1")], retargets: [], reason: "ask",
    } }]);
    expect(store.getGoal("g1")!.replans_used).toBe(1); // resume never bumps
  });

  it("ask.parked/resumed + pause/resume + abandon project statuses and ask pointer", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [created(), plan("a", "b")]);
    appendEvents(store, "g1", [{ type: "ask.parked", payload: { node: "a", mailId: "m1" } }]);
    expect(store.getGoal("g1")).toMatchObject({ status: "awaiting-mail", awaiting_mail: "m1" });
    expect(store.listNodes("g1").find((n) => n.node_key === "a")!.status).toBe("done");
    appendEvents(store, "g1", [{ type: "ask.resumed", payload: { mailId: "m1", resumeNodeKey: "resume_1" } }]);
    expect(store.getGoal("g1")).toMatchObject({ status: "running", awaiting_mail: null });
    appendEvents(store, "g1", [{ type: "goal.paused", payload: { reason: "budget" } }]);
    expect(store.getGoal("g1")!.status).toBe("paused-budget");
    appendEvents(store, "g1", [{ type: "goal.resumed", payload: { by: "budget-reset" } }]);
    expect(store.getGoal("g1")!.status).toBe("running");
    appendEvents(store, "g1", [
      { type: "node.skipped", payload: { node: "b" } },
      { type: "goal.abandoned", payload: { by: "user" } },
    ]);
    expect(store.getGoal("g1")!.status).toBe("abandoned");
    expect(store.listNodes("g1").find((n) => n.node_key === "b")!.status).toBe("skipped");
  });

  it("goal.failed on a parked goal clears the dangling ask pointer", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [created(), plan("a", "b")]);
    appendEvents(store, "g1", [{ type: "ask.parked", payload: { node: "a", mailId: "m1" } }]);
    appendEvents(store, "g1", [{ type: "goal.failed", payload: { error: "sibling died" } }]);
    expect(store.getGoal("g1")).toMatchObject({ status: "failed", awaiting_mail: null });
  });

  it("workspace.prepared strips project_dir when stripped, sets it when taskDir", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [created(), plan("a")]);
    appendEvents(store, "g1", [{ type: "workspace.prepared", payload: { taskDir: null, mode: null, stripped: true } }]);
    expect(store.getGoal("g1")!.project_dir).toBeNull();
    appendEvents(store, "g2", [created({ slug: "y" }), plan("a")]);
    appendEvents(store, "g2", [{ type: "workspace.prepared", payload: { taskDir: "/ws/z", mode: "analyze" } }]);
    expect(store.getGoal("g2")!.project_dir).toBe("/ws/z");
  });

  it("legacy freeze: pre-migration rows get legacy=1 and drop out of scheduler queries", () => {
    const store = new Store(":memory:");
    // simulate an old row: insertGoal writes legacy default 0, flip it like the migration would
    store.insertGoal({
      id: "old1", slug: "old", title: "O", request: "o", department: "engineering", lead: "athena",
      origin_channel: "t", origin_chat_id: "1", status: "running", project_dir: null, goal_dir: null,
      plan_summary: "planned", replans_used: 0, chain_depth: 0, error: null,
    });
    store.freezeLegacyGoals();
    expect(store.unfinishedGoals()).toHaveLength(0);          // frozen: never scheduled
    expect(store.getGoal("old1")!.legacy).toBe(1);            // still readable
    appendEvents(store, "g1", [created(), plan("a")]);
    expect(store.unfinishedGoals().map((g) => g.id)).toEqual(["g1"]); // journal goals schedule
  });
});
