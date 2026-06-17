import type { Store, PersonalTransactionRow } from "../store/db.js";
import type { Category, TxLike } from "./categorize.js";

const month = (iso: string) => iso.slice(0, 7); // "2026-06"

/** Spend by category for a month (outgoing only; amounts in positive cents). */
export async function spendingSummary(
  store: Store, categorize: (tx: TxLike) => Promise<Category>, ym: string,
): Promise<{ byCategory: Partial<Record<Category, number>>; totalOut: number }> {
  const byCategory: Partial<Record<Category, number>> = {};
  let totalOut = 0;
  for (const t of store.listPersonalTransactions()) {
    if (month(t.bunq_created) !== ym) continue;
    if (t.amount_cents >= 0) continue; // outgoing only
    const cat = await categorize(t);
    const amt = Math.abs(t.amount_cents);
    byCategory[cat] = (byCategory[cat] ?? 0) + amt;
    totalOut += amt;
  }
  return { byCategory, totalOut };
}

export interface BudgetLine { category: string; spent_cents: number; limit_cents: number; currency: string; over: boolean; }

export async function budgetStatus(
  store: Store, categorize: (tx: TxLike) => Promise<Category>, ym: string,
): Promise<BudgetLine[]> {
  const { byCategory } = await spendingSummary(store, categorize, ym);
  return store.listBudgets().map((b) => {
    const spent = byCategory[b.category as Category] ?? 0;
    return { category: b.category, spent_cents: spent, limit_cents: b.limit_cents, currency: b.currency, over: spent >= b.limit_cents };
  });
}

export interface RecurringCandidate { counterparty: string; amount_cents: number; currency: string; cadence: "monthly"; count: number; lastSeen: string; }

/** ≥3 outgoing charges, same counterparty + exact amount, spread across ≥2 distinct months → a monthly candidate. */
export function detectRecurring(txns: PersonalTransactionRow[]): RecurringCandidate[] {
  const groups = new Map<string, PersonalTransactionRow[]>();
  for (const t of txns) {
    if (t.amount_cents >= 0 || !t.counterparty) continue;
    const key = `${t.counterparty}\x00${t.amount_cents}\x00${t.currency}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }
  const out: RecurringCandidate[] = [];
  for (const [key, ts] of groups) {
    if (ts.length < 3) continue;
    const months = new Set(ts.map((t) => month(t.bunq_created)));
    if (months.size < 2) continue;
    const [counterparty, amount, currency] = key.split("\x00");
    const lastSeen = ts.map((t) => t.bunq_created).sort().at(-1)!;
    out.push({ counterparty, amount_cents: Number(amount), currency, cadence: "monthly", count: ts.length, lastSeen });
  }
  return out;
}
