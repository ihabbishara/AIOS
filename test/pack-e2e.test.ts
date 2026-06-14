import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPacks } from "../src/packs/loader.js";
import { resolvePack } from "../src/packs/resolve.js";
import { PlaybookExecutor } from "../src/engine/executor.js";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { EventBus } from "../src/events.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { ActionGate } from "../src/kernel/gate.js";
import { vaultWriteExecutor } from "../src/kernel/executors.js";
import { promote, newRecord } from "../src/kernel/trust.js";
import type { RunOptions, SpecialistResult } from "../src/agents/runner.js";

describe("pack e2e", () => {
  it("runs a pack playbook with pack context applied, no real side effects", async () => {
    // --- Step 1: scaffold a "money" pack in a temp dir ---
    const pbDir = mkdtempSync(join(tmpdir(), "pb-"));
    mkdirSync(join(pbDir, "money"));
    writeFileSync(
      join(pbDir, "money", "pack.yaml"),
      "pillar: money\npersona: Numerate money specialist.\nmemoDomain: money\ntools: [Read, recall]\nactions: [vault.write]\nroles: [finance]\nplaybooks: [audit]\n",
    );
    writeFileSync(
      join(pbDir, "money", "audit.yaml"),
      "name: audit\ndescription: audit\nstages:\n  - { type: single, id: s1, role: finance }\n",
    );

    // --- Step 2: load packs ---
    const { playbooks, packs, pillarOf } = loadPacks(pbDir);

    // --- Step 3: assert pillarOf ---
    expect(pillarOf.get("audit")).toBe("money");

    // --- Step 4: set up in-memory infrastructure ---
    const vroot = mkdtempSync(join(tmpdir(), "vault-"));
    const store = new Store(":memory:");
    const vault = new VaultWriter(vroot, "AIOS");
    vault.init();

    // --- Step 5: write pillar memo so memoContextForDomain finds it ---
    // VaultWriter.root = join(vroot, "AIOS"), writeNote reads from that root
    vault.writeNote("memos/money.md", "# Money\nbe frugal");

    const bus = new EventBus(store);
    const registry = new ExecutorRegistry();
    registry.register(vaultWriteExecutor(vault));

    // --- Step 6: upsert trust so vault.write is autonomous (skip approval queue) ---
    const now = new Date().toISOString();
    store.upsertTrust(promote(newRecord("vault.write", now), now));

    const gate = new ActionGate({
      store,
      registry,
      policy: { graduationStreak: 99, graduationAgeDays: 0, alwaysSupervised: new Set() },
      bus,
      expiryMs: 60_000,
    });

    // --- Step 7: resolve the pack ---
    const packDef = packs.get("money");
    expect(packDef).toBeDefined();
    const resolvedPack = resolvePack(packDef!, {
      store,
      vault,
      gate,
      origin: { channel: "cli", chatId: "x" },
    });

    // --- Step 8: stub run that captures pack.contextBlock ---
    let capturedContextBlock = "";
    const run = async (
      _role: string,
      _brief: string,
      opts: RunOptions,
    ): Promise<SpecialistResult> => {
      capturedContextBlock = opts.pack?.contextBlock ?? "";
      return { text: "audit complete", costUsd: 0, numTurns: 1 };
    };

    // --- Step 9: create PlaybookExecutor with the resolved pack ---
    const exec = new PlaybookExecutor({ run, store, vault, wallTimeMs: 60_000, pack: resolvedPack });

    // --- Step 10: insert job and execute ---
    store.insertJob({
      id: "j",
      slug: "audit",
      title: "Audit",
      playbook: "audit",
      request: "audit my subs",
      project_dir: null,
      channel: "cli",
      chat_id: "x",
      status: "queued",
      error: null,
    });
    await exec.execute(store.getJob("j")!, playbooks.get("audit")!, "2026-06-14-audit");

    // --- Step 11: assert pack context reached the agent ---
    expect(capturedContextBlock).toContain("## Pillar: money");
    expect(capturedContextBlock).toContain("be frugal"); // pillar memo reached the agent

    // --- Step 12: cleanup ---
    rmSync(pbDir, { recursive: true, force: true });
    rmSync(vroot, { recursive: true, force: true });
    store.close();
  });
});
