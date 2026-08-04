// test/cost-rollup.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { attachBudgetLedger } from "../src/engine/budget.js";

describe("cost_daily rollups", () => {
  it("costAdd upserts cents and run counts", () => {
    const store = new Store(":memory:");
    store.costAdd("vulcan", "2026-07-12", 40);
    store.costAdd("vulcan", "2026-07-12", 20);
    store.costAdd("clio", "2026-07-12", 10);
    store.costAdd("vulcan", "2026-07-11", 5);
    expect(store.costsByAgent()).toEqual([
      // last_date is the agent's newest spending day, not the newest day overall
      { agent: "vulcan", usd_cents: 65, runs: 3, last_date: "2026-07-12" },
      { agent: "clio", usd_cents: 10, runs: 1, last_date: "2026-07-12" },
    ]);
    expect(store.costsByDay(14)).toEqual([
      { date: "2026-07-11", usd_cents: 5 },
      { date: "2026-07-12", usd_cents: 70 },
    ]);
    expect(store.costRows("2026-07-11")).toEqual([
      { agent: "vulcan", date: "2026-07-11", usd_cents: 5 },
      { agent: "clio", date: "2026-07-12", usd_cents: 10 },
      { agent: "vulcan", date: "2026-07-12", usd_cents: 60 },
    ]);
  });

  it("costsByAgent respects sinceDate", () => {
    const store = new Store(":memory:");
    store.costAdd("vulcan", "2026-07-01", 100);
    store.costAdd("vulcan", "2026-07-12", 30);
    // last_date reports the newest day INSIDE the window — the 07-01 row is excluded
    // from the sum, so it must not leak into the date either.
    expect(store.costsByAgent("2026-07-12")).toEqual([
      { agent: "vulcan", usd_cents: 30, runs: 1, last_date: "2026-07-12" },
    ]);
  });

  it("attachBudgetLedger feeds cost_daily alongside budget_ledger", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    attachBudgetLedger(bus, store, () => "2026-07-12");
    bus.emit({ type: "agent.end", agent: "vulcan", context: "test", costUsd: 0.5, ok: true });
    bus.emit({ type: "agent.end", agent: "vulcan", context: "test", costUsd: 0.25, ok: true });
    bus.emit({ type: "agent.end", agent: "clio", context: "test", ok: true }); // no cost — ignored
    expect(store.budgetSpentCents("2026-07-12")).toBe(75);
    expect(store.costsByAgent()).toEqual([
      { agent: "vulcan", usd_cents: 75, runs: 2, last_date: "2026-07-12" },
    ]);
  });
});
