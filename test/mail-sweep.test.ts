// test/mail-sweep.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type MailRow, type GoalRow } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { GoalEngine, MAIL_PREFIX, type Planner } from "../src/engine/goals.js";
import { SpendGuard } from "../src/engine/budget.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "ms-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  const fin = join(agentsDir, "finance");
  mkdirSync(eng, { recursive: true });
  mkdirSync(fin, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  const agent = (name: string) =>
    `name: ${name}\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n`;
  writeFileSync(join(eng, "athena.yaml"), agent("athena"));
  writeFileSync(join(eng, "vulcan.yaml"), agent("vulcan"));
  writeFileSync(join(fin, "department.yaml"),
    "department: finance\nmission: Money.\nlead: midas\nmemoDomain: money\nplaybooks: []\nprivateMemo: true\n");
  writeFileSync(join(fin, "midas.yaml"),
    "name: midas\ntitle: CFO\ndepartment: finance\ncharter: c.\npersona: p.\nprompt: x.\ntools: []\nvisibility: private\n");
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();
const PRIMARY = { channel: "telegram", chatId: "1" };

function reqMail(over: Partial<MailRow> = {}): Omit<MailRow, "created_at" | "read_at"> {
  return {
    id: over.id ?? "m1", from_agent: "athena", to_agent: "vulcan", kind: "request",
    body: "summarize WAL tuning", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
    chain_depth: 1, status: "queued", error: null, ...over,
  } as Omit<MailRow, "created_at" | "read_at">;
}

function harness(run: SpecialistRunFn, capUsd?: number, planner?: Planner, opts?: { mailDisabled?: boolean }) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "ms-vault-")), "AIOS");
  if (capUsd !== undefined) store.budgetAdd(new Date().toISOString().slice(0, 10), Math.round(capUsd * 100));
  const onComplete = vi.fn(async () => {});
  const prepareSandbox = vi.fn(async () => ({ taskDir: "/tmp/should-not-be-used", mode: "build" as const }));
  const engine = new GoalEngine({
    store, vault, run, registry,
    playbooks: new Map(), wallTimeMs: 60_000, maxConcurrentNodes: 2,
    spendGuard: new SpendGuard({ store, capUsd }),
    onComplete,
    resolveDeptFor: () => undefined,
    prepareSandbox,
    primaryChat: PRIMARY,
    mailMaxDepth: 2,
    mailDisabled: opts?.mailDisabled,
    planner,
  });
  return { store, vault, engine, onComplete, prepareSandbox };
}

const okRun: SpecialistRunFn = async (_r, brief) => {
  return { text: `done: ${brief.slice(0, 20)}`, costUsd: 0.01, numTurns: 1 };
};

// A two-node graph, mirroring production: startPlannedGoal with the mail's provenance, no workspace.
const graphPlanner = (): Planner => ({
  plan: async () => { throw new Error("unused"); },
  replan: async () => {},
  planFromMail: async (engine, params, mail): Promise<GoalRow> => engine.startPlannedGoal({
    title: params.title, request: params.request, department: params.department, lead: "athena",
    origin: { channel: params.channel, chatId: params.chatId }, summary: "graph plan",
    nodes: [
      { node_key: "n1", type: "run", agent: "athena", critic: null, brief: "b", depends_on: [], max_rounds: 1 },
      { node_key: "n2", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: ["n1"], max_rounds: 1 },
    ],
    needsWorkspace: "none", spawnedByMail: mail.id, chainDepth: mail.chain_depth,
  }),
});

const flush = () => new Promise((r) => setTimeout(r, 50));

describe("mail sweep", () => {
  it("queued request spawns a single-node goal and reports back on completion (no chat ping)", async () => {
    const { store, engine, onComplete } = harness(okRun);
    store.insertMail(reqMail());
    engine.pump();
    await flush();
    const m = store.getMail("m1")!;
    expect(m.status).toBe("spawned");
    const goal = store.getGoal(m.goal_id!)!;
    expect(goal).toMatchObject({ department: "engineering", lead: "athena", chain_depth: 1 });
    expect(goal.plan_summary).toBe(`${MAIL_PREFIX}m1`);
    const nodes = store.listNodes(goal.id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ node_key: "task", type: "run", agent: "vulcan", status: "done" });
    // report mailed back to sender; origin chat NOT pinged
    const report = store.unreadMailFor("athena")[0];
    expect(report).toMatchObject({ kind: "report", from_agent: "vulcan", goal_id: goal.id });
    expect(report.body).toContain("Done");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("depth over cap downgrades to note; nothing spawns", async () => {
    const { store, engine } = harness(okRun);
    store.insertMail(reqMail({ chain_depth: 3 }));
    engine.pump();
    await flush();
    expect(store.getMail("m1")).toMatchObject({ kind: "note", status: "unread" });
    expect(store.listGoals()).toEqual([]);
  });

  it("budget cap leaves requests queued (drains later via resumeBudgetPaused pump)", async () => {
    const { store, engine } = harness(okRun, 0); // cap $0 → allow() false immediately
    store.insertMail(reqMail());
    engine.pump();
    await flush();
    expect(store.getMail("m1")!.status).toBe("queued");
  });

  it("unknown recipient and private wall refuse (sender-visible only)", async () => {
    const { store, engine } = harness(okRun);
    store.insertMail(reqMail({ id: "m1", to_agent: "nobody" }));
    store.insertMail(reqMail({ id: "m2", to_agent: "midas", origin_chat_id: "999" })); // shared origin
    engine.pump();
    await flush();
    expect(store.getMail("m1")!.status).toBe("refused");
    expect(store.getMail("m2")!.status).toBe("refused");
    expect(store.refusedMailFrom("athena").map((m) => m.id).sort()).toEqual(["m1", "m2"]);
    expect(store.unreadMailFor("midas")).toEqual([]); // walled recipient never sees it
  });

  it("failed mail-goal reports the failure", async () => {
    const failRun: SpecialistRunFn = async () => { throw new Error("agent exploded"); };
    const { store, engine } = harness(failRun);
    store.insertMail(reqMail());
    engine.pump();
    await flush();
    const report = store.unreadMailFor("athena")[0];
    expect(report.kind).toBe("report");
    expect(report.body).toContain("Failed");
  });

  it("mail-goals NEVER get a workspace/sandbox even when prepareSandbox is wired (code enters only via code_task)", async () => {
    const { store, engine, prepareSandbox } = harness(okRun);
    store.insertMail(reqMail());
    engine.pump();
    await flush();
    const goal = store.getGoal(store.getMail("m1")!.goal_id!)!;
    expect(goal.project_dir).toBeNull();
    expect(prepareSandbox).not.toHaveBeenCalled();
  });

  it("single-node mail-goal stamps spawned_by_mail (report-back keys on it)", async () => {
    const { store, engine } = harness(okRun);
    store.insertMail(reqMail()); // to_agent vulcan = specialist → single node
    engine.pump();
    await flush();
    const goal = store.getGoal(store.getMail("m1")!.goal_id!)!;
    expect(goal.spawned_by_mail).toBe("m1");
    expect(goal.plan_summary).toBe(`${MAIL_PREFIX}m1`); // prefix still present (re-plan marker)
    // report still went back to the sender
    expect(store.unreadMailFor("athena")[0]).toMatchObject({ kind: "report", from_agent: "vulcan" });
  });

  it("node runs carry the goal's origin + chain_depth as mailCtx", async () => {
    let seen: unknown;
    const spyRun: SpecialistRunFn = async (_r, _b, opts) => {
      seen = opts.mailCtx;
      return { text: "ok", costUsd: 0, numTurns: 1 };
    };
    const { store, engine } = harness(spyRun);
    store.insertMail(reqMail({ chain_depth: 2 }));
    engine.pump();
    await flush();
    const goal = store.getGoal(store.getMail("m1")!.goal_id!)!;
    expect(seen).toEqual({
      origin: { channel: "telegram", chatId: "1" }, goalDepth: 2, goalId: goal.id, nodeKey: "task",
    });
  });

  it("mail to a dept lead spawns a planned graph and reports back once (no workspace)", async () => {
    const { store, engine, onComplete, prepareSandbox } = harness(okRun, undefined, graphPlanner());
    store.insertMail(reqMail({ from_agent: "vulcan", to_agent: "athena" })); // recipient = engineering lead
    engine.pump();
    await flush();
    const m = store.getMail("m1")!;
    expect(m.status).toBe("spawned");
    const goal = store.getGoal(m.goal_id!)!;
    expect(goal.spawned_by_mail).toBe("m1");
    expect(goal.chain_depth).toBe(1);
    expect(goal.project_dir).toBeNull();
    expect(prepareSandbox).not.toHaveBeenCalled();      // engine gate blocks sandbox on spawned_by_mail
    expect(store.listNodes(goal.id)).toHaveLength(2);
    expect(store.getGoal(goal.id)!.status).toBe("done");
    const reports = store.unreadMailFor("vulcan").filter((x) => x.kind === "report");
    expect(reports).toHaveLength(1);                     // exactly one report at the end, not per node
    expect(onComplete).not.toHaveBeenCalled();           // no origin-chat ping
  });

  it("planner failure refuses the lead-mail; the queue keeps draining", async () => {
    const failPlanner: Planner = {
      plan: async () => { throw new Error("unused"); }, replan: async () => {},
      planFromMail: async () => { throw new Error("no plan"); },
    };
    const { store, engine } = harness(okRun, undefined, failPlanner);
    store.insertMail(reqMail({ id: "m1", from_agent: "vulcan", to_agent: "athena" })); // lead → graph (fails)
    store.insertMail(reqMail({ id: "m2", from_agent: "athena", to_agent: "vulcan" })); // specialist → single node
    engine.pump();
    await flush();
    expect(store.getMail("m1")!.status).toBe("refused");
    expect(store.getMail("m1")!.error).toContain("no plan");
    expect(store.getMail("m2")!.status).toBe("spawned");
  });

  it("planner failure on a lead request resumes the parked asker (H2)", async () => {
    const failingPlanner = {
      planFromMail: async () => { throw new Error("boom"); },
    } as unknown as Planner;
    // The resume the fix adds re-pumps the asker, which launches its resume node. Hold that node
    // in-flight (never settles) so the un-parked "running" state is observable — otherwise the
    // hand-inserted goal (no goal_dir/pack) would race straight to "failed" before we assert.
    const heldRun: SpecialistRunFn = () => new Promise(() => {});
    const { store, engine } = harness(heldRun, undefined, failingPlanner);
    // Asker goal, parked awaiting m1 (mirrors Mailbox.ask's post-state).
    store.insertGoal({
      id: "gask", slug: "asker", title: "Asker", request: "r", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "running", project_dir: null, goal_dir: null,
      plan_summary: "graph", replans_used: 0, chain_depth: 0, error: null,
    });
    store.insertNodes("gask", [{ node_key: "ask", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: [], max_rounds: 1 }]);
    store.updateNodeStatus("gask", "ask", "done");
    store.parkGoalAwaiting("gask", "m1");
    // Request to the LEAD (graph path).
    store.insertMail(reqMail({ id: "m1", from_agent: "vulcan", to_agent: "athena" }));

    engine.pump();
    // spawnGraphFromMail is async (void-called) — wait for the catch to land.
    await vi.waitFor(() => expect(store.getMail("m1")!.status).toBe("refused"));

    const gask = store.getGoal("gask")!;
    expect(gask.status).toBe("running");           // un-parked
    expect(gask.awaiting_mail).toBeNull();
    const resume = store.listNodes("gask").find((n) => n.node_key === "resume_1")!;
    expect(resume).toBeDefined();
    expect(resume.brief).toContain("Refused: planning failed: boom");
  });

  it("abandoning a mail-spawned goal reports back and resumes the asker (M1)", () => {
    const hangRun: SpecialistRunFn = () => new Promise(() => {}); // node never finishes
    const { store, engine } = harness(hangRun);
    // Asker parked on m1 (same setup as the H2 test).
    store.insertGoal({
      id: "gask", slug: "asker2", title: "Asker", request: "r", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "running", project_dir: null, goal_dir: null,
      plan_summary: "graph", replans_used: 0, chain_depth: 0, error: null,
    });
    store.insertNodes("gask", [{ node_key: "ask", type: "run", agent: "athena", critic: null, brief: "b", depends_on: [], max_rounds: 1 }]);
    store.updateNodeStatus("gask", "ask", "done");
    store.parkGoalAwaiting("gask", "m1");
    store.insertMail(reqMail({ id: "m1", from_agent: "athena", to_agent: "vulcan" }));

    engine.pump(); // spawns vulcan's goal, node hangs
    const spawned = store.listGoals(10).find((g) => g.spawned_by_mail === "m1")!;
    expect(spawned).toBeDefined();

    engine.abandonGoal(spawned.id);

    const report = store.mailAnsweringRequest("m1")!;
    expect(report).toBeDefined();
    expect(report.kind).toBe("report");
    expect(report.body).toContain("abandoned");
    const gask = store.getGoal("gask")!;
    expect(gask.status).toBe("running"); // resumed with the bad news
    expect(store.listNodes("gask").some((n) => n.node_key === "resume_1")).toBe(true);
  });

  it("a lead-mail graph is re-plannable (spawned_by_mail does not block re-plan)", async () => {
    let replans = 0;
    const store2Ref: { store?: Store } = {};
    const rePlanner: Planner = {
      plan: async () => { throw new Error("unused"); },
      async replan(goal, failed) {
        replans++;
        store2Ref.store!.replaceNode(goal.id, failed.node_key,
          { node_key: failed.node_key, type: "run", agent: "athena", critic: null, brief: "retry", depends_on: [], max_rounds: 1 });
      },
      planFromMail: async (engine, params, mail): Promise<GoalRow> => engine.startPlannedGoal({
        title: params.title, request: params.request, department: params.department, lead: "athena",
        origin: { channel: params.channel, chatId: params.chatId }, summary: "graph plan",
        nodes: [{ node_key: "n1", type: "run", agent: "athena", critic: null, brief: "b", depends_on: [], max_rounds: 1 }],
        needsWorkspace: "none", spawnedByMail: mail.id, chainDepth: mail.chain_depth,
      }),
    };
    let calls = 0;
    const flaky: SpecialistRunFn = async () => {
      calls++;
      if (calls <= 2) throw new Error("boom"); // 2 throws (runOnce + retry) => node fails => onNodeFailure
      return { text: "ok", costUsd: 0, numTurns: 1 };
    };
    const { store, engine } = harness(flaky, undefined, rePlanner);
    store2Ref.store = store;
    store.insertMail(reqMail({ from_agent: "vulcan", to_agent: "athena" }));
    engine.pump();
    await vi.waitFor(() => expect(store.getGoal(store.getMail("m1")!.goal_id!)!.status).toBe("done"));
    expect(replans).toBe(1);
  });

  it("two queued single-node requests swept together spawn exactly one goal each (H1)", () => {
    const { store, engine } = harness(okRun);
    store.insertMail(reqMail({ id: "m1", body: "task one" }));
    store.insertMail(reqMail({ id: "m2", body: "task two" }));

    engine.pump(); // single pass sweeps both; spawn is synchronous

    const goals = store.listGoals(10);
    expect(goals).toHaveLength(2); // buggy code re-spawns m2 from the stale snapshot → 3
    expect(goals.filter((g) => g.spawned_by_mail === "m1")).toHaveLength(1);
    expect(goals.filter((g) => g.spawned_by_mail === "m2")).toHaveLength(1);
  });

  it("AIOS_MAIL_DISABLED idles the sweep — queued requests never spawn (M5)", () => {
    const { store, engine } = harness(okRun, undefined, undefined, { mailDisabled: true });
    store.insertMail(reqMail({ id: "m1" }));
    engine.pump();
    expect(store.getMail("m1")!.status).toBe("queued"); // untouched, drains when re-enabled
    expect(store.listGoals(10)).toHaveLength(0);
  });
});

describe("answerUserMail", () => {
  function parkedOnUserAsk(store: Store) {
    store.insertGoal({
      id: "gask", slug: "ask-user", title: "Asker", request: "r", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "running", project_dir: null, goal_dir: null,
      plan_summary: "graph", replans_used: 0, chain_depth: 0, error: null,
    });
    store.insertNodes("gask", [{ node_key: "ask", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: [], max_rounds: 1 }]);
    store.updateNodeStatus("gask", "ask", "done");
    store.insertMail({
      id: "u1", from_agent: "vulcan", to_agent: "user", kind: "request", body: "which vendor?",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1,
      status: "awaiting-human", error: null, thread_id: "u1",
    });
    store.parkGoalAwaiting("gask", "u1");
  }

  it("answers a pending user-ask: report inserted, goal resumed with Q+A", () => {
    const hangRun: SpecialistRunFn = () => new Promise(() => {});
    const { store, engine } = harness(hangRun);
    parkedOnUserAsk(store);
    const res = engine.answerUserMail("u1", "Vendor B, cap $200.");
    expect(res).toEqual({ ok: true });
    const report = store.mailAnsweringRequest("u1")!;
    expect(report.from_agent).toBe("user");
    expect(report.to_agent).toBe("vulcan");
    expect(report.thread_id).toBe("u1");
    const gask = store.getGoal("gask")!;
    expect(gask.status).toBe("running");
    expect(gask.awaiting_mail).toBeNull();
    const resume = store.listNodes("gask").find((n) => n.node_key === "resume_1")!;
    expect(resume.agent).toBe("vulcan");
    expect(resume.brief).toContain("which vendor?");
    expect(resume.brief).toContain("Vendor B, cap $200.");
  });

  it("boot reconcile: answered user-ask resumes, unanswered stays parked", () => {
    const hangRun: SpecialistRunFn = () => new Promise(() => {});
    const { store, engine } = harness(hangRun);
    parkedOnUserAsk(store); // gask awaiting u1, unanswered
    engine.resumeUnfinished();
    expect(store.getGoal("gask")!.status).toBe("awaiting-mail"); // indefinite park is correct
    store.insertMail({
      id: "r-boot", from_agent: "user", to_agent: "vulcan", kind: "report", body: "answered pre-crash",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1,
      status: "unread", error: null, thread_id: "u1", in_reply_to: "u1",
    });
    engine.resumeUnfinished();
    expect(store.getGoal("gask")!.status).toBe("running");
    expect(store.listNodes("gask").some((n) => n.node_key === "resume_1")).toBe(true);
  });

  it("rejects double-answer, unknown id, non-user request, empty text", () => {
    const hangRun: SpecialistRunFn = () => new Promise(() => {});
    const { store, engine } = harness(hangRun);
    parkedOnUserAsk(store);
    expect(engine.answerUserMail("u1", "A.")).toEqual({ ok: true });
    expect(engine.answerUserMail("u1", "again")).toEqual({ ok: false, reason: "already answered" });
    expect(engine.answerUserMail("nope", "x").ok).toBe(false);
    expect(engine.answerUserMail("u1", "  ").ok).toBe(false);
    store.insertMail(reqMail({ id: "m-agent" })); // ordinary agent-addressed request
    expect(engine.answerUserMail("m-agent", "x")).toEqual({ ok: false, reason: "not a pending question" });
  });

  it("answerFromChat: '@agent answer' answers the oldest pending ask; everything else passes through", () => {
    const hangRun: SpecialistRunFn = () => new Promise(() => {});
    const { store, engine } = harness(hangRun);
    parkedOnUserAsk(store); // vulcan asked u1
    expect(engine.answerFromChat("hello no mention")).toBeNull();
    expect(engine.answerFromChat("@athena but athena asked nothing")).toBeNull();
    expect(engine.answerFromChat("@ghost not an agent")).toBeNull();
    const reply = engine.answerFromChat("@vulcan Vendor B.");
    expect(reply).toContain("Answer sent to vulcan");
    expect(store.getGoal("gask")!.status).toBe("running");
    expect(engine.answerFromChat("@vulcan again")).toBeNull(); // nothing pending anymore → normal routing
  });
});
