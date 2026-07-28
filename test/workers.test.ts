// test/workers.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { appendEvents, readJournal, type NodeSpec, type JournalEventType } from "../src/engine/journal.js";
import { AbortRegistry, runAttempt, ancestorArtifacts, isApiErrorOutput, type WorkerDeps } from "../src/engine/workers.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";
import { WORK_REPORT_SCHEMA } from "../src/agents/roles/index.js";

const SPEC = (over: Partial<NodeSpec> = {}): NodeSpec =>
  ({ key: "design", kind: "run", agent: "athena", critic: null, brief: "design it", dependsOn: [], maxRounds: 3, ...over });

function harness(run: SpecialistRunFn, specs: NodeSpec[] = [SPEC()]) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "wk-vault-")), "AIOS");
  const goalDir = vault.goalDirName("build-x");
  appendEvents(store, "g1", [
    { type: "goal.created", payload: {
      slug: "build-x", title: "Build X", request: "build x", department: "engineering", lead: "athena",
      origin: { channel: "telegram", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
      planSummary: "planned", goalDir, projectDir: null } },
    { type: "plan.recorded", payload: { summary: "s", needsWorkspace: "none", nodes: specs } },
    { type: "workspace.prepared", payload: { taskDir: null, mode: null } },
  ]);
  const registry = new AbortRegistry();
  const deps: WorkerDeps = {
    store, vault, run, registry, nodeTimeoutMs: 900_000,
  };
  return { store, vault, deps, registry, goalDir, goal: () => store.getGoal("g1")! };
}

const journalTypes = (store: Store) => readJournal(store, "g1").map((e) => e.type);
const payloadOf = (store: Store, type: JournalEventType) =>
  readJournal(store, "g1").filter((e) => e.type === type).map((e) => e.payload);

describe("runAttempt — run nodes", () => {
  it("claims, runs with brief+context, writes artifact, journals ok + cost", async () => {
    const briefs: string[] = [];
    const { store, vault, deps, goalDir, goal } = harness(async (_r, brief) => {
      briefs.push(brief);
      return { text: "the design", costUsd: 0.05, numTurns: 2 };
    });
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res).toEqual({ claimed: true, outcome: "ok", sessionLimit: false, apiUnreachable: false });
    expect(briefs[0]).toContain("design it");
    expect(briefs[0]).toContain("# Task\nbuild x");
    expect(vault.readGoalArtifact(goalDir, "design.md")).toContain("the design");
    expect(journalTypes(store)).toContain("attempt.started");
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({ node: "design", attempt: 1, outcome: "ok", costCents: 5, turns: 2 });
    expect(payloadOf(store, "node.completed")[0]).toMatchObject({ node: "design", artifactRef: "design.md" });
    expect(payloadOf(store, "attempt.started")[0]).toMatchObject({ idempotencyKey: "g1:design:1" });
    // projections followed
    expect(store.listNodes("g1")[0]).toMatchObject({ status: "done", artifact: "design.md", cost_cents: 5 });
  });

  it("lost claim: pre-existing attempt.started for same node+attempt → run fn never called", async () => {
    let calls = 0;
    const { store, deps, goal } = harness(async () => { calls++; return { text: "x", costUsd: 0, numTurns: 1 }; });
    appendEvents(store, "g1", [{ type: "attempt.started", payload: { node: "design", attempt: 1, agent: "athena", deadlineTs: 9e12, idempotencyKey: "g1:design:1" } }]);
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.claimed).toBe(false);
    expect(calls).toBe(0);
  });

  it("run error → attempt.finished{error}, no node.completed, no throw", async () => {
    const { store, deps, goal } = harness(async () => { throw new Error("flake"); });
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.outcome).toBe("error");
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({ outcome: "error", error: "flake" });
    expect(journalTypes(store)).not.toContain("node.completed");
  });

  it("session-limit output → outcome error + sessionLimit flag, run not retried here", async () => {
    let calls = 0;
    const { deps, goal } = harness(async () => {
      calls++;
      return { text: "You've hit your session limit — resets at 3pm", costUsd: 0, numTurns: 1 };
    });
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.sessionLimit).toBe(true);
    expect(calls).toBe(1);
  });

  it("abort with timeout reason → outcome timeout; budget reason → aborted", async () => {
    for (const [reason, outcome] of [["timeout", "timeout"], ["budget", "aborted"]] as const) {
      const { deps, registry, goal, store } = harness((_r, _b, opts) =>
        new Promise((_res, rej) => opts.signal?.addEventListener("abort", () => rej(new Error("aborted by signal")))));
      const p = runAttempt(goal(), SPEC(), 1, deps);
      await new Promise((r) => setTimeout(r, 10));
      registry.abort(registry.key("g1", "design", 1), reason);
      const res = await p;
      expect(res.outcome, reason).toBe(outcome);
      expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({ outcome });
    }
  });
});

describe("runAttempt — loop nodes", () => {
  const LOOP = SPEC({ key: "impl", kind: "loop", agent: "vulcan", critic: "minos-eng", maxRounds: 3 });

  it("revise then approve: rounds journaled, artifacts per round, final artifact clean", async () => {
    let call = 0;
    const { store, vault, deps, goalDir, goal } = harness(async (role) => {
      call++;
      if (role === "minos-eng") {
        const verdict = call === 2
          ? { verdict: "revise", summary: "needs work", reasons: ["r1"] }
          : { verdict: "approve", summary: "good", reasons: [] };
        return { text: "review", structured: verdict, costUsd: 0.01, numTurns: 1 };
      }
      return { text: `v${call}`, costUsd: 0.01, numTurns: 1 };
    }, [LOOP]);
    await runAttempt(goal(), LOOP, 1, deps);
    const rounds = payloadOf(store, "round.recorded");
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({ node: "impl", round: 1, role: "critic" });
    expect(rounds[1]).toMatchObject({ round: 2 });
    expect(vault.readGoalArtifact(goalDir, "impl-a1-v1.md")).toBeTruthy();       // attempt-scoped
    expect(vault.readGoalArtifact(goalDir, "impl-a1-review-2.md")).toContain("approve");
    expect(vault.readGoalArtifact(goalDir, "impl.md")).not.toContain("Loop cap reached");
    expect(store.listNodes("g1")[0].rounds_used).toBe(2);
  });

  it("cap without approval: review.requested with critic objections, no node.completed (spec §4)", async () => {
    const { store, deps, goal } = harness(async (role) =>
      role === "minos-eng"
        ? { text: "r", structured: { verdict: "revise", summary: "no", reasons: ["too long"] }, costUsd: 0, numTurns: 1 }
        : { text: "draft", costUsd: 0, numTurns: 1 }, [LOOP]);
    await runAttempt(goal(), LOOP, 1, deps);
    expect(journalTypes(store)).not.toContain("node.completed");
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({ outcome: "ok" });
    expect(payloadOf(store, "review.requested")[0]).toMatchObject({
      node: "impl", lastArtifactRef: "impl-a1-v3.md", objections: ["too long"],
    });
    expect(store.listNodes("g1")[0]).toMatchObject({ status: "needs-review", error: "too long" });
  });

  it("review-retry attempt injects user guidance, runs fresh rounds, and does NOT clobber attempt-1 artifacts", async () => {
    const briefs: string[] = [];
    const { store, vault, goalDir, deps, goal } = harness(async (role, brief) => {
      briefs.push(`${role}:${brief}`);
      if (role === "minos-eng") return { text: "r", structured: { verdict: "approve", summary: "ok", reasons: [] }, costUsd: 0, numTurns: 1 };
      return { text: "v", costUsd: 0, numTurns: 1 };
    }, [LOOP]);
    // seed: attempt 1 hit the cap, parked, user granted a retry with guidance
    appendEvents(store, "g1", [
      { type: "attempt.started", payload: { node: "impl", attempt: 1, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:impl:1" } },
      { type: "round.recorded", payload: { node: "impl", attempt: 1, round: 3, role: "critic",
        verdict: { verdict: "revise", summary: "no", reasons: ["r1"] }, feedback: "no", artifactRef: "impl-v3.md" } },
      { type: "attempt.finished", payload: { node: "impl", attempt: 1, outcome: "ok", costCents: 0, turns: 0 } },
      { type: "review.requested", payload: { node: "impl", lastArtifactRef: "impl-v3.md", objections: ["r1"] } },
      { type: "review.resolved", payload: { node: "impl", verdict: "retry", by: "ihab", guidance: "cut it to one page" } },
    ]);
    await runAttempt(goal(), LOOP, 2, deps);
    const producerBrief = briefs.find((b) => b.startsWith("vulcan:"))!;
    expect(producerBrief).toContain("cut it to one page");
    const rounds = payloadOf(store, "round.recorded");
    expect(rounds[rounds.length - 1]).toMatchObject({ round: 1, attempt: 2 }); // fresh rounds, not 4
    expect(payloadOf(store, "node.completed")[0]).toMatchObject({ node: "impl" });
    // The retry's round-1 producer writes under attempt 2 — attempt 1's -a1- files are never
    // overwritten (round reset to 0 used to make attempt 2 re-save impl-v1.md over attempt 1's).
    expect(vault.readGoalArtifact(goalDir, "impl-a2-v1.md")).toBeTruthy();
  });

  it("crash-resume: attempt 2 starts at round N+1 with the critic's last feedback", async () => {
    const briefs: string[] = [];
    const { store, deps, goal } = harness(async (role, brief) => {
      briefs.push(`${role}:${brief}`);
      if (role === "minos-eng") return { text: "r", structured: { verdict: "approve", summary: "ok", reasons: [] }, costUsd: 0, numTurns: 1 };
      return { text: "v2", costUsd: 0, numTurns: 1 };
    }, [LOOP]);
    // seed: attempt 1 completed round 1 (revise) then died (orphaned)
    appendEvents(store, "g1", [
      { type: "attempt.started", payload: { node: "impl", attempt: 1, agent: "vulcan", deadlineTs: 9e12, idempotencyKey: "g1:impl:1" } },
      { type: "round.recorded", payload: { node: "impl", attempt: 1, round: 1, role: "critic",
        verdict: { verdict: "revise", summary: "needs tests", reasons: ["add tests"] },
        feedback: "needs tests\n- add tests", artifactRef: "impl-v1.md" } },
      { type: "attempt.finished", payload: { node: "impl", attempt: 1, outcome: "orphaned", costCents: 0, turns: 0 } },
    ]);
    await runAttempt(goal(), LOOP, 2, deps);
    const producerBrief = briefs.find((b) => b.startsWith("vulcan:"))!;
    expect(producerBrief).toContain("needs tests");           // resumed with feedback
    expect(producerBrief).toContain("round 1");                // labeled as prior round's feedback
    const rounds = payloadOf(store, "round.recorded");
    expect(rounds[rounds.length - 1]).toMatchObject({ round: 2, attempt: 2 }); // NOT round 1 again
  });
});

describe("runAttempt — verify nodes", () => {
  const VERIFY = SPEC({ key: "test", kind: "verify", agent: "argus", critic: "vulcan", maxRounds: 3 });

  it("failing report triggers fixer, passing stops; roles sequence preserved", async () => {
    let runnerCalls = 0;
    const roles: string[] = [];
    const { store, deps, goal } = harness(async (role) => {
      roles.push(role);
      if (role === "argus") {
        runnerCalls++;
        return { text: "report", structured: { passed: runnerCalls > 1, summary: "s", failures: runnerCalls > 1 ? [] : ["f1"] }, costUsd: 0.01, numTurns: 1 };
      }
      return { text: "fixed", costUsd: 0.01, numTurns: 1 };
    }, [VERIFY]);
    await runAttempt(goal(), VERIFY, 1, deps);
    expect(roles).toEqual(["argus", "vulcan", "argus"]);
    const rounds = payloadOf(store, "round.recorded");
    expect(rounds.map((r) => r.role)).toEqual(["runner", "fixer", "runner"]);
    expect(store.listNodes("g1")[0].rounds_used).toBe(2);
  });

  it("crash-resume after failing runner round: fixer for that round runs, then next runner round", async () => {
    const roles: string[] = [];
    const { store, deps, goal } = harness(async (role) => {
      roles.push(role);
      if (role === "argus") return { text: "r", structured: { passed: true, summary: "ok", failures: [] }, costUsd: 0, numTurns: 1 };
      return { text: "fixed", costUsd: 0, numTurns: 1 };
    }, [VERIFY]);
    appendEvents(store, "g1", [
      { type: "attempt.started", payload: { node: "test", attempt: 1, agent: "argus", deadlineTs: 9e12, idempotencyKey: "g1:test:1" } },
      { type: "round.recorded", payload: { node: "test", attempt: 1, round: 1, role: "runner",
        report: { passed: false, summary: "broke", failures: ["f1"] }, feedback: "broke\n- f1", artifactRef: "test-run-1.md" } },
      { type: "attempt.finished", payload: { node: "test", attempt: 1, outcome: "orphaned", costCents: 0, turns: 0 } },
    ]);
    await runAttempt(goal(), VERIFY, 2, deps);
    expect(roles).toEqual(["vulcan", "argus"]); // fixer first (round 1 pending fix), then runner round 2
  });

  it("failing report at cap: review.requested with failures as objections (hard gate)", async () => {
    const { store, deps, goal } = harness(async (role) =>
      role === "vulcan"
        ? { text: "fix", costUsd: 0, numTurns: 1 }
        : { text: "r", structured: { passed: false, summary: "2 tests fail", failures: ["t1", "t2"] }, costUsd: 0, numTurns: 1 },
      [VERIFY]);
    await runAttempt(goal(), VERIFY, 1, deps);
    expect(journalTypes(store)).not.toContain("node.completed");
    expect(payloadOf(store, "review.requested")[0]).toMatchObject({
      node: "test", lastArtifactRef: "test-a1-run-3.md", objections: ["2 tests fail", "t1", "t2"],
    });
  });

  it("no structured report → attempt.finished{error}, no node.completed (spec §3 hard gate)", async () => {
    const { store, deps, goal } = harness(async () =>
      ({ text: "prose, no report", costUsd: 0.01, numTurns: 1 }), [VERIFY]);
    const res = await runAttempt(goal(), VERIFY, 1, deps);
    expect(res.outcome).toBe("error");
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({ outcome: "error", error: expect.stringContaining("no structured report") });
    expect(journalTypes(store)).not.toContain("node.completed");
  });

  it("retry after a no-report attempt runs the runner again (does not instant-fail)", async () => {
    let calls = 0;
    const { store, deps, goal } = harness(async () => {
      calls++;
      return calls === 1
        ? { text: "no report", costUsd: 0, numTurns: 1 }
        : { text: "ok", structured: { passed: true, summary: "s", failures: [] }, costUsd: 0, numTurns: 1 };
    }, [VERIFY]);
    await runAttempt(goal(), VERIFY, 1, deps);   // no-report → error
    const res = await runAttempt(goal(), VERIFY, 2, deps); // retry must actually run
    expect(calls).toBe(2);
    expect(res.outcome).toBe("ok");
    expect(payloadOf(store, "node.completed")[0]).toMatchObject({ node: "test" });
  });
});

describe("ancestorArtifacts + parked-node guard", () => {
  it("ancestorArtifacts: transitive deps only, done+artifact only", () => {
    const { store } = harness(async () => ({ text: "", costUsd: 0, numTurns: 0 }),
      [SPEC({ key: "a" }), SPEC({ key: "b", dependsOn: ["a"] }), SPEC({ key: "sib", dependsOn: ["a"] }), SPEC({ key: "c", dependsOn: ["b"] })]);
    for (const k of ["a", "b", "sib"]) {
      appendEvents(store, "g1", [{ type: "node.completed", payload: { node: k, artifactRef: `${k}.md`, roundsUsed: 0 } }]);
    }
    const anc = ancestorArtifacts(store.listNodes("g1"), "c").map((n) => n.node_key);
    expect(anc.sort()).toEqual(["a", "b"]);
  });

  it("a node parked done via ask_mail mid-attempt does not get re-completed", async () => {
    const { store, deps, goal } = harness(async () => {
      // simulate the agent calling ask_mail mid-run: the node flips done via ask.parked
      appendEvents(store, "g1", [{ type: "ask.parked", payload: { node: "design", mailId: "mQ" } }]);
      return { text: "asked, stopping", costUsd: 0, numTurns: 1 };
    });
    await runAttempt(goal(), SPEC(), 1, deps);
    expect(journalTypes(store).filter((t) => t === "node.completed")).toHaveLength(0);
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({ outcome: "ok" });
  });
});

describe("isApiErrorOutput", () => {
  it("matches the whole SDK API Error envelope family", () => {
    expect(isApiErrorOutput("API Error: Connection closed mid-response. The response above may be incomplete.")).toBe(true);
    expect(isApiErrorOutput("API Error: Unable to connect to API (ConnectionRefused)")).toBe(true);
    expect(isApiErrorOutput("\n  API Error: Unable to connect to API (ConnectionRefused)\n")).toBe(true);
  });

  it("does NOT match an agent writing about connection failures in a real report", () => {
    // This is the false positive that would pause a healthy goal.
    expect(isApiErrorOutput(
      "The test suite fails because the client gets ConnectionRefused; we were unable to connect to the API in CI.",
    )).toBe(false);
    expect(isApiErrorOutput("Root cause: unable to connect to API when DNS is cold.")).toBe(false);
  });

  it("does not match ordinary agent prose or a session limit", () => {
    expect(isApiErrorOutput("Verification passed. 12 tests, 0 failures.")).toBe(false);
    expect(isApiErrorOutput("You've hit your session limit")).toBe(false);
  });
});

describe("runAgent — unreachable API", () => {
  const DOWN = "API Error: Unable to connect to API (ConnectionRefused)";

  it("retries in place and succeeds when the blip passes", async () => {
    const slept: number[] = [];
    let calls = 0;
    const { deps, goal, store } = harness(async () => {
      calls++;
      return calls < 3 ? { text: DOWN, costUsd: 0, numTurns: 0 } : { text: "the design", costUsd: 0.05, numTurns: 2 };
    });
    deps.sleep = async (ms) => { slept.push(ms); };

    const res = await runAttempt(goal(), SPEC(), 1, deps);

    expect(calls).toBe(3);                       // 1 initial + 2 retries
    expect(slept).toEqual([5_000, 15_000]);      // backoff actually applied, in order
    expect(res.outcome).toBe("ok");
    expect(res.apiUnreachable).toBe(false);
    expect(journalTypes(store)).toContain("node.completed");
  });

  it("gives up after the retries and reports apiUnreachable with the verbatim error", async () => {
    const slept: number[] = [];
    let calls = 0;
    const { deps, goal, store } = harness(async () => { calls++; return { text: DOWN, costUsd: 0, numTurns: 0 }; });
    deps.sleep = async (ms) => { slept.push(ms); };

    const res = await runAttempt(goal(), SPEC(), 1, deps);

    expect(calls).toBe(3);                       // never more than 1 initial + 2 retries
    expect(slept).toEqual([5_000, 15_000]);
    expect(res.apiUnreachable).toBe(true);
    expect(res.outcome).toBe("error");
    const finished = payloadOf(store, "attempt.finished")[0] as { error?: string };
    expect(finished.error).toContain("Unable to connect to API");   // the REAL error, not a paraphrase
  });
});

describe("no-report provenance", () => {
  const VERIFY_SPEC = SPEC({ key: "test", kind: "verify", agent: "argus", critic: "vulcan", maxRounds: 2 });

  it("keeps a snippet of what the agent actually said", async () => {
    // The generic "no structured report" sent an hour of debugging in the wrong direction on
    // goal cab8495e — the evidence existed only in the vault. Carry it in the error.
    const { store, deps, goal } = harness(
      async () => ({ text: "I could not find the test command, so I stopped.", costUsd: 0.01, numTurns: 1 }),
      [VERIFY_SPEC],
    );
    await runAttempt(goal(), VERIFY_SPEC, 1, deps);
    const finished = payloadOf(store, "attempt.finished")[0] as { error?: string };
    expect(finished.error).toContain("no structured report");
    expect(finished.error).toContain("could not find the test command");
  });
});

describe("run nodes reject transport errors and empty output", () => {
  it("an SDK 'Connection closed mid-response' never becomes a done artifact", async () => {
    // facts-macro.md was marked done/ok with EXACTLY this as its whole content (167¢, 13 min),
    // and deck-md then consumed it as a prior artifact. Silent false success.
    const { store, deps, goal } = harness(async () => ({
      text: "API Error: Connection closed mid-response. The response above may be incomplete.",
      costUsd: 0.5, numTurns: 12,
    }));
    deps.sleep = async () => {};
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.apiUnreachable).toBe(true);
    expect(journalTypes(store)).not.toContain("node.completed");
  });

  it("blank output fails the attempt instead of completing the node", async () => {
    const { store, deps, goal } = harness(async () => ({ text: "  \n \t ", costUsd: 0.01, numTurns: 1 }));
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.outcome).toBe("error");
    expect(journalTypes(store)).not.toContain("node.completed");
  });
});

describe("node artifacts never clobber an agent-written file", () => {
  it("keeps the agent's file and writes the node artifact beside it", async () => {
    // clio wrote the real outline to goals/<dir>/deck-outline.md via vault_write, then the
    // worker saved its completion message to the SAME path and destroyed it. Silent data loss.
    const { store, vault, deps, goalDir, goal } = harness(
      async () => ({ text: "`goals/x/design.md` — 18 slides.", costUsd: 0.1, numTurns: 3 }),
    );
    vault.writeNote(`goals/${goalDir}/design.md`, "THE REAL OUTLINE — 18 slides of content");

    await runAttempt(goal(), SPEC(), 1, deps);

    // the agent's file survives untouched…
    expect(vault.readGoalArtifact(goalDir, "design.md")).toContain("THE REAL OUTLINE");
    // …and the node artifact went somewhere else, with the journal pointing at it
    const ref = (payloadOf(store, "node.completed")[0] as { artifactRef: string }).artifactRef;
    expect(ref).not.toBe("design.md");
    expect(vault.readGoalArtifact(goalDir, ref)).toContain("18 slides.");
  });

  it("still overwrites its OWN artifact on a re-run, so retries do not proliferate files", async () => {
    const { store, vault, deps, goalDir, goal } = harness(
      async () => ({ text: "second pass output", costUsd: 0.1, numTurns: 1 }),
    );
    // a prior attempt's artifact carries this node's frontmatter
    vault.writeGoalArtifact(goalDir, "design.md", "first pass output", { goal: "g1", node: "design", role: "athena" });

    await runAttempt(goal(), SPEC(), 1, deps);

    expect(vault.readGoalArtifact(goalDir, "design.md")).toContain("second pass output");
    expect((payloadOf(store, "node.completed")[0] as { artifactRef: string }).artifactRef).toBe("design.md");
  });
});

describe("agents are told where their goal folder is", () => {
  it("puts the vault goal-folder path and vault_read in the brief", async () => {
    // clio searched the filesystem from cwd, concluded deck-full.md did not exist, and refused
    // to fabricate — while the file sat in the vault and clio had vault_read all along.
    const briefs: string[] = [];
    const { deps, goal, goalDir } = harness(async (_r, brief) => {
      briefs.push(brief);
      return { text: "done", costUsd: 0.01, numTurns: 1 };
    });
    await runAttempt(goal(), SPEC(), 1, deps);
    expect(briefs[0]).toContain(`goals/${goalDir}/`);
    expect(briefs[0]).toContain("vault_read");
  });
});

describe("run nodes demand a work report", () => {
  it("passes WORK_REPORT_SCHEMA to the agent on a run node", async () => {
    let seen: unknown;
    const { deps, goal } = harness(async (_r, _b, opts) => {
      seen = (opts as { outputSchema?: unknown }).outputSchema;
      return { text: "the design", costUsd: 0.01, numTurns: 1 };
    });
    await runAttempt(goal(), SPEC(), 1, deps);
    // toBe(WORK_REPORT_SCHEMA) alone passes vacuously before the const exists — both sides are
    // undefined. Pin the shape too, so this test can only pass for the right reason.
    expect((seen as { properties?: Record<string, unknown> })?.properties).toHaveProperty("completed");
    expect(seen).toBe(WORK_REPORT_SCHEMA);
  });

  it("completed:false fails the attempt with the blockers, and never completes the node", async () => {
    // Goal c03a3bda, verbatim: clio reported "I could not apply any fixes — the target files do
    // not exist" and the engine journaled outcome:ok + node.completed. Twice.
    const { store, deps, goal } = harness(async () => ({
      text: "I could not apply any fixes — the target files do not exist and I have exhausted the tool budget locating them.",
      structured: { completed: false, summary: "blocked", blockers: ["deck-full.md does not exist", "Bash is not in my allowlist"] },
      costUsd: 0.15, numTurns: 10,
    }));
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.outcome).toBe("error");
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({
      outcome: "error",
      error: "did not complete: deck-full.md does not exist; Bash is not in my allowlist",
    });
    expect(journalTypes(store)).not.toContain("node.completed");
  });

  it("completed:false with no blockers falls back to the summary, then to a fixed string", async () => {
    const { store, deps, goal } = harness(async () => ({
      text: "I can't do this — the premise is wrong.",
      structured: { completed: false, summary: "the premise is wrong", blockers: [] },
      costUsd: 0.1, numTurns: 6,
    }));
    await runAttempt(goal(), SPEC(), 1, deps);
    expect(payloadOf(store, "attempt.finished")[0]).toMatchObject({
      error: "did not complete: the premise is wrong",
    });

    const bare = harness(async () => ({
      text: "nope", structured: { completed: false }, costUsd: 0.1, numTurns: 1,
    }));
    await runAttempt(bare.goal(), SPEC(), 1, bare.deps);
    expect(payloadOf(bare.store, "attempt.finished")[0]).toMatchObject({
      error: "did not complete: no reason given",
    });
  });

  it("completed:true saves res.text byte-identically — the report never reaches the artifact", async () => {
    const { store, vault, deps, goalDir, goal } = harness(async () => ({
      text: "# The design\n\nThree layers.",
      structured: { completed: true, summary: "wrote the design", blockers: [] },
      costUsd: 0.05, numTurns: 2,
    }));
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.outcome).toBe("ok");
    const ref = (payloadOf(store, "node.completed")[0] as { artifactRef: string }).artifactRef;
    const saved = vault.readGoalArtifact(goalDir, ref)!;
    expect(saved).toContain("# The design\n\nThree layers.");
    expect(saved).not.toContain("wrote the design");
  });

  it("no structured report completes the node (lenient) and logs which node did so", async () => {
    const lines: string[] = [];
    const { store, deps, goal } = harness(async () => ({ text: "the design", costUsd: 0.05, numTurns: 2 }));
    deps.log = (l) => lines.push(l);
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.outcome).toBe("ok");
    expect(journalTypes(store)).toContain("node.completed");
    expect(lines.join("\n")).toContain("design: no work report (agent athena)");
  });

  it("a foreign structured shape completes the node — the test is === false, not falsy", async () => {
    // argus carries outputSchema: test-report and minos carries verdict (runner.ts:142 lets the
    // manifest win), so a run node using either returns an object with no `completed` key. Under
    // `!rep.completed` that would error a node whose work was fine — strictly worse than the hole.
    const { store, deps, goal } = harness(async () => ({
      text: "reviewed it",
      structured: { verdict: "approve", summary: "looks right", reasons: [] },
      costUsd: 0.05, numTurns: 2,
    }));
    const res = await runAttempt(goal(), SPEC(), 1, deps);
    expect(res.outcome).toBe("ok");
    expect(journalTypes(store)).toContain("node.completed");
  });

  it("a retry after completed:false carries the blockers into the brief", async () => {
    const briefs: string[] = [];
    const { store, deps, goal } = harness(async (_r, brief) => {
      briefs.push(brief);
      return { text: "done now", structured: { completed: true, summary: "ok", blockers: [] }, costUsd: 0.05, numTurns: 2 };
    });
    appendEvents(store, "g1", [{ type: "attempt.finished", payload: {
      node: "design", attempt: 1, outcome: "error", costCents: 15, turns: 10,
      error: "did not complete: deck-full.md does not exist; Bash is not in my allowlist",
    } }]);

    const res = await runAttempt(goal(), SPEC(), 2, deps);
    expect(res.outcome).toBe("ok");
    expect(briefs[0]).toContain("previous attempt reported it could not complete");
    expect(briefs[0]).toContain("deck-full.md does not exist; Bash is not in my allowlist");
    expect(briefs[0]).not.toContain("did not complete:"); // the prefix is ours, not the agent's
  });

  it("a retry after an unrelated error carries nothing extra", async () => {
    // lastError also holds timeouts and wall-clock messages. "Goal wall-time budget exceeded" is
    // always the last symptom, never a cause — feeding it to an agent as a blocker is misdirection.
    for (const priorError of ["timeout", "Goal wall-time budget exceeded", "Specialist clio failed: error_max_turns"]) {
      const briefs: string[] = [];
      const { store, deps, goal } = harness(async (_r, brief) => {
        briefs.push(brief);
        return { text: "done", structured: { completed: true, summary: "ok", blockers: [] }, costUsd: 0.01, numTurns: 1 };
      });
      appendEvents(store, "g1", [{ type: "attempt.finished", payload: {
        node: "design", attempt: 1, outcome: "error", costCents: 0, turns: 0, error: priorError,
      } }]);

      await runAttempt(goal(), SPEC(), 2, deps);
      expect(briefs[0]).not.toContain("previous attempt");
      expect(briefs[0]).not.toContain(priorError);
    }
  });

  it("a reopened run node carries the human guidance in its brief", async () => {
    const briefs: string[] = [];
    const { store, deps, goal } = harness(async (_r, brief) => {
      briefs.push(brief);
      return { text: "recovered", structured: { completed: true, summary: "ok", blockers: [] }, costUsd: 0.01, numTurns: 1 };
    });
    appendEvents(store, "g1", [
      { type: "attempt.finished", payload: { node: "design", attempt: 1, outcome: "error", costCents: 0, turns: 1, error: "boom" } },
      { type: "attempt.finished", payload: { node: "design", attempt: 2, outcome: "error", costCents: 0, turns: 1, error: "boom" } },
      { type: "node.failed", payload: { node: "design", error: "boom" } },
      { type: "goal.failed", payload: { error: "node design failed: boom" } },
      { type: "goal.reopened", payload: { by: "user", guidance: "the missing file now exists — use vault_read" } },
    ]);

    const res = await runAttempt(goal(), SPEC(), 3, deps);
    expect(res.outcome).toBe("ok");
    expect(briefs[0]).toContain("# User guidance (from review) — follow this");
    expect(briefs[0]).toContain("the missing file now exists — use vault_read");
  });
});
