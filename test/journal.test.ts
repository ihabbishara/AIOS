// test/journal.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { appendEvents, readJournal, attemptClaimed, replayInto } from "../src/engine/journal.js";

describe("goal_journal", () => {
  it("appendEvents assigns sequential gseqs and round-trips payloads", () => {
    const store = new Store(":memory:");
    const a = appendEvents(store, "g1", [
      { type: "goal.created", payload: { slug: "x" } },
      { type: "plan.recorded", payload: { nodes: [] } },
    ]);
    expect(a!.map((e) => e.gseq)).toEqual([1, 2]);
    const b = appendEvents(store, "g1", [{ type: "goal.completed", payload: {} }]);
    expect(b![0].gseq).toBe(3);
    const all = readJournal(store, "g1");
    expect(all.map((e) => e.type)).toEqual(["goal.created", "plan.recorded", "goal.completed"]);
    expect(all[0].payload).toEqual({ slug: "x" });
    expect(all[0].v).toBe(1);
    expect(typeof all[0].ts).toBe("number");
  });

  it("journals are per-goal: gseq restarts for another goal", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [{ type: "goal.created", payload: {} }]);
    const b = appendEvents(store, "g2", [{ type: "goal.created", payload: {} }]);
    expect(b![0].gseq).toBe(1);
  });

  it("claimLost: a pre-existing attempt.started for the same node+attempt wins", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [
      { type: "attempt.started", payload: { node: "a", attempt: 1 } },
    ]);
    const lost = appendEvents(store, "g1",
      [{ type: "attempt.started", payload: { node: "a", attempt: 1 } }],
      { claimLost: attemptClaimed("a", 1) });
    expect(lost).toBeNull();
    // a different attempt number is a fresh claim
    const won = appendEvents(store, "g1",
      [{ type: "attempt.started", payload: { node: "a", attempt: 2 } }],
      { claimLost: attemptClaimed("a", 2) });
    expect(won).not.toBeNull();
  });

  it("gseq conflict retries with a fresh gseq (raced append)", () => {
    const store = new Store(":memory:");
    // occupy gseq 1 directly — simulates another async context winning the race
    store.journalInsert("g1", 1, "goal.created", "{}", Date.now());
    const a = appendEvents(store, "g1", [{ type: "plan.recorded", payload: {} }]);
    expect(a![0].gseq).toBe(2);
  });

  it("also() runs in the same transaction — a throw rolls back the events", () => {
    const store = new Store(":memory:");
    expect(() =>
      appendEvents(store, "g1", [{ type: "goal.created", payload: {} }], {
        also: () => { throw new Error("boom"); },
      }),
    ).toThrow("boom");
    expect(readJournal(store, "g1")).toHaveLength(0);
  });

  it("joins an open Store.transaction instead of nesting", () => {
    const store = new Store(":memory:");
    store.transaction(() => {
      store.kvSet("k", "1");
      appendEvents(store, "g1", [{ type: "goal.created", payload: {} }]);
    });
    expect(readJournal(store, "g1")).toHaveLength(1);
    expect(store.kvGet("k")).toBe("1");
  });

  it("replayInto writes fixed gseqs with original timestamps", () => {
    const store = new Store(":memory:");
    const src = new Store(":memory:");
    const evs = appendEvents(src, "g1", [
      { type: "goal.created", payload: { slug: "x" } },
      { type: "goal.completed", payload: {} },
    ])!;
    replayInto(store, evs);
    expect(readJournal(store, "g1").map((e) => [e.gseq, e.type])).toEqual([
      [1, "goal.created"], [2, "goal.completed"],
    ]);
  });
});
