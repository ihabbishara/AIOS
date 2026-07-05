# Mail threads + mid-goal clarification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a working agent pause mid-goal to ask another agent a question; the goal parks until the answer arrives, then the same goal resumes — with a shared thread substrate that makes the exchange legible.

**Architecture:** A new `ask_mail` tool queues an ordinary `request` mail and parks the caller's goal in a new `awaiting-mail` status keyed by the request id (`goals.awaiting_mail`). The recipient's `report` (which inherits `thread_id` and carries `in_reply_to = <request id>`) triggers the engine to spawn a continuation node in the *same* goal and un-park it. Parking needs no scheduler change — `unfinishedGoals()` already excludes `awaiting-mail`. Turn count is bounded by the existing chain-depth cap; failure/refusal answers also resume, so a goal never parks forever.

**Tech Stack:** TypeScript, `node:sqlite` (no FTS5, no better-sqlite3), Vitest, Claude Agent SDK MCP tool (`aios-mail`).

## Global Constraints

- **Auth:** subscription only (`CLAUDE_CODE_OAUTH_TOKEN`); never `ANTHROPIC_API_KEY`.
- **DB:** `node:sqlite` only. No new npm deps. Migrations are additive (`ALTER TABLE … ADD COLUMN` in try/catch + add to the `CREATE TABLE` DDL). Integer cents.
- **Turn bound = chain-depth cap only** (`AIOS_MAIL_MAX_DEPTH`, default 2). Do NOT add any mail quota / fan-out / budget cap.
- **No second exec path:** an ask is a `request` routed through the existing `sweepMail` path (specialist → single node, lead → planned graph). Do not add a parallel spawn path.
- **Walls untouched:** code work enters only via `code_task`; mail-spawned goals get no workspace; private-department visibility wall enforced at send AND sweep.
- **New `MailRow`/`GoalRow` fields are declared OPTIONAL** (`thread_id?`, `in_reply_to?`, `awaiting_mail?`) so existing test literal-builders compile unchanged; they are always populated at insert time.
- **Commits:** every commit message ends with the two standard trailers:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FTMzs2sEmG9ruKgFV1veko
  ```
  (Omitted from the short commit commands below for brevity — add them.)
- **Verify after each task:** `npx vitest run` (836+ pass) and `npx tsc --noEmit` clean before committing.

---

### Task 1: Store — threads + park/resume schema and methods

**Files:**
- Modify: `src/store/db.ts` (types ~7, 34–51; CREATE TABLE `goals` ~174, `mail` ~215; migrations ~251–265; `insertMail` ~615)
- Test: `test/mail-store.test.ts`

**Interfaces:**
- Produces:
  - `type GoalStatus` gains `"awaiting-mail"`.
  - `MailRow` gains `thread_id?: string; in_reply_to?: string | null`.
  - `GoalRow` gains `awaiting_mail?: string | null`.
  - `Store.insertMail(m)` now defaults `thread_id` to `m.id` and `in_reply_to` to `null` when omitted.
  - `Store.parkGoalAwaiting(goalId: string, mailId: string): void`
  - `Store.clearAwaiting(goalId: string): void`
  - `Store.goalAwaiting(mailId: string): GoalRow | undefined` — the goal parked on that request (status `awaiting-mail`).
  - `Store.awaitingMailGoals(): GoalRow[]`
  - `Store.mailAnsweringRequest(requestId: string): MailRow | undefined` — newest mail whose `in_reply_to = requestId`.
  - `Store.mailThread(threadId: string): MailRow[]` — ordered by `created_at ASC`.

- [ ] **Step 1: Write the failing tests**

Add to the end of `test/mail-store.test.ts` (inside `describe("mail store", …)`), before its closing `});`:

```typescript
  it("stamps thread_id = own id by default and groups a thread in order", () => {
    const s = new Store(":memory:");
    s.insertMail(mail({ id: "root", body: "please analyze" }));                          // new thread
    s.insertMail(mail({ id: "rep", from_agent: "vulcan", to_agent: "athena", kind: "report",
      body: "Done", thread_id: "root", in_reply_to: "root", status: "unread" }));
    expect(s.getMail("root")!.thread_id).toBe("root");
    expect(s.getMail("rep")!.in_reply_to).toBe("root");
    expect(s.mailThread("root").map((m) => m.id)).toEqual(["root", "rep"]);
    expect(s.mailAnsweringRequest("root")!.id).toBe("rep");
  });

  it("parks a goal on a mail and finds/clears it", () => {
    const s = new Store(":memory:");
    s.insertGoal({
      id: "g1", slug: "g1", title: "t", request: "r", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "running", project_dir: null,
      goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, error: null,
    });
    s.parkGoalAwaiting("g1", "mX");
    expect(s.getGoal("g1")).toMatchObject({ status: "awaiting-mail", awaiting_mail: "mX" });
    expect(s.goalAwaiting("mX")!.id).toBe("g1");
    expect(s.awaitingMailGoals().map((g) => g.id)).toEqual(["g1"]);
    s.clearAwaiting("g1");
    s.updateGoalStatus("g1", "running");
    expect(s.goalAwaiting("mX")).toBeUndefined();
    expect(s.getGoal("g1")!.awaiting_mail).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mail-store.test.ts`
Expected: FAIL — `mailThread`/`parkGoalAwaiting`/`goalAwaiting`/`clearAwaiting`/`awaitingMailGoals`/`mailAnsweringRequest` are not functions; `awaiting-mail` not assignable to `GoalStatus`.

- [ ] **Step 3: Add the type fields**

In `src/store/db.ts` line 7, add `"awaiting-mail"` to the union:

```typescript
export type GoalStatus = "planning" | "running" | "paused-budget" | "paused-user" | "replanning" | "done" | "failed" | "abandoned" | "awaiting-mail";
```

In `MailRow` (after `read_at: string | null;`, before the closing `}`):

```typescript
  /** Conversation grouping key; defaults to the mail's own id (a fresh thread). */
  thread_id?: string;
  /** The request id this report/reply answers; null for fresh requests/notes. */
  in_reply_to?: string | null;
```

In `GoalRow` (after `spawned_by_mail: string | null;`):

```typescript
  /** When parked (status 'awaiting-mail'), the request id whose answer un-parks this goal. */
  awaiting_mail?: string | null;
```

- [ ] **Step 4: Add columns to the CREATE TABLE DDL**

In the `CREATE TABLE IF NOT EXISTS mail (…)` block, add after `read_at TEXT`:

```sql
        thread_id TEXT,
        in_reply_to TEXT
```
(Add a comma after `read_at TEXT` so it becomes `read_at TEXT,`.)

In the `CREATE TABLE IF NOT EXISTS goals (…)` block, add after `error TEXT,` and before `created_at TEXT NOT NULL,`:

```sql
        awaiting_mail TEXT,
```

- [ ] **Step 5: Add migrations + backfill**

In `src/store/db.ts`, next to the other `ALTER TABLE` migrations (after the `spawned_by_mail` block ~262), add:

```typescript
    // Migration (mail-threads): conversation id + reply pointer on existing mail rows.
    try { this.db.exec("ALTER TABLE mail ADD COLUMN thread_id TEXT"); } catch { /* exists */ }
    try { this.db.exec("ALTER TABLE mail ADD COLUMN in_reply_to TEXT"); } catch { /* exists */ }
    // Backfill: pre-thread mail each becomes its own singleton thread.
    this.db.exec("UPDATE mail SET thread_id = id WHERE thread_id IS NULL");
    // Migration (mail-clarification): the request a parked goal is blocked on.
    try { this.db.exec("ALTER TABLE goals ADD COLUMN awaiting_mail TEXT"); } catch { /* exists */ }
```

- [ ] **Step 6: Default thread_id / in_reply_to in insertMail**

Replace the `insertMail` method body (~615) with:

```typescript
  insertMail(m: Omit<MailRow, "created_at" | "read_at">): void {
    this.db.prepare(
      `INSERT INTO mail (id, from_agent, to_agent, kind, body, goal_id, origin_channel, origin_chat_id,
                         chain_depth, status, error, thread_id, in_reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.id, m.from_agent, m.to_agent, m.kind, m.body, m.goal_id, m.origin_channel, m.origin_chat_id,
          m.chain_depth, m.status, m.error, m.thread_id ?? m.id, m.in_reply_to ?? null, new Date().toISOString());
  }
```

- [ ] **Step 7: Add the park/resume/thread store methods**

Add these methods to the `Store` class, next to the mailbox methods (after `downgradeMailToNote` ~704):

```typescript
  // --- Mail threads + mid-goal clarification ---

  mailThread(threadId: string): MailRow[] {
    return this.db.prepare("SELECT * FROM mail WHERE thread_id = ? ORDER BY created_at ASC")
      .all(threadId) as unknown as MailRow[];
  }

  /** Newest mail answering a given request (report/refusal-note carrying in_reply_to). */
  mailAnsweringRequest(requestId: string): MailRow | undefined {
    return this.db.prepare("SELECT * FROM mail WHERE in_reply_to = ? ORDER BY created_at DESC LIMIT 1")
      .get(requestId) as MailRow | undefined;
  }

  parkGoalAwaiting(goalId: string, mailId: string): void {
    this.db.prepare("UPDATE goals SET status = 'awaiting-mail', awaiting_mail = ?, updated_at = ? WHERE id = ?")
      .run(mailId, new Date().toISOString(), goalId);
  }

  clearAwaiting(goalId: string): void {
    this.db.prepare("UPDATE goals SET awaiting_mail = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), goalId);
  }

  /** The goal parked on a given request (if any). */
  goalAwaiting(mailId: string): GoalRow | undefined {
    return this.db.prepare("SELECT * FROM goals WHERE awaiting_mail = ? AND status = 'awaiting-mail' LIMIT 1")
      .get(mailId) as GoalRow | undefined;
  }

  awaitingMailGoals(): GoalRow[] {
    return this.db.prepare("SELECT * FROM goals WHERE status = 'awaiting-mail' ORDER BY created_at ASC")
      .all() as unknown as GoalRow[];
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/mail-store.test.ts`
Expected: PASS (all, including the two new tests).

- [ ] **Step 9: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; full suite green (838 pass + 1 skip).

- [ ] **Step 10: Commit**

```bash
git add src/store/db.ts test/mail-store.test.ts
git commit -m "feat(mail): thread_id + in_reply_to + awaiting_mail store layer"
```

---

### Task 2: Mailbox `ask` + `ask_mail` tool + ctx threading

**Files:**
- Modify: `src/mail/mailbox.ts` (`MailSendCtx` ~18; add `ask` method)
- Modify: `src/mail/server.ts` (add `ask_mail` tool + `ASK_TOOL` export)
- Modify: `src/agents/runner.ts` (`mailCtx` type ~112; allowedTools ~145)
- Modify: `src/engine/goals.ts` (`mailCtx` construction in `runAgent` ~109)
- Test: `test/mailbox.test.ts`

**Interfaces:**
- Consumes (from Task 1): `store.parkGoalAwaiting`, `store.getGoal`, `store.getMail`.
- Produces:
  - `MailSendCtx` gains `goalId?: string; nodeKey?: string`.
  - `Mailbox.ask(ctx: MailSendCtx, args: { to: string; question: string }): string` — tool-friendly, never throws.
  - `ASK_TOOL = "mcp__aios-mail__ask_mail"` exported from `src/mail/server.ts`.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `test/mailbox.test.ts` (after the existing `describe("Mailbox.send", …)`):

```typescript
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
});
```

Add a `mail()` helper to `test/mailbox.test.ts` if not present (it currently has none — send-based tests don't need it). Add near the top, after `const CTX = …`:

```typescript
function mail(over: Partial<import("../src/store/db.js").MailRow> = {}) {
  return {
    id: over.id ?? "m1", from_agent: over.from_agent ?? "vulcan", to_agent: over.to_agent ?? "athena",
    kind: over.kind ?? "request", body: over.body ?? "b", goal_id: over.goal_id ?? null,
    origin_channel: "telegram", origin_chat_id: "1", chain_depth: over.chain_depth ?? 0,
    status: over.status ?? "queued", error: null, thread_id: over.thread_id, in_reply_to: over.in_reply_to,
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mailbox.test.ts`
Expected: FAIL — `mb.ask` is not a function.

- [ ] **Step 3: Add `goalId`/`nodeKey` to `MailSendCtx`**

In `src/mail/mailbox.ts`, extend the `MailSendCtx` interface:

```typescript
export interface MailSendCtx {
  from: string;
  origin: { channel: string; chatId: string };
  goalDepth: number;
  /** Set when the run is a goal node — enables ask_mail to park the goal. */
  goalId?: string;
  nodeKey?: string;
}
```

- [ ] **Step 4: Add the `ask` method to `Mailbox`**

In `src/mail/mailbox.ts`, add this method to the `Mailbox` class (after `send`, before `peekInbound`). It reuses `send`'s validation shape:

```typescript
  /** Ask another agent a question mid-goal. Queues a request AND parks the caller's goal
   *  until the answer reports back. Tool-friendly: always returns a string, never throws. */
  ask(ctx: MailSendCtx, args: { to: string; question: string }): string {
    if (this.deps.disabled) return "Refused: the mailbox is disabled (AIOS_MAIL_DISABLED).";
    if (!ctx.goalId) return "Refused: ask_mail only works inside a goal (use send_mail for fire-and-forget).";
    const canonical = this.deps.registry.agentOf.get(args.to);
    const def = canonical ? this.deps.registry.agents.get(canonical) : undefined;
    if (!canonical || !def) return `Refused: Unknown recipient "${args.to}".`;
    if (canonical === ctx.from) return "Refused: you can't ask yourself.";
    if (def.manifest.visibility === "private" &&
        !isPrivateOrigin(this.deps.primaryChat, ctx.origin.channel, ctx.origin.chatId)) {
      return `Refused: ${canonical} is private — this chat's origin can't reach them.`;
    }
    const goal = this.deps.store.getGoal(ctx.goalId);
    if (goal?.awaiting_mail) return `Refused: you already have a pending question (mail ${goal.awaiting_mail}).`;
    // Continue the goal's incoming conversation when it was itself mail-spawned; else a fresh thread.
    const parentThread = goal?.spawned_by_mail
      ? this.deps.store.getMail(goal.spawned_by_mail)?.thread_id : undefined;
    const id = randomUUID();
    this.deps.store.insertMail({
      id, from_agent: ctx.from, to_agent: canonical, kind: "request", body: args.question,
      goal_id: null, origin_channel: ctx.origin.channel, origin_chat_id: ctx.origin.chatId,
      chain_depth: ctx.goalDepth + 1, status: "queued", error: null,
      thread_id: parentThread ?? id, in_reply_to: null,
    });
    this.deps.store.parkGoalAwaiting(ctx.goalId, id);
    this.deps.onEvent?.({ type: "mail.sent", id, from: ctx.from, to: canonical, kind: "request" });
    this.deps.onQueued?.();
    return `Question sent to ${canonical}. Your task will pause and resume automatically when they answer.`;
  }
```

- [ ] **Step 5: Add the `ask_mail` tool to the mail server**

Replace `src/mail/server.ts` with:

```typescript
// src/mail/server.ts — per-run aios-mail MCP server; sender identity/origin/depth baked, non-spoofable.
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Mailbox, MailSendCtx } from "./mailbox.js";

export const MAIL_TOOL = "mcp__aios-mail__send_mail";
export const ASK_TOOL = "mcp__aios-mail__ask_mail";

export function buildMailServer(mailbox: Mailbox, ctx: MailSendCtx) {
  const sendMail = tool(
    "send_mail",
    "Send mail to another staff agent. kind=request: they run it as a goal later and the result " +
      "reports back to you automatically. kind=note: FYI only, nothing runs.",
    { to: z.string(), kind: z.enum(["request", "note"]), body: z.string() },
    async (a) => ({ content: [{ type: "text" as const, text: mailbox.send(ctx, a) }] }),
  );
  const askMail = tool(
    "ask_mail",
    "Ask another staff agent a question and PAUSE your current task until they answer. Your goal " +
      "resumes automatically with their reply. Use this when you need input to continue; use send_mail " +
      "for fire-and-forget. Only works inside a goal.",
    { to: z.string(), question: z.string() },
    async (a) => ({ content: [{ type: "text" as const, text: mailbox.ask(ctx, a) }] }),
  );
  return createSdkMcpServer({ name: "aios-mail", version: "0.1.0", tools: [sendMail, askMail] });
}
```

- [ ] **Step 6: Allow `ask_mail` in run options**

In `src/agents/runner.ts`, update the `mailCtx` field type (~112) to include the goal linkage:

```typescript
  mailCtx?: { origin: { channel: string; chatId: string }; goalDepth: number; goalId?: string; nodeKey?: string };
```

And in `withMailOptions` (~145), add `ASK_TOOL` to the import and to `allowedTools`. Change the import line:

```typescript
import { buildMailServer, MAIL_TOOL, ASK_TOOL } from "../mail/server.js";
```

and the `allowedTools` line:

```typescript
    allowedTools: [...new Set([...(base.allowedTools ?? []), MAIL_TOOL, ASK_TOOL])],
```

- [ ] **Step 7: Thread goalId/nodeKey from the node run**

In `src/engine/goals.ts`, in `runAgent` (~109), extend the `mailCtx` passed to `deps.run`:

```typescript
      mailCtx: { origin: { channel: goal.origin_channel, chatId: goal.origin_chat_id }, goalDepth: goal.chain_depth, goalId: goal.id, nodeKey: node.node_key },
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/mailbox.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; suite green.

- [ ] **Step 10: Commit**

```bash
git add src/mail/mailbox.ts src/mail/server.ts src/agents/runner.ts src/engine/goals.ts test/mailbox.test.ts
git commit -m "feat(mail): ask_mail tool — park caller's goal on a question"
```

---

### Task 3: Engine — resume the parked goal on the answer

**Files:**
- Modify: `src/engine/goals.ts` (`mailReport` ~485; `sweepMail` ~416; `resumeUnfinished` ~595; add `resumeFromAnswer`)
- Test: `test/goal-scheduler.test.ts`

**Interfaces:**
- Consumes (Task 1): `store.goalAwaiting`, `store.getMail`, `store.clearAwaiting`, `store.insertNodes`, `store.listNodes`, `store.awaitingMailGoals`, `store.mailAnsweringRequest`.
- Produces:
  - `GoalEngine.resumeFromAnswer(requestId: string, answerBody: string): void` — private; idempotent (no-op when no goal is parked on `requestId`). Adds a continuation node `resume_<n>` (agent = the asker `from_agent`), clears the park, sets the goal `running`, pumps.
  - `mailReport` now stamps `thread_id` + `in_reply_to` on the report and calls `resumeFromAnswer`.
  - `sweepMail` calls `resumeFromAnswer` after a request is refused or depth-downgraded.
  - `resumeUnfinished` reconciles `awaiting-mail` goals whose answer already landed.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `test/goal-scheduler.test.ts` (after the existing top-level describes). It drives a real recipient goal to completion and asserts the parked asker resumes:

```typescript
describe("GoalEngine mid-goal clarification (park + resume)", () => {
  // A parked asker goal 'g-ask' waits on request 'mQ'; a report answering mQ must resume it.
  // maxConcurrentNodes:0 so pump schedules the resume node but does not launch it (g-ask has no
  // goal_dir in these fixtures) — assertions stay synchronous and deterministic.
  function parkedAsker(store: Store) {
    store.insertGoal({
      id: "g-ask", slug: "g-ask", title: "asker", request: "do the thing", department: "engineering",
      lead: "athena", origin_channel: "telegram", origin_chat_id: "1", status: "running",
      project_dir: null, goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, error: null,
    });
    store.insertNodes("g-ask", [{ node_key: "task", type: "run", agent: "athena", critic: null,
      brief: "b", depends_on: [], max_rounds: 1 }]);
    store.updateNodeStatus("g-ask", "task", "done");
    store.insertMail({ id: "mQ", from_agent: "athena", to_agent: "vulcan", kind: "request",
      body: "which db?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "queued", error: null });
    store.parkGoalAwaiting("g-ask", "mQ");
  }

  it("a report answering the awaited request adds a continuation node and un-parks the goal", async () => {
    const { store, engine } = harness({ maxConcurrentNodes: 0 });
    parkedAsker(store);
    // A recipient goal spawned by mQ completes → mailReport(ok) → resumeFromAnswer.
    store.insertGoal({
      id: "g-rec", slug: "g-rec", title: "rec", request: "which db?", department: "engineering",
      lead: "athena", origin_channel: "telegram", origin_chat_id: "1", status: "running",
      project_dir: null, goal_dir: null, plan_summary: "mail:mQ", replans_used: 0, chain_depth: 1,
      error: null, spawned_by_mail: "mQ",
    });
    store.insertNodes("g-rec", [{ node_key: "task", type: "run", agent: "vulcan", critic: null,
      brief: "answer", depends_on: [], max_rounds: 1 }]);
    store.updateNodeStatus("g-rec", "task", "done");
    await (engine as unknown as { complete: (g: unknown, ok: boolean) => Promise<void> })
      .complete(store.getGoal("g-rec"), true);
    // asker un-parked, a resume node exists, and it got scheduled to run.
    expect(store.getGoal("g-ask")).toMatchObject({ status: "running", awaiting_mail: null });
    const keys = store.listNodes("g-ask").map((n) => n.node_key);
    expect(keys.some((k) => k.startsWith("resume_"))).toBe(true);
    const report = store.mailAnsweringRequest("mQ")!;
    expect(report).toMatchObject({ in_reply_to: "mQ", thread_id: "mQ" });
  });

  it("boot reconcile resumes a parked goal whose answer already landed, leaves others parked", () => {
    const { store, engine } = harness({ maxConcurrentNodes: 0 });
    parkedAsker(store);
    store.insertMail({ id: "rep", from_agent: "vulcan", to_agent: "athena", kind: "report",
      body: "Done: use sqlite", goal_id: "g-rec", origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "unread", error: null, thread_id: "mQ", in_reply_to: "mQ" });
    // second parked goal with NO answer yet
    store.insertGoal({ id: "g2", slug: "g2", title: "t2", request: "r2", department: "engineering",
      lead: "athena", origin_channel: "telegram", origin_chat_id: "1", status: "running",
      project_dir: null, goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, error: null });
    store.parkGoalAwaiting("g2", "mZ");
    engine.resumeUnfinished();
    expect(store.getGoal("g-ask")!.status).toBe("running");
    expect(store.getGoal("g2")!.status).toBe("awaiting-mail");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/goal-scheduler.test.ts`
Expected: FAIL — no continuation node created; asker stays `awaiting-mail`; report lacks `in_reply_to`/`thread_id`.

- [ ] **Step 3: Add `resumeFromAnswer`**

In `src/engine/goals.ts`, add this private method to `GoalEngine` (next to `mailReport` ~499):

```typescript
  /** Un-park a goal waiting on `requestId` by adding a continuation node carrying the answer.
   *  Idempotent: a no-op when no goal is parked on that request (already resumed / never parked). */
  private resumeFromAnswer(requestId: string, answerBody: string): void {
    const g = this.deps.store.goalAwaiting(requestId);
    if (!g) return;
    const req = this.deps.store.getMail(requestId);
    if (!req) return;
    const n = this.deps.store.listNodes(g.id).filter((x) => x.node_key.startsWith("resume_")).length + 1;
    const key = `resume_${n}`;
    const brief = `Earlier you asked ${req.to_agent}: "${req.body}"\n\nThey answered:\n${answerBody}\n\n` +
      `Continue and complete the task with this answer.`;
    this.deps.store.insertNodes(g.id, [{
      node_key: key, type: "run", agent: req.from_agent, critic: null, brief, depends_on: [], max_rounds: 1,
    }]);
    this.deps.store.clearAwaiting(g.id);
    this.setGoalStatus(g.id, "running");
    this.pump();
  }
```

- [ ] **Step 4: Stamp the report and trigger resume in `mailReport`**

Replace the `insertMail` call and the trailing lines of `mailReport` (~493–498) so the report inherits the thread + points at its request, then resumes the waiter:

```typescript
    const id = randomUUID();
    this.deps.store.insertMail({
      id, from_agent: src.to_agent, to_agent: src.from_agent, kind: "report", body,
      goal_id: goal.id, origin_channel: goal.origin_channel, origin_chat_id: goal.origin_chat_id,
      chain_depth: goal.chain_depth, status: "unread", error: null,
      thread_id: src.thread_id ?? src.id, in_reply_to: src.id,
    });
    this.emit({ type: "mail.sent", id, from: src.to_agent, to: src.from_agent, kind: "report" });
    this.resumeFromAnswer(src.id, body);
```

- [ ] **Step 5: Trigger resume on refusal / depth-downgrade in `sweepMail`**

In `src/engine/goals.ts` `sweepMail` (~416), after each terminal decline of a request, tell any waiter. Update the three decline sites:

Depth cap (~419), after `downgradeMailToNote`:

```typescript
      if (m.chain_depth > this.deps.mailMaxDepth) {
        const reason = `downgraded: chain too deep (cap ${this.deps.mailMaxDepth})`;
        this.deps.store.downgradeMailToNote(m.id, reason);
        this.resumeFromAnswer(m.id, `Declined: ${reason}`);
        continue;
      }
```

Unknown recipient (~426):

```typescript
      if (!canonical || !def) {
        this.deps.store.refuseMail(m.id, `unknown recipient "${m.to_agent}"`);
        this.resumeFromAnswer(m.id, `Refused: unknown recipient "${m.to_agent}"`);
        continue;
      }
```

Private wall (~432):

```typescript
      if (def.manifest.visibility === "private" &&
          !isPrivateOrigin(this.deps.primaryChat, m.origin_channel, m.origin_chat_id)) {
        const reason = `${canonical} is private — origin not the private chat`;
        this.deps.store.refuseMail(m.id, reason);
        this.resumeFromAnswer(m.id, `Refused: ${reason}`);
        continue;
      }
```

- [ ] **Step 6: Boot reconcile parked goals in `resumeUnfinished`**

In `src/engine/goals.ts` `resumeUnfinished` (~595), after `this.deps.store.reconcilePlanningMail();` and before `resetRunningNodes()`, add:

```typescript
    // Parked (awaiting-mail) goals whose answer already landed while we were down → resume now.
    for (const g of this.deps.store.awaitingMailGoals()) {
      if (!g.awaiting_mail) continue;
      const answer = this.deps.store.mailAnsweringRequest(g.awaiting_mail);
      if (answer) { this.resumeFromAnswer(g.awaiting_mail, answer.body); continue; }
      const req = this.deps.store.getMail(g.awaiting_mail);
      if (req?.status === "refused") this.resumeFromAnswer(g.awaiting_mail, `Refused: ${req.error ?? "unknown"}`);
    }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/goal-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; suite green.

- [ ] **Step 9: Commit**

```bash
git add src/engine/goals.ts test/goal-scheduler.test.ts
git commit -m "feat(mail): resume parked goal on report/refusal (continuation node)"
```

---

### Task 4: Thread view endpoint + parked-goal UI legibility

**Files:**
- Modify: `src/web/goals-view.ts` (add `buildMailThread` after `buildMailView` ~72)
- Modify: `src/web/server.ts` (add route after `/api/mail` ~438)
- Modify: `ui/src/views/Goals.tsx` (`BUCKETS` ~10; `GOAL_STATUS_TEXT` ~30)
- Test: `test/mail-endpoints.test.ts`

**Interfaces:**
- Consumes (Task 1): `store.mailThread`.
- Produces: `buildMailThread(store: Store, threadId: string): MailView[]` — the conversation, oldest first.

- [ ] **Step 1: Write the failing test**

Add to `test/mail-endpoints.test.ts` (inside its top-level `describe`, before the closing `});`):

```typescript
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
```

Ensure `buildMailThread` is imported at the top of the test alongside the other `goals-view` imports (e.g. `import { buildMailView, buildMailThread } from "../src/web/goals-view.js";` — match the existing import path/style in that file).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mail-endpoints.test.ts`
Expected: FAIL — `buildMailThread` is not exported.

- [ ] **Step 3: Add `buildMailThread`**

In `src/web/goals-view.ts`, add after `buildMailView` (~72):

```typescript
/** All mail in one conversation, oldest first — the thread read view (spec §8). */
export function buildMailThread(store: Store, threadId: string): MailView[] {
  return store.mailThread(threadId).map((m) => ({
    id: m.id, from: m.from_agent, to: m.to_agent, kind: m.kind, status: m.status, body: m.body,
    goalId: m.goal_id, chainDepth: m.chain_depth, createdAt: m.created_at, readAt: m.read_at, error: m.error,
  }));
}
```

- [ ] **Step 4: Add the route**

In `src/web/server.ts`, add after the `/api/mail` handler (~442) — and add `buildMailThread` to the existing `goals-view` import in that file:

```typescript
        const threadMatch = /^\/api\/mail\/thread\/([\w-]+)$/.exec(path);
        if (threadMatch && req.method === "GET") {
          return json(res, 200, buildMailThread(store, threadMatch[1]));
        }
```

Note: place this BEFORE the `/api/mail` exact-match check is fine (distinct path), but ensure it is inside the same request-handler block and after `const url = …` is in scope (mirror neighbouring handlers).

- [ ] **Step 5: Make parked goals legible in the UI**

In `ui/src/views/Goals.tsx`, add a bucket to `BUCKETS` (~10), after the "Paused" row:

```typescript
  { title: "Waiting", accent: "text-cyan", match: ["awaiting-mail"] },
```

And add to `GOAL_STATUS_TEXT` (~30):

```typescript
  "awaiting-mail": "text-cyan",
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/mail-endpoints.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck (backend + UI) + full suite**

Run: `npx tsc --noEmit && npx vitest run && (cd ui && npx tsc --noEmit && npm run build)`
Expected: all clean; suite green.

- [ ] **Step 8: Commit**

```bash
git add src/web/goals-view.ts src/web/server.ts ui/src/views/Goals.tsx test/mail-endpoints.test.ts
git commit -m "feat(mail): thread read endpoint + parked-goal UI bucket"
```

---

## Notes for the implementer

- **Parking is automatic.** You do NOT modify `pump`/`launch`/`complete` to park. `store.parkGoalAwaiting` sets status `awaiting-mail`, and `unfinishedGoals()` (`WHERE status IN ('planning','running','replanning')`) already excludes it — so the scheduler skips a parked goal for free. The asker node finishes normally (marked `done` by `launch().then`), and the completion check never fires because the goal is no longer `running`.
- **`resumeFromAnswer` is idempotent** — it guards on `goalAwaiting(requestId)` returning a still-parked goal. So the runtime report path and boot reconcile can both fire without double-resuming.
- **Turn bound stays depth-cap-only.** Do not add any counter. A too-deep ask is downgraded by the existing guard, and its waiter resumes with a "Declined: too deep" answer.
- **Ceiling (ponytail):** one outstanding ask per goal (`goal.awaiting_mail` is a single value; a second ask is refused). The continuation brief rebuilds context from the goal request (`contextBlock` injects `# Task\n${goal.request}`) plus the Q and A — it does not replay the original node's full brief. Widen either only if a real need appears.
- **Walls unchanged:** `ask` re-checks private visibility at send; `sweepMail` re-checks at spawn. No workspace, no `code_task` bypass.
