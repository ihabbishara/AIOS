// test/session-pause.test.ts — goal.paused{reason:"session"} lands paused-session in BOTH
// writers (fold + projection) and is queryable (failure-class spec §A3). Two-writer pin.
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { appendEvents, readJournal } from "../src/engine/journal.js";
import { reduce } from "../src/engine/reduce.js";

function pausedSessionStore() {
  const store = new Store(":memory:");
  appendEvents(store, "g1", [
    { type: "goal.created", payload: {
      slug: "build-x", title: "Build X", request: "r", department: "engineering", lead: "athena",
      origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
      planSummary: "planned", goalDir: "d", projectDir: null } },
    { type: "plan.recorded", payload: { summary: "s", needsWorkspace: "none", nodes: [
      { key: "impl", kind: "loop", agent: "clio", critic: "minos", brief: "b", dependsOn: [], maxRounds: 2 },
    ] } },
    { type: "workspace.prepared", payload: { taskDir: null, mode: null } },
    { type: "goal.paused", payload: { reason: "session", error: "Agent hit session limit — re-run after quota resets" } },
  ]);
  return store;
}

describe("paused-session — two-writer pin", () => {
  it("fold phase, projected status, and the store query all agree", () => {
    const store = pausedSessionStore();
    expect(reduce(readJournal(store, "g1")).phase).toBe("paused-session");
    expect(store.getGoal("g1")!.status).toBe("paused-session");
    expect(store.pausedSessionGoals().map((g) => g.id)).toEqual(["g1"]);
  });
});
