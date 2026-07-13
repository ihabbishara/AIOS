// test/journal.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { appendEvents, readJournal, attemptClaimed, replayInto, type EventInput } from "../src/engine/journal.js";

// Projections run inside every append, so fixtures must carry real payloads.
const created = (slug = "x"): EventInput => ({
  type: "goal.created",
  payload: {
    slug, title: "X", request: "do x", department: "engineering", lead: "athena",
    origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
    planSummary: "planned", goalDir: `d-${slug}`, projectDir: null,
  },
});
const plan = (): EventInput => ({
  type: "plan.recorded",
  payload: { summary: "s", needsWorkspace: "none", nodes: [
    { key: "a", kind: "run", agent: "vulcan", critic: null, brief: "b", dependsOn: [], maxRounds: 1 },
  ] },
});
const att = (node: string, attempt: number): EventInput => ({
  type: "attempt.started",
  payload: { node, attempt, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: `g:${node}:${attempt}` },
});

describe("goal_journal", () => {
  it("appendEvents assigns sequential gseqs and round-trips payloads", () => {
    const store = new Store(":memory:");
    const a = appendEvents(store, "g1", [created(), plan()]);
    expect(a!.map((e) => e.gseq)).toEqual([1, 2]);
    const b = appendEvents(store, "g1", [{ type: "goal.completed", payload: {} }]);
    expect(b![0].gseq).toBe(3);
    const all = readJournal(store, "g1");
    expect(all.map((e) => e.type)).toEqual(["goal.created", "plan.recorded", "goal.completed"]);
    expect(all[0].payload).toMatchObject({ slug: "x" });
    expect(all[0].v).toBe(1);
    expect(typeof all[0].ts).toBe("number");
  });

  it("journals are per-goal: gseq restarts for another goal", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [created("x")]);
    const b = appendEvents(store, "g2", [created("y")]);
    expect(b![0].gseq).toBe(1);
  });

  it("claimLost: a pre-existing attempt.started for the same node+attempt wins", () => {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [created(), plan()]);
    appendEvents(store, "g1", [att("a", 1)]);
    const lost = appendEvents(store, "g1", [att("a", 1)], { claimLost: attemptClaimed("a", 1) });
    expect(lost).toBeNull();
    // a different attempt number is a fresh claim
    const won = appendEvents(store, "g1", [att("a", 2)], { claimLost: attemptClaimed("a", 2) });
    expect(won).not.toBeNull();
  });

  it("gseq conflict retries with a fresh gseq (raced append)", () => {
    const store = new Store(":memory:");
    // occupy gseq 1 directly — simulates another async context winning the race
    store.journalInsert("g1", 1, "noop", "{}", Date.now());
    const a = appendEvents(store, "g1", [created()]);
    expect(a![0].gseq).toBe(2);
  });

  it("also() runs in the same transaction — a throw rolls back events AND projections", () => {
    const store = new Store(":memory:");
    expect(() =>
      appendEvents(store, "g1", [created()], {
        also: () => { throw new Error("boom"); },
      }),
    ).toThrow("boom");
    expect(readJournal(store, "g1")).toHaveLength(0);
    expect(store.getGoal("g1")).toBeUndefined(); // projected row rolled back too
  });

  it("joins an open Store.transaction instead of nesting", () => {
    const store = new Store(":memory:");
    store.transaction(() => {
      store.kvSet("k", "1");
      appendEvents(store, "g1", [created()]);
    });
    expect(readJournal(store, "g1")).toHaveLength(1);
    expect(store.kvGet("k")).toBe("1");
  });

  it("replayInto writes fixed gseqs with original timestamps and re-projects", () => {
    const store = new Store(":memory:");
    const src = new Store(":memory:");
    const evs = appendEvents(src, "g1", [created(), plan()])!;
    replayInto(store, evs);
    expect(readJournal(store, "g1").map((e) => [e.gseq, e.type])).toEqual([
      [1, "goal.created"], [2, "plan.recorded"],
    ]);
    expect(store.getGoal("g1")!.slug).toBe("x"); // projection rebuilt from the journal
  });
});
