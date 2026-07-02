// test/spend-guard.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { SpendGuard, attachBudgetLedger } from "../src/engine/budget.js";

describe("SpendGuard", () => {
  it("no cap → always allow", () => {
    const store = new Store(":memory:");
    expect(new SpendGuard({ store }).allow()).toBe(true);
  });

  it("allows under cap, refuses at/over cap", () => {
    const store = new Store(":memory:");
    const g = new SpendGuard({ store, capUsd: 1, todayFn: () => "2026-07-02" });
    store.budgetAdd("2026-07-02", 99);
    expect(g.allow()).toBe(true);
    store.budgetAdd("2026-07-02", 1); // exactly 100 cents = $1
    expect(g.allow()).toBe(false);
    expect(g.capCents()).toBe(100);
  });

  it("ledger listener accumulates agent.end costUsd as integer cents", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    attachBudgetLedger(bus, store, () => "2026-07-02");
    bus.emit({ type: "agent.end", agent: "vulcan", context: "chat:web:ui", ok: true, costUsd: 0.123 });
    bus.emit({ type: "agent.end", agent: "vulcan", context: "chat:web:ui", ok: true }); // no cost — ignored
    bus.emit({ type: "agent.end", agent: "juno", context: "chat:t:1", ok: true, costUsd: 0.011 });
    expect(store.budgetSpentCents("2026-07-02")).toBe(13); // round(12.3) + round(1.1)
  });
});
