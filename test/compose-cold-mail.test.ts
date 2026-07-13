// test/compose-cold-mail.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type MailRow } from "../src/store/db.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { Mailbox, isUserReportEvent } from "../src/mail/mailbox.js";
import { buildUserThreads } from "../src/web/goals-view.js";
import type { AiosEvent } from "../src/events.js";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { VaultWriter } from "../src/vault/writer.js";
import { GoalEngine } from "../src/engine/goals.js";
import { SpendGuard } from "../src/engine/budget.js";
import { startWebServer, type WebDeps } from "../src/web/server.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";
import { indexMailThread } from "../src/memory/indexer.js";
import { recall } from "../src/memory/recall.js";

/** engineering (code): athena lead, vulcan (alias developer) — shared. finance: midas private. */
function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "cc-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  const fin = join(agentsDir, "finance");
  mkdirSync(eng, { recursive: true });
  mkdirSync(fin, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  const agent = (name: string, dept: string, extra = "") =>
    `name: ${name}\ntitle: T\ndepartment: ${dept}\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n${extra}`;
  writeFileSync(join(eng, "athena.yaml"), agent("athena", "engineering", "kind: coordinator\n")); // fixture coordinator (loader v2)
  writeFileSync(join(eng, "vulcan.yaml"), agent("vulcan", "engineering", "aliases: [developer]\n"));
  writeFileSync(join(fin, "department.yaml"),
    "department: finance\nmission: Money.\nlead: midas\nmemoDomain: money\nplaybooks: []\nprivateMemo: true\n");
  writeFileSync(join(fin, "midas.yaml"), agent("midas", "finance", "visibility: private\n"));
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();
const PRIMARY = { channel: "telegram", chatId: "1" };

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

describe("Mailbox.sendFromUser", () => {
  it("queues a depth-0 request from 'user' with web/ui origin; emits mail.sent; pumps", () => {
    const { store, mb, events, queuedCount } = harness();
    const r = mb.sendFromUser({ to: "developer", body: "audit the deploy scripts" });
    expect(r.ok).toBe(true);
    const m = store.getMail((r as { ok: true; id: string }).id)!;
    expect(m).toMatchObject({
      from_agent: "user", to_agent: "vulcan", kind: "request", status: "queued",
      chain_depth: 0, origin_channel: "web", origin_chat_id: "ui", in_reply_to: null,
    });
    expect(m.thread_id).toBe(m.id); // fresh thread defaults to own id
    expect(events.some((e) => e.type === "mail.sent" && e.to === "vulcan" && e.from === "user")).toBe(true);
    expect(queuedCount()).toBe(1);
  });

  it("threads a reply: threadId + inReplyTo stored verbatim", () => {
    const { store, mb } = harness();
    const r = mb.sendFromUser({ to: "vulcan", body: "follow-up", threadId: "t0", inReplyTo: "rep1" });
    const m = store.getMail((r as { ok: true; id: string }).id)!;
    expect(m.thread_id).toBe("t0");
    expect(m.in_reply_to).toBe("rep1");
  });

  it("private recipient ACCEPTED — web/ui is a private origin (pinned)", () => {
    const { mb } = harness();
    expect(mb.sendFromUser({ to: "midas", body: "runway question" }).ok).toBe(true);
  });

  it("refuses unknown recipient, user-target, and disabled mailbox", () => {
    const { mb } = harness();
    const unknown = mb.sendFromUser({ to: "nobody", body: "x" });
    expect(unknown.ok).toBe(false);
    expect((unknown as { ok: false; refusal: string }).refusal).toContain("Unknown");
    const self = mb.sendFromUser({ to: "me", body: "x" });
    expect(self.ok).toBe(false);
    const { mb: dead } = harness({ disabled: true });
    expect(dead.sendFromUser({ to: "vulcan", body: "x" }).ok).toBe(false);
  });

  it("refusals insert nothing and emit nothing", () => {
    const { store, mb, events, queuedCount } = harness();
    mb.sendFromUser({ to: "nobody", body: "x" });
    expect(store.listMail(undefined, 10)).toEqual([]);
    expect(events).toEqual([]);
    expect(queuedCount()).toBe(0);
  });
});

describe("isUserReportEvent", () => {
  it("true only for mail.sent report to user", () => {
    expect(isUserReportEvent({ type: "mail.sent", id: "a", from: "vulcan", to: "user", kind: "report" })).toBe(true);
    expect(isUserReportEvent({ type: "mail.sent", id: "a", from: "vulcan", to: "user", kind: "request" })).toBe(false);
    expect(isUserReportEvent({ type: "mail.sent", id: "a", from: "user", to: "vulcan", kind: "report" })).toBe(false);
    expect(isUserReportEvent({ type: "mail.sent", id: "a", from: "athena", to: "hermes", kind: "standup" })).toBe(false);
    expect(isUserReportEvent({ type: "mail.read", ids: ["a"] })).toBe(false);
  });
});

function rawMail(store: Store, over: Partial<MailRow>): void {
  store.insertMail({
    id: over.id ?? "m1", from_agent: over.from_agent ?? "athena", to_agent: over.to_agent ?? "vulcan",
    kind: over.kind ?? "request", body: over.body ?? "body", goal_id: null,
    origin_channel: "web", origin_chat_id: "ui", chain_depth: over.chain_depth ?? 0,
    status: over.status ?? "queued", error: over.error ?? null,
    thread_id: over.thread_id, in_reply_to: over.in_reply_to ?? null,
  });
}

describe("store user-inbox queries", () => {
  it("userThreads: only user threads, newest activity first, unread + pending_ask counts", () => {
    const store = new Store(":memory:");
    // user thread A: cold mail + unread report back
    rawMail(store, { id: "a1", from_agent: "user", to_agent: "vulcan", status: "spawned", thread_id: "ta" });
    rawMail(store, { id: "a2", from_agent: "vulcan", to_agent: "user", kind: "report", status: "unread", thread_id: "ta", in_reply_to: "a1", body: "done: audit finished" });
    // user thread B: pending ask (awaiting-human, unanswered)
    rawMail(store, { id: "b1", from_agent: "athena", to_agent: "user", status: "awaiting-human", thread_id: "tb" });
    // agent-only thread: excluded
    rawMail(store, { id: "c1", from_agent: "athena", to_agent: "vulcan", status: "queued", thread_id: "tc" });
    const threads = store.userThreads();
    expect(threads.map((t) => t.thread_id)).toEqual(["tb", "ta"]); // b1 inserted last → newest
    const ta = threads.find((t) => t.thread_id === "ta")!;
    expect(ta).toMatchObject({ unread: 1, pending_ask: 0, last_from: "vulcan" });
    expect(ta.last_body).toContain("audit finished");
    const tb = threads.find((t) => t.thread_id === "tb")!;
    expect(tb).toMatchObject({ unread: 0, pending_ask: 1 });
  });

  it("userThreads: refused count surfaces per thread (store + view)", () => {
    const store = new Store(":memory:");
    // thread R: user cold mail that the sweep refused
    rawMail(store, { id: "r1", from_agent: "user", to_agent: "vulcan", status: "refused", thread_id: "tr", error: "unknown recipient" });
    // thread A: clean cold mail + report
    rawMail(store, { id: "a1", from_agent: "user", to_agent: "vulcan", status: "spawned", thread_id: "ta" });
    rawMail(store, { id: "a2", from_agent: "vulcan", to_agent: "user", kind: "report", status: "unread", thread_id: "ta", in_reply_to: "a1", body: "done" });
    // thread S: user cold mail that spawned a goal whose agent sub-request later failed —
    // the refused sub-request (from_agent != 'user') inherits the user thread_id and DOES count:
    // the badge means "a request in this thread was refused", not "MY direct request died".
    rawMail(store, { id: "s1", from_agent: "user", to_agent: "athena", status: "spawned", thread_id: "ts" });
    rawMail(store, { id: "s2", from_agent: "athena", to_agent: "vulcan", status: "refused", thread_id: "ts", error: "sub-task failed" });
    const byId = Object.fromEntries(store.userThreads().map((t) => [t.thread_id, t]));
    expect(byId["tr"].refused).toBe(1);
    expect(byId["ta"].refused).toBe(0);
    expect(byId["ts"].refused).toBe(1); // agent-origin refusal in a user thread is surfaced
    // view carries it through
    const view = Object.fromEntries(buildUserThreads(store).map((t) => [t.threadId, t]));
    expect(view["tr"].refused).toBe(1);
    expect(view["ta"].refused).toBe(0);
  });

  it("pending_ask drops to 0 once a reply answers the ask (derived, status untouched)", () => {
    const store = new Store(":memory:");
    rawMail(store, { id: "b1", from_agent: "athena", to_agent: "user", status: "awaiting-human", thread_id: "tb" });
    rawMail(store, { id: "b2", from_agent: "user", to_agent: "athena", kind: "report", status: "unread", thread_id: "tb", in_reply_to: "b1" });
    expect(store.userThreads()[0].pending_ask).toBe(0);
    expect(store.getMail("b1")!.status).toBe("awaiting-human"); // never flips
  });

  it("unreadUserInbox counts unread to-user only; unreadCountsByAgent excludes 'user'", () => {
    const store = new Store(":memory:");
    rawMail(store, { id: "r1", from_agent: "vulcan", to_agent: "user", kind: "report", status: "unread", thread_id: "t1" });
    rawMail(store, { id: "n1", from_agent: "athena", to_agent: "vulcan", kind: "note", status: "unread", thread_id: "t2" });
    expect(store.unreadUserInbox()).toBe(1);
    const counts = store.unreadCountsByAgent();
    expect(counts.vulcan).toBe(1);
    expect(counts.user).toBeUndefined(); // reports to the human never pollute agent badges
  });
});

const TOKEN = "test-ui-token";
const hangRun: SpecialistRunFn = () => new Promise(() => {});

/** Real server + real Mailbox (no onQueued — endpoint tests pin HTTP contracts, not spawning). */
async function spinServer(store: Store) {
  const prev = process.env.AIOS_UI_TOKEN;
  process.env.AIOS_UI_TOKEN = TOKEN;
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "cc-http-vault-")), "AIOS");
  const engine = new GoalEngine({
    store, vault, run: hangRun, registry,
    playbooks: new Map(), wallTimeMs: 60_000, maxConcurrentNodes: 2,
    spendGuard: new SpendGuard({ store }),
    onComplete: async () => {},
    prepareSandbox: async () => ({ taskDir: "/tmp/should-not-be-used", mode: "build" as const }),
    primaryChat: PRIMARY,
    mailMaxDepth: 2,
  });
  const mailbox = new Mailbox({ store, registry, maxDepth: 2, disabled: false, primaryChat: PRIMARY });
  const deps = {
    store, goals: engine, vault, registry, mailbox,
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

describe("compose/mine/read endpoints", () => {
  it("compose 200 ok+id, refusal for unknown, 400 for missing fields, 4000-char clamp", async () => {
    const store = new Store(":memory:");
    const { base, auth, close } = await spinServer(store);
    try {
      const ok = await fetch(`${base}/api/mail/compose`, {
        method: "POST", headers: auth, body: JSON.stringify({ to: "vulcan", body: "x".repeat(5000) }),
      });
      const okBody = (await ok.json()) as { ok: boolean; id: string };
      expect(ok.status).toBe(200);
      expect(okBody.ok).toBe(true);
      expect(store.getMail(okBody.id)!.body.length).toBe(4000); // clamped server-side
      const refused = await (await fetch(`${base}/api/mail/compose`, {
        method: "POST", headers: auth, body: JSON.stringify({ to: "nobody", body: "x" }),
      })).json() as { ok: boolean; refusal: string };
      expect(refused.ok).toBe(false);
      expect(refused.refusal).toContain("Unknown");
      const bad = await fetch(`${base}/api/mail/compose`, {
        method: "POST", headers: auth, body: JSON.stringify({ to: "vulcan" }),
      });
      expect(bad.status).toBe(400);
      const noauth = await fetch(`${base}/api/mail/compose`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "vulcan", body: "x" }),
      });
      expect(noauth.status).toBe(401);
    } finally { await close(); }
  });

  it("mine returns camelCased user threads; unread carries userInbox", async () => {
    const store = new Store(":memory:");
    rawMail(store, { id: "a1", from_agent: "user", to_agent: "vulcan", status: "spawned", thread_id: "ta" });
    rawMail(store, { id: "a2", from_agent: "vulcan", to_agent: "user", kind: "report", status: "unread", thread_id: "ta", in_reply_to: "a1" });
    const { base, auth, close } = await spinServer(store);
    try {
      const mine = (await (await fetch(`${base}/api/mail/mine`, { headers: auth })).json()) as
        { threads: Array<{ threadId: string; unread: number; pendingAsk: number; lastFrom: string }> };
      expect(mine.threads).toHaveLength(1);
      expect(mine.threads[0]).toMatchObject({ threadId: "ta", unread: 1, pendingAsk: 0, lastFrom: "vulcan" });
      const unread = (await (await fetch(`${base}/api/mail/unread`, { headers: auth })).json()) as { userInbox: number };
      expect(unread.userInbox).toBe(1);
    } finally { await close(); }
  });

  it("read marks user mail read (idempotent); 400 on non-user mail", async () => {
    const store = new Store(":memory:");
    rawMail(store, { id: "r1", from_agent: "vulcan", to_agent: "user", kind: "report", status: "unread", thread_id: "t1" });
    rawMail(store, { id: "n1", from_agent: "athena", to_agent: "vulcan", kind: "note", status: "unread", thread_id: "t2" });
    const { base, auth, close } = await spinServer(store);
    try {
      const ok = await fetch(`${base}/api/mail/r1/read`, { method: "POST", headers: auth });
      expect(ok.status).toBe(200);
      expect(store.getMail("r1")!.status).toBe("read");
      expect(store.getMail("r1")!.read_at).toBeTruthy();
      const again = await fetch(`${base}/api/mail/r1/read`, { method: "POST", headers: auth });
      expect(again.status).toBe(200); // idempotent
      const notUser = await fetch(`${base}/api/mail/n1/read`, { method: "POST", headers: auth });
      expect(notUser.status).toBe(400);
    } finally { await close(); }
  });
});

const okRun: SpecialistRunFn = async (_r, brief) => ({ text: `done: ${brief.slice(0, 20)}`, costUsd: 0.01, numTurns: 1 });
const flush = () => new Promise((r) => setTimeout(r, 50));

function engineHarness(run: SpecialistRunFn) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "cc-vault-")), "AIOS");
  const events: AiosEvent[] = [];
  const engine = new GoalEngine({
    store, vault, run, registry,
    playbooks: new Map(), wallTimeMs: 60_000, maxConcurrentNodes: 2,
    spendGuard: new SpendGuard({ store }),
    onComplete: async () => {},
    prepareSandbox: async () => ({ taskDir: "/tmp/should-not-be-used", mode: "build" as const }),
    primaryChat: PRIMARY,
    mailMaxDepth: 2,
  });
  const mailbox = new Mailbox({
    store, registry, maxDepth: 2, disabled: false, primaryChat: PRIMARY,
    onEvent: (e) => events.push(e), onQueued: () => engine.pump(),
  });
  return { store, engine, mailbox, events };
}

describe("cold mail end-to-end (sweep)", () => {
  it("compose → goal spawns depth 0 → report lands unread to user in the same thread", async () => {
    const { store, mailbox } = engineHarness(okRun);
    const r = mailbox.sendFromUser({ to: "vulcan", body: "audit the deploy scripts" });
    const id = (r as { ok: true; id: string }).id;
    await flush();
    const m = store.getMail(id)!;
    expect(m.status).toBe("spawned");
    const goal = store.getGoal(m.goal_id!)!;
    expect(goal.chain_depth).toBe(0);
    expect(goal).toMatchObject({ origin_channel: "web", origin_chat_id: "ui" });
    const report = store.mailThread(m.thread_id!).find((x) => x.kind === "report")!;
    expect(report).toMatchObject({ to_agent: "user", from_agent: "vulcan", status: "unread", in_reply_to: id });
    expect(store.unreadUserInbox()).toBe(1);
  });

  it("compose path is recall-indexable — mail.sent carries the id the indexer listener needs (spec §10.7)", async () => {
    const { store, mailbox, events } = engineHarness(okRun);
    const r = mailbox.sendFromUser({ to: "vulcan", body: "investigate the flaky nightly backup" });
    // The production index.ts listener keys off the EMITTED event's id — assert the event
    // carries the composed mail's id, then mirror the listener using the event, not the row.
    const sent = events.find((e) => e.type === "mail.sent" && e.from === "user");
    expect(sent && sent.type === "mail.sent" ? sent.id : undefined).toBe((r as { ok: true; id: string }).id);
    const m = store.getMail((sent as { type: "mail.sent"; id: string }).id)!;
    indexMailThread(store, registry, m.thread_id ?? m.id);
    const hits = recall(store, "flaky nightly backup");
    expect(hits[0]?.source).toBe("mail");
  });

  it("user↔private-agent thread is never indexed — recall stays blind, no memory doc written", async () => {
    const { store, mailbox, events } = engineHarness(okRun);
    const r = mailbox.sendFromUser({ to: "midas", body: "confidential runway forecast question" });
    expect(r.ok).toBe(true);
    const id = (r as { ok: true; id: string }).id;
    const sent = events.find((e) => e.type === "mail.sent" && e.from === "user");
    expect(sent && sent.type === "mail.sent" ? sent.id : undefined).toBe(id);
    const m = store.getMail(id)!;
    const threadId = m.thread_id ?? m.id;
    indexMailThread(store, registry, threadId);
    const hits = recall(store, "confidential runway forecast question");
    expect(hits).toHaveLength(0);
    expect(store.memoryFingerprint("mail", `thread:${threadId}`)).toBeUndefined();
  });

  it("reply-in-thread spawns a second goal in the SAME thread", async () => {
    const { store, mailbox } = engineHarness(okRun);
    const first = mailbox.sendFromUser({ to: "vulcan", body: "first task" });
    const firstId = (first as { ok: true; id: string }).id;
    await flush();
    const thread = store.getMail(firstId)!.thread_id!;
    const report = store.mailThread(thread).find((x) => x.kind === "report")!;
    const second = mailbox.sendFromUser({ to: "vulcan", body: "follow-up task", threadId: thread, inReplyTo: report.id });
    await flush();
    const secondRow = store.getMail((second as { ok: true; id: string }).id)!;
    expect(secondRow.status).toBe("spawned");
    expect(secondRow.goal_id).not.toBe(store.getMail(firstId)!.goal_id); // a NEW goal
    const msgs = store.mailThread(thread);
    expect(msgs.length).toBe(4); // request, report, follow-up, second report
    expect(msgs.filter((x) => x.kind === "report" && x.to_agent === "user").length).toBe(2);
  });
});
