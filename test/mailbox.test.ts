// test/mailbox.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { Mailbox } from "../src/mail/mailbox.js";
import type { AiosEvent } from "../src/events.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "mb-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  const fin = join(agentsDir, "finance");
  mkdirSync(eng, { recursive: true });
  mkdirSync(fin, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  const agent = (name: string, extra = "") =>
    `name: ${name}\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n${extra}`;
  writeFileSync(join(eng, "athena.yaml"), agent("athena"));
  writeFileSync(join(eng, "vulcan.yaml"), agent("vulcan", "aliases: [developer]\n"));
  writeFileSync(join(fin, "department.yaml"),
    "department: finance\nmission: Money.\nlead: midas\nmemoDomain: money\nplaybooks: []\nprivateMemo: true\n");
  writeFileSync(join(fin, "midas.yaml"),
    "name: midas\ntitle: CFO\ndepartment: finance\ncharter: c.\npersona: p.\nprompt: x.\ntools: []\nvisibility: private\n");
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();
const PRIMARY = { channel: "telegram", chatId: "1" };
const CTX = { from: "athena", origin: PRIMARY, goalDepth: 0 };

function mail(over: Partial<import("../src/store/db.js").MailRow> = {}) {
  return {
    id: over.id ?? "m1", from_agent: over.from_agent ?? "vulcan", to_agent: over.to_agent ?? "athena",
    kind: over.kind ?? "request", body: over.body ?? "b", goal_id: over.goal_id ?? null,
    origin_channel: "telegram", origin_chat_id: "1", chain_depth: over.chain_depth ?? 0,
    status: over.status ?? "queued", error: null, thread_id: over.thread_id, in_reply_to: over.in_reply_to,
  };
}

function harness(over: Partial<ConstructorParameters<typeof Mailbox>[0]> = {}) {
  const store = new Store(":memory:");
  const events: AiosEvent[] = [];
  let queued = 0;
  const mb = new Mailbox({
    store, registry, maxDepth: 2, disabled: false, primaryChat: PRIMARY,
    onEvent: (e) => events.push(e), onQueued: () => queued++, ...over,
  });
  return { store, mb, events, queuedCount: () => queued };
}

describe("Mailbox.send", () => {
  it("queues a request (alias canonicalized), emits mail.sent, fires onQueued", () => {
    const { store, mb, events, queuedCount } = harness();
    const out = mb.send(CTX, { to: "developer", kind: "request", body: "build X" });
    expect(out).toContain("vulcan");
    const m = store.queuedRequests()[0];
    expect(m).toMatchObject({ from_agent: "athena", to_agent: "vulcan", chain_depth: 1, status: "queued" });
    expect(events[0]).toMatchObject({ type: "mail.sent", from: "athena", to: "vulcan", kind: "request" });
    expect(queuedCount()).toBe(1);
  });

  it("notes land unread and do not fire onQueued", () => {
    const { store, mb, queuedCount } = harness();
    mb.send(CTX, { to: "vulcan", kind: "note", body: "fyi" });
    expect(store.unreadMailFor("vulcan").length).toBe(1);
    expect(queuedCount()).toBe(0);
  });

  it("refuses: unknown recipient, self-send, disabled", () => {
    const { mb, store } = harness();
    expect(mb.send(CTX, { to: "nobody", kind: "note", body: "x" })).toContain("Unknown");
    expect(mb.send(CTX, { to: "athena", kind: "note", body: "x" })).toContain("yourself");
    const off = harness({ disabled: true });
    expect(off.mb.send(CTX, { to: "vulcan", kind: "note", body: "x" })).toContain("disabled");
    expect(store.listMail().length).toBe(0);
  });

  it("private recipient walled: refused from shared origin, fail-closed without primaryChat, allowed from primary", () => {
    const { mb } = harness();
    const shared = { ...CTX, origin: { channel: "telegram", chatId: "999" } };
    expect(mb.send(shared, { to: "midas", kind: "request", body: "x" })).toContain("private");
    const noPrimary = harness({ primaryChat: undefined });
    expect(noPrimary.mb.send(CTX, { to: "midas", kind: "request", body: "x" })).toContain("private");
    const ok = harness();
    expect(ok.mb.send(CTX, { to: "midas", kind: "request", body: "x" })).toContain("midas");
  });

  it("chain_depth = goalDepth + 1", () => {
    const { store, mb } = harness();
    mb.send({ ...CTX, goalDepth: 2 }, { to: "vulcan", kind: "request", body: "x" });
    expect(store.queuedRequests()[0].chain_depth).toBe(3);
  });
});

describe("Mailbox.ask", () => {
  const GCTX = { from: "athena", origin: PRIMARY, goalDepth: 0, goalId: "g1", nodeKey: "task" };

  function withGoal(store: Store) {
    store.insertGoal({
      id: "g1", slug: "g1", title: "t", request: "r", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "running", project_dir: null,
      goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, error: null,
    });
  }

  it("queues a request, parks the caller's goal, fires onQueued", () => {
    const { store, mb, queuedCount } = harness();
    withGoal(store);
    const out = mb.ask(GCTX, { to: "vulcan", question: "which framework?" });
    expect(out).toContain("pause");
    const m = store.queuedRequests()[0];
    expect(m).toMatchObject({ from_agent: "athena", to_agent: "vulcan", kind: "request", chain_depth: 1 });
    expect(store.getGoal("g1")).toMatchObject({ status: "awaiting-mail", awaiting_mail: m.id });
    expect(queuedCount()).toBe(1);
  });

  it("refuses outside a goal, unknown recipient (no park), and a second ask while parked", () => {
    const { store, mb } = harness();
    withGoal(store);
    expect(mb.ask({ from: "athena", origin: PRIMARY, goalDepth: 0 }, { to: "vulcan", question: "q" }))
      .toContain("only works inside a goal");
    expect(mb.ask(GCTX, { to: "ghost", question: "q" })).toContain("Unknown recipient");
    expect(store.getGoal("g1")!.status).toBe("running");           // unknown recipient did NOT park
    mb.ask(GCTX, { to: "vulcan", question: "first" });             // parks
    expect(mb.ask(GCTX, { to: "vulcan", question: "second" })).toContain("pending question");
  });

  it("inherits thread_id from a mail-spawned goal", () => {
    const { store, mb } = harness();
    store.insertMail(mail({ id: "lead", to_agent: "athena", thread_id: "lead" }));
    store.insertGoal({
      id: "g1", slug: "g1", title: "t", request: "r", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "running", project_dir: null,
      goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, error: null,
      spawned_by_mail: "lead",
    });
    mb.ask(GCTX, { to: "vulcan", question: "q" });
    expect(store.queuedRequests()[0].thread_id).toBe("lead");
  });

  it("marks the asking node done at park (so a late run reject can't re-run it)", () => {
    const { store, mb } = harness();
    withGoal(store);
    store.insertNodes("g1", [{ node_key: "task", type: "run", agent: "athena", critic: null,
      brief: "b", depends_on: [], max_rounds: 1 }]);
    mb.ask(GCTX, { to: "vulcan", question: "q" });
    expect(store.listNodes("g1").find((n) => n.node_key === "task")!.status).toBe("done");
  });

  it("refuses when the mailbox is disabled, before the goal check", () => {
    const { store, mb } = harness({ disabled: true });
    withGoal(store);
    expect(mb.ask({ from: "athena", origin: PRIMARY, goalDepth: 0 }, { to: "vulcan", question: "q" }))
      .toContain("disabled");
  });
});

describe("ask_mail → user", () => {
  // helper: a running goal g1 with one node "ask" (mirror the file's existing ask-test setup)
  function goalFixture(store: Store) {
    store.insertGoal({
      id: "g1", slug: "g1", title: "T", request: "r", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "running", project_dir: null,
      goal_dir: null, plan_summary: "graph", replans_used: 0, chain_depth: 0, error: null,
    });
    store.insertNodes("g1", [{ node_key: "ask", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: [], max_rounds: 1 }]);
  }

  it("each user alias parks the goal with an awaiting-human request", () => {
    for (const alias of ["user", "you", "me", "owner", "principal", "You "]) {
      const { store, mb } = harness();
      goalFixture(store);
      const out = mb.ask({ from: "vulcan", origin: PRIMARY, goalDepth: 1, goalId: "g1", nodeKey: "ask" },
        { to: alias, question: "which vendor?" });
      expect(out).toContain("Question sent to you");
      const m = store.pendingUserAsks()[0];
      expect(m.to_agent).toBe("user");
      expect(m.status).toBe("awaiting-human");
      expect(m.chain_depth).toBe(2);            // goalDepth+1
      expect(m.thread_id).toBe(m.id);            // fresh thread (goal not mail-spawned)
      expect(store.getGoal("g1")!.status).toBe("awaiting-mail");
      expect(store.getGoal("g1")!.awaiting_mail).toBe(m.id);
      expect(store.listNodes("g1").find((n) => n.node_key === "ask")!.status).toBe("done");
    }
  });

  it("user-ask emits mail.asked_user and does NOT call onQueued", () => {
    const { store, mb, events, queuedCount } = harness();
    goalFixture(store);
    mb.ask({ from: "vulcan", origin: PRIMARY, goalDepth: 0, goalId: "g1", nodeKey: "ask" },
      { to: "you", question: "q?" });
    expect(events.some((e) => e.type === "mail.asked_user" && e.from === "vulcan" && e.goalId === "g1")).toBe(true);
    expect(queuedCount()).toBe(0);
  });

  it("a private agent CAN ask the user from any origin (no wall on the owner)", () => {
    const { store, mb } = harness();
    goalFixture(store);
    const out = mb.ask({ from: "midas", origin: { channel: "web", chatId: "ui" }, goalDepth: 0, goalId: "g1", nodeKey: "ask" },
      { to: "user", question: "budget?" });
    expect(out).toContain("Question sent to you");
    expect(store.pendingUserAsks()).toHaveLength(1);
  });

  it("user-ask refuses outside a goal, when disabled, and when already parked", () => {
    const { mb: disabled } = harness({ disabled: true });
    expect(disabled.ask({ from: "vulcan", origin: PRIMARY, goalDepth: 0, goalId: "g1" }, { to: "user", question: "q" }))
      .toContain("disabled");
    const { store, mb } = harness();
    goalFixture(store);
    expect(mb.ask({ from: "vulcan", origin: PRIMARY, goalDepth: 0 }, { to: "user", question: "q" }))
      .toContain("only works inside a goal");
    mb.ask({ from: "vulcan", origin: PRIMARY, goalDepth: 0, goalId: "g1", nodeKey: "ask" }, { to: "user", question: "q1" });
    expect(mb.ask({ from: "vulcan", origin: PRIMARY, goalDepth: 0, goalId: "g1" }, { to: "user", question: "q2" }))
      .toContain("already have a pending question");
  });

  it("user-ask inside a mail-spawned goal continues the incoming thread", () => {
    const { store, mb } = harness();
    store.insertMail({
      id: "m0", from_agent: "athena", to_agent: "vulcan", kind: "request", body: "b",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1,
      status: "spawned", error: null, thread_id: "t-root",
    });
    store.insertGoal({
      id: "g2", slug: "g2", title: "T", request: "r", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "running", project_dir: null,
      goal_dir: null, plan_summary: "mail:m0", replans_used: 0, chain_depth: 1, error: null,
      spawned_by_mail: "m0",
    });
    store.insertNodes("g2", [{ node_key: "task", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: [], max_rounds: 1 }]);
    mb.ask({ from: "vulcan", origin: PRIMARY, goalDepth: 1, goalId: "g2", nodeKey: "task" },
      { to: "user", question: "q?" });
    expect(store.pendingUserAsks()[0].thread_id).toBe("t-root");
  });
});

describe("Mailbox.peekInbound + markDelivered", () => {
  it("renders unread inbound + own refusals, truncates, caps at 5; peek alone does NOT mark read", () => {
    const { store, mb } = harness();
    for (let i = 0; i < 5; i++) {
      store.insertMail({
        id: `n${i}`, from_agent: "athena", to_agent: "vulcan", kind: "note", body: "y".repeat(600),
        goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "unread", error: null,
      });
    }
    store.insertMail({
      id: "r1", from_agent: "vulcan", to_agent: "midas", kind: "request", body: "z",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "999", chain_depth: 1, status: "refused", error: "private wall",
    });
    const { block, ids } = mb.peekInbound("vulcan");
    expect(block).toContain("# Mail");
    expect(block).toContain("from athena");
    expect(block).not.toContain("y".repeat(501));   // truncated at 500
    expect(block).not.toContain("refused");          // cap 5 hit by the unread notes first
    expect(ids).toHaveLength(5);
    expect(store.unreadMailFor("vulcan")).toHaveLength(5); // NOT marked — commit is deferred to markDelivered

    mb.markDelivered(ids);
    expect(store.unreadMailFor("vulcan")).toEqual([]);     // now committed
    // second peek now surfaces the refusal ack
    const second = mb.peekInbound("vulcan");
    expect(second.block).toContain("your request to midas was refused: private wall");
    mb.markDelivered(second.ids);
    expect(mb.peekInbound("vulcan").block).toBe("");       // everything acked
  });

  it("peek without deliver is crash-safe: mail survives repeated peeks until delivered", () => {
    const { store, mb } = harness();
    store.insertMail({
      id: "n1", from_agent: "athena", to_agent: "vulcan", kind: "note", body: "heads up",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "unread", error: null,
    });
    mb.peekInbound("vulcan"); // simulate a run that crashed after injection — no markDelivered
    mb.peekInbound("vulcan");
    expect(store.unreadMailFor("vulcan")).toHaveLength(1); // still deliverable — the whole point
    mb.markDelivered(mb.peekInbound("vulcan").ids);
    expect(store.unreadMailFor("vulcan")).toEqual([]);
  });

  it("markDelivered([]) is a harmless no-op", () => {
    const { mb } = harness();
    expect(() => mb.markDelivered([])).not.toThrow();
  });

  it("markDelivered emits mail.read with the committed ids; empty is silent (M6)", () => {
    const { store, mb, events } = harness();
    store.insertMail({
      id: "n1", from_agent: "athena", to_agent: "vulcan", kind: "note", body: "heads up",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "unread", error: null,
    });
    const { ids } = mb.peekInbound("vulcan");
    mb.markDelivered(ids);
    expect(events).toContainEqual({ type: "mail.read", ids });
    events.length = 0;
    mb.markDelivered([]);
    expect(events).toEqual([]);
  });

  it("markDelivered is idempotent — a double commit of the same ids is harmless", () => {
    const { store, mb } = harness();
    store.insertMail({
      id: "n1", from_agent: "athena", to_agent: "vulcan", kind: "note", body: "hi",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "unread", error: null,
    });
    mb.markDelivered(["n1"]);
    expect(() => mb.markDelivered(["n1"])).not.toThrow(); // e.g. resumable retry firing onSuccess twice
    expect(store.getMail("n1")!.status).toBe("read");
    expect(store.unreadMailFor("vulcan")).toEqual([]);
  });

  it("disabled mailbox injects nothing (M5)", () => {
    const { store, mb } = harness({ disabled: true });
    store.insertMail({
      id: "n1", from_agent: "athena", to_agent: "vulcan", kind: "note", body: "heads up",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "unread", error: null,
    });
    const { block, ids } = mb.peekInbound("vulcan");
    expect(block).toBe("");
    expect(ids).toEqual([]);
  });
});
