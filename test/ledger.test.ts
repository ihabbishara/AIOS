import { describe, it, expect } from "vitest";
import { computeSettlement, toCents, type ExpenseEntry } from "../src/finance/ledger.js";

const MEMBERS = ["Ihab", "Amr", "Sara", "Omar", "Lina"];

function exp(id: number, payer: string, amount: number): ExpenseEntry {
  return { id, payer, amountCents: toCents(amount), currency: "EUR", description: "x", date: "2026-06-05" };
}

describe("computeSettlement", () => {
  it("splits equally among 5 and produces a transfer plan", () => {
    const s = computeSettlement(
      [exp(1, "Ihab", 100), exp(2, "Amr", 50)],
      MEMBERS,
      "2026-06",
    );
    expect(s.totalCents).toBe(15000);
    expect(s.shareCents).toBe(3000); // 150 / 5 = 30 each
    expect(s.balances["Ihab"]).toBe(7000);   // paid 100, share 30 -> receives 70
    expect(s.balances["Amr"]).toBe(2000);    // paid 50, share 30 -> receives 20
    expect(s.balances["Sara"]).toBe(-3000);  // owes 30
    // transfers cover exactly the debt
    const totalTransfers = s.transfers.reduce((sum, t) => sum + t.amountCents, 0);
    expect(totalTransfers).toBe(9000); // Sara + Omar + Lina owe 30 each
    // every transfer goes to a creditor
    for (const t of s.transfers) expect(["Ihab", "Amr"]).toContain(t.to);
  });

  it("balances always sum to zero (remainder cents distributed)", () => {
    const s = computeSettlement([exp(1, "Ihab", 0.07)], MEMBERS, "2026-06");
    expect(Object.values(s.balances).reduce((a, b) => a + b, 0)).toBe(0);
    expect(s.totalCents).toBe(7);
  });

  it("matches payers case-insensitively", () => {
    const s = computeSettlement([exp(1, "ihab", 10)], MEMBERS, "2026-06");
    expect(s.paidByMember["Ihab"]).toBe(1000);
  });

  it("rejects payers outside the member list", () => {
    expect(() => computeSettlement([exp(1, "Stranger", 10)], MEMBERS, "2026-06")).toThrow(/not in the member list/);
  });

  it("rejects mixed currencies", () => {
    const usd: ExpenseEntry = { ...exp(2, "Amr", 10), currency: "USD" };
    expect(() => computeSettlement([exp(1, "Ihab", 10), usd], MEMBERS, "2026-06")).toThrow(/Mixed currencies/);
  });

  it("members who paid nothing still owe their share", () => {
    const s = computeSettlement([exp(1, "Ihab", 50)], MEMBERS, "2026-06");
    expect(s.paidByMember["Lina"]).toBe(0);
    expect(s.balances["Lina"]).toBe(-1000);
  });
});
