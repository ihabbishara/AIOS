# Compose UI + Human Cold Mail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner composes durable mail to any agent from a new Mission Control Mail tab; the sweeper spawns the goal; the report lands back in a user-centric inbox with a primary-chat ping.

**Architecture:** One new Mailbox primitive (`sendFromUser`) inserts a `from='user'` request with the hardcoded private `web/ui` origin — the untouched sweeper does everything else. Store gains user-thread queries; the web server gains compose/mine/read endpoints (server now receives the Mailbox); `index.ts` gains a report-to-user ping listener mirroring the shipped 🙋 pattern; the UI gains a Mail tab.

**Tech Stack:** TypeScript, `node:sqlite`, vitest, React (existing Mission Control UI conventions).

**Spec:** `docs/superpowers/specs/2026-07-07-compose-ui-cold-mail-design.md` — read it first.

## Global Constraints

- `node:sqlite` only; **no new npm deps** (backend or UI).
- The client NEVER supplies sender, origin, depth, or status — `sendFromUser` hardcodes `from='user'`, origin `{channel:'web', chatId:'ui'}`, `chain_depth=0`, `status='queued'`, `kind='request'`.
- Do not touch: sweeper, depth cap, awaiting-human machinery, agents' read-at-success semantics, recall wall, `EVENT_INDEX_ALLOW`.
- Every mail insert path must emit `mail.sent` (recall indexing rides it) — `sendFromUser` complies.
- `AGENT_MAIL_EVENTS` sets in `ui/src/App.tsx` and `ui/src/views/Org.tsx` are explicit and MUST stay identical to each other.
- Report/mail bodies render as text in the UI, never HTML.
- Suite baseline: 899 pass + 1 skip. Stays green.
- Commands from repo root: `npx vitest run <file>`, `npx tsc --noEmit`; UI: `cd ui && npx tsc --noEmit && npm run build`.

**One spec deviation, decided here:** spec §6 says `sendFromUser` returns a human string, §6-endpoints says compose returns `{ok:true, id}`. A string can't carry the id, and `sendFromUser` is a UI primitive (not an agent tool), so it returns structured data: `{ ok: true; id: string } | { ok: false; refusal: string }`. The endpoint maps it 1:1.

---

### Task 1: `Mailbox.sendFromUser` + `isUserReportEvent`

**Files:**
- Modify: `src/mail/mailbox.ts` (new method after `ask`, new exported predicate near `isUserTarget`)
- Test: `test/compose-cold-mail.test.ts` (create)

**Interfaces:**
- Consumes: existing private `resolveRecipient(ctx, to, verb)`, `isUserTarget`, `USER`, `MailboxDeps` (`store`, `registry`, `disabled`, `primaryChat`, `onEvent`, `onQueued`).
- Produces:
  - `Mailbox.sendFromUser(args: { to: string; body: string; threadId?: string; inReplyTo?: string }): { ok: true; id: string } | { ok: false; refusal: string }`
  - `isUserReportEvent(e: AiosEvent): boolean` — true only for `{type:'mail.sent', kind:'report', to:'user'}`. Tasks 3 and 4 use both.

- [ ] **Step 1: Write the failing tests**

Create `test/compose-cold-mail.test.ts`:

```ts
// test/compose-cold-mail.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { Mailbox, isUserReportEvent } from "../src/mail/mailbox.js";
import type { AiosEvent } from "../src/events.js";

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
  writeFileSync(join(eng, "athena.yaml"), agent("athena", "engineering"));
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/compose-cold-mail.test.ts`
Expected: FAIL — `sendFromUser is not a function`, `isUserReportEvent` not exported.

- [ ] **Step 3: Implement**

`src/mail/mailbox.ts` — add next to `isUserTarget` (module level):

```ts
/** True only for a completed-goal report addressed to the owner — drives the 📨 chat ping. */
export function isUserReportEvent(e: AiosEvent): boolean {
  return e.type === "mail.sent" && e.kind === "report" && e.to === USER;
}
```

Add the method to the `Mailbox` class, after `ask()`:

```ts
  /** Owner-originated cold mail from Mission Control (compose spec 2026-07-07). Durable:
   *  the request queues for the sweeper like agent mail and the report lands back in the
   *  user's inbox. Origin is hardcoded server-side to the private web/ui surface — the
   *  client never supplies sender, origin, depth, or status. */
  sendFromUser(args: { to: string; body: string; threadId?: string; inReplyTo?: string }):
    { ok: true; id: string } | { ok: false; refusal: string } {
    if (isUserTarget(args.to)) return { ok: false, refusal: "Refused: that target is you — mail an agent instead." };
    const ctx: MailSendCtx = { from: USER, origin: { channel: "web", chatId: "ui" }, goalDepth: -1 };
    const r = this.resolveRecipient(ctx, args.to, "mail");
    if ("refusal" in r) return { ok: false, refusal: r.refusal };
    const { canonical } = r;
    const id = randomUUID();
    this.deps.store.insertMail({
      id, from_agent: USER, to_agent: canonical, kind: "request", body: args.body,
      goal_id: null, origin_channel: "web", origin_chat_id: "ui",
      chain_depth: 0, status: "queued", error: null,
      thread_id: args.threadId ?? id, in_reply_to: args.inReplyTo ?? null,
    });
    this.deps.onEvent?.({ type: "mail.sent", id, from: USER, to: canonical, kind: "request" });
    this.deps.onQueued?.();
    return { ok: true, id };
  }
```

(`goalDepth: -1` is inert — this method hardcodes `chain_depth: 0`; the ctx exists only for `resolveRecipient`'s origin/self checks.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/compose-cold-mail.test.ts test/mailbox.test.ts`
Expected: PASS (new file 6 tests; mailbox regressions unchanged).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` — clean.

```bash
git add src/mail/mailbox.ts test/compose-cold-mail.test.ts
git commit -m "feat(mail): sendFromUser — owner-originated durable cold mail"
```

---

### Task 2: Store — `userThreads`, `unreadUserInbox`, counts exclusion

**Files:**
- Modify: `src/store/db.ts` (`unreadCountsByAgent` ~line 683; new methods + `UserThreadRow` type near `mailThread` ~line 742)
- Test: `test/compose-cold-mail.test.ts` (append)

**Interfaces:**
- Consumes: `mail` table (all columns exist; `idx_mail_thread` exists).
- Produces:
  - `export interface UserThreadRow { thread_id: string; last_ts: string; last_from: string; last_body: string; unread: number; pending_ask: number }`
  - `Store.userThreads(limit = 100): UserThreadRow[]` — threads with any message from/to `'user'`, newest activity first, rowid tiebreak.
  - `Store.unreadUserInbox(): number`
  - `unreadCountsByAgent()` now excludes `to_agent = 'user'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/compose-cold-mail.test.ts` (extend the Store import: `import { Store, type MailRow } from "../src/store/db.js";`):

```ts
function rawMail(store: Store, over: Partial<MailRow>): void {
  store.insertMail({
    id: over.id ?? "m1", from_agent: over.from_agent ?? "athena", to_agent: over.to_agent ?? "vulcan",
    kind: over.kind ?? "request", body: over.body ?? "body", goal_id: null,
    origin_channel: "web", origin_chat_id: "ui", chain_depth: over.chain_depth ?? 0,
    status: over.status ?? "queued", error: null,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/compose-cold-mail.test.ts`
Expected: FAIL — `userThreads is not a function`, `unreadUserInbox is not a function`, `counts.user` defined.

- [ ] **Step 3: Implement**

`src/store/db.ts` — change `unreadCountsByAgent` (~line 683):

```ts
  unreadCountsByAgent(): Record<string, number> {
    // The human's inbox is a separate surface (unreadUserInbox) — exclude it from agent badges.
    const rows = this.db.prepare(
      "SELECT to_agent, COUNT(*) AS c FROM mail WHERE status = 'unread' AND to_agent != 'user' GROUP BY to_agent",
    ).all() as unknown as Array<{ to_agent: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.to_agent] = r.c;
    return out;
  }
```

Add near `mailThread` (after `listMailThreadIds`), plus the exported type next to `MailRow`:

```ts
export interface UserThreadRow {
  thread_id: string; last_ts: string; last_from: string; last_body: string;
  unread: number; pending_ask: number;
}
```

```ts
  /** Thread summaries for conversations involving the human, newest activity first.
   *  pending_ask is DERIVED like pendingUserAsks (a reply carrying in_reply_to answers it). */
  userThreads(limit = 100): UserThreadRow[] {
    return this.db.prepare(`
      SELECT t.thread_id,
             l.created_at AS last_ts, l.from_agent AS last_from, substr(l.body, 1, 160) AS last_body,
             t.unread, t.pending_ask
      FROM (
        SELECT thread_id,
               SUM(CASE WHEN status = 'unread' AND to_agent = 'user' THEN 1 ELSE 0 END) AS unread,
               SUM(CASE WHEN kind = 'request' AND to_agent = 'user' AND status = 'awaiting-human'
                         AND id NOT IN (SELECT in_reply_to FROM mail WHERE in_reply_to IS NOT NULL)
                        THEN 1 ELSE 0 END) AS pending_ask
        FROM mail
        WHERE thread_id IN (SELECT DISTINCT thread_id FROM mail WHERE from_agent = 'user' OR to_agent = 'user')
        GROUP BY thread_id
      ) t
      JOIN mail l ON l.rowid = (
        SELECT rowid FROM mail WHERE thread_id = t.thread_id ORDER BY created_at DESC, rowid DESC LIMIT 1
      )
      ORDER BY l.created_at DESC, l.rowid DESC
      LIMIT ?
    `).all(limit) as unknown as UserThreadRow[];
  }

  unreadUserInbox(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM mail WHERE status = 'unread' AND to_agent = 'user'")
      .get() as { c: number }).c;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/compose-cold-mail.test.ts test/mail-store.test.ts test/mail-endpoints.test.ts`
Expected: PASS. If an existing test pinned `unreadCountsByAgent` including `'user'`, STOP — re-read it; the exclusion is spec §6 and the old expectation must be updated deliberately, not reverted.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` — clean.

```bash
git add src/store/db.ts test/compose-cold-mail.test.ts
git commit -m "feat(store): user-inbox queries — userThreads, unreadUserInbox, badge exclusion"
```

---

### Task 3: Views + endpoints — compose / mine / read, `userInbox` count

**Files:**
- Modify: `src/web/goals-view.ts` (`buildMailUnread` ~line 87; new `buildUserThreads`)
- Modify: `src/web/server.ts` (`WebDeps` ~line 64; routes near the mail block ~line 439)
- Modify: `src/index.ts:635-638` (pass `mailbox` to `startWebServer`)
- Test: `test/compose-cold-mail.test.ts` (append HTTP tests)

**Interfaces:**
- Consumes: `Mailbox.sendFromUser` (Task 1), `store.userThreads()` / `unreadUserInbox()` (Task 2), existing `json`/`readBody`/auth plumbing, `mailbox.markDelivered(ids)` (emits `mail.read`).
- Produces:
  - `WebDeps.mailbox: Mailbox` (required field).
  - `POST /api/mail/compose` `{to, body, threadId?, inReplyTo?}` → 200 `{ok:true, id}` | 200 `{ok:false, refusal}` | 400 `{error}`; body clamped to 4000 chars.
  - `GET /api/mail/mine` → `{threads: UserThreadView[]}` where `UserThreadView = {threadId, lastTs, lastFrom, lastBody, unread, pendingAsk}`.
  - `POST /api/mail/:id/read` → 200 `{ok:true}`, 400 for non-user mail.
  - `GET /api/mail/unread` gains `userInbox: number`.

- [ ] **Step 1: Write the failing tests**

Append to `test/compose-cold-mail.test.ts`. Add imports at top:

```ts
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { VaultWriter } from "../src/vault/writer.js";
import { GoalEngine } from "../src/engine/goals.js";
import { SpendGuard } from "../src/engine/budget.js";
import { startWebServer, type WebDeps } from "../src/web/server.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";
```

(Task 4's recall test additionally needs: `import { indexMailThread } from "../src/memory/indexer.js";` and `import { recall } from "../src/memory/recall.js";`)

```ts
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
    resolveDeptFor: () => undefined,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/compose-cold-mail.test.ts`
Expected: new endpoint tests FAIL with 404-ish JSON parse errors (routes absent); earlier tests still PASS.

- [ ] **Step 3: Implement**

3a. `src/web/goals-view.ts` — extend `buildMailUnread` and add the view builder:

```ts
export function buildMailUnread(store: Store): { total: number; byAgent: Record<string, number>; pendingUser: number; userInbox: number } {
  const byAgent = store.unreadCountsByAgent();
  const total = Object.values(byAgent).reduce((s, n) => s + n, 0);
  return { total, byAgent, pendingUser: store.pendingUserAsks().length, userInbox: store.unreadUserInbox() };
}
```

```ts
export interface UserThreadView {
  threadId: string; lastTs: string; lastFrom: string; lastBody: string; unread: number; pendingAsk: number;
}

/** The human's correspondence — thread summaries for the Mail tab (spec §6). */
export function buildUserThreads(store: Store): UserThreadView[] {
  return store.userThreads().map((t) => ({
    threadId: t.thread_id, lastTs: t.last_ts, lastFrom: t.last_from, lastBody: t.last_body,
    unread: t.unread, pendingAsk: t.pending_ask,
  }));
}
```

3b. `src/web/server.ts` — add to `WebDeps` (after `registry`):

```ts
  /** Mailbox — compose (sendFromUser) and human read-marking (markDelivered → mail.read). */
  mailbox: Mailbox;
```

with imports `import type { Mailbox } from "../mail/mailbox.js";` and `buildUserThreads` added to the goals-view import. Destructure `mailbox` wherever the handler destructures deps (match the existing pattern — `store`, `goals`, etc.).

Add routes inside the handler, directly after the `/api/mail/unread` block:

```ts
        if (path === "/api/mail/mine" && req.method === "GET") {
          return json(res, 200, { threads: buildUserThreads(store) });
        }

        if (path === "/api/mail/compose" && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { to?: string; body?: string; threadId?: string; inReplyTo?: string };
          if (!body.to?.trim() || !body.body?.trim()) return json(res, 400, { error: "to and body required" });
          const result = mailbox.sendFromUser({
            to: body.to, body: body.body.slice(0, 4000),
            threadId: body.threadId, inReplyTo: body.inReplyTo,
          });
          return json(res, 200, result);
        }
```

And after the existing `answerMatch` block:

```ts
        const readMatch = /^\/api\/mail\/([\w-]+)\/read$/.exec(path);
        if (readMatch && req.method === "POST") {
          const m = store.getMail(readMatch[1]);
          if (!m || m.to_agent !== "user") return json(res, 400, { error: "not user mail" });
          mailbox.markDelivered([m.id]);
          return json(res, 200, { ok: true });
        }
```

3c. `src/index.ts:635-638` — pass the existing mailbox instance:

```ts
  startWebServer(
    { store, bus, goals, spendGuard, vault, config, router, gate, voice, registry, mailbox, reloadPacks: reloadRegistry, envPath: config.envPath, uiDist: config.uiDist, log },
    config.uiPort,
  );
```

(`mailbox` is constructed at `src/index.ts:78` — already in scope.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/compose-cold-mail.test.ts test/mail-endpoints.test.ts`
Expected: PASS. `test/mail-endpoints.test.ts`'s `spinServer` casts deps `as unknown as WebDeps` without `mailbox` — it only exercises the answer route, so the missing field is inert at runtime; if TypeScript complains anywhere, add a real `Mailbox` there the same way as this task's harness.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` — clean.

```bash
git add src/web/goals-view.ts src/web/server.ts src/index.ts test/compose-cold-mail.test.ts
git commit -m "feat(web): compose/mine/read endpoints — the human inbox API"
```

---

### Task 4: Sweep e2e + reply-in-thread + 📨 ping listener

**Files:**
- Modify: `src/index.ts` (listener after the 🙋 block, ~line 437)
- Test: `test/compose-cold-mail.test.ts` (append)

**Interfaces:**
- Consumes: `isUserReportEvent` (Task 1), `sendVia` + `config.primaryChat` + `store.getMail` (all in scope at the 🙋 listener site), GoalEngine harness pattern.
- Produces: nothing new — wiring + pinned behavior.

- [ ] **Step 1: Write the failing test**

Append to `test/compose-cold-mail.test.ts`:

```ts
const okRun: SpecialistRunFn = async (_r, brief) => ({ text: `done: ${brief.slice(0, 20)}`, costUsd: 0.01, numTurns: 1 });
const flush = () => new Promise((r) => setTimeout(r, 50));

function engineHarness(run: SpecialistRunFn) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "cc-vault-")), "AIOS");
  const engine = new GoalEngine({
    store, vault, run, registry,
    playbooks: new Map(), wallTimeMs: 60_000, maxConcurrentNodes: 2,
    spendGuard: new SpendGuard({ store }),
    onComplete: async () => {},
    resolveDeptFor: () => undefined,
    prepareSandbox: async () => ({ taskDir: "/tmp/should-not-be-used", mode: "build" as const }),
    primaryChat: PRIMARY,
    mailMaxDepth: 2,
  });
  const mailbox = new Mailbox({
    store, registry, maxDepth: 2, disabled: false, primaryChat: PRIMARY,
    onQueued: () => engine.pump(),
  });
  return { store, engine, mailbox };
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
    const { store, mailbox } = engineHarness(okRun);
    // Mirror the index.ts listener: on mail.sent → indexMailThread(store, registry, thread).
    const r = mailbox.sendFromUser({ to: "vulcan", body: "investigate the flaky nightly backup" });
    const m = store.getMail((r as { ok: true; id: string }).id)!;
    indexMailThread(store, registry, m.thread_id ?? m.id);
    const hits = recall(store, "flaky nightly backup");
    expect(hits[0]?.source).toBe("mail");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compose-cold-mail.test.ts`
Expected: these two tests should PASS already if Tasks 1–3 are correct — they pin substrate behavior end-to-end. If either FAILS, STOP and debug before proceeding (do not weaken assertions). The commit gate for this task is the listener below plus these pins.

- [ ] **Step 3: Implement the ping listener**

`src/index.ts` — extend the memory-indexer import line? No — add to the existing mailbox import if one exists, otherwise a named import: `import { Mailbox, isUserReportEvent } from "./mail/mailbox.js";` (the file already imports `Mailbox` — extend that line). Then add directly AFTER the 🙋 `mail.asked_user` listener block (~line 442):

```ts
  // A report for the owner landed (reply to their cold mail) — courtesy copy to primary chat.
  // Transport-only: no read-marking, no vaulting; the Mail tab is the source of truth.
  bus.on((e) => {
    if (!isUserReportEvent(e.event) || !config.primaryChat) return;
    if (e.event.type !== "mail.sent") return; // narrow for TypeScript
    const first = (store.getMail(e.event.id)?.body.split("\n")[0] ?? "").slice(0, 200);
    void sendVia(config.primaryChat.channel, config.primaryChat.chatId,
      `📨 ${e.event.from} → you: ${first}\n\nFull report in Mission Control → Mail.`,
    ).catch((err) => log(`report ping failed: ${(err as Error).message}`));
  });
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run test/compose-cold-mail.test.ts`
Expected: PASS (all sections). The listener itself is composition-root wiring (untested by repo convention, same as the 🙋 ping); its predicate `isUserReportEvent` is pinned by Task 1's unit tests.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` — clean.

```bash
git add src/index.ts test/compose-cold-mail.test.ts
git commit -m "feat(mail): cold-mail e2e pins + report-to-owner chat ping"
```

---

### Task 5: UI — Mail tab

**Files:**
- Modify: `ui/src/api.ts` (new endpoints + types; extend `mailUnread` type)
- Modify: `ui/src/App.tsx` (TABS, badge, view mount)
- Create: `ui/src/views/Mail.tsx`
- Test: none (repo has no UI test rig; gate = `cd ui && npx tsc --noEmit && npm run build`)

**Interfaces:**
- Consumes: Task 3 endpoints; existing `request<T>` helper, `usePoll`, `useEvents` `StoredEvent`, `MailView` type (exists in `api.ts`), `OrgDepartmentView`.
- Produces: `Mail` component `({ events }: { events: StoredEvent[] })`.

- [ ] **Step 1: `ui/src/api.ts` additions**

Add type + entries (match existing style; `MailView` already exists):

```ts
export interface UserThreadView {
  threadId: string; lastTs: string; lastFrom: string; lastBody: string; unread: number; pendingAsk: number;
}
```

In the `api` object, extend `mailUnread`'s type and add three calls:

```ts
  mailUnread: () => request<{ total: number; byAgent: Record<string, number>; pendingUser: number; userInbox: number }>("/api/mail/unread"),
  mailMine: () => request<{ threads: UserThreadView[] }>("/api/mail/mine"),
  mailThreadView: (id: string) => request<MailView[]>(`/api/mail/thread/${encodeURIComponent(id)}`),
  composeMail: (args: { to: string; body: string; threadId?: string; inReplyTo?: string }) =>
    request<{ ok: true; id: string } | { ok: false; refusal: string }>("/api/mail/compose", {
      method: "POST", body: JSON.stringify(args),
    }),
  markMailRead: (id: string) =>
    request<{ ok: boolean }>(`/api/mail/${encodeURIComponent(id)}/read`, { method: "POST" }),
```

(If an `api.mailThread` already exists with the same GET, reuse it and skip `mailThreadView`.)

- [ ] **Step 2: `ui/src/views/Mail.tsx`**

```tsx
// ui/src/views/Mail.tsx — the human's correspondence: inbox threads + compose (spec 2026-07-07).
import { useEffect, useMemo, useState } from "react";
import { api, type MailView, type StoredEvent, type UserThreadView } from "../api.js";
import { usePoll } from "../hooks.js";

const AGENT_MAIL_EVENTS = new Set(["mail.sent", "mail.spawned", "mail.read", "mail.asked_user"]);

export function Mail({ events }: { events: StoredEvent[] }) {
  const lastMailEvt = useMemo(
    () => events.filter((e) => AGENT_MAIL_EVENTS.has(e.event.type)).at(-1)?.id,
    [events],
  );
  const { data: mine, reload } = usePoll(() => api.mailMine(), [lastMailEvt]);
  const { data: org } = usePoll(() => api.org(), []);
  const [open, setOpen] = useState<string | null>(null);
  const agents = useMemo(
    () => (org ?? []).flatMap((d) => d.agents.map((a) => ({ name: a.name, dept: d.department }))),
    [org],
  );

  return (
    <div className="flex gap-4 h-full min-h-0">
      <div className="w-72 shrink-0 flex flex-col gap-3 min-h-0">
        <Compose agents={agents} onSent={reload} />
        <div className="label">Threads</div>
        <div className="flex-1 overflow-auto flex flex-col gap-1">
          {(mine?.threads ?? []).map((t) => (
            <ThreadRow key={t.threadId} t={t} active={open === t.threadId} onOpen={() => setOpen(t.threadId)} />
          ))}
          {mine && mine.threads.length === 0 && <div className="text-dim text-[11px]">No correspondence yet.</div>}
        </div>
      </div>
      <div className="flex-1 min-w-0 overflow-auto">
        {open
          ? <ThreadDetail threadId={open} lastMailEvt={lastMailEvt} onChanged={reload} />
          : <div className="text-dim text-[11px] pt-8 text-center">Select a thread — or compose cold mail to any agent.</div>}
      </div>
    </div>
  );
}

function ThreadRow({ t, active, onOpen }: { t: UserThreadView; active: boolean; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className={`text-left px-3 py-2 border ${active ? "border-phosphor bg-panel-2" : "border-line bg-panel hover:border-fg"}`}
    >
      <div className="flex items-center gap-2 text-[11px]">
        <span className={t.unread > 0 ? "text-bright font-bold" : "text-fg"}>{t.lastFrom}</span>
        {t.unread > 0 && <span className="text-void bg-amber px-1 rounded-full text-[9px]">{t.unread}</span>}
        {t.pendingAsk > 0 && <span className="text-[10px]">🙋</span>}
        <span className="ml-auto text-dim text-[10px]">{t.lastTs.slice(5, 16)}</span>
      </div>
      <div className="text-dim text-[11px] truncate">{t.lastBody}</div>
    </button>
  );
}

function ThreadDetail({ threadId, lastMailEvt, onChanged }:
  { threadId: string; lastMailEvt: string | undefined; onChanged: () => void }) {
  const { data: msgs, reload } = usePoll(() => api.mailThreadView(threadId), [threadId, lastMailEvt]);
  // Human opened the thread = read (fire-and-forget per unread to-user message).
  useEffect(() => {
    for (const m of msgs ?? []) {
      if (m.to === "user" && m.status === "unread") void api.markMailRead(m.id).catch(() => {});
    }
  }, [msgs]);
  // Answered-ness isn't derivable client-side (MailView carries no inReplyTo) — show the box
  // for any awaiting-human message; the server's existing 409 guards double answers.
  const pendingAsk = (msgs ?? []).find((m) => m.to === "user" && m.status === "awaiting-human");
  const lastReport = [...(msgs ?? [])].reverse().find((m) => m.kind === "report" && m.to === "user");
  return (
    <div className="flex flex-col gap-2">
      {(msgs ?? []).map((m) => (
        <div key={m.id} className="border border-line bg-panel px-3 py-2">
          <div className="text-[11px] text-dim">
            <span className={m.from === "user" ? "text-cyan" : "text-amber"}>{m.from}</span>
            {" → "}{m.to} · {m.kind} · {m.createdAt.slice(0, 16)}
          </div>
          <div className="text-[12px] whitespace-pre-wrap">{m.body}</div>
        </div>
      ))}
      {pendingAsk && <AnswerBox mailId={pendingAsk.id} onDone={() => { reload(); onChanged(); }} />}
      <ReplyBox threadId={threadId} inReplyTo={lastReport?.id} onSent={() => { reload(); onChanged(); }} />
    </div>
  );
}

function AnswerBox({ mailId, onDone }: { mailId: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const send = () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    api.answerMail(mailId, text)
      .then(() => { setText(""); onDone(); })
      .catch((e) => setMsg((e as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="border border-cyan px-3 py-2 flex flex-col gap-1">
      <div className="label">🙋 answer this question</div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
        className="bg-panel-2 border border-line px-2 py-1 text-[12px]" />
      <div className="flex items-center gap-2">
        <button onClick={send} disabled={busy || !text.trim()}
          className="text-[11px] border border-line px-3 py-1 hover:border-fg disabled:opacity-50">answer</button>
        {msg && <span className="text-alert text-[11px]">{msg}</span>}
      </div>
    </div>
  );
}

function ReplyBox({ threadId, inReplyTo, onSent }:
  { threadId: string; inReplyTo: string | undefined; onSent: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Reply target = the last participant who isn't the user; server refuses unknowns anyway.
  const send = (to: string) => {
    if (busy || !text.trim()) return;
    setBusy(true);
    api.composeMail({ to, body: text, threadId, inReplyTo })
      .then((r) => { if (!r.ok) setMsg(r.refusal); else { setText(""); onSent(); } })
      .catch((e) => setMsg((e as Error).message))
      .finally(() => setBusy(false));
  };
  return <ReplyTarget threadId={threadId} busy={busy} text={text} setText={setText} msg={msg} onSend={send} />;
}

function ReplyTarget({ threadId, busy, text, setText, msg, onSend }:
  { threadId: string; busy: boolean; text: string; setText: (s: string) => void; msg: string | null; onSend: (to: string) => void }) {
  const { data: msgs } = usePoll(() => api.mailThreadView(threadId), [threadId]);
  const other = [...(msgs ?? [])].reverse().map((m) => (m.from === "user" ? m.to : m.from)).find((n) => n !== "user") ?? "";
  return (
    <div className="border border-line px-3 py-2 flex flex-col gap-1">
      <div className="label">reply → {other || "…"}</div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
        className="bg-panel-2 border border-line px-2 py-1 text-[12px]" />
      <div className="flex items-center gap-2">
        <button onClick={() => onSend(other)} disabled={busy || !text.trim() || !other}
          className="text-[11px] border border-line px-3 py-1 hover:border-fg disabled:opacity-50">send follow-up</button>
        {msg && <span className="text-alert text-[11px]">{msg}</span>}
      </div>
    </div>
  );
}

function Compose({ agents, onSent }: { agents: Array<{ name: string; dept: string }>; onSent: () => void }) {
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const send = () => {
    if (busy || !to || !body.trim()) return;
    setBusy(true);
    setMsg(null);
    api.composeMail({ to, body })
      .then((r) => { if (!r.ok) setMsg(r.refusal); else { setBody(""); setMsg("sent ✓"); onSent(); } })
      .catch((e) => setMsg((e as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="border border-line bg-panel px-3 py-2 flex flex-col gap-1">
      <div className="label">compose</div>
      <select value={to} onChange={(e) => setTo(e.target.value)}
        className="bg-panel-2 border border-line px-2 py-1 text-[12px]">
        <option value="">to…</option>
        {agents.map((a) => <option key={a.name} value={a.name}>{a.name} ({a.dept})</option>)}
      </select>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={4000}
        placeholder="What should they do?" className="bg-panel-2 border border-line px-2 py-1 text-[12px]" />
      <div className="flex items-center gap-2">
        <button onClick={send} disabled={busy || !to || !body.trim()}
          className="text-[11px] border border-line px-3 py-1 hover:border-fg disabled:opacity-50">send</button>
        {msg && <span className={`text-[11px] ${msg === "sent ✓" ? "text-phosphor" : "text-alert"}`}>{msg}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `ui/src/App.tsx` wiring**

Three edits:

```ts
import { Mail } from "./views/Mail.js";
```

```ts
const TABS = ["org", "mail", "chat", "routing", "goals", "approvals", "trust", "permissions", "departments", "config", "costs"] as const;
```

Badge, inside the `TABS.map` button after the goals badge:

```tsx
              {t === "mail" && unread && unread.userInbox > 0 && (
                <span className="ml-2 text-[9px] text-void bg-amber px-1.5 rounded-full tracking-normal align-middle">{unread.userInbox}</span>
              )}
```

View mount, next to the other hidden-tab divs:

```tsx
          <div className={tab === "mail" ? "h-full" : "hidden"}><Mail events={events} /></div>
```

Do NOT touch `AGENT_MAIL_EVENTS` in `App.tsx`/`Org.tsx` — `Mail.tsx` declares its own identical copy (same convention as `Org.tsx`).

- [ ] **Step 4: Verify**

```bash
cd ui && npx tsc --noEmit && npm run build
```
Expected: clean + built. Fix any type drift against `api.ts` (e.g. if `StoredEvent` lives in `hooks.ts` not `api.ts`, import from there — check `Org.tsx`'s imports and copy its source).

- [ ] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/App.tsx ui/src/views/Mail.tsx
git commit -m "feat(ui): Mail tab — user inbox threads, compose, in-thread reply"
```

---

### Task 6: Full verification

**Files:** none.

- [ ] **Step 1:** `npx vitest run` — expected ~911 pass + 1 skip (899 baseline + 12 new: 6 Task 1, 3 Task 2, 3 Task 3, 3 Task 4 — count may land ±1 if a Task-2 neighbor needed a deliberate update; zero failures either way).
- [ ] **Step 2:** `npx tsc --noEmit` and `cd ui && npx tsc --noEmit && npm run build` — clean.
- [ ] **Step 3:** `git diff main -- package.json package-lock.json ui/package.json ui/package-lock.json` — empty.

---

## Self-review notes (already applied)

- Spec §6 return-type conflict resolved as a header-documented deviation (structured `sendFromUser`, endpoint maps 1:1).
- `pendingAsk` client-side derivation impossible from `MailView` (no `inReplyTo` field) — the plan pins the simple form; the server's existing 409 on double-answer is the guard. `userThreads.pending_ask` (server-side, derived correctly) drives the 🙋 list marker.
- Route order checked: `/api/mail/compose` and `/api/mail/mine` are exact-match paths that cannot collide with the `thread/:id`, `:id/answer`, `:id/read` regexes.
- Test counts: 6+3+3+2 = 11 new in one file; Task 4's two e2e tests intentionally pass pre-listener (they pin substrate; the listener is untestable composition-root wiring whose predicate is Task 1-pinned).
- `mail-endpoints.test.ts` deps cast may need a real `Mailbox` after `WebDeps` gains the field — flagged in Task 3 Step 4, not silently.
