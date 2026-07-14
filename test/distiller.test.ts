// test/distiller.test.ts — fact-diff distiller with fail-closed grounding (memory-v2 §4).
// The prose-merge (curate) cases died with the LLM-merge distiller; memos are now a rendered
// projection of memo_facts.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { EventBus, type StoredEvent } from "../src/events.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { ActionGate } from "../src/kernel/gate.js";
import { vaultWriteExecutor } from "../src/kernel/executors.js";
import { promote, newRecord } from "../src/kernel/trust.js";
import { distill } from "../src/memory/distiller.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const store = new Store(":memory:");
  const vault = new VaultWriter(root, "AIOS");
  vault.init();
  const bus = new EventBus(store);
  const events: StoredEvent[] = [];
  bus.on((e) => events.push(e));
  const registry = new ExecutorRegistry();
  registry.register(vaultWriteExecutor(vault));
  store.upsertTrust(promote(newRecord("vault.write", "2026-01-01T00:00:00.000Z"), "2026-01-01T00:00:00.000Z"));
  const gate = new ActionGate({ store, registry, policy: { graduationStreak: 99, graduationAgeDays: 0, shadowMatches: 99, alwaysSupervised: new Set() }, bus, expiryMs: 60000 });
  return { root, store, vault, gate, bus, events };
}

const NOW = "2026-06-13T21:00:00.000Z";
const groundAll = async (b: Array<{ subject: string }>) => b.map(() => true);

describe("fact-diff distill (memory-v2 §4)", () => {
  it("new fact: extracted, grounded, inserted, rendered, teachings consolidated", async () => {
    const { root, store, vault, gate } = setup();
    const tid = store.addTeaching({ text: "prefers oat milk", domain: "general", kind: "preference" });
    await distill({
      store, vault, gate, nowIso: NOW,
      factDiff: async ({ signals }) => signals.length
        ? [{ subject: "coffee", fact: "prefers oat milk", source_ref: `teaching:${tid}` }] : [],
      ground: groundAll,
    });
    expect(store.activeMemoFacts("general").map((f) => f.fact)).toEqual(["prefers oat milk"]);
    expect(vault.readNote("memos/general.md")).toContain("prefers oat milk");
    expect(store.listUnconsolidatedTeachings("general")).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("supersede: newer fact replaces the old, history kept", async () => {
    const { root, store, vault, gate } = setup();
    const old = store.addMemoFact({ domain: "general", subject: "coffee", fact: "prefers oat milk", origin: "user-stated" });
    const tid = store.addTeaching({ text: "switched to black coffee", domain: "general", kind: "preference" });
    await distill({
      store, vault, gate, nowIso: NOW,
      factDiff: async () => [{ subject: "coffee", fact: "prefers black coffee", source_ref: `teaching:${tid}`, supersedes: old }],
      ground: groundAll,
    });
    const active = store.activeMemoFacts("general");
    expect(active.map((f) => f.fact)).toEqual(["prefers black coffee"]);
    expect(vault.readNote("memos/general.md")).not.toContain("oat milk");
    rmSync(root, { recursive: true, force: true });
  });

  it("grounding fail-closed: ungrounded fact dropped + memory.ungrounded emitted; grounded sibling lands", async () => {
    const { root, store, vault, gate, bus, events } = setup();
    const tid = store.addTeaching({ text: "real signal", domain: "general", kind: "preference" });
    await distill({
      store, vault, gate, bus, nowIso: NOW,
      factDiff: async () => [
        { subject: "real", fact: "real fact", source_ref: `teaching:${tid}` },
        { subject: "fake", fact: "fabricated", source_ref: `teaching:${tid}` },
      ],
      ground: async (batch) => batch.map((b) => b.subject === "real"),
    });
    expect(store.activeMemoFacts("general").map((f) => f.subject)).toEqual(["real"]);
    expect(events.some((e) => e.event.type === "memory.ungrounded")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("unresolvable source_ref is dropped before the verifier (fail-closed)", async () => {
    const { root, store, vault, gate } = setup();
    store.addTeaching({ text: "signal", domain: "general", kind: "preference" });
    let groundCalls = 0;
    await distill({
      store, vault, gate, nowIso: NOW,
      factDiff: async () => [{ subject: "x", fact: "y", source_ref: "teaching:99999" }],
      ground: async (b) => { groundCalls += b.length; return b.map(() => true); },
    });
    expect(groundCalls).toBe(0);
    expect(store.activeMemoFacts("general")).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("verifier failure (throw) drops everything — writes are fail-closed", async () => {
    const { root, store, vault, gate } = setup();
    const tid = store.addTeaching({ text: "signal", domain: "general", kind: "preference" });
    await distill({
      store, vault, gate, nowIso: NOW, log: () => {},
      factDiff: async () => [{ subject: "x", fact: "y", source_ref: `teaching:${tid}` }],
      ground: async () => { throw new Error("verifier down"); },
    });
    expect(store.activeMemoFacts("general")).toHaveLength(0);
    expect(store.listUnconsolidatedTeachings("general")).toHaveLength(1); // retry next distill
    rmSync(root, { recursive: true, force: true });
  });

  it("bootstrap: first run over an existing prose memo converts it (source_ref memo:<domain> resolves)", async () => {
    const { root, store, vault, gate } = setup();
    vault.writeNote("memos/general.md", "# general\n- prefers window seats");
    store.addTeaching({ text: "anything", domain: "general", kind: "preference" }); // trigger signal
    await distill({
      store, vault, gate, nowIso: NOW,
      factDiff: async ({ signals }) => signals.some((s) => s.ref === "memo:general")
        ? [{ subject: "travel", fact: "prefers window seats", source_ref: "memo:general" }] : [],
      ground: groundAll,
    });
    expect(store.activeMemoFacts("general").map((f) => f.fact)).toContain("prefers window seats");
    rmSync(root, { recursive: true, force: true });
  });

  it("profile domain folds fact + forget teachings as fact-diff signals", async () => {
    const { root, store, vault, gate } = setup();
    const tid = store.addTeaching({ text: "Sara is my business partner", domain: null, kind: "fact" });
    await distill({
      store, vault, gate, nowIso: NOW,
      factDiff: async ({ domain, signals }) => domain === "profile" && signals.length
        ? [{ subject: "people", fact: "Sara is my business partner", source_ref: `teaching:${tid}` }] : [],
      ground: groundAll,
    });
    expect(vault.readNote("memos/profile.md")).toContain("Sara is my business partner");
    expect(store.listUnconsolidatedTeachings(null)).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("empty diff → no write; a throwing domain does not block others", async () => {
    const { root, store, vault, gate } = setup();
    store.addTeaching({ text: "g", domain: "general", kind: "preference" });
    const cid = store.addTeaching({ text: "c", domain: "code", kind: "preference" });
    await distill({
      store, vault, gate, nowIso: NOW, log: () => {},
      factDiff: async ({ domain }) => {
        if (domain === "general") throw new Error("boom");
        if (domain === "code") return [{ subject: "style", fact: "c", source_ref: `teaching:${cid}` }];
        return [];
      },
      ground: groundAll,
    });
    expect(store.listUnconsolidatedTeachings("general")).toHaveLength(1); // failed domain untouched
    expect(vault.readNote("memos/code.md")).toContain("- c ");
    rmSync(root, { recursive: true, force: true });
  });

  it("does not consolidate or apply when vault.write is not autonomous... facts still recorded only on executed write", async () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const store = new Store(":memory:");
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    const bus = new EventBus(store);
    const registry = new ExecutorRegistry();
    registry.register(vaultWriteExecutor(vault));
    // vault.write left supervised AND forced supervised:
    const gate = new ActionGate({ store, registry, policy: { graduationStreak: 99, graduationAgeDays: 0, shadowMatches: 99, alwaysSupervised: new Set(["vault.write"]) }, bus, expiryMs: 60000 });
    const tid = store.addTeaching({ text: "rule", domain: "general", kind: "preference" });
    await distill({
      store, vault, gate, nowIso: NOW, log: () => {},
      factDiff: async () => [{ subject: "rules", fact: "rule", source_ref: `teaching:${tid}` }],
      ground: groundAll,
    });
    expect(vault.readNote("memos/general.md")).toBeUndefined(); // queued, not executed
    expect(store.listUnconsolidatedTeachings().length).toBe(1); // NOT consolidated
    rmSync(root, { recursive: true, force: true });
  });

  it("does not re-distill a decision after a successful write", async () => {
    const { root, store, vault, gate } = setup();
    store.insertAction({ id: "d1", type: "finance.pay_bill", payload: "{}", preview: "pay rent", status: "executed", origin_channel: "cli", origin_chat_id: "x", trust_state: "autonomous", verdict_by: null, reject_reason: null, result: "ok", created_at: "2026-06-10T00:00:00.000Z", resolved_at: "2026-06-10T00:00:00.000Z", expires_at: "2026-06-11T00:00:00.000Z" });
    let moneyCalls = 0;
    await distill({ store, vault, gate, nowIso: NOW, ground: groundAll,
      factDiff: async ({ domain, signals }) => {
        if (domain === "money" && signals.length) { moneyCalls++; return [{ subject: "bills", fact: "pays rent", source_ref: "decision:d1" }]; }
        return [];
      } });
    await distill({ store, vault, gate, nowIso: NOW, ground: groundAll,
      factDiff: async ({ domain, signals }) => {
        if (domain === "money" && signals.length) { moneyCalls++; return []; }
        return [];
      } });
    expect(moneyCalls).toBe(1); // cursor advanced after the executed write
    rmSync(root, { recursive: true, force: true });
  });
});
