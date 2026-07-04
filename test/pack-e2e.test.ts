import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { makeResolveDeptFor, resolvePack } from "../src/packs/resolve.js";
import { packSchema } from "../src/packs/types.js";
import { runNode } from "../src/engine/goals.js";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { EventBus } from "../src/events.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { ActionGate } from "../src/kernel/gate.js";
import { vaultWriteExecutor } from "../src/kernel/executors.js";
import { promote, newRecord } from "../src/kernel/trust.js";
import type { RunOptions, SpecialistResult } from "../src/agents/runner.js";

describe("pack e2e (via resolvePack with Pack shape)", () => {
  it("runs a department playbook with pack context applied, no real side effects", async () => {
    // scaffold: agents/finance + playbooks/audit
    const pbDir = mkdtempSync(join(tmpdir(), "pb-"));
    const agentsDir = mkdtempSync(join(tmpdir(), "ag-"));
    mkdirSync(join(agentsDir, "finance"));
    writeFileSync(
      join(agentsDir, "finance", "department.yaml"),
      "department: finance\nmission: Numerate money specialist.\nmemoDomain: money\nplaybooks: [audit]\n",
    );
    writeFileSync(
      join(agentsDir, "finance", "faris.yaml"),
      "name: faris\ntitle: CFO\ndepartment: finance\ncharter: Manages money.\npersona: Precise.\nprompt: You are the CFO.\ntools: [Read]\nmaxTurns: 20\n",
    );
    writeFileSync(
      join(pbDir, "audit.yaml"),
      "name: audit\ndescription: audit\nstages:\n  - { type: single, id: s1, role: faris }\n",
    );

    const reg = loadRegistry(agentsDir, pbDir);
    expect(reg.ownerOfPlaybook.get("audit")).toBe("finance");

    const vroot = mkdtempSync(join(tmpdir(), "vault-"));
    const store = new Store(":memory:");
    const vault = new VaultWriter(vroot, "AIOS");
    vault.init();
    vault.writeNote("memos/money.md", "# Money\nbe frugal");

    const bus = new EventBus(store);
    const registry = new ExecutorRegistry();
    registry.register(vaultWriteExecutor(vault));
    const now = new Date().toISOString();
    store.upsertTrust(promote(newRecord("vault.write", now), now));
    const gate = new ActionGate({
      store, registry,
      policy: { graduationStreak: 99, graduationAgeDays: 0, alwaysSupervised: new Set() },
      bus, expiryMs: 60_000,
    });

    // Use resolvePack with a Pack-shaped object derived from department
    const dept = reg.departments.get("finance")!;
    const pack = packSchema.parse({
      pillar: dept.department, persona: dept.mission, memoDomain: dept.memoDomain,
      actions: dept.actions, tools: dept.toolsUnion, playbooks: dept.playbooks,
    });
    const resolvedPack = resolvePack(pack, { store, vault, gate, origin: { channel: "cli", chatId: "x" } });

    let capturedContextBlock = "";
    const run = async (_role: string, _brief: string, opts: RunOptions): Promise<SpecialistResult> => {
      capturedContextBlock = opts.pack?.contextBlock ?? "";
      return { text: "audit complete", costUsd: 0, numTurns: 1 };
    };

    store.insertGoal({
      id: "j", slug: "audit", title: "Audit", request: "audit my subs", department: "finance", lead: "midas",
      origin_channel: "cli", origin_chat_id: "x", status: "running", project_dir: null,
      goal_dir: null, plan_summary: "playbook:audit", replans_used: 0, chain_depth: 0, error: null,
    });
    store.setGoalDir("j", "2026-06-14-audit");
    store.insertNodes("j", [
      { node_key: "s1", type: "run", agent: "faris", critic: null, brief: "", depends_on: [], max_rounds: 1 },
    ]);
    await runNode(store.getGoal("j")!, store.listNodes("j")[0], { store, vault, run, resolvePack: () => resolvedPack });

    expect(capturedContextBlock).toContain("## Pillar: finance");
    expect(capturedContextBlock).toContain("be frugal");

    rmSync(pbDir, { recursive: true, force: true });
    rmSync(agentsDir, { recursive: true, force: true });
    rmSync(vroot, { recursive: true, force: true });
    store.close();
  });
});
