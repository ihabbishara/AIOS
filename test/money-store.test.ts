import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

describe("money store", () => {
  it("category rules upsert on pattern", () => {
    const s = new Store(":memory:");
    s.upsertCategoryRule("albert heijn", "groceries", "user");
    s.upsertCategoryRule("albert heijn", "shopping", "llm");
    expect(s.listCategoryRules()).toHaveLength(1);
    expect(s.listCategoryRules()[0]).toMatchObject({ pattern: "albert heijn", category: "shopping", source: "llm" });
  });

  it("tx-category cache upserts on (account_id, bunq_id)", () => {
    const s = new Store(":memory:");
    s.setTxCategory("acc1", 100, "groceries", "rule");
    s.setTxCategory("acc1", 100, "eating-out", "llm");
    expect(s.getTxCategory("acc1", 100)).toMatchObject({ category: "eating-out", source: "llm" });
    expect(s.getTxCategory("acc1", 999)).toBeUndefined();
  });

  it("subscriptions add + status transitions", () => {
    const s = new Store(":memory:");
    const id = s.addSubscription({ name: "Spotify", counterparty: "Spotify AB", amount_cents: 1099, currency: "EUR", cadence: "monthly", next_renewal: "2026-07-01", status: "detected", source: "auto" });
    expect(s.listSubscriptions("detected")).toHaveLength(1);
    s.setSubscriptionStatus(id, "confirmed");
    expect(s.listSubscriptions("confirmed")[0].name).toBe("Spotify");
    expect(s.listSubscriptions("detected")).toHaveLength(0);
  });

  it("budgets upsert per category", () => {
    const s = new Store(":memory:");
    s.setBudget("groceries", 40000, "EUR");
    s.setBudget("groceries", 35000, "EUR");
    expect(s.listBudgets()).toHaveLength(1);
    expect(s.listBudgets()[0].limit_cents).toBe(35000);
  });
});
