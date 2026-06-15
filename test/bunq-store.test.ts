import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

const txn = {
  account_id: "acc1", account_label: "Main", bunq_id: 1001, amount_cents: -1299, currency: "EUR",
  description: "Spotify", counterparty: "Spotify AB", counterparty_iban: "NL00SPOT", type: "DIRECT_DEBIT",
  bunq_created: "2026-06-10T08:00:00.000Z",
};

describe("personal_transactions store", () => {
  it("inserts a transaction and reads it back", () => {
    const s = new Store(":memory:");
    expect(s.upsertPersonalTransaction(txn)).toBe(true); // inserted
    const rows = s.listPersonalTransactions("acc1");
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe(-1299);
    expect(rows[0].counterparty).toBe("Spotify AB");
  });
  it("dedupes by (account_id, bunq_id) — re-upsert is a no-op", () => {
    const s = new Store(":memory:");
    expect(s.upsertPersonalTransaction(txn)).toBe(true);
    expect(s.upsertPersonalTransaction(txn)).toBe(false); // already present
    expect(s.listPersonalTransactions().length).toBe(1);
  });
  it("same bunq_id under a different account is a distinct row", () => {
    const s = new Store(":memory:");
    s.upsertPersonalTransaction(txn);
    expect(s.upsertPersonalTransaction({ ...txn, account_id: "acc2", account_label: "Savings" })).toBe(true);
    expect(s.listPersonalTransactions().length).toBe(2);
    expect(s.listPersonalTransactions("acc2").length).toBe(1);
  });
});
