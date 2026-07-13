// test/reduce.test.ts
import { describe, it, expect } from "vitest";
import { reduce, nodeStatus, type GoalState } from "../src/engine/reduce.js";
import type { JournalEvent, JournalEventType } from "../src/engine/journal.js";

let g = 0;
const ev = (type: JournalEventType, payload: Record<string, unknown>, ts = 1000): JournalEvent =>
  ({ seq: ++g, goalId: "g1", gseq: g, type, payload, v: 1, ts });

const created = (over: Record<string, unknown> = {}) => ev("goal.created", {
  slug: "x", title: "X", request: "do x", department: "engineering", lead: "athena",
  origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
  planSummary: "planned", goalDir: "2026-07-13-x", projectDir: null, ...over,
});
const node = (key: string, dependsOn: string[] = [], kind = "run") =>
  ({ key, kind, agent: "vulcan", critic: null, brief: "b", dependsOn, maxRounds: 3 });
const plan = (...keys: string[]) => ev("plan.recorded", { summary: "s", needsWorkspace: "none", nodes: keys.map((k) => node(k)) });
const ws = () => ev("workspace.prepared", { taskDir: null, mode: null });

/** Map/Set-free snapshot for equality assertions. */
const snap = (s: GoalState) => ({
  ...s,
  nodes: Object.fromEntries([...s.nodes.entries()]),
  replannedFor: [...s.replannedFor].sort(),
});

describe("reduce — golden states per event type", () => {
  it("goal.created + plan.recorded: running, pending nodes, wall-clock base set", () => {
    const s = reduce([created(), plan("a", "b")]);
    expect(s.phase).toBe("running");
    expect(s.created!.slug).toBe("x");
    expect(s.planned).toBe(true);
    expect(s.workspacePending).toBe(true);
    expect(s.order).toEqual(["a", "b"]);
    expect(s.nodes.get("a")!.status).toBe("pending");
    expect(s.lastResumeTs).toBe(1000);
  });

  it("workspace.prepared clears pending; taskDir lands; stripped nulls projectDir", () => {
    const s1 = reduce([created({ projectDir: "/p" }), plan("a"), ev("workspace.prepared", { taskDir: "/ws/t1", mode: "build" })]);
    expect(s1.workspacePending).toBe(false);
    expect(s1.workspace).toEqual({ taskDir: "/ws/t1", mode: "build" });
    expect(s1.created!.projectDir).toBe("/ws/t1");
    const s2 = reduce([created({ projectDir: "/p" }), plan("a"), ev("workspace.prepared", { taskDir: null, mode: null, stripped: true })]);
    expect(s2.created!.projectDir).toBeNull();
    const s3 = reduce([created(), plan("a"), ev("workspace.failed", { error: "no disk" })]);
    expect(s3.workspaceError).toBe("no disk");
    expect(s3.workspacePending).toBe(false);
  });

  it("attempt.started/finished: running derived from dangling attempt; cost accrues", () => {
    const base = [created(), plan("a"), ws()];
    const started = reduce([...base, ev("attempt.started", { node: "a", attempt: 1, agent: "vulcan", deadlineTs: 99, idempotencyKey: "g1:a:1" })]);
    expect(started.nodes.get("a")!.runningAttempt).toEqual({ attempt: 1, deadlineTs: 99, startedTs: 1000 });
    expect(nodeStatus(started, "a")).toBe("running");
    const finished = reduce([...base,
      ev("attempt.started", { node: "a", attempt: 1, agent: "vulcan", deadlineTs: 99, idempotencyKey: "g1:a:1" }),
      ev("attempt.finished", { node: "a", attempt: 1, outcome: "error", costCents: 12, turns: 3, error: "boom" }),
    ]);
    const n = finished.nodes.get("a")!;
    expect(n.runningAttempt).toBeNull();
    expect(n.attempts).toBe(1);
    expect(n.lastOutcome).toBe("error");
    expect(n.lastError).toBe("boom");
    expect(n.costCents).toBe(12);
    expect(finished.spendCents).toBe(12);
    expect(nodeStatus(finished, "a")).toBe("ready"); // retryable
  });

  it("round.recorded: loop critic rounds, verify runner/fixer rounds, feedback carried", () => {
    const base = [created(), ev("plan.recorded", { summary: "s", needsWorkspace: "none",
      nodes: [{ key: "l", kind: "loop", agent: "vulcan", critic: "minos", brief: "b", dependsOn: [], maxRounds: 3 },
              { key: "v", kind: "verify", agent: "argus", critic: "vulcan", brief: "b", dependsOn: [], maxRounds: 3 }] }), ws()];
    const s = reduce([...base,
      ev("round.recorded", { node: "l", attempt: 1, round: 1, role: "critic",
        verdict: { verdict: "revise", summary: "needs work", reasons: ["r1"] }, feedback: "needs work\n- r1", artifactRef: "l-v1.md" }),
      ev("round.recorded", { node: "v", attempt: 1, round: 1, role: "runner",
        report: { passed: false, summary: "f", failures: ["f1"] }, feedback: "f\n- f1", artifactRef: "v-run-1.md" }),
      ev("round.recorded", { node: "v", attempt: 1, round: 1, role: "fixer", feedback: "f", artifactRef: "v-fix-1.md" }),
    ]);
    const l = s.nodes.get("l")!;
    expect(l.loopRounds).toBe(1);
    expect(l.currentRound).toBe(1);
    expect(l.lastVerdict!.verdict).toBe("revise");
    expect(l.lastFeedback).toBe("needs work\n- r1");
    expect(l.lastArtifactRef).toBe("l-v1.md");
    const v = s.nodes.get("v")!;
    expect(v.runnerRounds).toBe(1);
    expect(v.fixerRounds).toBe(1);
    expect(v.lastReport!.passed).toBe(false);
  });

  it("node.completed/failed/skipped + goal terminal events", () => {
    const s = reduce([created(), plan("a", "b", "c"), ws(),
      ev("node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 2 }),
      ev("node.failed", { node: "b", error: "boom" }),
      ev("node.skipped", { node: "c" }),
      ev("goal.failed", { error: "node b failed: boom" }),
    ]);
    expect(s.nodes.get("a")).toMatchObject({ status: "done", artifact: "a.md", currentRound: 2 });
    expect(s.nodes.get("b")).toMatchObject({ status: "failed", lastError: "boom" });
    expect(s.nodes.get("c")!.status).toBe("skipped");
    expect(s.phase).toBe("failed");
    expect(s.error).toBe("node b failed: boom");
  });

  it("ready derivation: deps gate; done unlocks dependents", () => {
    const s = reduce([created(), ev("plan.recorded", { summary: "s", needsWorkspace: "none",
      nodes: [node("a"), node("b", ["a"])] }), ws()]);
    expect(nodeStatus(s, "a")).toBe("ready");
    expect(nodeStatus(s, "b")).toBe("pending");
    const s2 = reduce([created(), ev("plan.recorded", { summary: "s", needsWorkspace: "none",
      nodes: [node("a"), node("b", ["a"])] }), ws(),
      ev("node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 0 })]);
    expect(nodeStatus(s2, "b")).toBe("ready");
  });

  it("ask.parked/ask.resumed: park marks asking node done; resume resets wall-clock", () => {
    const s = reduce([created(), plan("a"), ws(),
      ev("ask.parked", { node: "a", mailId: "m1" })]);
    expect(s.phase).toBe("awaiting-mail");
    expect(s.parkedOn).toBe("m1");
    expect(s.nodes.get("a")!.status).toBe("done");
    const s2 = reduce([created(), plan("a"), ws(),
      ev("ask.parked", { node: "a", mailId: "m1" }),
      ev("ask.resumed", { mailId: "m1", resumeNodeKey: "resume_1" }, 5000)]);
    expect(s2.phase).toBe("running");
    expect(s2.parkedOn).toBeNull();
    expect(s2.lastResumeTs).toBe(5000);
  });

  it("goal.paused/resumed: budget vs user; resume resets wall-clock", () => {
    const p = reduce([created(), plan("a"), ev("goal.paused", { reason: "budget" })]);
    expect(p.phase).toBe("paused-budget");
    const u = reduce([created(), plan("a"), ev("goal.paused", { reason: "user" })]);
    expect(u.phase).toBe("paused-user");
    const r = reduce([created(), plan("a"), ev("goal.paused", { reason: "budget" }),
      ev("goal.resumed", { by: "budget-reset" }, 9000)]);
    expect(r.phase).toBe("running");
    expect(r.lastResumeTs).toBe(9000);
  });

  it("replan.recorded: replace resets node, add appends, retarget rewires, cap counting", () => {
    const s = reduce([created(), plan("a", "b"), ws(),
      ev("node.failed", { node: "a", error: "boom" }),
      ev("replan.recorded", { kind: "replan", forNode: "a",
        replaced: [node("a")], added: [node("c", ["a"])],
        retargets: [{ node: "b", dependsOn: ["c"] }], reason: "boom" }),
    ]);
    expect(s.replansUsed).toBe(1);
    expect(s.nodes.get("a")!.status).toBe("pending"); // reset by replace
    expect(s.replannedFor.has("a")).toBe(false);       // replaced key can fail+replan again
    expect(s.order).toEqual(["a", "b", "c"]);
    expect(s.nodes.get("b")!.spec.dependsOn).toEqual(["c"]);
    // resume-kind does not count against the cap but marks forNode addressed
    const s2 = reduce([created(), plan("a"), ws(),
      ev("ask.parked", { node: "a", mailId: "m1" }),
      ev("ask.resumed", { mailId: "m1", resumeNodeKey: "resume_1" }),
      ev("replan.recorded", { kind: "resume", forNode: "a",
        replaced: [], added: [node("resume_1", ["a"])], retargets: [], reason: "ask-resume" }),
    ]);
    expect(s2.replansUsed).toBe(0);
    expect(s2.nodes.get("resume_1")!.status).toBe("pending");
  });

  it("goal.abandoned + goal.completed terminal phases", () => {
    expect(reduce([created(), plan("a"), ev("goal.abandoned", { by: "user" })]).phase).toBe("abandoned");
    expect(reduce([created(), plan("a"),
      ev("node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 0 }),
      ev("goal.completed", {})]).phase).toBe("done");
  });
});

describe("reduce — replay determinism", () => {
  const script = () => [created(), plan("a", "b"), ws(),
    ev("attempt.started", { node: "a", attempt: 1, agent: "vulcan", deadlineTs: 9, idempotencyKey: "k" }),
    ev("attempt.finished", { node: "a", attempt: 1, outcome: "ok", costCents: 7, turns: 2 }),
    ev("node.completed", { node: "a", artifactRef: "a.md", roundsUsed: 0 }),
    ev("attempt.started", { node: "b", attempt: 1, agent: "vulcan", deadlineTs: 9, idempotencyKey: "k2" }),
    ev("attempt.finished", { node: "b", attempt: 1, outcome: "ok", costCents: 3, turns: 1 }),
    ev("node.completed", { node: "b", artifactRef: "b.md", roundsUsed: 0 }),
    ev("goal.completed", {}),
  ];

  it("fold twice ≡ fold once", () => {
    const evs = script();
    expect(snap(reduce(evs))).toEqual(snap(reduce(evs)));
  });

  it("fold(prefix)+fold(suffix) ≡ fold(all), at every split point", () => {
    const evs = script();
    const whole = snap(reduce(evs));
    for (let k = 0; k <= evs.length; k++) {
      const partial = reduce(evs.slice(k), reduce(evs.slice(0, k)));
      expect(snap(partial), `split at ${k}`).toEqual(whole);
    }
  });

  it("initial state is not mutated by continued folding", () => {
    const evs = script();
    const mid = reduce(evs.slice(0, 5));
    const before = snap(mid);
    reduce(evs.slice(5), mid);
    expect(snap(mid)).toEqual(before);
  });
});
