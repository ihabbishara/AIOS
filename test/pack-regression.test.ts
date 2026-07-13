// test/pack-regression.test.ts — pack threading pin, ported to the journaled attempt runner.
import { describe, it, expect } from "vitest";
import { runAttempt, AbortRegistry } from "../src/engine/goals.js";
import { appendEvents, type NodeSpec } from "../src/engine/journal.js";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SPEC: NodeSpec = { key: "s1", kind: "run", agent: "researcher", critic: null, brief: "", dependsOn: [], maxRounds: 1 };

function harness(pack?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const store = new Store(":memory:");
  const vault = new VaultWriter(root, "AIOS");
  vault.init();
  appendEvents(store, "g1", [
    { type: "goal.created", payload: {
      slug: "p", title: "P", request: "do", department: "research", lead: "clio",
      origin: { channel: "cli", chatId: "x" }, chainDepth: 0, spawnedByMail: null,
      planSummary: "playbook:p", goalDir: vault.goalDirName("p"), projectDir: null } },
    { type: "plan.recorded", payload: { summary: "s", needsWorkspace: "none", nodes: [SPEC] } },
    { type: "workspace.prepared", payload: { taskDir: null, mode: null } },
  ]);
  const seen: Array<Record<string, unknown>> = [];
  const run = async (_role: string, _brief: string, opts: Record<string, unknown>) => {
    seen.push(opts);
    return { text: "ok", costUsd: 0, numTurns: 1 };
  };
  const deps = {
    store, vault, run: run as never, resolvePack: () => pack as never,
    registry: new AbortRegistry(), nodeTimeoutMs: 900_000,
  };
  return { root, store, deps, seen, goal: () => store.getGoal("g1")! };
}

describe("node runner pack threading", () => {
  it("packless node passes NO pack in run opts (zero regression)", async () => {
    const { root, deps, seen, goal } = harness(undefined);
    await runAttempt(goal(), SPEC, 1, deps);
    expect(seen[0].pack).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("passes the resolved pack through to every run opts when set", async () => {
    const fakePack = { pillar: "money", contextBlock: "x", tools: [], mcpServers: {} };
    const { root, deps, seen, goal } = harness(fakePack);
    await runAttempt(goal(), SPEC, 1, deps);
    expect(seen[0].pack).toBe(fakePack);
    rmSync(root, { recursive: true, force: true });
  });
});
