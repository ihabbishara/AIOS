import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { makeCategorizer } from "../src/money/categorize.js";
import { spendingSummary, budgetStatus, detectRecurring } from "../src/money/ops.js";

function seed(s: Store) {
  const base = { account_label: "Main", currency: "EUR", counterparty_iban: null, type: "CARD", account_id: "acc1" };
  const rows = [
    { bunq_id: 1, amount_cents: -2000, description: "x", counterparty: "Albert Heijn", bunq_created: "2026-06-03T10:00:00.000Z" },
    { bunq_id: 2, amount_cents: -3000, description: "x", counterparty: "Jumbo", bunq_created: "2026-06-10T10:00:00.000Z" },
    { bunq_id: 3, amount_cents: -1099, description: "x", counterparty: "Spotify AB", bunq_created: "2026-06-05T10:00:00.000Z" },
    { bunq_id: 4, amount_cents: 250000, description: "salary", counterparty: "Employer", bunq_created: "2026-06-01T10:00:00.000Z" },
  ];
  for (const r of rows) s.upsertPersonalTransaction({ ...base, ...r });
}

describe("money ops", () => {
  it("spendingSummary totals outgoing by category for a month", async () => {
    const s = new Store(":memory:"); seed(s);
    const cat = makeCategorizer(s, async () => "other");
    const sum = await spendingSummary(s, cat, "2026-06");
    expect(sum.byCategory.groceries).toBe(5000);       // AH 2000 + Jumbo 3000
    expect(sum.byCategory.subscriptions).toBe(1099);   // Spotify default
    expect(sum.byCategory.income).toBeUndefined();     // incoming excluded from spend
    expect(sum.totalOut).toBe(6099);
  });
  it("budgetStatus compares month-to-date actuals vs limit", async () => {
    const s = new Store(":memory:"); seed(s);
    s.setBudget("groceries", 4000, "EUR");
    const cat = makeCategorizer(s, async () => "other");
    const status = await budgetStatus(s, cat, "2026-06");
    const g = status.find((b) => b.category === "groceries")!;
    expect(g.spent_cents).toBe(5000);
    expect(g.limit_cents).toBe(4000);
    expect(g.over).toBe(true);
  });
  it("detectRecurring finds ≥3 same-amount same-counterparty outgoing charges", () => {
    const s = new Store(":memory:");
    const base = { account_label: "Main", currency: "EUR", counterparty_iban: null, type: "DIRECT_DEBIT", account_id: "acc1", description: "sub" };
    ["2026-04-05", "2026-05-05", "2026-06-05"].forEach((d, i) =>
      s.upsertPersonalTransaction({ ...base, bunq_id: 10 + i, amount_cents: -1099, counterparty: "Spotify AB", bunq_created: `${d}T10:00:00.000Z` }));
    const cands = detectRecurring(s.listPersonalTransactions());
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ counterparty: "Spotify AB", amount_cents: -1099, cadence: "monthly", count: 3 });
  });
});
