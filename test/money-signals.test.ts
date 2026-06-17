import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { makeCategorizer } from "../src/money/categorize.js";
import { computeMoneySignals } from "../src/money/signals.js";

const cfg = { moneyLargeTxCents: 50000, moneyRenewalDays: 3 };
function txn(s: Store, over = {}) {
  s.upsertPersonalTransaction({ account_id: "acc1", account_label: "Main", bunq_id: 1, amount_cents: -1000, currency: "EUR", description: "x", counterparty: "Shop", counterparty_iban: null, type: "CARD", bunq_created: "2026-06-17T10:00:00.000Z", ...over });
}

describe("computeMoneySignals", () => {
  it("fires a large-transaction signal once (dedup by stamp)", async () => {
    const s = new Store(":memory:"); txn(s, { bunq_id: 7, amount_cents: -80000 });
    const cat = makeCategorizer(s, async () => "other");
    const now = new Date("2026-06-17T12:00:00.000Z");
    const first = await computeMoneySignals(s, cat, now, cfg);
    expect(first.some((sig) => sig.key.startsWith("money:largetx:") && /large/i.test(sig.text))).toBe(true);
    for (const sig of first) s.kvSet(sig.key, now.toISOString());
    const second = await computeMoneySignals(s, cat, now, cfg);
    expect(second.find((sig) => sig.key.startsWith("money:largetx:"))).toBeUndefined();
  });

  it("fires a renewal signal for a confirmed sub due within N days", async () => {
    const s = new Store(":memory:");
    s.addSubscription({ name: "Spotify", counterparty: "Spotify AB", amount_cents: 1099, currency: "EUR", cadence: "monthly", next_renewal: "2026-06-18", status: "confirmed", source: "auto" });
    const cat = makeCategorizer(s, async () => "other");
    const sigs = await computeMoneySignals(s, cat, new Date("2026-06-17T12:00:00.000Z"), cfg);
    expect(sigs.some((sig) => /renew/i.test(sig.text) && sig.text.includes("Spotify"))).toBe(true);
  });

  it("fires a budget-overrun signal and a new-recurring candidate", async () => {
    const s = new Store(":memory:");
    // Budget of 500 cents; June AcmeSub charge of 1099 > 500 → overrun
    // AcmeSub has no built-in default category, so the injected classifier ("groceries") runs.
    s.setBudget("groceries", 500, "EUR");
    // Dates span ≥2 distinct months so detectRecurring fires (requires ≥2 distinct months)
    ["2026-04-08", "2026-05-08", "2026-06-08"].forEach((d, i) =>
      s.upsertPersonalTransaction({ account_id: "acc1", account_label: "M", bunq_id: 20 + i, amount_cents: -1099, currency: "EUR", description: "sub", counterparty: "AcmeSub", counterparty_iban: null, type: "DIRECT_DEBIT", bunq_created: `${d}T10:00:00.000Z` }));
    const cat = makeCategorizer(s, async () => "groceries"); // force grocery spend over the 5.00 budget
    const sigs = await computeMoneySignals(s, cat, new Date("2026-06-17T12:00:00.000Z"), cfg);
    expect(sigs.some((sig) => /budget/i.test(sig.text))).toBe(true);
    expect(s.listSubscriptions("detected").some((x) => x.counterparty === "AcmeSub")).toBe(true);
  });
});
