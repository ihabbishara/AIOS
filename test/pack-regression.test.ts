// test/pack-regression.test.ts — pack threading pin, ported from the executor to runNode.
import { describe, it, expect } from "vitest";
import { runNode } from "../src/engine/goals.js";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function harness(pack?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const store = new Store(":memory:");
  const vault = new VaultWriter(root, "AIOS");
  vault.init();
  store.insertGoal({
    id: "g1", slug: "p", title: "P", request: "do", department: "research", lead: "clio",
    origin_channel: "cli", origin_chat_id: "x", status: "running", project_dir: null,
    goal_dir: null, plan_summary: "playbook:p", replans_used: 0, error: null,
  });
  store.setGoalDir("g1", vault.goalDirName("p"));
  store.insertNodes("g1", [
    { node_key: "s1", type: "run", agent: "researcher", critic: null, brief: "", depends_on: [], max_rounds: 1 },
  ]);
  const seen: Array<Record<string, unknown>> = [];
  const run = async (_role: string, _brief: string, opts: Record<string, unknown>) => {
    seen.push(opts);
    return { text: "ok", costUsd: 0, numTurns: 1 };
  };
  const deps = { store, vault, run: run as never, resolvePack: () => pack as never };
  return { root, store, deps, seen, goal: () => store.getGoal("g1")! };
}

describe("node runner pack threading", () => {
  it("packless node passes NO pack in run opts (zero regression)", async () => {
    const { root, store, deps, seen, goal } = harness(undefined);
    await runNode(goal(), store.listNodes("g1")[0], deps);
    expect(seen[0].pack).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("passes the resolved pack through to every run opts when set", async () => {
    const fakePack = { pillar: "money", contextBlock: "x", tools: [], mcpServers: {} };
    const { root, store, deps, seen, goal } = harness(fakePack);
    await runNode(goal(), store.listNodes("g1")[0], deps);
    expect(seen[0].pack).toBe(fakePack);
    rmSync(root, { recursive: true, force: true });
  });
});
