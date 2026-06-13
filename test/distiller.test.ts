import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { EventBus } from "../src/events.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { ActionGate } from "../src/kernel/gate.js";
import { vaultWriteExecutor } from "../src/kernel/executors.js";
import { promote, newRecord } from "../src/kernel/trust.js";
import { distill } from "../src/memory/distiller.js";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const store = new Store(":memory:");
  const vault = new VaultWriter(root, "AIOS");
  vault.init();
  const bus = new EventBus(store);
  const registry = new ExecutorRegistry();
  registry.register(vaultWriteExecutor(vault));
  store.upsertTrust(promote(newRecord("vault.write", "2026-01-01T00:00:00.000Z"), "2026-01-01T00:00:00.000Z"));
  const gate = new ActionGate({ store, registry, policy: { graduationStreak: 99, graduationAgeDays: 0, alwaysSupervised: new Set() }, bus, expiryMs: 60000 });
  return { root, store, vault, gate };
}

const NOW = "2026-06-13T21:00:00.000Z";

describe("distill", () => {
  it("writes a memo from teachings and marks them consolidated", async () => {
    const { root, store, vault, gate } = harness();
    const id = store.addTeaching({ text: "always CC Sara on invoices", domain: "money", kind: "preference" });
    const calls: string[] = [];
    const curate = async (i: { domain: string; existing: string; signals: string }) => {
      calls.push(i.domain);
      return `# ${i.domain}\n${i.signals}`;
    };
    await distill({ store, vault, gate, curate, nowIso: NOW });
    expect(vault.readNote("memos/money.md")).toContain("always CC Sara");
    expect(store.listUnconsolidatedTeachings().find((t) => t.id === id)).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("is a no-op for domains with no new signal", async () => {
    const { root, store, vault, gate } = harness();
    let called = false;
    await distill({ store, vault, gate, curate: async () => { called = true; return "x"; }, nowIso: NOW });
    expect(called).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the prior memo when the curator returns empty", async () => {
    const { root, store, vault, gate } = harness();
    vault.writeNote("memos/general.md", "# General\nkeep me");
    store.addTeaching({ text: "noise", domain: "general", kind: "preference" });
    await distill({ store, vault, gate, curate: async () => "   ", nowIso: NOW });
    expect(vault.readNote("memos/general.md")).toContain("keep me");
    expect(store.listUnconsolidatedTeachings().length).toBe(1); // NOT consolidated
    rmSync(root, { recursive: true, force: true });
  });

  it("one failing domain does not block others", async () => {
    const { root, store, vault, gate } = harness();
    store.addTeaching({ text: "money rule", domain: "money", kind: "preference" });
    store.addTeaching({ text: "code rule", domain: "code", kind: "preference" });
    const curate = async (i: { domain: string }) => {
      if (i.domain === "money") throw new Error("curator down");
      return `# ${i.domain}\nok`;
    };
    await distill({ store, vault, gate, curate, nowIso: NOW, log: () => {} });
    expect(vault.readNote("memos/code.md")).toContain("ok");
    expect(vault.readNote("memos/money.md")).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("profile domain folds in fact + forget teachings", async () => {
    const { root, store, vault, gate } = harness();
    store.addTeaching({ text: "Sara is my business partner", domain: null, kind: "fact" });
    const curate = async (i: { domain: string; signals: string }) => `# ${i.domain}\n${i.signals}`;
    await distill({ store, vault, gate, curate, nowIso: NOW });
    expect(vault.readNote("memos/profile.md")).toContain("Sara is my business partner");
    rmSync(root, { recursive: true, force: true });
  });

  it("does not re-distill a decision after a successful write", async () => {
    const { root, store, vault, gate } = harness();
    // seed one resolved decision in 'money'
    store.insertAction({ id: "d1", type: "finance.pay_bill", payload: "{}", preview: "pay rent", status: "executed", origin_channel: "cli", origin_chat_id: "x", trust_state: "autonomous", verdict_by: null, reject_reason: null, result: "ok", created_at: "2026-06-10T00:00:00.000Z", resolved_at: "2026-06-10T00:00:00.000Z", expires_at: "2026-06-11T00:00:00.000Z" });
    let calls = 0;
    const curate = async (i: { domain: string; signals: string }) => { calls++; return `# ${i.domain}\n${i.signals}`; };
    await distill({ store, vault, gate, curate, nowIso: NOW });
    await distill({ store, vault, gate, curate, nowIso: NOW }); // no new signal
    expect(calls).toBe(1); // money distilled once; second run is a no-op
    rmSync(root, { recursive: true, force: true });
  });

  it("does not consolidate or write when vault.write is not autonomous", async () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const store = new Store(":memory:");
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    const bus = new EventBus(store);
    const registry = new ExecutorRegistry();
    registry.register(vaultWriteExecutor(vault));
    // NOTE: vault.write left supervised (no promote) AND forced supervised:
    const gate = new ActionGate({ store, registry, policy: { graduationStreak: 99, graduationAgeDays: 0, alwaysSupervised: new Set(["vault.write"]) }, bus, expiryMs: 60000 });
    store.addTeaching({ text: "rule", domain: "general", kind: "preference" });
    await distill({ store, vault, gate, curate: async (i) => `# ${i.domain}\nx`, nowIso: NOW, log: () => {} });
    expect(vault.readNote("memos/general.md")).toBeUndefined(); // queued, not executed
    expect(store.listUnconsolidatedTeachings().length).toBe(1); // NOT consolidated
    rmSync(root, { recursive: true, force: true });
  });

  it("folds a profile-domain forget teaching into the profile memo", async () => {
    const { root, store, vault, gate } = harness();
    store.addTeaching({ text: "drop the morning-meetings note", domain: "profile", kind: "forget" });
    await distill({ store, vault, gate, curate: async (i: { domain: string; signals: string }) => `# ${i.domain}\n${i.signals}`, nowIso: NOW });
    expect(vault.readNote("memos/profile.md")).toContain("drop the morning-meetings note");
    expect(store.listUnconsolidatedTeachings().length).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});
