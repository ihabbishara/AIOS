// src/engine/budget.ts — daily global spend ledger + background-work gate (spec §6).
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import { localParts } from "../heartbeat/clock.js";

const today = () => localParts(new Date()).date;

export interface SpendGuardDeps {
  store: Store;
  capUsd?: number;
  todayFn?: () => string;
}

export class SpendGuard {
  constructor(private deps: SpendGuardDeps) {}

  capCents(): number | null {
    return this.deps.capUsd == null ? null : Math.round(this.deps.capUsd * 100);
  }

  spentCents(date = (this.deps.todayFn ?? today)()): number {
    return this.deps.store.budgetSpentCents(date);
  }

  /** Consulted before SCHEDULING background work (nodes, dream, speculate). Never kills mid-flight. */
  allow(): boolean {
    const cap = this.capCents();
    return cap == null || this.spentCents() < cap;
  }
}

/** Every agent run lands in the ledger (chat included — the ledger is the truth of spend);
 *  only enforcement distinguishes background from chat. Returns the unsubscribe fn. */
export function attachBudgetLedger(bus: EventBus, store: Store, todayFn = today): () => void {
  return bus.on((e) => {
    if (e.event.type !== "agent.end" || !e.event.costUsd) return;
    store.budgetAdd(todayFn(), Math.round(e.event.costUsd * 100));
  });
}
