// test/engine-mail.test.ts — mail integration on the journaled engine.
import { describe, it, expect, vi } from "vitest";
import type { Store } from "../src/store/db.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";
import { harness, plannedGoal } from "./engine-core.test.js";

const queuedMail = (store: Store, over: Record<string, unknown> = {}) => {
  store.insertMail({
    id: "mQ", from_agent: "athena", to_agent: "vulcan", kind: "request", body: "which db?",
    goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
    chain_depth: 1, status: "queued", error: null, ...over,
  } as never);
};

describe("engine mail integration", () => {
  it("sweep spawns a single-node goal from queued request; report mails back; mail marked spawned atomically", async () => {
    const { engine, store } = harness();
    queuedMail(store);
    engine.pump();
    await vi.waitFor(() => expect(store.getMail("mQ")!.status).toBe("spawned"));
    const goal = store.listGoals(10).find((g) => g.spawned_by_mail === "mQ")!;
    await vi.waitFor(() => expect(store.getGoal(goal.id)!.status).toBe("done"));
    const report = store.mailAnsweringRequest("mQ")!;
    expect(report).toMatchObject({ from_agent: "vulcan", to_agent: "athena", kind: "report" });
    expect(report.body).toContain("Done:");
  });

  it("unknown recipient → refused + parked asker resumes with the refusal", async () => {
    const { engine, store } = harness({ maxConcurrentNodes: 0 });
    const g = plannedGoal(engine, [{ key: "task", agent: "athena" }]);
    store.insertMail({ id: "mR", from_agent: "athena", to_agent: "ghost", kind: "request",
      body: "?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "queued", error: null } as never);
    engine.parkFromAsk(g.id, "task", "mR");
    expect(store.getGoal(g.id)!.status).toBe("awaiting-mail");
    engine.pump(); // sweep refuses unknown recipient → resumeFromAnswer
    expect(store.getGoal(g.id)).toMatchObject({ status: "running", awaiting_mail: null });
    const resume = store.listNodes(g.id).find((n) => n.node_key.startsWith("resume_"))!;
    expect(resume.brief).toContain("Refused");
  });

  it("depth cap → downgraded to note + parked asker resumes with Declined", async () => {
    const { engine, store } = harness({ maxConcurrentNodes: 0 }); // mailMaxDepth 2
    const g = plannedGoal(engine, [{ key: "task", agent: "athena" }]);
    store.insertMail({ id: "mD", from_agent: "athena", to_agent: "vulcan", kind: "request",
      body: "?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 3, status: "queued", error: null } as never);
    engine.parkFromAsk(g.id, "task", "mD");
    engine.pump();
    expect(store.getGoal(g.id)).toMatchObject({ status: "running", awaiting_mail: null });
    expect(store.listNodes(g.id).find((n) => n.node_key.startsWith("resume_"))!.brief).toContain("Declined");
    expect(store.getMail("mD")).toMatchObject({ kind: "note", status: "unread" });
  });

  it("answerUserMail resumes a user-parked goal; retargets dependents; double-submit safe", () => {
    const { engine, store } = harness({ maxConcurrentNodes: 0 });
    const g = plannedGoal(engine, [{ key: "task", agent: "athena" }, { key: "after", deps: ["task"] }]);
    store.insertMail({ id: "ask1", from_agent: "athena", to_agent: "user", kind: "request",
      body: "which db?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "awaiting-human", error: null, from_node: "task" } as never);
    engine.parkFromAsk(g.id, "task", "ask1");
    const res = engine.answerUserMail("ask1", "use sqlite");
    expect(res).toEqual({ ok: true });
    expect(store.getGoal(g.id)).toMatchObject({ status: "running", awaiting_mail: null });
    const after = store.listNodes(g.id).find((n) => n.node_key === "after")!;
    expect(JSON.parse(after.depends_on)).toEqual(["resume_1"]); // repointed downstream
    const resume = store.listNodes(g.id).find((n) => n.node_key === "resume_1")!;
    expect(JSON.parse(resume.depends_on)).toEqual(["task"]);    // joins the DAG at the asker
    expect(resume.brief).toContain("use sqlite");
    expect(engine.answerUserMail("ask1", "again").ok).toBe(false);  // double-submit safe
  });

  it("answerFromChat intercepts @agent replies only for pending asks", () => {
    const { engine, store } = harness({ maxConcurrentNodes: 0 });
    const g = plannedGoal(engine, [{ key: "task", agent: "athena" }]);
    store.insertMail({ id: "ask2", from_agent: "athena", to_agent: "user", kind: "request",
      body: "?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "awaiting-human", error: null, from_node: "task" } as never);
    engine.parkFromAsk(g.id, "task", "ask2");
    expect(engine.answerFromChat("@athena use postgres")).toContain("Answer sent");
    expect(engine.answerFromChat("@athena more text")).toBeNull(); // nothing pending now
    expect(engine.answerFromChat("bare message")).toBeNull();
  });

  it("boot reconcile resumes a parked goal whose answer landed while down; others stay parked", () => {
    const { engine, store } = harness({ maxConcurrentNodes: 0 });
    const g = plannedGoal(engine, [{ key: "task", agent: "athena" }]);
    store.insertMail({ id: "mQ2", from_agent: "athena", to_agent: "vulcan", kind: "request",
      body: "?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "spawned", error: null } as never);
    engine.parkFromAsk(g.id, "task", "mQ2");
    store.insertMail({ id: "rep", from_agent: "vulcan", to_agent: "athena", kind: "report",
      body: "Done: sqlite", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "unread", error: null, thread_id: "mQ2", in_reply_to: "mQ2" } as never);
    const g2 = plannedGoal(engine, [{ key: "task", agent: "athena" }]);
    engine.parkFromAsk(g2.id, "task", "mZ"); // no answer for this one
    engine.resumeUnfinished();
    expect(store.getGoal(g.id)!.status).toBe("running");
    expect(store.getGoal(g2.id)!.status).toBe("awaiting-mail");
  });

  it("abandoning a mail-spawned goal still reports back to the asker", async () => {
    const { engine, store } = harness({ maxConcurrentNodes: 0 });
    queuedMail(store);
    engine.pump();
    const goal = store.listGoals(10).find((g) => g.spawned_by_mail === "mQ")!;
    engine.abandonGoal(goal.id);
    const report = store.mailAnsweringRequest("mQ")!;
    expect(report.body).toContain("Failed:");
    expect(report.body).toContain("abandoned by user");
  });

  it("failing sibling on a parked goal fails the goal and clears the ask pointer", async () => {
    let sibStarted!: () => void;
    const started = new Promise<void>((r) => { sibStarted = r; });
    const run: SpecialistRunFn = async (role) => {
      if (role === "vulcan") { sibStarted(); throw new Error("sibling boom"); }
      return { text: "o", costUsd: 0, numTurns: 1 };
    };
    const { engine, store } = harness({ run });
    const g = plannedGoal(engine, [{ key: "ask", agent: "athena" }, { key: "sib", agent: "vulcan" }]);
    await started; // sib attempt in flight — now park (parked goals still retry siblings)
    engine.parkFromAsk(g.id, "ask", "mAsk");
    await vi.waitFor(() => expect(store.getGoal(g.id)!.status).toBe("failed"));
    expect(store.getGoal(g.id)!.awaiting_mail).toBeNull(); // no dangling ask pointer
  });
});
