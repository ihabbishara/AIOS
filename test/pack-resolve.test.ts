import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { memoContextForDomain } from "../src/memory/memos.js";
import { resolvePack, MCP_TOOL_NAMES } from "../src/packs/resolve.js";
import { packSchema } from "../src/packs/types.js";
import { EventBus } from "../src/events.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { ActionGate } from "../src/kernel/gate.js";
import { vaultWriteExecutor } from "../src/kernel/executors.js";

function freshVault() {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const vault = new VaultWriter(root, "AIOS");
  vault.init();
  return { root, vault };
}

describe("memoContextForDomain", () => {
  it("loads profile + the given domain's memo + that domain's pending teachings only", () => {
    const { root, vault } = freshVault();
    const s = new Store(":memory:");
    vault.writeNote("memos/profile.md", "# Profile\nSara is my partner");
    vault.writeNote("memos/money.md", "# Money\napprove invoices under fifty");
    vault.writeNote("memos/inbox.md", "# Inbox\narchive newsletters");
    s.addTeaching({ text: "always CC Sara", domain: "money", kind: "preference" });
    s.addTeaching({ text: "ignore promos", domain: "inbox", kind: "preference" });
    const block = memoContextForDomain(s, vault, "money");
    expect(block).toContain("Sara is my partner");
    expect(block).toContain("approve invoices under fifty");
    expect(block).toContain("always CC Sara");
    expect(block).not.toContain("archive newsletters");
    expect(block).not.toContain("ignore promos");
    rmSync(root, { recursive: true, force: true });
  });
  it("returns '' when nothing relevant exists", () => {
    const { root, vault } = freshVault();
    expect(memoContextForDomain(new Store(":memory:"), vault, "code")).toBe("");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("resolvePack", () => {
  it("builds context block, fq tool names, and an mcp server", () => {
    const { root, vault } = freshVault();
    const store = new Store(":memory:");
    vault.writeNote("memos/money.md", "# Money\napprove under fifty");
    const bus = new EventBus(store);
    const registry = new ExecutorRegistry();
    registry.register(vaultWriteExecutor(vault));
    const gate = new ActionGate({ store, registry, policy: { graduationStreak: 99, graduationAgeDays: 0, alwaysSupervised: new Set() }, bus, expiryMs: 60000 });
    const pack = packSchema.parse({
      pillar: "money", persona: "Money specialist.", memoDomain: "money",
      tools: ["Read", "Grep", "recall", "vault_write"], actions: ["vault.write"], roles: ["finance"], playbooks: [],
    });
    const r = resolvePack(pack, { store, vault, gate, origin: { channel: "cli", chatId: "x" } });
    expect(r.pillar).toBe("money");
    expect(r.contextBlock).toContain("## Pillar: money");
    expect(r.contextBlock).toContain("Money specialist.");
    expect(r.contextBlock).toContain("approve under fifty");
    expect(r.tools).toContain("Read");
    expect(r.tools).toContain("Grep");
    expect(r.tools).toContain("mcp__aios-pack__recall");
    expect(r.tools).toContain("mcp__aios-pack__vault_write");
    expect(r.tools).not.toContain("recall"); // short name replaced by fq
    expect(Object.keys(r.mcpServers)).toEqual(["aios-pack"]);
    expect(MCP_TOOL_NAMES).toContain("propose_action");
    rmSync(root, { recursive: true, force: true });
  });
});

