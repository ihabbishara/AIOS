# User-Addressable Mail (Agent Asks You) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent can `ask_mail` the human mid-goal; its goal parks; the human answers from Mission Control or by replying `@agent …` in the primary chat; the same goal resumes via the existing `resumeFromAnswer` path.

**Architecture:** Reserved `'user'` target (NOT a registry entry) + new `'awaiting-human'` mail status that bypasses the sweeper entirely. Everything downstream — park, resume, thread stamping, boot reconcile — reuses the shipped substrate unchanged. Two answer surfaces converge on one new engine method `answerUserMail`.

**Tech Stack:** TypeScript (Node), `node:sqlite` (synchronous), vitest, React UI.

**Spec:** `docs/superpowers/specs/2026-07-06-user-addressable-mail-design.md` (approved 2026-07-06). Line numbers below are from main `f7a8cd3`; re-locate by quoted code if drifted.

## Global Constraints

- `node:sqlite` only — no better-sqlite3, no FTS5. DB calls are synchronous.
- No new npm dependencies. `package.json` untouched.
- **No new columns.** `thread_id`/`in_reply_to`/`awaiting_mail` already exist. Only a widened `MailStatus` union + read queries.
- Depth-cap remains the ONLY mail bound. Human-asks are depth-cap-EXEMPT by construction (they bypass the sweeper; asking the owner terminates a chain) — do NOT add a downgrade path for them.
- New/changed struct fields OPTIONAL (test literal-builders keep compiling).
- Answered-ness of a user-ask is DERIVED from `mailAnsweringRequest(id)` — never flip the request's status. It stays `'awaiting-human'` forever.
- Indefinite park is correct (no TTL, no auto-decline).
- NO compose/inbox tab — reply affordance on an existing pending question only (spec §2).
- The human target bypasses the private-visibility wall as recipient (owner always reachable); agent↔agent walls untouched.
- Do NOT call `onQueued` for user-asks (nothing to sweep/spawn).
- New mail queries take `ORDER BY created_at ASC, rowid ASC` (same-ms tiebreak — review lesson from the fix wave).
- Test baseline: **859 pass + 1 skip**. Full suite green per task; final task also runs both `tsc --noEmit` + `cd ui && npm run build`.
- Commit per task, conventional-commit style.

---

### Task 1: Store — `awaiting-human` status + pending-ask queries

**Files:**
- Modify: `src/store/db.ts` (`MailStatus` union ~line 37; new queries next to `mailAnsweringRequest` ~line 730)
- Test: `test/mail-store.test.ts`

**Interfaces:**
- Produces: `MailStatus` includes `"awaiting-human"`; `Store.pendingUserAsks(): MailRow[]`; `Store.pendingUserAsksFrom(agent: string): MailRow[]`. Later tasks rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Add to `test/mail-store.test.ts` (the file's `Store(":memory:")` + insertMail literal pattern is established; `mail(over)`-style builders exist in sibling files — inline literals are fine here, matching the file's own style):

```ts
describe("user-ask store layer", () => {
  const userAsk = (store: Store, id: string, from = "vulcan") =>
    store.insertMail({
      id, from_agent: from, to_agent: "user", kind: "request", body: `q-${id}`,
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "awaiting-human", error: null,
    });

  it("awaiting-human requests never enter the sweeper's queue", () => {
    const store = new Store(":memory:");
    userAsk(store, "u1");
    expect(store.queuedRequests()).toHaveLength(0);
  });

  it("pendingUserAsks lists unanswered user-asks oldest-first; answered ones drop out", () => {
    const store = new Store(":memory:");
    userAsk(store, "u1");
    userAsk(store, "u2");
    expect(store.pendingUserAsks().map((m) => m.id)).toEqual(["u1", "u2"]); // same-ms → rowid tiebreak
    store.insertMail({
      id: "r1", from_agent: "user", to_agent: "vulcan", kind: "report", body: "a",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "unread", error: null, in_reply_to: "u1",
    });
    expect(store.pendingUserAsks().map((m) => m.id)).toEqual(["u2"]); // derived, status untouched
    expect(store.getMail("u1")!.status).toBe("awaiting-human");
  });

  it("pendingUserAsksFrom filters by asking agent", () => {
    const store = new Store(":memory:");
    userAsk(store, "u1", "vulcan");
    userAsk(store, "u2", "athena");
    expect(store.pendingUserAsksFrom("vulcan").map((m) => m.id)).toEqual(["u1"]);
    expect(store.pendingUserAsksFrom("nobody")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mail-store.test.ts -t "user-ask"`
Expected: FAIL — TS error `"awaiting-human"` not assignable to `MailStatus`, and/or `pendingUserAsks is not a function`.

- [ ] **Step 3: Implement**

(a) `src/store/db.ts:37` — widen the union:

```ts
export type MailStatus = "queued" | "planning" | "spawned" | "refused" | "unread" | "read" | "awaiting-human";
```

(No CHECK constraints exist anywhere in the schema — verified during the fix-wave review — so this is a TS-only widening; old DBs accept the new value.)

(b) Next to `mailAnsweringRequest` (~line 730):

```ts
  /** Unanswered questions addressed to the human, oldest first. Answered-ness is DERIVED
   *  (a report carrying in_reply_to exists) — the request's own status never changes. */
  pendingUserAsks(): MailRow[] {
    return this.db.prepare(
      "SELECT * FROM mail WHERE kind = 'request' AND to_agent = 'user' AND status = 'awaiting-human' " +
      "AND id NOT IN (SELECT in_reply_to FROM mail WHERE in_reply_to IS NOT NULL) " +
      "ORDER BY created_at ASC, rowid ASC",
    ).all() as unknown as MailRow[];
  }

  /** Same, filtered to one asking agent (drives the chat @agent-answer intercept). */
  pendingUserAsksFrom(agent: string): MailRow[] {
    return this.db.prepare(
      "SELECT * FROM mail WHERE kind = 'request' AND to_agent = 'user' AND status = 'awaiting-human' " +
      "AND from_agent = ? " +
      "AND id NOT IN (SELECT in_reply_to FROM mail WHERE in_reply_to IS NOT NULL) " +
      "ORDER BY created_at ASC, rowid ASC",
    ).all(agent) as unknown as MailRow[];
  }
```

- [ ] **Step 4: Run tests + whole file**

Run: `npx vitest run test/mail-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts test/mail-store.test.ts
git commit -m "feat(mail): awaiting-human status + pending user-ask queries"
```

---

### Task 2: Events + Mailbox user branch

**Files:**
- Modify: `src/events.ts` (union, after `mail.read` line 27), `src/heartbeat/triage.ts` (hard-guard lines 83-84), `src/mail/mailbox.ts` (`ask` method + exported helpers)
- Test: `test/mailbox.test.ts` (+ triage pin in `test/mail-store.test.ts`)

**Interfaces:**
- Consumes: Task 1's `"awaiting-human"` status.
- Produces: `export const USER = "user"`, `export function isUserTarget(to: string): boolean` (from `src/mail/mailbox.ts`); event `{ type: "mail.asked_user"; id: string; from: string; question: string; goalId: string }`. Tasks 4/6 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Add to `test/mailbox.test.ts` (the file's `fixtureRegistry()`, `PRIMARY`, and `harness(over)` helpers exist at the top; `vulcan` has alias `developer`; `midas` is private/finance). Compose ctx like existing ask tests — `{ from, origin: PRIMARY, goalDepth, goalId, nodeKey }` — and create the parked goal with `store.insertGoal`/`insertNodes` the way the file's existing ask tests do:

```ts
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
      const { store, mailbox } = harness();
      goalFixture(store);
      const out = mailbox.ask({ from: "vulcan", origin: PRIMARY, goalDepth: 1, goalId: "g1", nodeKey: "ask" },
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
    const events: AiosEvent[] = [];
    let queued = 0;
    const { store, mailbox } = harness({ onEvent: (e) => events.push(e), onQueued: () => queued++ });
    goalFixture(store);
    mailbox.ask({ from: "vulcan", origin: PRIMARY, goalDepth: 0, goalId: "g1", nodeKey: "ask" },
      { to: "you", question: "q?" });
    expect(events.some((e) => e.type === "mail.asked_user" && e.from === "vulcan" && e.goalId === "g1")).toBe(true);
    expect(queued).toBe(0);
  });

  it("a private agent CAN ask the user from any origin (no wall on the owner)", () => {
    const { store, mailbox } = harness();
    goalFixture(store);
    const out = mailbox.ask({ from: "midas", origin: { channel: "web", chatId: "ui" }, goalDepth: 0, goalId: "g1", nodeKey: "ask" },
      { to: "user", question: "budget?" });
    expect(out).toContain("Question sent to you");
    expect(store.pendingUserAsks()).toHaveLength(1);
  });

  it("user-ask refuses outside a goal, when disabled, and when already parked", () => {
    const { mailbox: disabled } = harness({ disabled: true });
    expect(disabled.ask({ from: "vulcan", origin: PRIMARY, goalDepth: 0, goalId: "g1" }, { to: "user", question: "q" }))
      .toContain("disabled");
    const { store, mailbox } = harness();
    goalFixture(store);
    expect(mailbox.ask({ from: "vulcan", origin: PRIMARY, goalDepth: 0 }, { to: "user", question: "q" }))
      .toContain("only works inside a goal");
    mailbox.ask({ from: "vulcan", origin: PRIMARY, goalDepth: 0, goalId: "g1", nodeKey: "ask" }, { to: "user", question: "q1" });
    expect(mailbox.ask({ from: "vulcan", origin: PRIMARY, goalDepth: 0, goalId: "g1" }, { to: "user", question: "q2" }))
      .toContain("already have a pending question");
  });

  it("user-ask inside a mail-spawned goal continues the incoming thread", () => {
    const { store, mailbox } = harness();
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
    mailbox.ask({ from: "vulcan", origin: PRIMARY, goalDepth: 1, goalId: "g2", nodeKey: "task" },
      { to: "user", question: "q?" });
    expect(store.pendingUserAsks()[0].thread_id).toBe("t-root");
  });
});
```

And extend the triage hard-guard pin in `test/mail-store.test.ts` (find the existing `mail.sent`/`mail.spawned`/`mail.read` ignore pins, ~line 108-152) with a parallel case for `{ type: "mail.asked_user", id: "x", from: "vulcan", question: "q", goalId: "g" }` — ignored even with a matching `mail.*` user rule, exactly like its siblings.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mailbox.test.ts test/mail-store.test.ts`
Expected: FAIL — user target resolves as `Unknown recipient "user"`; `mail.asked_user` not in the event union (TS error).

- [ ] **Step 3: Implement**

(a) `src/events.ts` — extend the union after `mail.read` (line 27):

```ts
  | { type: "mail.read"; ids: string[] }
  | { type: "mail.asked_user"; id: string; from: string; question: string; goalId: string };
```

(b) `src/heartbeat/triage.ts:83-84` — add to the hard-guard:

```ts
    if (event.type === "triage.decision" || event.type === "brief.sent" ||
        event.type === "mail.sent" || event.type === "mail.spawned" || event.type === "mail.read" ||
        event.type === "mail.asked_user") return;
```

(c) `src/mail/mailbox.ts` — exported helpers near the top (after the imports):

```ts
/** Reserved human target — NOT a registry entry. A registry agent named/aliased one of
 *  these would be shadowed here (the user branch is checked first); don't name agents these. */
export const USER = "user";
const USER_ALIASES = new Set([USER, "you", "me", "owner", "principal"]);
export const isUserTarget = (to: string): boolean => USER_ALIASES.has(to.trim().toLowerCase());
```

(d) In `Mailbox.ask` — insert the user branch AFTER the existing `disabled` and `goalId` guards (mailbox.ts:71-72) and BEFORE `resolveRecipient` is called. Do NOT reorder the existing agent-path checks (their refusal precedence is pinned by deterministic tests from a1b3e59):

```ts
    if (isUserTarget(args.to)) {
      const goal = this.deps.store.getGoal(ctx.goalId);
      if (goal?.awaiting_mail) return `Refused: you already have a pending question (mail ${goal.awaiting_mail}).`;
      // No private-visibility wall: the owner is always reachable (spec §6).
      const parentThread = goal?.spawned_by_mail
        ? this.deps.store.getMail(goal.spawned_by_mail)?.thread_id : undefined;
      const id = randomUUID();
      this.deps.store.transaction(() => {
        this.deps.store.insertMail({
          id, from_agent: ctx.from, to_agent: USER, kind: "request", body: args.question,
          goal_id: null, origin_channel: ctx.origin.channel, origin_chat_id: ctx.origin.chatId,
          // ponytail: depth-cap exempt by construction — awaiting-human never enters the
          // sweeper, and asking the owner terminates a chain (the human doesn't fan out).
          chain_depth: ctx.goalDepth + 1, status: "awaiting-human", error: null,
          thread_id: parentThread ?? id, in_reply_to: null,
        });
        this.deps.store.parkGoalAwaiting(ctx.goalId!, id);
        if (ctx.nodeKey) this.deps.store.updateNodeStatus(ctx.goalId!, ctx.nodeKey, "done");
      });
      this.deps.onEvent?.({ type: "mail.asked_user", id, from: ctx.from, question: args.question, goalId: ctx.goalId });
      // NO onQueued — nothing to sweep/spawn.
      return `Question sent to you — your task pauses and resumes automatically when you answer ` +
        `(Mission Control, or reply @${ctx.from} in chat).`;
    }
```

- [ ] **Step 4: Run tests + both files**

Run: `npx vitest run test/mailbox.test.ts test/mail-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events.ts src/heartbeat/triage.ts src/mail/mailbox.ts test/mailbox.test.ts test/mail-store.test.ts
git commit -m "feat(mail): ask_mail user target — park goal on a question to the human"
```

---

### Task 3: Engine — `answerUserMail`

**Files:**
- Modify: `src/engine/goals.ts` (new public method next to `resumeFromAnswer` ~line 510)
- Test: `test/mail-sweep.test.ts` (its `harness()` builds a real engine + store)

**Interfaces:**
- Consumes: Task 1's `pendingUserAsks`; existing `resumeFromAnswer(requestId, answerBody)` and `mailAnsweringRequest(id)`.
- Produces: `GoalEngine.answerUserMail(mailId: string, text: string): { ok: true } | { ok: false; reason: string }`. Tasks 4/5 rely on this exact signature.

- [ ] **Step 1: Write the failing test**

Add to `test/mail-sweep.test.ts` (uses the file's `harness(okRun)`; parked-goal setup mirrors the file's existing H2/M1 tests):

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mail-sweep.test.ts -t "answerUserMail"`
Expected: FAIL — `engine.answerUserMail is not a function`.

- [ ] **Step 3: Implement**

In `src/engine/goals.ts`, directly above `resumeFromAnswer` (~line 508):

```ts
  /** Owner answers a pending user-ask (Mission Control POST or chat intercept): insert the
   *  answering report, then resume the parked asker via the shared path. Double-submit safe —
   *  answered-ness is derived from mailAnsweringRequest, the request's status never changes. */
  answerUserMail(mailId: string, text: string): { ok: true } | { ok: false; reason: string } {
    const m = this.deps.store.getMail(mailId);
    if (!m || m.kind !== "request" || m.to_agent !== "user" || m.status !== "awaiting-human")
      return { ok: false, reason: "not a pending question" };
    if (this.deps.store.mailAnsweringRequest(m.id)) return { ok: false, reason: "already answered" };
    if (!text.trim()) return { ok: false, reason: "empty answer" };
    const id = randomUUID();
    this.deps.store.insertMail({
      id, from_agent: "user", to_agent: m.from_agent, kind: "report", body: text,
      goal_id: null, origin_channel: m.origin_channel, origin_chat_id: m.origin_chat_id,
      chain_depth: m.chain_depth, status: "unread", error: null,
      thread_id: m.thread_id ?? m.id, in_reply_to: m.id,
    });
    this.emit({ type: "mail.sent", id, from: "user", to: m.from_agent, kind: "report" });
    this.resumeFromAnswer(m.id, text);
    return { ok: true };
  }
```

(Boot reconcile needs NO change: `resumeUnfinished` already resumes any parked goal whose `mailAnsweringRequest(awaiting_mail)` exists — an answer submitted just before a crash resumes at boot. An unanswered user-ask stays parked, which is correct: indefinite park.)

- [ ] **Step 4: Run test + whole file**

Run: `npx vitest run test/mail-sweep.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/goals.ts test/mail-sweep.test.ts
git commit -m "feat(mail): answerUserMail — owner's answer resumes the parked asker"
```

---

### Task 4: Chat surface — `@agent` answer intercept + ask notification

**Files:**
- Modify: `src/engine/goals.ts` (small `answerFromChat` next to `answerUserMail`), `src/index.ts` (notification listener + `onMessage` intercept, ~line 315)
- Test: `test/mail-sweep.test.ts`

**Interfaces:**
- Consumes: Task 3's `answerUserMail`; Task 1's `pendingUserAsksFrom`; Task 2's `mail.asked_user` event; `GoalEngineDeps.registry` (already present).
- Produces: `GoalEngine.answerFromChat(text: string): string | null` — null means "not an answer, route normally".

- [ ] **Step 1: Write the failing test**

Add to `test/mail-sweep.test.ts` inside the `answerUserMail` describe (reuses its `parkedOnUserAsk` helper; fixture registry: `athena`/`vulcan` in engineering — check the file's `fixtureRegistry`; vulcan has no alias in THIS file's fixture, so test canonical names):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mail-sweep.test.ts -t "answerFromChat"`
Expected: FAIL — `answerFromChat is not a function`.

- [ ] **Step 3: Implement the engine method**

In `src/engine/goals.ts`, directly below `answerUserMail`:

```ts
  /** Primary-chat "@agent <answer>" intercept core. Fires ONLY when that agent has a pending
   *  user-ask (oldest wins); returns the confirmation reply, or null → normal routing.
   *  Bare messages and unknown/idle @mentions are never intercepted. */
  answerFromChat(text: string): string | null {
    const m = /^@([\w-]+)\s+([\s\S]+)$/.exec(text.trim());
    if (!m) return null;
    const agent = this.deps.registry.agentOf.get(m[1]);
    if (!agent) return null;
    const pending = this.deps.store.pendingUserAsksFrom(agent);
    if (!pending.length) return null;
    const res = this.answerUserMail(pending[0].id, m[2]);
    return res.ok ? `Answer sent to ${agent} — resuming.` : null; // lost race → fall through
  }
```

- [ ] **Step 4: Run test, then wire `src/index.ts`**

Run: `npx vitest run test/mail-sweep.test.ts` → PASS. Then two edits in `src/index.ts`:

(a) Notification — add a bus listener next to the existing `bus.on` blocks (match the local send helper; the brief-ping helpers around index.ts:428-435 use `sendVia(channel, chatId, text)`):

```ts
  // An agent asked the human a question — ping the owner's primary chat (transport-only,
  // never vaulted/indexed; safe even for private-dept askers — it's the owner's own channel).
  bus.on((e) => {
    if (e.type !== "mail.asked_user" || !config.primaryChat) return;
    void sendVia(config.primaryChat.channel, config.primaryChat.chatId,
      `🙋 ${e.from} is asking:\n${e.question}\n\nAnswer in Mission Control, or reply here: @${e.from} <your answer>`,
    ).catch((err) => log(`ask ping failed: ${(err as Error).message}`));
  });
```

(If `sendVia` is declared after this point in the file, place the listener after `sendVia`'s declaration — it's a hoisting-safe closure either way since it only fires on events.)

(b) Intercept — in `onMessage` (index.ts:315), FIRST statement inside the `try`, before `router.handle`:

```ts
      // Owner answering a pending agent question — primary chat only, BEFORE routing.
      if (config.primaryChat && msg.channel === config.primaryChat.channel &&
          msg.chatId === config.primaryChat.chatId) {
        const answered = goals.answerFromChat(msg.text);
        if (answered) {
          await channels.get(msg.channel)?.send(msg.chatId, answered);
          return;
        }
      }
```

(`goals` is in scope in `onMessage` — it's used by the router construction just above.)

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean; suite ≥ Task-3 count, zero failures. (The index.ts wiring has no unit test — convention for this file; it is exercised in the live smoke at the end.)

- [ ] **Step 6: Commit**

```bash
git add src/engine/goals.ts src/index.ts test/mail-sweep.test.ts
git commit -m "feat(mail): primary-chat @agent answer intercept + ask notification ping"
```

---

### Task 5: Web API — answer endpoint + pending count + goal-detail ask

**Files:**
- Modify: `src/web/goals-view.ts` (`buildMailUnread` ~line 81; `buildGoalDetail` ~line 44), `src/web/server.ts` (route next to the mail GETs ~line 434)
- Test: `test/mail-endpoints.test.ts`

**Interfaces:**
- Consumes: Task 3's `answerUserMail` (server deps already include `goals: GoalEngine`); Task 1's `pendingUserAsks`.
- Produces: `POST /api/mail/:id/answer {text}` → `200 {resumed:true}` | `409 {error}` | `400 {error}`; `buildMailUnread` return gains `pendingUser: number`; `buildGoalDetail` return gains `awaitingUserAsk: { mailId: string; question: string; from: string } | null`. Task 6 relies on these exact shapes.

- [ ] **Step 1: Write the failing tests**

Add to `test/mail-endpoints.test.ts` (follow the file's existing server-spinning harness and auth-header pattern exactly — it already tests `/api/mail/unread` and the thread route; reuse its fixture store/engine setup; insert an awaiting-human request + parked goal like Task 3's `parkedOnUserAsk`):

```ts
  it("POST /api/mail/:id/answer answers once: 200 then 409; 400 on empty; 401 unauthorized", async () => {
    // setup: parked goal gask awaiting user-ask u1 (same rows as the engine test)
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
    const noauth = await fetch(`${base}/api/mail/u1/answer`, { method: "POST", body: JSON.stringify({ text: "x" }) });
    expect(noauth.status).toBe(401);
  });

  it("GET /api/mail/unread carries pendingUser; goal detail carries awaitingUserAsk", async () => {
    // with one unanswered user-ask u2 parked on goal gask2:
    const unread = await (await fetch(`${base}/api/mail/unread`, { headers: auth })).json();
    expect(unread.pendingUser).toBe(1);
    const detail = await (await fetch(`${base}/api/goals/gask2`, { headers: auth })).json();
    expect(detail.awaitingUserAsk).toEqual({ mailId: "u2", question: expect.any(String), from: expect.any(String) });
  });
```

(Adapt fixture ids/setup to the file's harness — the assertions and status codes above are the requirement.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mail-endpoints.test.ts`
Expected: FAIL — 404 (route missing), `pendingUser` undefined.

- [ ] **Step 3: Implement**

(a) `src/web/goals-view.ts` — `buildMailUnread`:

```ts
/** Unread inbound mail per agent + grand total + questions waiting on the human. */
export function buildMailUnread(store: Store): { total: number; byAgent: Record<string, number>; pendingUser: number } {
  const byAgent = store.unreadCountsByAgent();
  const total = Object.values(byAgent).reduce((s, n) => s + n, 0);
  return { total, byAgent, pendingUser: store.pendingUserAsks().length };
}
```

(b) `src/web/goals-view.ts` — in `buildGoalDetail`, extend the return (current: `return { ...goalView(g, store), artifacts, spawnedBy };`):

```ts
  const askMail = g.awaiting_mail ? store.getMail(g.awaiting_mail) : undefined;
  const awaitingUserAsk =
    askMail && askMail.to_agent === "user" && askMail.status === "awaiting-human" &&
    !store.mailAnsweringRequest(askMail.id)
      ? { mailId: askMail.id, question: askMail.body, from: askMail.from_agent }
      : null;
  return { ...goalView(g, store), artifacts, spawnedBy, awaitingUserAsk };
```

(c) `src/web/server.ts` — add the route next to the existing mail routes (before `threadMatch` is fine; the `/api/mail/thread/:id` regex cannot collide with `/:id/answer`):

```ts
        const answerMatch = /^\/api\/mail\/([\w-]+)\/answer$/.exec(path);
        if (answerMatch && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { text?: string };
          if (!body.text?.trim()) return json(res, 400, { error: "text required" });
          const result = goals.answerUserMail(answerMatch[1], body.text);
          return result.ok ? json(res, 200, { resumed: true }) : json(res, 409, { error: result.reason });
        }
```

- [ ] **Step 4: Run tests + whole file**

Run: `npx vitest run test/mail-endpoints.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/goals-view.ts src/web/server.ts test/mail-endpoints.test.ts
git commit -m "feat(mail): answer endpoint, pendingUser count, goal-detail awaitingUserAsk"
```

---

### Task 6: UI — reply box on the parked question + 🙋 indicator

**Files:**
- Modify: `ui/src/api.ts`, `ui/src/views/Goals.tsx` (GoalDetailView, ~line 116-180), `ui/src/App.tsx` (AGENT_MAIL_EVENTS line 20 + nav badge ~line 90), `ui/src/views/Org.tsx` (AGENT_MAIL_EVENTS const)
- Test: `cd ui && npx tsc --noEmit && npm run build` (no UI test runner in this repo — plan 4b precedent)

**Interfaces:**
- Consumes: Task 5's endpoint + `pendingUser` + `awaitingUserAsk` shapes.

- [ ] **Step 1: api.ts surface**

Extend `GoalDetail` (line 134):

```ts
  awaitingUserAsk: { mailId: string; question: string; from: string } | null;
```

Extend the `mailUnread` return type with `pendingUser: number`:

```ts
  mailUnread: () => request<{ total: number; byAgent: Record<string, number>; pendingUser: number }>("/api/mail/unread"),
```

Add the answer call — follow the file's existing POST idiom (the goal pause/resume/abandon calls show it; match `request`'s actual options signature):

```ts
  answerMail: (id: string, text: string) =>
    request<{ resumed: boolean }>(`/api/mail/${encodeURIComponent(id)}/answer`, {
      method: "POST", body: JSON.stringify({ text }),
    }),
```

- [ ] **Step 2: Goals.tsx reply box**

In `GoalDetailView`, after the `goal.error` line (~line 171) and near the `spawnedBy` provenance block (~line 172-178), render the pending question with a reply box when `goal.awaitingUserAsk` is set. Match the file's styling idiom (hud panels, text size classes) — skeleton:

```tsx
      {goal.awaitingUserAsk && (
        <div className="hud hud-cyan p-3 mt-2">
          <div className="text-[10px] uppercase tracking-widest text-cyan">🙋 {goal.awaitingUserAsk.from} is asking</div>
          <div className="text-[12px] text-bright mt-1 whitespace-pre-wrap">{goal.awaitingUserAsk.question}</div>
          <div className="flex gap-2 mt-2">
            <input value={answer} onChange={(e) => setAnswer(e.target.value)}
              placeholder="your answer…"
              className="flex-1 bg-transparent border border-cyan/40 px-2 py-1 text-[12px] text-bright outline-none" />
            <button disabled={!answer.trim()}
              onClick={() => { void api.answerMail(goal.awaitingUserAsk!.mailId, answer).then(() => { setAnswer(""); refetch(); }); }}
              className="text-[11px] text-cyan border border-cyan px-2">send</button>
          </div>
        </div>
      )}
```

with `const [answer, setAnswer] = useState("");` added to `GoalDetailView`'s state, and `refetch` = whatever the component already uses to reload the goal detail (it polls via `usePoll` keyed on events — reuse that; if there's no manual refetch handle, rely on the `mail.sent`-driven event refresh and clear the input optimistically).

- [ ] **Step 3: badges + event sets**

In BOTH `ui/src/App.tsx:20` and `ui/src/views/Org.tsx` (module-scope const), extend the set (keep the two identical):

```ts
const AGENT_MAIL_EVENTS = new Set(["mail.sent", "mail.spawned", "mail.read", "mail.asked_user"]);
```

In `App.tsx`'s nav (next to the existing org unread badge ~line 90), show the waiting-on-you indicator on the goals tab:

```tsx
              {t === "goals" && unread && unread.pendingUser > 0 && (
                <span className="ml-2 text-[9px] text-void bg-cyan px-1.5 rounded-full tracking-normal align-middle">🙋 {unread.pendingUser}</span>
              )}
```

- [ ] **Step 4: Verify**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean, build green.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/views/Goals.tsx ui/src/App.tsx ui/src/views/Org.tsx
git commit -m "feat(ui): reply box on pending user-ask + waiting-on-you badge"
```

---

### Task 7: Full verification

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: **≥873 passed + 1 skipped** (859 baseline + ~14 new cases), zero failures.

- [ ] **Step 2: Typechecks + UI build + dep drift**

Run: `npx tsc --noEmit && (cd ui && npx tsc --noEmit && npm run build) && git diff origin/main --stat -- package.json package-lock.json`
Expected: all clean; empty dep diff.

---

## Explicitly out of scope (spec §2)

- Human-originated cold mail to an agent (durable-task direction) — separate cycle.
- Compose/inbox tab.
- Answer TTL / auto-decline (indefinite park is the design).
- Driving a real agent ask on the LIVE daemon post-deploy (spends + mutates; the ask→park→answer→resume path is unit-covered end-to-end).
