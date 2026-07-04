// test/goal-runner.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type GoalRow } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { runNode, ancestorArtifacts, SessionLimitError } from "../src/engine/goals.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";

function harness(run: SpecialistRunFn) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "gr-vault-")), "AIOS");
  store.insertGoal({
    id: "g1", slug: "build-x", title: "Build X", request: "build x",
    department: "engineering", lead: "athena", origin_channel: "telegram", origin_chat_id: "1",
    status: "running", project_dir: null, goal_dir: vault.goalDirName("build-x"),
    plan_summary: "", replans_used: 0, chain_depth: 0, error: null,
  });
  store.setGoalDir("g1", vault.goalDirName("build-x"));
  const events: string[] = [];
  const deps = {
    store, vault, run,
    onEvent: (e: { type: string }) => events.push(e.type),
    resolvePack: () => undefined,
  };
  return { store, vault, deps, events, goal: () => store.getGoal("g1")! };
}

const NODE = (over: Record<string, unknown> = {}) => ({
  goal_id: "g1", node_key: "design", type: "run" as const, agent: "athena", critic: null,
  brief: "design it", depends_on: "[]", max_rounds: 1, status: "ready" as const,
  artifact: null, cost_cents: 0, rounds_used: 0, error: null, started_at: null, finished_at: null, ...over,
});

describe("runNode", () => {
  it("run node: brief+context to agent, artifact written, cost recorded", async () => {
    const briefs: string[] = [];
    const { store, vault, deps, goal } = harness(async (_r, brief) => {
      briefs.push(brief);
      return { text: "the design", costUsd: 0.05, numTurns: 2 };
    });
    store.insertNodes("g1", [{ node_key: "design", type: "run", agent: "athena", critic: null, brief: "design it", depends_on: [], max_rounds: 1 }]);
    await runNode(goal(), store.listNodes("g1")[0], deps);
    expect(briefs[0]).toContain("design it");
    expect(briefs[0]).toContain("# Task\nbuild x");
    expect(vault.readGoalArtifact(goal().goal_dir!, "design.md")).toContain("the design");
    const n = store.listNodes("g1")[0];
    expect(n.cost_cents).toBe(5);
    expect(n.artifact).toBe("design.md");
  });

  it("loop node: revise then approve, artifacts per round, rounds_used set", async () => {
    let call = 0;
    const { store, deps, goal, vault } = harness(async (role) => {
      call++;
      if (role === "minos-eng") {
        const verdict = call === 2
          ? { verdict: "revise", summary: "needs work", reasons: ["r1"] }
          : { verdict: "approve", summary: "good", reasons: [] };
        return { text: "review", structured: verdict, costUsd: 0.01, numTurns: 1 };
      }
      return { text: `v${call}`, costUsd: 0.01, numTurns: 1 };
    });
    store.insertNodes("g1", [{ node_key: "impl", type: "loop", agent: "vulcan", critic: "minos-eng", brief: "build", depends_on: [], max_rounds: 3 }]);
    await runNode(goal(), store.listNodes("g1")[0], deps);
    const n = store.listNodes("g1")[0];
    expect(n.rounds_used).toBe(2);
    expect(vault.readGoalArtifact(goal().goal_dir!, "impl-v1.md")).toBeTruthy();
    expect(vault.readGoalArtifact(goal().goal_dir!, "impl-review-2.md")).toContain("approve");
    expect(vault.readGoalArtifact(goal().goal_dir!, "impl.md")).not.toContain("Loop cap reached");
  });

  it("verify node: failing report triggers fixer, passing stops", async () => {
    let runnerCalls = 0;
    const roles: string[] = [];
    const { store, deps, goal } = harness(async (role) => {
      roles.push(role);
      if (role === "argus") {
        runnerCalls++;
        return {
          text: "report",
          structured: { passed: runnerCalls > 1, summary: "s", failures: runnerCalls > 1 ? [] : ["f1"] },
          costUsd: 0.01, numTurns: 1,
        };
      }
      return { text: "fixed", costUsd: 0.01, numTurns: 1 };
    });
    store.insertNodes("g1", [{ node_key: "test", type: "verify", agent: "argus", critic: "vulcan", brief: "test it", depends_on: [], max_rounds: 3 }]);
    await runNode(goal(), store.listNodes("g1")[0], deps);
    expect(roles).toEqual(["argus", "vulcan", "argus"]);
  });

  it("session-limit output becomes SessionLimitError, not retried", async () => {
    let calls = 0;
    const { store, deps, goal } = harness(async () => {
      calls++;
      return { text: "You've hit your session limit — resets at 3pm", costUsd: 0, numTurns: 1 };
    });
    store.insertNodes("g1", [{ node_key: "design", type: "run", agent: "athena", critic: null, brief: "b", depends_on: [], max_rounds: 1 }]);
    await expect(runNode(goal(), store.listNodes("g1")[0], deps)).rejects.toBeInstanceOf(SessionLimitError);
    expect(calls).toBe(1);
  });

  it("non-limit failure retries once", async () => {
    let calls = 0;
    const { store, deps, goal } = harness(async () => {
      calls++;
      if (calls === 1) throw new Error("flake");
      return { text: "ok", costUsd: 0.01, numTurns: 1 };
    });
    store.insertNodes("g1", [{ node_key: "design", type: "run", agent: "athena", critic: null, brief: "b", depends_on: [], max_rounds: 1 }]);
    await runNode(goal(), store.listNodes("g1")[0], deps);
    expect(calls).toBe(2);
  });

  it("ancestorArtifacts: transitive deps only, done+artifact only", () => {
    const { store } = harness(async () => ({ text: "", costUsd: 0, numTurns: 0 }));
    store.insertNodes("g1", [
      { node_key: "a", type: "run", agent: "x", critic: null, brief: "", depends_on: [], max_rounds: 1 },
      { node_key: "b", type: "run", agent: "x", critic: null, brief: "", depends_on: ["a"], max_rounds: 1 },
      { node_key: "sib", type: "run", agent: "x", critic: null, brief: "", depends_on: ["a"], max_rounds: 1 },
      { node_key: "c", type: "run", agent: "x", critic: null, brief: "", depends_on: ["b"], max_rounds: 1 },
    ]);
    store.updateNodeStatus("g1", "a", "done"); store.setNodeArtifact("g1", "a", "a.md");
    store.updateNodeStatus("g1", "b", "done"); store.setNodeArtifact("g1", "b", "b.md");
    store.updateNodeStatus("g1", "sib", "done"); store.setNodeArtifact("g1", "sib", "sib.md");
    const anc = ancestorArtifacts(store.listNodes("g1"), "c").map((n) => n.node_key);
    expect(anc.sort()).toEqual(["a", "b"]); // sibling excluded
  });
});
