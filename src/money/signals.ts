import type { Store } from "../store/db.js";
import type { Category, TxLike } from "./categorize.js";
import { budgetStatus, detectRecurring } from "./ops.js";

export interface MoneySignal { key: string; text: string }
export interface MoneySignalConfig { moneyLargeTxCents: number; moneyRenewalDays: number }
const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
const ym = (d: Date) => d.toISOString().slice(0, 7);
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Compute proactive money signals (NOT yet delivered). The caller checks each `key` against kv to
 * fire once, sends `text` to the private chat, then stamps the key. Side effect: newly-detected
 * recurring charges are inserted as `status='detected'` subscriptions (idempotent — skipped if a row
 * for that counterparty+amount already exists).
 */
export async function computeMoneySignals(
  store: Store, categorize: (tx: TxLike) => Promise<Category>, now: Date, cfg: MoneySignalConfig,
): Promise<MoneySignal[]> {
  const out: MoneySignal[] = [];

  // Budget overruns (this month).
  for (const b of await budgetStatus(store, categorize, ym(now))) {
    if (b.over) out.push({ key: `money:budget:${b.category}:${ym(now)}`, text: `Budget alert: ${b.category} ${eur(b.spent_cents)} of ${eur(b.limit_cents)} this month — over.` });
  }

  // Upcoming renewals (confirmed subs within N days).
  const horizon = new Date(now.getTime() + cfg.moneyRenewalDays * 86400_000);
  for (const sub of store.listSubscriptions("confirmed")) {
    if (!sub.next_renewal) continue;
    const r = new Date(`${sub.next_renewal}T00:00:00.000Z`);
    if (r >= now && r <= horizon) out.push({ key: `money:renewal:${sub.id}:${sub.next_renewal}`, text: `${sub.name} renews ${sub.next_renewal} (${eur(sub.amount_cents)}).` });
  }

  // New recurring charges → detected subscription + a confirm prompt (skip ones already tracked).
  // `known` uses positive amount_cents (as stored in subscriptions table).
  // detectRecurring returns negative amount_cents (as stored in transactions), so we Math.abs to match.
  const known = new Set(store.listSubscriptions().map((s) => `${s.counterparty}\x00${s.amount_cents}`));
  for (const c of detectRecurring(store.listPersonalTransactions())) {
    // Use Math.abs so sig matches the positive amount stored in the subscriptions table.
    const sig = `${c.counterparty}\x00${Math.abs(c.amount_cents)}`;
    if (known.has(sig)) continue;
    store.addSubscription({ name: c.counterparty, counterparty: c.counterparty, amount_cents: Math.abs(c.amount_cents), currency: c.currency, cadence: "monthly", next_renewal: null, status: "detected", source: "auto" });
    known.add(sig);
    out.push({ key: `money:recurring:${sig}`, text: `Looks like a subscription: ${c.counterparty} ${eur(Math.abs(c.amount_cents))}/month (seen ${c.count}x). Confirm with @cfo if it is one.` });
  }

  // Unusually large debits this month.
  for (const t of store.listPersonalTransactions()) {
    if (t.bunq_created.slice(0, 7) !== ym(now)) continue;
    if (t.amount_cents < 0 && Math.abs(t.amount_cents) >= cfg.moneyLargeTxCents) {
      const alreadyFired = store.kvGet(`money:largetx:${t.account_id}:${t.bunq_id}`);
      if (!alreadyFired) {
        out.push({ key: `money:largetx:${t.account_id}:${t.bunq_id}`, text: `Large transaction ${day(new Date(t.bunq_created))}: ${eur(Math.abs(t.amount_cents))} to ${t.counterparty ?? t.description}.` });
      }
    }
  }

  return out;
}
