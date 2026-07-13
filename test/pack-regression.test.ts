// test/pack-regression.test.ts — workspace/origin threading pin on the journaled attempt runner.
// (Was the pack-threading pin; packs died with the capability cutover — the engine's remaining
// contract is threading workspace + origin + idempotencyKey into every run's options.)
import { describe, it, expect } from "vitest";
import { runAttempt, AbortRegistry } from "../src/engine/goals.js";
import { appendEvents, type NodeSpec } from "../src/engine/journal.js";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SPEC: NodeSpec = { key: "s1", kind: "run", agent: "researcher", critic: null, brief: "", dependsOn: [], maxRounds: 1 };

function harness(workspace?: { taskDir: string; mode: "build" | "analyze" }) {
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
    store, vault, run: run as never, workspace,
    registry: new AbortRegistry(), nodeTimeoutMs: 900_000,
  };
  return { root, store, deps, seen, goal: () => store.getGoal("g1")! };
}

describe("node runner workspace/origin threading", () => {
  it("workspace-less node passes NO workspace in run opts (zero regression)", async () => {
    const { root, deps, seen, goal } = harness(undefined);
    await runAttempt(goal(), SPEC, 1, deps);
    expect(seen[0].workspace).toBeUndefined();
    expect(seen[0].origin).toEqual({ channel: "cli", chatId: "x" });
    expect(seen[0].idempotencyKey).toBe("g1:s1:1");
    rmSync(root, { recursive: true, force: true });
  });

  it("threads the sandbox workspace through to every run opts when set", async () => {
    const ws = { taskDir: "/tmp/ws", mode: "analyze" as const };
    const { root, deps, seen, goal } = harness(ws);
    await runAttempt(goal(), SPEC, 1, deps);
    expect(seen[0].workspace).toBe(ws);
    rmSync(root, { recursive: true, force: true });
  });
});
