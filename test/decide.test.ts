// test/decide.test.ts
import { describe, it, expect } from "vitest";
import { reduce } from "../src/engine/reduce.js";
import { decide, type Caps } from "../src/engine/decide.js";
import type { JournalEvent, JournalEventType } from "../src/engine/journal.js";

let seq = 0;
const ev = (goalId: string, gseq: number, type: JournalEventType, payload: Record<string, unknown>, ts = 1000): JournalEvent =>
  ({ seq: ++seq, goalId, gseq, type, payload, v: 1, ts });

const node = (key: string, dependsOn: string[] = []) =>
  ({ key, kind: "run", agent: "vulcan", critic: null, brief: "b", dependsOn, maxRounds: 1 });

/** Ready-to-run goal: created + planned + workspace done. */
function goal(goalId: string, keys: Array<{ key: string; deps?: string[] }>, over: Record<string, unknown> = {}) {
  let g = 0;
  return [
    ev(goalId, ++g, "goal.created", {
      slug: goalId, title: goalId, request: "r", department: "engineering", lead: "athena",
      origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
      planSummary: "planned", goalDir: `d-${goalId}`, projectDir: null, ...over,
    }),
    ev(goalId, ++g, "plan.recorded", { summary: "s", needsWorkspace: "none", nodes: keys.map((k) => node(k.key, k.deps ?? [])) }),
    ev(goalId, ++g, "workspace.prepared", { taskDir: null, mode: null }),
  ];
}
const withGseq = (base: JournalEvent[], type: JournalEventType, payload: Record<string, unknown>, ts = 1000) =>
  [...base, ev(base[0].goalId, base[base.length - 1].gseq + 1, type, payload, ts)];

const CAPS: Caps = { maxConcurrent: 2, budgetAllowed: true, wallTimeMs: 60_000, replanCap: 2, plannerAvailable: true, maxAttempts: 2 };
const att = (n: string, a: number, deadlineTs = 999_999) =>
  ({ node: n, attempt: a, agent: "vulcan", deadlineTs, idempotencyKey: "k" });
const fin = (n: string, a: number, outcome: string, error?: string) =>
  ({ node: n, attempt: a, outcome, costCents: 0, turns: 0, ...(error ? { error } : {}) });

describe("decide", () => {
  it("starts ready nodes attempt 1; never exceeds maxConcurrent; round-robin across goals", () => {
    const g1 = reduce(goal("g1", [{ key: "a" }, { key: "b" }, { key: "c" }]));
    const g2 = reduce(goal("g2", [{ key: "x" }, { key: "y" }]));
    const cmds = decide([g1, g2], { ...CAPS, maxConcurrent: 3 }, 1000);
    const starts = cmds.filter((c) => c.cmd === "StartAttempt");
    expect(starts).toHaveLength(3);
    // fairness: g2 gets a slot before g1's second node
    expect(starts.map((s) => `${(s as { goalId: string }).goalId}:${(s as { node: string }).node}`))
      .toEqual(["g1:a", "g2:x", "g1:b"]);
    expect(starts.every((s) => (s as { attempt: number }).attempt === 1)).toBe(true);
  });

  it("running attempts consume global slots", () => {
    let evs = goal("g1", [{ key: "a" }, { key: "b" }, { key: "c" }]);
    evs = withGseq(evs, "attempt.started", att("a", 1));
    const cmds = decide([reduce(evs)], CAPS, 1000);
    expect(cmds.filter((c) => c.cmd === "StartAttempt")).toHaveLength(1); // 2 cap - 1 running
  });

  it("no command for non-ready nodes (dep gating)", () => {
    const s = reduce(goal("g1", [{ key: "a" }, { key: "b", deps: ["a"] }]));
    const starts = decide([s], CAPS, 1000).filter((c) => c.cmd === "StartAttempt");
    expect(starts.map((c) => (c as { node: string }).node)).toEqual(["a"]);
  });

  it("errored node with attempts left → retry with attempt+1", () => {
    let evs = goal("g1", [{ key: "a" }]);
    evs = withGseq(evs, "attempt.started", att("a", 1));
    evs = withGseq(evs, "attempt.finished", fin("a", 1, "error", "boom"));
    const cmds = decide([reduce(evs)], CAPS, 1000);
    expect(cmds).toContainEqual({ cmd: "StartAttempt", goalId: "g1", node: "a", attempt: 2 });
  });

  it("attempts exhausted → FailNode; then failed node → RequestReplan (planned goal)", () => {
    let evs = goal("g1", [{ key: "a" }]);
    evs = withGseq(evs, "attempt.started", att("a", 1));
    evs = withGseq(evs, "attempt.finished", fin("a", 1, "error", "boom"));
    evs = withGseq(evs, "attempt.started", att("a", 2));
    evs = withGseq(evs, "attempt.finished", fin("a", 2, "error", "boom"));
    const c1 = decide([reduce(evs)], CAPS, 1000);
    expect(c1).toContainEqual({ cmd: "FailNode", goalId: "g1", node: "a", error: "boom" });
    expect(c1.filter((c) => c.cmd === "StartAttempt")).toHaveLength(0);
    evs = withGseq(evs, "node.failed", { node: "a", error: "boom" });
    const c2 = decide([reduce(evs)], CAPS, 1000);
    expect(c2).toContainEqual({ cmd: "RequestReplan", goalId: "g1", node: "a", error: "boom" });
  });

  it("failed node on facade/mail goal, or replan cap hit → FailGoal", () => {
    let f = goal("g1", [{ key: "a" }], { planSummary: "playbook:research-report" });
    f = withGseq(f, "node.failed", { node: "a", error: "boom" });
    expect(decide([reduce(f)], CAPS, 1000)[0]).toMatchObject({ cmd: "FailGoal", error: "node a failed: boom" });

    let m = goal("g2", [{ key: "a" }], { planSummary: "mail:m1" });
    m = withGseq(m, "node.failed", { node: "a", error: "boom" });
    expect(decide([reduce(m)], CAPS, 1000)[0]).toMatchObject({ cmd: "FailGoal" });

    let capped = goal("g3", [{ key: "a" }, { key: "b" }]);
    capped = withGseq(capped, "node.failed", { node: "a", error: "boom" });
    capped = withGseq(capped, "replan.recorded", { kind: "replan", forNode: "a", replaced: [], added: [node("b2")], retargets: [], reason: "1" });
    capped = withGseq(capped, "node.failed", { node: "b", error: "boom2" });
    capped = withGseq(capped, "replan.recorded", { kind: "replan", forNode: "b", replaced: [], added: [node("b3")], retargets: [], reason: "2" });
    capped = withGseq(capped, "node.failed", { node: "b2", error: "boom3" });
    const c = decide([reduce(capped)], CAPS, 1000);
    expect(c[0]).toMatchObject({ cmd: "FailGoal", goalId: "g3" });
    expect((c[0] as { error: string }).error).toContain("re-plans exhausted: 2");
  });

  it("a replanned-but-still-failed graph deadlocks → FailGoal stuck", () => {
    let evs = goal("g1", [{ key: "a" }, { key: "b", deps: ["a"] }]);
    evs = withGseq(evs, "node.failed", { node: "a", error: "boom" });
    // lead patched by adding an unrelated node; "a" was NOT replaced and stays failed
    evs = withGseq(evs, "replan.recorded", { kind: "replan", forNode: "a", replaced: [], added: [node("c")], retargets: [], reason: "boom" });
    evs = withGseq(evs, "node.completed", { node: "c", artifactRef: "c.md", roundsUsed: 0 });
    const cmds = decide([reduce(evs)], CAPS, 1000);
    expect(cmds).toContainEqual({
      cmd: "FailGoal", goalId: "g1", error: "stuck: unfinished nodes depend on failed/skipped nodes",
    });
  });

  it("all nodes done → CompleteGoal", () => {
    let evs = goal("g1", [{ key: "a" }]);
    evs = withGseq(evs, "node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 0 });
    expect(decide([reduce(evs)], CAPS, 1000)).toEqual([{ cmd: "CompleteGoal", goalId: "g1" }]);
  });

  it("wall-time exceeded (from last resume event) → FailGoal", () => {
    const fresh = reduce(goal("g1", [{ key: "a" }]));
    expect(decide([fresh], CAPS, 1000 + 60_001)[0]).toMatchObject({ cmd: "FailGoal", error: "Goal wall-time budget exceeded" });
    // resumed goal gets a fresh window
    let evs = goal("g1", [{ key: "a" }]);
    evs = withGseq(evs, "goal.paused", { reason: "budget" });
    evs = withGseq(evs, "goal.resumed", { by: "budget-reset" }, 100_000);
    const resumed = decide([reduce(evs)], CAPS, 100_000 + 59_000);
    expect(resumed.filter((c) => c.cmd === "FailGoal")).toHaveLength(0);
    expect(resumed).toContainEqual({ cmd: "StartAttempt", goalId: "g1", node: "a", attempt: 1 });
  });

  it("budget denied → ParkForBudget instead of starts; running goals untouched", () => {
    const s = reduce(goal("g1", [{ key: "a" }]));
    const cmds = decide([s], { ...CAPS, budgetAllowed: false }, 1000);
    expect(cmds).toEqual([{ cmd: "ParkForBudget", goalId: "g1" }]);
  });

  it("paused goals get no commands at all", () => {
    let evs = goal("g1", [{ key: "a" }]);
    evs = withGseq(evs, "goal.paused", { reason: "user" });
    expect(decide([reduce(evs)], CAPS, 1000)).toEqual([]);
  });

  it("past-deadline running attempt → AbortAttempt(timeout), even while parked", () => {
    let evs = goal("g1", [{ key: "a" }, { key: "b" }]);
    evs = withGseq(evs, "attempt.started", att("a", 1, 5000));
    evs = withGseq(evs, "ask.parked", { node: "b", mailId: "m1" });
    const cmds = decide([reduce(evs)], CAPS, 6000);
    expect(cmds).toContainEqual({ cmd: "AbortAttempt", goalId: "g1", node: "a", attempt: 1, reason: "timeout" });
  });

  it("parked goal: sibling retry allowed, fresh starts and completion suppressed", () => {
    let evs = goal("g1", [{ key: "a" }, { key: "b" }]);
    evs = withGseq(evs, "ask.parked", { node: "a", mailId: "m1" });
    evs = withGseq(evs, "attempt.started", att("b", 1));
    evs = withGseq(evs, "attempt.finished", fin("b", 1, "error", "boom"));
    const cmds = decide([reduce(evs)], CAPS, 1000);
    expect(cmds).toContainEqual({ cmd: "StartAttempt", goalId: "g1", node: "b", attempt: 2 });
    // all-done while parked: no CompleteGoal
    let done = goal("g2", [{ key: "a" }]);
    done = withGseq(done, "ask.parked", { node: "a", mailId: "m2" });
    expect(decide([reduce(done)], CAPS, 1000)).toEqual([]);
  });

  it("workspace pending → PrepareWorkspace, nothing starts; workspace failed → FailGoal", () => {
    const pending = reduce(goal("g1", [{ key: "a" }]).slice(0, 2)); // no workspace.prepared
    expect(decide([pending], CAPS, 1000)).toEqual([{ cmd: "PrepareWorkspace", goalId: "g1" }]);
    let failed = goal("g2", [{ key: "a" }]).slice(0, 2);
    failed = withGseq(failed, "workspace.failed", { error: "no disk" });
    expect(decide([reduce(failed)], CAPS, 1000)[0]).toMatchObject({
      cmd: "FailGoal", goalId: "g2", error: "workspace setup failed: no disk",
    });
  });

  it("terminal goals produce nothing", () => {
    let evs = goal("g1", [{ key: "a" }]);
    evs = withGseq(evs, "node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 0 });
    evs = withGseq(evs, "goal.completed", {});
    expect(decide([reduce(evs)], CAPS, 1000)).toEqual([]);
  });
});
