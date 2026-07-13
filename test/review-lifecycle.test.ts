// test/review-lifecycle.test.ts — reducer + decide + projection for the needs-review
// lifecycle (verification-hardening spec §4, §7).
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { appendEvents, type JournalEvent, type JournalEventType } from "../src/engine/journal.js";
import { reduce, nodeStatus } from "../src/engine/reduce.js";
import { decide, type Caps } from "../src/engine/decide.js";

let seq = 0;
const ev = (goalId: string, gseq: number, type: JournalEventType, payload: Record<string, unknown>, ts = 1000): JournalEvent =>
  ({ seq: ++seq, goalId, gseq, type, payload, v: 1, ts });

const node = (key: string, kind: "run" | "loop" = "loop", dependsOn: string[] = []) =>
  ({ key, kind, agent: "vulcan", critic: kind === "loop" ? "minos" : null, brief: "b", dependsOn, maxRounds: 3 });

/** created + planned + workspace-prepared base for one goal. */
function base(goalId: string, keys: Array<{ key: string; kind?: "run" | "loop"; deps?: string[] }>) {
  let g = 0;
  return [
    ev(goalId, ++g, "goal.created", {
      slug: goalId, title: goalId, request: "r", department: "engineering", lead: "athena",
      origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
      planSummary: "planned", goalDir: `d-${goalId}`, projectDir: null,
    }),
    ev(goalId, ++g, "plan.recorded", { summary: "s", needsWorkspace: "none", nodes: keys.map((k) => node(k.key, k.kind ?? "loop", k.deps ?? [])) }),
    ev(goalId, ++g, "workspace.prepared", { taskDir: null, mode: null }),
  ];
}
const more = (evs: JournalEvent[], type: JournalEventType, payload: Record<string, unknown>, ts = 1000) =>
  [...evs, ev(evs[0].goalId, evs[evs.length - 1].gseq + 1, type, payload, ts)];

const CAPS: Caps = { maxConcurrent: 2, budgetAllowed: true, wallTimeMs: 60_000, replanCap: 2, plannerAvailable: true, maxAttempts: 2 };

/** loop node "a" that ran attempt 1 to the cap and parked. */
function parked(extraNodes: Array<{ key: string; kind?: "run" | "loop"; deps?: string[] }> = []) {
  let evs = base("g1", [{ key: "a" }, ...extraNodes]);
  evs = more(evs, "attempt.started", { node: "a", attempt: 1, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:a:1" });
  evs = more(evs, "round.recorded", { node: "a", attempt: 1, round: 3, role: "critic",
    verdict: { verdict: "revise", summary: "no", reasons: ["r1", "r2"] }, feedback: "no", artifactRef: "a-v3.md" });
  evs = more(evs, "attempt.finished", { node: "a", attempt: 1, outcome: "ok", costCents: 0, turns: 1 });
  evs = more(evs, "review.requested", { node: "a", lastArtifactRef: "a-v3.md", objections: ["r1", "r2"] });
  return evs;
}

describe("reduce — review lifecycle", () => {
  it("review.requested parks the node as needs-review with objections + lastArtifactRef", () => {
    const s = reduce(parked());
    const n = s.nodes.get("a")!;
    expect(n.status).toBe("needs-review");
    expect(n.reviewObjections).toEqual(["r1", "r2"]);
    expect(n.lastArtifactRef).toBe("a-v3.md");
    expect(nodeStatus(s, "a")).toBe("needs-review");
  });

  it("dependents of a parked node stay pending (not ready)", () => {
    const s = reduce(parked([{ key: "b", kind: "run", deps: ["a"] }]));
    expect(nodeStatus(s, "b")).toBe("pending");
  });

  it("review.resolved{retry} → pending + reviewRetry + guidance, rounds reset, fresh wall-time base", () => {
    const evs = more(parked(), "review.resolved", { node: "a", verdict: "retry", by: "ihab", guidance: "shorter" }, 5000);
    const s = reduce(evs);
    const n = s.nodes.get("a")!;
    expect(n.status).toBe("pending");
    expect(n.reviewRetry).toBe(true);
    expect(n.reviewGuidance).toBe("shorter");
    expect(n.currentRound).toBe(0);
    expect(n.lastVerdict).toBeNull();
    expect(s.lastResumeTs).toBe(5000);
  });

  it("attempt.started consumes the reviewRetry grant", () => {
    let evs = more(parked(), "review.resolved", { node: "a", verdict: "retry", by: "ihab" });
    evs = more(evs, "attempt.started", { node: "a", attempt: 2, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:a:2" });
    expect(reduce(evs).nodes.get("a")!.reviewRetry).toBe(false);
  });

  it("review.resolved{accept} + node.completed in one batch completes the node", () => {
    let evs = more(parked(), "review.resolved", { node: "a", verdict: "accept", by: "ihab" });
    evs = more(evs, "node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 3 });
    const n = reduce(evs).nodes.get("a")!;
    expect(n.status).toBe("done");
    expect(n.reviewObjections).toBeNull();
  });

  it("review.resolved{abandon} + node.failed fails the node", () => {
    let evs = more(parked(), "review.resolved", { node: "a", verdict: "abandon", by: "ihab" });
    evs = more(evs, "node.failed", { node: "a", error: "review: abandoned by user" });
    expect(reduce(evs).nodes.get("a")!.status).toBe("failed");
  });
});

describe("decide — review rules", () => {
  it("a needs-review node is not started, not failed, and blocks completion", () => {
    const cmds = decide([reduce(parked())], CAPS, 1000);
    expect(cmds).toEqual([]); // idles awaiting the human — no FailGoal, no StartAttempt
  });

  it("wall-time does NOT fail a goal parked on review", () => {
    const cmds = decide([reduce(parked())], CAPS, 10_000_000);
    expect(cmds.filter((c) => c.cmd === "FailGoal")).toEqual([]);
  });

  it("deadlock guard does NOT fire while a node is needs-review", () => {
    const cmds = decide([reduce(parked([{ key: "b", kind: "run", deps: ["a"] }]))], CAPS, 1000);
    expect(cmds.filter((c) => c.cmd === "FailGoal")).toEqual([]);
  });

  it("review.resolved{retry} grants exactly one StartAttempt with the next attempt number", () => {
    const evs = more(parked(), "review.resolved", { node: "a", verdict: "retry", by: "ihab" }, 2000);
    const cmds = decide([reduce(evs)], CAPS, 2500);
    expect(cmds).toEqual([{ cmd: "StartAttempt", goalId: "g1", node: "a", attempt: 2 }]);
  });

  it("other branches keep running while one node is parked", () => {
    const evs = parked([{ key: "c", kind: "run" }]); // c has no deps
    const starts = decide([reduce(evs)], CAPS, 1000).filter((c) => c.cmd === "StartAttempt");
    expect(starts).toEqual([{ cmd: "StartAttempt", goalId: "g1", node: "c", attempt: 1 }]);
  });
});

describe("projection — review lifecycle", () => {
  function seeded() {
    const store = new Store(":memory:");
    appendEvents(store, "g1", [
      { type: "goal.created", payload: {
        slug: "g1", title: "G", request: "r", department: "engineering", lead: "athena",
        origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
        planSummary: "planned", goalDir: "d-g1", projectDir: null } },
      { type: "plan.recorded", payload: { summary: "s", needsWorkspace: "none", nodes: [node("a")] } },
      { type: "workspace.prepared", payload: { taskDir: null, mode: null } },
      { type: "review.requested", payload: { node: "a", lastArtifactRef: "a-v3.md", objections: ["r1", "r2"] } },
    ]);
    return store;
  }

  it("review.requested projects needs-review + objections in error + artifact = last version", () => {
    const row = seeded().listNodes("g1")[0];
    expect(row.status).toBe("needs-review");
    expect(row.error).toBe("r1; r2");
    expect(row.artifact).toBe("a-v3.md");
    expect(row.finished_at).toBeTruthy();
  });

  it("review.resolved{retry} projects the node back to ready", () => {
    const store = seeded();
    appendEvents(store, "g1", [{ type: "review.resolved", payload: { node: "a", verdict: "retry", by: "ihab" } }]);
    expect(store.listNodes("g1")[0].status).toBe("ready");
  });

  it("needsReviewNodes lists parked nodes of unfinished goals only", () => {
    const store = seeded();
    const rows = store.needsReviewNodes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ goal_id: "g1", node_key: "a", goal_slug: "g1", error: "r1; r2" });
    appendEvents(store, "g1", [{ type: "goal.failed", payload: { error: "x" } }]);
    expect(store.needsReviewNodes()).toHaveLength(0);
  });
});
