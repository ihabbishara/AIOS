import type { Store } from "../../store/db.js";

export interface BunqTxn {
  bunq_id: number;
  account_id: string;
  account_label: string;
  amount_cents: number;
  currency: string;
  description: string;
  counterparty: string | null;
  counterparty_iban: string | null;
  type: string | null;
  bunq_created: string;
}
export interface HelperOutput {
  accounts: Array<{ id: string; label: string; currency: string }>;
  transactions: BunqTxn[];
}
export type FetchTransactions = (sinceIdByAccount: Record<string, number>) => Promise<HelperOutput>;

export interface BunqSyncDeps {
  store: Store;
  fetch: FetchTransactions;
  log?: (line: string) => void;
}

const CURSOR_PREFIX = "bunq:cursor:";

export class BunqSync {
  constructor(private deps: BunqSyncDeps) {}

  /** One sync pass: read cursors → fetch fresh txns → upsert → advance cursors. Idempotent. */
  async poll(): Promise<{ inserted: number }> {
    const { store } = this.deps;
    const accountsKnown = new Set(store.listPersonalTransactions().map((r) => r.account_id));
    const since: Record<string, number> = {};
    for (const acc of accountsKnown) {
      const cur = store.kvGet(`${CURSOR_PREFIX}${acc}`);
      if (cur) since[acc] = Number(cur);
    }

    const out = await this.deps.fetch(since);

    const maxByAccount = new Map<string, number>();
    let inserted = 0;
    for (const t of out.transactions) {
      if (store.upsertPersonalTransaction(t)) inserted++;
      maxByAccount.set(t.account_id, Math.max(maxByAccount.get(t.account_id) ?? 0, t.bunq_id));
    }
    for (const [acc, max] of maxByAccount) {
      const prev = Number(store.kvGet(`${CURSOR_PREFIX}${acc}`) ?? 0);
      if (max > prev) store.kvSet(`${CURSOR_PREFIX}${acc}`, String(max));
    }
    this.deps.log?.(`bunq sync: +${inserted} transactions`);
    return { inserted };
  }
}
