// test/reopen.test.ts — goal resurrection: a failed or abandoned goal reopens at its exact
// frontier. Done nodes replay free; failed/skipped nodes retry fresh; done goals never reopen.
import { describe, it, expect, vi } from "vitest";
import { readJournal } from "../src/engine/journal.js";
import { harness, plannedGoal } from "./engine-core.test.js";

describe("reopenGoal", () => {
  it("failed goal → reopen → node retries → done; store agrees at every step", async () => {
    let fail = true;
    const { engine, store } = harness({
      run: async () => {
        if (fail) throw new Error("boom");
        return { text: "recovered", costUsd: 0.01, numTurns: 1 };
      },
    });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));

    fail = false;
    const msg = engine.reopenGoal(g.slug, { by: "user", guidance: "the flake is fixed, retry" });
    expect(msg).toContain("reopened");

    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    const types = readJournal(store, g.id).map((e) => e.type);
    expect(types).toContain("goal.reopened");
    expect(types).toContain("goal.completed");
    // projection: the node row recovered too
    expect(store.listNodes(g.id)[0]).toMatchObject({ status: "done" });
  });

  it("projection flips the goals row out of failed immediately on reopen", async () => {
    const { engine, store } = harness({ run: async () => { throw new Error("boom"); } });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(store.getGoal(g.id)!.error).toBeTruthy();

    engine.reopenGoal(g.slug, { by: "user" });

    // status may already be past "running" if the retry raced ahead — assert it LEFT failed.
    expect(store.getGoal(g.id)!.status).not.toBe("failed");
  });

  it("abandoned goal reopens: skipped nodes retry", async () => {
    let fail = true;
    const { engine, store } = harness({
      run: async () => {
        if (fail) throw new Error("boom");
        return { text: "recovered", costUsd: 0.01, numTurns: 1 };
      },
    });
    const g = plannedGoal(engine, [{ key: "a" }]);
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    engine.abandonGoal(g.slug);
    expect(store.getGoal(g.id)!.status).toBe("abandoned");

    fail = false;
    const msg = engine.reopenGoal(g.slug, { by: "user" });
    expect(msg).toContain("reopened");
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
  });

  it("refuses done, unknown goals", async () => {
    const { engine, store } = harness();
    const g = engine.createFromPlaybook({ playbook: "research-report", title: "R", request: "r", channel: "t", chatId: "1" });
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("done"));
    expect(engine.reopenGoal(g.slug, { by: "user" })).toMatch(/only failed or abandoned/);
    expect(readJournal(store, g.id).map((e) => e.type)).not.toContain("goal.reopened");

    expect(engine.reopenGoal("no-such-goal", { by: "user" })).toContain("No goal");
  });
});
