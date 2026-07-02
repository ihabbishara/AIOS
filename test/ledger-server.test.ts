import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { buildLedgerServer } from "../src/finance/server.js";

const MEMBERS = [
  { name: "Ihab", handle: "ihab" },
  { name: "Amr", handle: "amr" },
];

function handlers(store: Store, origin: { channel: string; chatId: string }) {
  const bus = new EventBus(store);
  const gate = new ActionGate({
    store,
    registry: new ExecutorRegistry(),
    policy: DEFAULT_POLICY,
    bus,
    expiryMs: 60_000,
  });
  const vaultRoot = mkdtempSync(join(tmpdir(), "vault-"));
  const vault = new VaultWriter(vaultRoot, "test");
  vault.init();
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

  it("export_csv writes under /tmp/aios-exports and instructs attach_file", async () => {
    const t = handlers(store, { channel: "slack", chatId: "C123" });
    await callText(t.add_expense, {
      payer: "Ihab",
      amount: 42.5,
      currency: "EUR",
      description: "Lunch",
      date: "2026-06-15",
    });

    const result = await callText(t.export_csv, { month: "2026-06" });

    // Must mention the path and attach_file
    expect(result).toContain("/tmp/aios-exports");
    expect(result).toContain("attach_file");

    // Extract path and verify file exists
    const match = /(\/tmp\/aios-exports\/[^\s]+\.csv)/.exec(result);
    expect(match).not.toBeNull();
    const csvPath = match![1];
    expect(existsSync(csvPath)).toBe(true);

    // First line must be the exact CSV header used by FinanceAgent
    const content = readFileSync(csvPath, "utf8");
    expect(content.split("\n")[0]).toBe("id,date,payer,amount,currency,description");

    // Data row must contain the expense
    expect(content).toContain("Ihab");
    expect(content).toContain("42.50");
    expect(content).toContain("Lunch");
  });
});
