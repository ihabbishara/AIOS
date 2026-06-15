import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { BunqSync, type HelperOutput } from "../src/senses/bunq/sync.js";

function fixture(): HelperOutput {
  return {
    accounts: [{ id: "acc1", label: "Main", currency: "EUR" }],
    transactions: [
      { bunq_id: 1001, account_id: "acc1", account_label: "Main", amount_cents: -1299, currency: "EUR", description: "Spotify", counterparty: "Spotify AB", counterparty_iban: null, type: "DIRECT_DEBIT", bunq_created: "2026-06-10T08:00:00.000Z" },
      { bunq_id: 1002, account_id: "acc1", account_label: "Main", amount_cents: 250000, currency: "EUR", description: "Salary", counterparty: "ACME", counterparty_iban: null, type: "TRANSFER", bunq_created: "2026-06-11T08:00:00.000Z" },
    ],
  };
}

describe("BunqSync.poll", () => {
  it("upserts transactions and advances the per-account cursor to the max bunq_id", async () => {
    const s = new Store(":memory:");
    const sync = new BunqSync({ store: s, fetch: async () => fixture() });
    const res = await sync.poll();
    expect(res.inserted).toBe(2);
    expect(s.listPersonalTransactions("acc1").length).toBe(2);
    expect(s.kvGet("bunq:cursor:acc1")).toBe("1002");
  });
  it("passes the stored cursor back to fetch and is idempotent on replay", async () => {
    const s = new Store(":memory:");
    let sawSince: Record<string, number> = {};
    const sync = new BunqSync({ store: s, fetch: async (since) => { sawSince = since; return fixture(); } });
    await sync.poll();                 // first run: no cursor → since {}
    expect(sawSince).toEqual({});
    const res2 = await sync.poll();    // second run: cursor present, same fixture → 0 new
    expect(sawSince).toEqual({ acc1: 1002 });
    expect(res2.inserted).toBe(0);
    expect(s.listPersonalTransactions().length).toBe(2);
  });
});
