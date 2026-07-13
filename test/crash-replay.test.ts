// test/crash-replay.test.ts — spec §14: truncate the journal at every position mid-goal,
// recover, and the goal must still terminate. Recovery is the same fold→decide path as
// normal operation; a failure here is a real recovery bug.
import { describe, it, expect, vi } from "vitest";
import { readJournal, replayInto } from "../src/engine/journal.js";
import { reduce } from "../src/engine/reduce.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";
import { harness } from "./engine-core.test.js";

/** Deterministic multi-kind run fn: loop critic revises once then approves;
 *  verify runner fails once then passes; everything else echoes. */
function scriptedRun(): SpecialistRunFn {
  const counts = new Map<string, number>();
  return async (role) => {
    const n = (counts.get(role) ?? 0) + 1;
    counts.set(role, n);
    if (role === "minos") {
      const verdict = n === 1
        ? { verdict: "revise", summary: "needs work", reasons: ["r1"] }
        : { verdict: "approve", summary: "good", reasons: [] };
      return { text: "review", structured: verdict, costUsd: 0.01, numTurns: 1 };
    }
    if (role === "argus") {
      return { text: "report", structured: { passed: n > 1, summary: "s", failures: n > 1 ? [] : ["f1"] }, costUsd: 0.01, numTurns: 1 };
    }
    return { text: `${role}-out-${n}`, costUsd: 0.01, numTurns: 1 };
  };
}

const GRAPH = [
  { node_key: "design", type: "run" as const, agent: "odin", critic: null, brief: "design", depends_on: [], max_rounds: 1 },
  { node_key: "impl", type: "loop" as const, agent: "vulcan", critic: "minos", brief: "build", depends_on: ["design"], max_rounds: 3 },
  { node_key: "check", type: "verify" as const, agent: "argus", critic: "vulcan", brief: "verify", depends_on: ["impl"], max_rounds: 3 },
];

function startGraphGoal(h: ReturnType<typeof harness>) {
  return h.engine.startPlannedGoal({
    title: "C", request: "do c", department: "engineering", lead: "athena",
    origin: { channel: "t", chatId: "1" }, summary: "planned", needsWorkspace: "none", nodes: GRAPH,
  });
}

describe("crash simulation: recover from every journal prefix", () => {
  it("goal terminates from any truncation point; done nodes never re-run; claims never collide", async () => {
    // 1. Golden run to completion.
    const golden = harness({ run: scriptedRun() });
    const g = startGraphGoal(golden);
    await vi.waitFor(() => expect(golden.store.getGoal(g.id)!.status).toBe("done"), { timeout: 10_000 });
    const journal = readJournal(golden.store, g.id);
    expect(journal.length).toBeGreaterThan(10);

    // 2. For every prefix: replay → boot a fresh engine → must terminate.
    for (let k = 1; k < journal.length; k++) {
      // goal.created + plan.recorded land in ONE transaction — a prefix cut between them
      // is a state that cannot exist on disk. Skip impossible mid-batch cuts.
      if (!reduce(journal.slice(0, k)).planned) continue;
      const fresh = harness({ run: scriptedRun() });
      replayInto(fresh.store, journal.slice(0, k));
      const before = fresh.store.listNodes(g.id).filter((n) => n.status === "done").map((n) => n.node_key);
      fresh.engine.resumeUnfinished();
      await vi.waitFor(() => {
        const st = fresh.store.getGoal(g.id)!.status;
        expect(["done", "failed"], `prefix ${k} stuck at ${st}`).toContain(st);
      }, { timeout: 10_000 });
      // recovery must not re-run completed work: done nodes stay done
      for (const key of before) {
        expect(fresh.store.listNodes(g.id).find((n) => n.node_key === key)!.status, `prefix ${k}/${key}`).toBe("done");
      }
      // and the journal replays deterministically: no duplicate attempt claims
      const starts = readJournal(fresh.store, g.id).filter((e) => e.type === "attempt.started");
      const claims = starts.map((e) => `${e.payload.node}:${e.payload.attempt}`);
      expect(new Set(claims).size, `prefix ${k}`).toBe(claims.length);
    }
  }, 120_000);
});
