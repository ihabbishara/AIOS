// test/router-cost.test.ts — chat turns must reach the ledger.
//
// The ledger is the truth of spend and chat is deliberately in it
// (engine/budget.ts) — only ENFORCEMENT distinguishes background work from chat.
// The router emitted agent.end with no costUsd, so every chat turn was billed as
// free: 570 of 875 agent.end events in the live store carry no cost, neo showed
// $0.38 lifetime across ~292 runs, and the whole finance department showed $0.00.
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { MessageRouter } from "../src/router.js";
import { attachBudgetLedger } from "../src/engine/budget.js";

function setup(
  reply: { text: string; attachments: never[]; costUsd?: number },
  names: string[] = [],
) {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  attachBudgetLedger(bus, store, () => "2026-08-04");
  const router = new MessageRouter({ coordinator: "neo",
    moderator: { handle: async () => reply } as never,
    directChats: {
      handle: async () => reply, names: () => names, canonical: (n: string) => n,
    } as never,
    chatBindings: new Map(),
    bus,
  });
  return { store, bus, router };
}

const endEvents = (bus: EventBus) =>
  bus.history(0, 100)
    .map((e) => e.event as { type: string; costUsd?: number })
    .filter((e) => e.type === "agent.end");

describe("chat turns are billed", () => {
  it("puts a chat turn's cost on agent.end, and from there into both ledgers", async () => {
    const { store, bus, router } = setup({ text: "hello", attachments: [], costUsd: 0.25 });
    await router.handle({ channel: "cli", chatId: "local", text: "what's up" });

    expect(endEvents(bus).map((e) => e.costUsd)).toEqual([0.25]);
    // budgetAdd + costAdd are what attachBudgetLedger does with it.
    expect(store.budgetSpentCents("2026-08-04")).toBe(25);
    expect(store.costsByAgent()).toEqual([
      { agent: "neo", usd_cents: 25, runs: 1, last_date: "2026-08-04" },
    ]);
  });

  it("bills the addressed agent, not the coordinator", async () => {
    // Naming an agent routes past neo, so the ledger must attribute the spend to
    // the agent that actually burned it.
    const { store, router } = setup({ text: "hi", attachments: [], costUsd: 1 }, ["clio"]);
    await router.handle({ channel: "cli", chatId: "local", text: "@clio hello" });
    expect(store.costsByAgent()).toEqual([
      { agent: "clio", usd_cents: 100, runs: 1, last_date: "2026-08-04" },
    ]);
  });

  it("omits costUsd rather than sending zero when the turn reported none", async () => {
    // A zero would be indistinguishable from a real free turn and would still
    // write a cost_daily row, inventing a run that cost nothing.
    const { store, bus, router } = setup({ text: "hello", attachments: [] });
    await router.handle({ channel: "cli", chatId: "local", text: "hi" });

    const ends = endEvents(bus);
    expect(ends).toHaveLength(1);
    expect("costUsd" in ends[0]).toBe(false);
    expect(store.costsByAgent()).toEqual([]);
    expect(store.budgetSpentCents("2026-08-04")).toBe(0);
  });

  it("does not bill a turn that threw before producing a result", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    attachBudgetLedger(bus, store, () => "2026-08-04");
    const router = new MessageRouter({ coordinator: "neo",
      moderator: { handle: async () => { throw new Error("boom"); } } as never,
      directChats: { handle: async () => ({ text: "", attachments: [] }), names: () => [] } as never,
      chatBindings: new Map(),
      bus,
    });
    await expect(router.handle({ channel: "cli", chatId: "local", text: "hi" })).rejects.toThrow("boom");
    expect(endEvents(bus).map((e) => e.costUsd)).toEqual([undefined]);
    expect(store.budgetSpentCents("2026-08-04")).toBe(0);
  });
});
