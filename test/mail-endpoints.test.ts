// test/mail-endpoints.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Store, type MailKind, type MailStatus } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildMailView, buildGoalDetail, buildMailUnread, buildMailThread } from "../src/web/goals-view.js";
import { GoalEngine, MAIL_PREFIX } from "../src/engine/goals.js";
import { SpendGuard } from "../src/engine/budget.js";
import { startWebServer, type WebDeps } from "../src/web/server.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "me-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  mkdirSync(eng, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  writeFileSync(join(eng, "vulcan.yaml"),
    "name: vulcan\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\naliases: [developer]\n");
  writeFileSync(join(eng, "athena.yaml"),
    "name: athena\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n");
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();

describe("buildMailView", () => {
  it("lists mail camelCased, alias-canonicalized filter", () => {
    const store = new Store(":memory:");
    store.insertMail({
      id: "m1", from_agent: "athena", to_agent: "vulcan", kind: "request", body: "x", goal_id: null,
      origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "queued", error: null,
    });
    const all = buildMailView(store, registry);
    expect(all[0]).toMatchObject({ id: "m1", from: "athena", to: "vulcan", chainDepth: 1 });
    expect(buildMailView(store, registry, "developer").length).toBe(1); // alias → vulcan
    expect(buildMailView(store, registry, "athena").length).toBe(1);
    expect(buildMailView(store, registry, "nobody").length).toBe(0);
  });
});

describe("buildMailUnread", () => {
  it("totals + per-agent unread, status='unread' only", () => {
    const store = new Store(":memory:");
    const put = (id: string, to: string, status: MailStatus, kind: MailKind = "note") =>
      store.insertMail({
        id, from_agent: "athena", to_agent: to, kind, body: "x", goal_id: null,
        origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status, error: null,
      });
    put("u1", "vulcan", "unread");
    put("u2", "athena", "unread", "report");
    put("q1", "vulcan", "queued", "request"); // excluded — work, not inbox
    put("rd", "athena", "read");              // excluded — already seen
    expect(buildMailUnread(store)).toEqual({ total: 2, byAgent: { vulcan: 1, athena: 1 }, pendingUser: 0 });
  });

  it("empty store → zero total, empty map, no pending user asks", () => {
    expect(buildMailUnread(new Store(":memory:"))).toEqual({ total: 0, byAgent: {}, pendingUser: 0 });
  });

  it("pendingUser counts unanswered questions addressed to the human", () => {
    const store = new Store(":memory:");
    store.insertMail({
      id: "ask1", from_agent: "vulcan", to_agent: "user", kind: "request", body: "which vendor?",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1,
      status: "awaiting-human", error: null, thread_id: "ask1",
    });
    expect(buildMailUnread(store).pendingUser).toBe(1);
    // Answering it (a report carrying in_reply_to) makes it no longer pending — answered-ness is derived.
    store.insertMail({
      id: "ans1", from_agent: "user", to_agent: "vulcan", kind: "report", body: "Vendor B.",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1,
      status: "unread", error: null, thread_id: "ask1", in_reply_to: "ask1",
    });
    expect(buildMailUnread(store).pendingUser).toBe(0);
  });
});

describe("goal detail spawnedBy", () => {
  it("mail-spawned goal exposes provenance; normal goal null", () => {
    const store = new Store(":memory:");
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "me-vault-")), "AIOS");
    store.insertMail({
      id: "m1", from_agent: "athena", to_agent: "vulcan", kind: "request", body: "x", goal_id: "g1",
      origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "spawned", error: null,
    });
    store.insertGoal({
      id: "g1", slug: "x", title: "X", request: "x", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "done", project_dir: null, goal_dir: null,
      plan_summary: `${MAIL_PREFIX}m1`, replans_used: 0, error: null, chain_depth: 1,
      spawned_by_mail: "m1",
    });
    store.insertGoal({
      id: "g2", slug: "y", title: "Y", request: "y", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "done", project_dir: null, goal_dir: null,
      plan_summary: "planned", replans_used: 0, error: null, chain_depth: 0,
    });
    expect(buildGoalDetail(store, vault, "g1")!.spawnedBy).toEqual({ mailId: "m1", from: "athena" });
    expect(buildGoalDetail(store, vault, "g2")!.spawnedBy).toBeNull();
  });

  it("buildMailThread returns the conversation oldest-first", () => {
    const store = new Store(":memory:");
    store.insertMail({ id: "root", from_agent: "athena", to_agent: "vulcan", kind: "request",
      body: "which db?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "spawned", error: null, thread_id: "root", in_reply_to: null });
    store.insertMail({ id: "rep", from_agent: "vulcan", to_agent: "athena", kind: "report",
      body: "Done: sqlite", goal_id: "g", origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "unread", error: null, thread_id: "root", in_reply_to: "root" });
    expect(buildMailThread(store, "root").map((m) => m.id)).toEqual(["root", "rep"]);
    expect(buildMailThread(store, "nope")).toEqual([]);
  });
});

describe("goal detail awaitingUserAsk", () => {
  function parkedGoal(store: Store, goalId: string, mailId: string) {
    store.insertGoal({
      id: goalId, slug: goalId, title: "Asker", request: "r", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "running", project_dir: null, goal_dir: null,
      plan_summary: "graph", replans_used: 0, error: null, chain_depth: 0,
    });
    store.insertMail({
      id: mailId, from_agent: "vulcan", to_agent: "user", kind: "request", body: "which db?",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1,
      status: "awaiting-human", error: null, thread_id: mailId,
    });
    store.parkGoalAwaiting(goalId, mailId);
  }

  it("exposes an unanswered user-ask; null once answered; null when not parked", () => {
    const store = new Store(":memory:");
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "me-vault-")), "AIOS");
    parkedGoal(store, "gask2", "u2");
    expect(buildGoalDetail(store, vault, "gask2")!.awaitingUserAsk)
      .toEqual({ mailId: "u2", question: "which db?", from: "vulcan" });

    // Answering the ask (report carrying in_reply_to) clears the pending flag — derived, not stored.
    store.insertMail({
      id: "ansU2", from_agent: "user", to_agent: "vulcan", kind: "report", body: "sqlite",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1,
      status: "unread", error: null, thread_id: "u2", in_reply_to: "u2",
    });
    expect(buildGoalDetail(store, vault, "gask2")!.awaitingUserAsk).toBeNull();

    // A goal not parked on a user-ask has no pending question.
    store.insertGoal({
      id: "gplain", slug: "gplain", title: "Y", request: "y", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "done", project_dir: null, goal_dir: null,
      plan_summary: "planned", replans_used: 0, error: null, chain_depth: 0,
    });
    expect(buildGoalDetail(store, vault, "gplain")!.awaitingUserAsk).toBeNull();
  });
});

/** Spins the real web server (token-gated) so the answer route is exercised over HTTP, with a real
 *  GoalEngine seeded exactly like the engine's `parkedOnUserAsk` fixture. */
const TOKEN = "test-ui-token";
const hangRun: SpecialistRunFn = () => new Promise(() => {});

function parkedOnUserAsk(store: Store, goalId: string, mailId: string) {
  store.insertGoal({
    id: goalId, slug: goalId, title: "Asker", request: "r", department: "engineering", lead: "athena",
    origin_channel: "telegram", origin_chat_id: "1", status: "running", project_dir: null, goal_dir: null,
    plan_summary: "graph", replans_used: 0, chain_depth: 0, error: null,
  });
  store.insertNodes(goalId, [{ node_key: "ask", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: [], max_rounds: 1 }]);
  store.updateNodeStatus(goalId, "ask", "done");
  store.insertMail({
    id: mailId, from_agent: "vulcan", to_agent: "user", kind: "request", body: "which vendor?",
    goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1,
    status: "awaiting-human", error: null, thread_id: mailId,
  });
  store.parkGoalAwaiting(goalId, mailId);
}

async function spinServer(store: Store) {
  const prev = process.env.AIOS_UI_TOKEN;
  process.env.AIOS_UI_TOKEN = TOKEN;
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "me-http-vault-")), "AIOS");
  const engine = new GoalEngine({
    store, vault, run: hangRun, registry,
    playbooks: new Map(), wallTimeMs: 60_000, maxConcurrentNodes: 2,
    spendGuard: new SpendGuard({ store }),
    onComplete: async () => {},
    resolveDeptFor: () => undefined,
    prepareSandbox: async () => ({ taskDir: "/tmp/should-not-be-used", mode: "build" as const }),
    primaryChat: { channel: "telegram", chatId: "1" },
    mailMaxDepth: 2,
  });
  const deps = {
    store, goals: engine, vault, registry,
    reloadPacks: () => {}, envPath: "", uiDist: "", log: () => {},
    bus: {}, spendGuard: new SpendGuard({ store }), config: {}, router: {}, gate: {}, voice: {},
  } as unknown as WebDeps;
  const server = startWebServer(deps, 0);
  if (!server.listening) await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    auth: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } as Record<string, string>,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      if (prev === undefined) delete process.env.AIOS_UI_TOKEN; else process.env.AIOS_UI_TOKEN = prev;
    },
  };
}

describe("POST /api/mail/:id/answer", () => {
  it("answers once: 200 {resumed:true} then 409; 400 on empty; 401 unauthorized", async () => {
    const store = new Store(":memory:");
    parkedOnUserAsk(store, "gask", "u1");
    const { base, auth, close } = await spinServer(store);
    try {
      const ok = await fetch(`${base}/api/mail/u1/answer`, {
        method: "POST", headers: auth, body: JSON.stringify({ text: "Vendor B." }),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ resumed: true });

      const dup = await fetch(`${base}/api/mail/u1/answer`, {
        method: "POST", headers: auth, body: JSON.stringify({ text: "again" }),
      });
      expect(dup.status).toBe(409);

      const empty = await fetch(`${base}/api/mail/u1/answer`, {
        method: "POST", headers: auth, body: JSON.stringify({ text: " " }),
      });
      expect(empty.status).toBe(400);

      const noauth = await fetch(`${base}/api/mail/u1/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x" }),
      });
      expect(noauth.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("GET /api/mail/unread carries pendingUser; goal detail carries awaitingUserAsk", async () => {
    const store = new Store(":memory:");
    parkedOnUserAsk(store, "gask2", "u2"); // one unanswered user-ask, never answered
    const { base, auth, close } = await spinServer(store);
    try {
      const unread = await (await fetch(`${base}/api/mail/unread`, { headers: auth })).json();
      expect(unread.pendingUser).toBe(1);

      const detail = await (await fetch(`${base}/api/goals/gask2`, { headers: auth })).json();
      expect(detail.awaitingUserAsk).toEqual({ mailId: "u2", question: expect.any(String), from: expect.any(String) });
    } finally {
      await close();
    }
  });
});
