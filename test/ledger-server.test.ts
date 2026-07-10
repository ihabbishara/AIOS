import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { buildLedgerServer } from "../src/finance/server.js";
import { buildAttachmentServer } from "../src/agents/attachment-server.js";
import type { Attachment } from "../src/agents/attachment.js";
import { ledgerWriteExecutor } from "../src/kernel/executors.js";
import { newRecord } from "../src/kernel/trust.js";

const MEMBERS = [
  { name: "Ihab", handle: "ihab" },
  { name: "Amr", handle: "amr" },
];

function handlers(store: Store, origin: { channel: string; chatId: string }, seedAutonomous = true) {
  const bus = new EventBus(store);
  const registry = new ExecutorRegistry();
  const gate = new ActionGate({
    store,
    registry,
    policy: DEFAULT_POLICY,
    bus,
    expiryMs: 60_000,
  });
  const vaultRoot = mkdtempSync(join(tmpdir(), "vault-"));
  const vault = new VaultWriter(vaultRoot, "test");
  vault.init();
  registry.register(ledgerWriteExecutor(store, vault, "TestCo"));
  if (seedAutonomous) {
    const rec = newRecord("ledger.write", new Date().toISOString());
    store.upsertTrust({ ...rec, state: "autonomous", graduatedAt: rec.firstSeen });
  }
  const server = buildLedgerServer(
    { store, vault, gate, origin },
    { company: "TestCo", members: MEMBERS },
  ) as unknown as {
    instance: {
      _registeredTools: Record<
        string,
        { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }
      >;
    };
  };
  return server.instance._registeredTools;
}

const callText = async (
  h: { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> },
  a: unknown,
) => (await h.handler(a)).content[0].text;

describe("ledger toolServer", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  it("add_expense + list_expenses + settle round-trip in integer cents", async () => {
    const t = handlers(store, { channel: "telegram", chatId: "-100123" });
    await callText(t.add_expense, {
      payer: "Ihab",
      amount: 100,
      currency: "EUR",
      description: "Server",
      date: "2026-06-01",
    });
    await callText(t.add_expense, {
      payer: "Amr",
      amount: 50,
      currency: "EUR",
      description: "Domain",
      date: "2026-06-02",
    });

    const list = await callText(t.list_expenses, {});
    expect(list).toContain("Ihab");
    expect(list).toContain("Amr");
    expect(list).toContain("150.00 EUR"); // total

    const settle = await callText(t.settle, { month: "2026-06" });
    // 150 EUR / 2 members = 75 EUR each
    // Ihab paid 100 → receives 25; Amr paid 50 → owes 25
    expect(settle).toContain("75.00 EUR"); // fair share
    expect(settle).toContain("receives 25.00 EUR");
    expect(settle).toContain("owes 25.00 EUR");
    // transfer plan: Amr → Ihab: 25 EUR
    expect(settle).toContain("Amr");
    expect(settle).toContain("Ihab");
  });

  it("scopes the ledger to origin channel:chatId (entries don't cross)", async () => {
    const tA = handlers(store, { channel: "telegram", chatId: "chat-A" });
    const tB = handlers(store, { channel: "telegram", chatId: "chat-B" });

    await callText(tA.add_expense, {
      payer: "Ihab",
      amount: 10,
      currency: "EUR",
      description: "Coffee",
      date: "2026-06-01",
    });

    const listA = await callText(tA.list_expenses, {});
    const listB = await callText(tB.list_expenses, {});

    expect(listA).toContain("Coffee");
    expect(listB).toContain("Ledger is empty");
  });

  it("export_csv writes under data/downloads/exports and instructs attach_file", async () => {
    const t = handlers(store, { channel: "slack", chatId: "C123" });
    await callText(t.add_expense, {
      payer: "Ihab",
      amount: 42.5,
      currency: "EUR",
      description: "Lunch",
      date: "2026-06-15",
    });

    const result = await callText(t.export_csv, { month: "2026-06" });

    // Must mention attach_file and the path must NOT be under /tmp
    expect(result).toContain("attach_file");
    expect(result).not.toContain("/tmp/aios-exports");

    // Extract path and verify file exists under data/downloads
    const match = /([^\s]+\.csv)/.exec(result);
    expect(match).not.toBeNull();
    const csvPath = match![1];
    expect(csvPath).toContain("data/downloads/exports");
    expect(existsSync(csvPath)).toBe(true);

    // First line must be the exact CSV header
    const content = readFileSync(csvPath, "utf8");
    expect(content.split("\n")[0]).toBe("id,date,payer,amount,currency,description");

    // Data row must contain the expense
    expect(content).toContain("Ihab");
    expect(content).toContain("42.50");
    expect(content).toContain("Lunch");
  });

  it("export_csv path is attachable via buildAttachmentServer (darwin-safe attach pin)", async () => {
    // This test verifies the /tmp symlink bug cannot regress:
    // on macOS /tmp is a symlink to /private/tmp; isSafe() calls realpathSync,
    // so any path under /tmp/aios-* would fail the data/downloads safe-dir check.
    // By writing under data/downloads/exports we stay realpath-stable on all platforms.
    const t = handlers(store, { channel: "telegram", chatId: "C456" });
    await callText(t.add_expense, {
      payer: "Amr",
      amount: 99,
      currency: "EUR",
      description: "Server",
      date: "2026-07-01",
    });

    // export_csv returns the file path
    const result = await callText(t.export_csv, { month: "2026-07" });
    const match = /([^\s]+\.csv)/.exec(result);
    expect(match).not.toBeNull();
    const csvPath = match![1];

    // Build attachment server the same way DirectChats does
    const collected: Attachment[] = [];
    const server = buildAttachmentServer(collected, [resolve("data/downloads")]);
    const inst = (server as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }> } }).instance;
    const handler = inst._registeredTools["attach_file"].handler;

    const attachResult = await handler({ path: csvPath });

    // Must succeed — NOT a refusal
    expect(attachResult.content[0].text).not.toContain("Refused");
    expect(attachResult.content[0].text).toContain("Queued for delivery");
    expect(collected).toHaveLength(1);
    expect(collected[0].path).toBe(csvPath);
  });

  it("export_csv uses 'all-time' label when no month given", async () => {
    const t = handlers(store, { channel: "slack", chatId: "C789" });
    await callText(t.add_expense, {
      payer: "Ihab",
      amount: 10,
      currency: "EUR",
      description: "Coffee",
      date: "2026-06-01",
    });

    const result = await callText(t.export_csv, {});
    expect(result).toContain("all-time");
  });

  it("ledger writes flow through the gate: autonomous seed → executed + audited", async () => {
    const t = handlers(store, { channel: "telegram", chatId: "gated-A" });
    const reply = await callText(t.add_expense, {
      payer: "Ihab", amount: 12, currency: "EUR", description: "Cable", date: "2026-07-01",
    });
    expect(reply).toContain("Recorded #");
    const audited = store.listActions().filter((a) => a.type === "ledger.write");
    expect(audited).toHaveLength(1);
    expect(audited[0].status).toBe("executed");
  });

  it("ledger writes queue when ledger.write is supervised (no seed)", async () => {
    const t = handlers(store, { channel: "telegram", chatId: "gated-B" }, false);
    const reply = await callText(t.add_expense, {
      payer: "Ihab", amount: 12, currency: "EUR", description: "Cable", date: "2026-07-01",
    });
    expect(reply).toContain("Queued for approval");
    expect(await callText(t.list_expenses, {})).toContain("Ledger is empty");
    const queued = store.listActions().filter((a) => a.type === "ledger.write");
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe("proposed");
  });
});
