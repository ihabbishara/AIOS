// test/abandon-terminal.test.ts — abandonGoal's terminal guard. A FAILED goal is not terminal
// for abandonment (a user must be able to clear a dead goal off the board), but a goal that is
// already done/abandoned is — abandoning it again must be a no-op refusal, never a second event.
import { describe, it, expect, vi } from "vitest";
import { readJournal } from "../src/engine/journal.js";
import { harness, plannedGoal } from "./engine-core.test.js";

describe("abandonGoal terminal guard", () => {
  it("abandons a FAILED goal: status flips to abandoned and the event is journaled", async () => {
    const { engine, store } = harness({ run: async () => { throw new Error("boom"); } });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));

    const msg = engine.abandonGoal(g.slug);

    expect(msg).toContain("abandoned");
    expect(store.getGoal(g.id)!.status).toBe("abandoned");
    expect(readJournal(store, g.id).map((e) => e.type)).toContain("goal.abandoned");
  });

  it("refuses an already-done goal: no status change, no goal.abandoned event", async () => {
    const { engine, store } = harness();
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));

    const msg = engine.abandonGoal(g.slug);

    expect(msg).toMatch(/already done/);
    expect(store.getGoal(g.id)!.status).toBe("done");
    expect(readJournal(store, g.id).map((e) => e.type)).not.toContain("goal.abandoned");
  });

  it("refuses an already-abandoned goal: the terminal event fires exactly once", async () => {
    const { engine, store } = harness({ run: async () => { throw new Error("boom"); } });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(engine.abandonGoal(g.slug)).toContain("abandoned");
    expect(store.getGoal(g.id)!.status).toBe("abandoned");

    const msg = engine.abandonGoal(g.slug);

    expect(msg).toMatch(/already abandoned/);
    expect(readJournal(store, g.id).filter((e) => e.type === "goal.abandoned")).toHaveLength(1);
  });
});
