# Mail Review Fix Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Implementer subagents run Opus (user-directed).**

**Goal:** Fix the 2 HIGH + 5 MEDIUM findings (and one missing test pin) from the 2026-07-06 six-agent review of the July 4–6 mail work (`a0362d3..f4e7ecf`).

**Architecture:** Nine small, independent fixes inside the existing mail/goal-engine substrate. No new subsystems, no schema changes beyond one read-only query helper. Every fix follows an existing in-file pattern (paired `refuseMail`+`resumeFromAnswer`, atomic claim, snapshot-then-commit, triage hard-guard list).

**Tech Stack:** TypeScript (Node), `node:sqlite` (synchronous), vitest, React (UI badges only).

**Review provenance:** Findings labeled H1/H2/M1/M2/M5/M6/M7 per the review report. Verified against code at `f4e7ecf` — all cited line numbers are from that commit; re-locate by the quoted code if drifted.

## Global Constraints

- `node:sqlite` only — no better-sqlite3, no FTS5. DB calls are synchronous.
- No new npm dependencies. `package.json` must be untouched.
- Depth-cap is the ONLY mail bound (`AIOS_MAIL_MAX_DEPTH`) — do not add quotas/counters.
- Do NOT guard `onNodeFailure` globally by `awaiting-mail` status (locked decision — a genuinely-failing sibling must still fail the goal). Findings M3/M4 are explicitly OUT OF SCOPE (need separate design decisions).
- Mail-spawned goals never get a workspace; code enters only via `code_task`. Don't touch privacy walls.
- New/changed struct fields must be OPTIONAL (test literal-builders must keep compiling).
- Test baseline: **849 pass + 1 skip**. Every task ends with the full suite green (`npx vitest run`), and the final task also runs `npx tsc --noEmit` (root and `ui/`) + `cd ui && npm run build`.
- Commit per task, conventional-commit style (`fix(mail): …` / `test(mail): …`).

---

### Task 1: H2 — planner failure on a lead-ask must resume the parked asker

The catch in `spawnGraphFromMail` is the **only** refusal site without a paired `resumeFromAnswer` (compare `src/engine/goals.ts:428-429`, `:436-437`, `:420-421`). An agent that `ask_mail`s a department lead whose planning run throws stays parked (`awaiting-mail`) until the next daemon restart.

**Files:**
- Modify: `src/engine/goals.ts:462-465` (the `catch` in `spawnGraphFromMail`)
- Test: `test/mail-sweep.test.ts`

**Interfaces:**
- Consumes: existing `resumeFromAnswer(requestId, answerBody)` (goals.ts:510) — inserts a `resume_<n>` continuation node, clears `awaiting_mail`, sets goal `running`, pumps.
- Produces: nothing new — behavior fix only.

- [ ] **Step 1: Write the failing test**

Add to `test/mail-sweep.test.ts` (the file's `harness(run, capUsd?, planner?)` helper and `reqMail(over)` builder already exist at the top; `athena` is the engineering lead in the fixture registry, so mail addressed to `athena` with a `planner` passed takes the graph path):

```ts
it("planner failure on a lead request resumes the parked asker (H2)", async () => {
  const failingPlanner = {
    planFromMail: async () => { throw new Error("boom"); },
  } as unknown as Planner;
  const { store, engine } = harness(okRun, undefined, failingPlanner);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mail-sweep.test.ts -t "H2"`
Expected: FAIL — goal status stays `"awaiting-mail"` (no resume happens today).

- [ ] **Step 3: Implement the fix**

In `src/engine/goals.ts`, the `spawnGraphFromMail` catch currently reads:

```ts
    } catch (err) {
      this.deps.store.refuseMail(m.id, `planning failed: ${(err as Error).message}`);
      this.pump();
    }
```

Replace with (mirror every other refusal site — refuse, then resume the waiter):

```ts
    } catch (err) {
      const reason = `planning failed: ${(err as Error).message}`;
      this.deps.store.refuseMail(m.id, reason);
      // The ONLY refusal path that previously skipped this — an asker parked on this
      // request would otherwise stay awaiting-mail until the next daemon restart.
      this.resumeFromAnswer(m.id, `Refused: ${reason}`);
      this.pump();
    }
```

- [ ] **Step 4: Run test to verify it passes, then the whole file**

Run: `npx vitest run test/mail-sweep.test.ts`
Expected: PASS, all tests in file green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/goals.ts test/mail-sweep.test.ts
git commit -m "fix(mail): resume parked asker when lead-mail planning fails"
```

---

### Task 2: H1 — re-entrant sweep double-spawns single-node mail goals

`sweepMail` iterates a `queuedRequests()` snapshot. For a single-node (non-lead) mail, `spawnFromMail` + `void this.startGoal(goal)` runs **fully synchronously** into `pump()` → `sweepMail()` again (mail goals skip the only `await` — the sandbox ternary at goals.ts:338-340). The re-entrant sweep drains the rest of the queue; then every unwinding frame's stale snapshot re-spawns the later mails — mail #k gets up to k goals. The lead path is already protected by `claimMailPlanning`; the single-node path re-checks nothing.

**Files:**
- Modify: `src/engine/goals.ts:417` (top of the `sweepMail` loop)
- Test: `test/mail-sweep.test.ts`

**Interfaces:**
- Consumes: existing `store.getMail(id)` (db.ts:640).
- Produces: nothing new — behavior fix only.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mail-sweep.test.ts -t "H1"`
Expected: FAIL — 3 goals (m2 spawned twice).

- [ ] **Step 3: Implement the fix**

In `src/engine/goals.ts`, `sweepMail` currently starts:

```ts
  private sweepMail(): void {
    for (const m of this.deps.store.queuedRequests()) {
      if (m.chain_depth > this.deps.mailMaxDepth) {
```

Insert a per-item freshness re-check as the first statement of the loop body (synchronous sqlite → no TOCTOU; this also hardens the lead path for free):

```ts
  private sweepMail(): void {
    for (const m of this.deps.store.queuedRequests()) {
      // startGoal for a mail goal runs synchronously into pump() → sweepMail() re-enters and
      // may have already processed later items of THIS stale snapshot. Re-check the live row.
      if (this.deps.store.getMail(m.id)?.status !== "queued") continue;
      if (m.chain_depth > this.deps.mailMaxDepth) {
```

- [ ] **Step 4: Run test + whole file**

Run: `npx vitest run test/mail-sweep.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/goals.ts test/mail-sweep.test.ts
git commit -m "fix(mail): guard sweep against re-entrant stale-snapshot double-spawn"
```

---

### Task 3: M1 — abandoning a mail-spawned goal must report back (else asker parks forever)

`abandonGoal` (goals.ts:617-624) never calls `complete()` → no `mailReport` → the spawning request stays `spawned` → a parked asker never resumes, **even across restarts** (`resumeUnfinished` only handles answered/refused/note).

**Files:**
- Modify: `src/engine/goals.ts:617-624` (`abandonGoal`)
- Test: `test/mail-sweep.test.ts`

**Interfaces:**
- Consumes: existing private `mailReport(goal, ok, error, files)` (goals.ts:490) — inserts the `report` (stamps `thread_id`/`in_reply_to`) and calls `resumeFromAnswer`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mail-sweep.test.ts -t "M1"`
Expected: FAIL — no report exists, asker stays `awaiting-mail`.

- [ ] **Step 3: Implement the fix**

`abandonGoal` currently:

```ts
  abandonGoal(idOrSlug: string): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (["done", "failed", "abandoned"].includes(g.status)) return `Goal ${g.slug} is already ${g.status}.`;
    this.setGoalStatus(g.id, "abandoned");
    this.deps.store.skipUnfinishedNodes(g.id);
    return `Goal ${g.slug} abandoned; unfinished nodes skipped.`;
  }
```

Add the report-back (narrow: mail-spawned goals only — regular goals keep today's silent abandon; do NOT route through `complete()`, which would ping the origin chat for non-mail goals):

```ts
  abandonGoal(idOrSlug: string): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (["done", "failed", "abandoned"].includes(g.status)) return `Goal ${g.slug} is already ${g.status}.`;
    this.setGoalStatus(g.id, "abandoned");
    this.deps.store.skipUnfinishedNodes(g.id);
    // A mail-spawned goal must still answer its request — otherwise the request stays
    // 'spawned' forever and a parked asker never resumes (boot reconcile has no branch for it).
    if (g.spawned_by_mail) {
      const files = this.deps.store.listNodes(g.id).filter((n) => n.artifact).map((n) => n.artifact!);
      this.mailReport(this.deps.store.getGoal(g.id)!, false, "abandoned by user", files);
    }
    return `Goal ${g.slug} abandoned; unfinished nodes skipped.`;
  }
```

- [ ] **Step 4: Run test + whole file**

Run: `npx vitest run test/mail-sweep.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/goals.ts test/mail-sweep.test.ts
git commit -m "fix(mail): abandoned mail-spawned goals report back so askers resume"
```

---

### Task 4: M2 — morning brief must mark read exactly the mail it briefed

`runBrief` assembles the brief, `await`s LLM narration (seconds), then issues a **fresh** `unreadMailFor("hermes")` at `src/heartbeat/briefs.ts:330` and marks it all read. Mail landing during narration is acked but never briefed and never resurfaces — a lost user-facing report.

**Files:**
- Modify: `src/heartbeat/briefs.ts` (`BriefData` interface ~line 33, `assembleBrief` morning block ~line 171-182 + return ~line 207, `runBrief` ~line 329-332)
- Test: `test/standup-brief.test.ts`

**Interfaces:**
- Produces: `BriefData.briefedMailIds?: string[]` — OPTIONAL (existing literal-builders keep compiling). Renderers ignore it (`renderBriefNote` prints explicit sections only).

- [ ] **Step 1: Write the failing test**

Add to `test/standup-brief.test.ts` (the `hermesMail(store, over)` helper exists at the top; note `runBrief`'s deps shape is used verbatim in the existing "money wall" test):

```ts
it("mail arriving during narration is NOT marked read by the brief (M2)", async () => {
  const store = new Store(":memory:");
  hermesMail(store, { id: "early", from: "athena", kind: "report", body: "Done: early thing" });
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "sb-race-")), "AIOS");
  vault.init();
  await runBrief({
    store, bus: new EventBus(store), vault,
    narrate: async () => {
      // Simulates a report landing mid-narration (the race window).
      hermesMail(store, { id: "late", from: "vulcan", kind: "report", body: "Done: late thing" });
      return "n";
    },
    send: async () => {}, primary: { channel: "cli", chatId: "local" },
    nowFn: () => new Date(),
  }, "morning");
  expect(store.getMail("early")!.status).toBe("read");   // briefed → acked
  expect(store.getMail("late")!.status).toBe("unread");  // NOT briefed → must resurface tomorrow
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/standup-brief.test.ts -t "M2"`
Expected: FAIL — `late` is `"read"` (the fresh post-narration query swallows it).

- [ ] **Step 3: Implement the fix**

Three edits in `src/heartbeat/briefs.ts`.

(a) `BriefData` — after the `hermesMail?` field (~line 33):

```ts
  /** Ids of the hermes mail consumed by THIS brief — runBrief marks exactly these read. */
  briefedMailIds?: string[];
```

(b) `assembleBrief` morning block — capture the snapshot ids. Current code:

```ts
  let standups: BriefData["standups"];
  let hermesMail: BriefData["hermesMail"];
  if (anchor === "morning") {
    // Drop private-dept senders before anything reaches the vaulted/indexed brief.
    const unread = store.unreadMailFor("hermes").filter((m) => !privateAgents.has(m.from_agent));
```

becomes:

```ts
  let standups: BriefData["standups"];
  let hermesMail: BriefData["hermesMail"];
  let briefedMailIds: BriefData["briefedMailIds"];
  if (anchor === "morning") {
    // Drop private-dept senders before anything reaches the vaulted/indexed brief.
    const unread = store.unreadMailFor("hermes").filter((m) => !privateAgents.has(m.from_agent));
```

and at the end of the same `if` block (after the `if (other.length) hermesMail = other;` line):

```ts
    if (unread.length) briefedMailIds = unread.map((m) => m.id);
```

then add `briefedMailIds,` to the returned object next to `standups,` / `hermesMail,` (~line 207-208).

(c) `runBrief` — replace the fresh re-query:

```ts
  if (anchor === "morning") {
    const briefed = deps.store.unreadMailFor("hermes").filter((m) => !privateAgents.has(m.from_agent)).map((m) => m.id);
    if (briefed.length) deps.store.markMailRead(briefed);
  }
```

with the assemble-time snapshot (mail that arrived during narration was not briefed — leave it unread):

```ts
  if (anchor === "morning") {
    const briefed = data.briefedMailIds ?? [];
    if (briefed.length) deps.store.markMailRead(briefed);
  }
```

- [ ] **Step 4: Run test + whole file**

Run: `npx vitest run test/standup-brief.test.ts`
Expected: PASS — including the pre-existing money-wall test (private mail still left unread: it never enters `briefedMailIds` because the filter runs before the snapshot).

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/briefs.ts test/standup-brief.test.ts
git commit -m "fix(briefs): mark read only the mail actually briefed (narration race)"
```

---

### Task 5: M5 — complete the AIOS_MAIL_DISABLED kill-switch (sweep + injection)

Spec §11 promises 4 effects; only 2 exist (send/ask refuse, standups die). Missing: `sweepMail` still spawns already-queued mail (engine has no disabled flag), and `peekInbound` still injects the `# Mail` block.

**Files:**
- Modify: `src/engine/goals.ts` (`GoalEngineDeps` interface + top of `sweepMail`)
- Modify: `src/mail/mailbox.ts:103` (top of `peekInbound`)
- Modify: `src/index.ts:235-240` (engine construction — pass the flag)
- Test: `test/mail-sweep.test.ts`, `test/mailbox.test.ts`

**Interfaces:**
- Produces: `GoalEngineDeps.mailDisabled?: boolean` — OPTIONAL (all existing test harnesses keep compiling; `undefined` = enabled).

- [ ] **Step 1: Write the failing tests**

In `test/mail-sweep.test.ts` — first extend the `harness` helper's signature and engine construction:

```ts
function harness(run: SpecialistRunFn, capUsd?: number, planner?: Planner, opts?: { mailDisabled?: boolean }) {
```

and inside the `new GoalEngine({...})` options add:

```ts
    mailDisabled: opts?.mailDisabled,
```

then the test:

```ts
it("AIOS_MAIL_DISABLED idles the sweep — queued requests never spawn (M5)", () => {
  const { store, engine } = harness(okRun, undefined, undefined, { mailDisabled: true });
  store.insertMail(reqMail({ id: "m1" }));
  engine.pump();
  expect(store.getMail("m1")!.status).toBe("queued"); // untouched, drains when re-enabled
  expect(store.listGoals(10)).toHaveLength(0);
});
```

In `test/mailbox.test.ts` (follow the file's existing `new Mailbox({...})` construction pattern; it already builds a disabled mailbox for the send/ask refusal tests):

```ts
it("disabled mailbox injects nothing (M5)", () => {
  // Build a Mailbox exactly like the existing disabled-send test in this file, but with
  // an unread note in the store addressed to the agent.
  // (reuse the file's store/registry setup helpers)
  const { block, ids } = mailbox.peekInbound("vulcan");
  expect(block).toBe("");
  expect(ids).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mail-sweep.test.ts test/mailbox.test.ts -t "M5"`
Expected: both FAIL (mail spawns / block renders).

- [ ] **Step 3: Implement**

(a) `src/engine/goals.ts` — in `GoalEngineDeps`, after `mailMaxDepth`:

```ts
  /** AIOS_MAIL_DISABLED — when true the sweep idles: queued mail stays queued (spec §11). */
  mailDisabled?: boolean;
```

and make it the first line of `sweepMail`:

```ts
  private sweepMail(): void {
    if (this.deps.mailDisabled) return; // kill-switch: nothing spawns; queue drains on re-enable
    for (const m of this.deps.store.queuedRequests()) {
```

(b) `src/mail/mailbox.ts` — first line of `peekInbound`:

```ts
  peekInbound(canonical: string): { block: string; ids: string[] } {
    if (this.deps.disabled) return { block: "", ids: [] }; // kill-switch: no injection
```

(c) `src/index.ts` — in the `new GoalEngine({...})` options (around line 240, next to `mailMaxDepth: config.mailMaxDepth,`):

```ts
    mailDisabled: config.mailDisabled,
```

- [ ] **Step 4: Run tests + both files**

Run: `npx vitest run test/mail-sweep.test.ts test/mailbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/goals.ts src/mail/mailbox.ts src/index.ts test/mail-sweep.test.ts test/mailbox.test.ts
git commit -m "fix(mail): AIOS_MAIL_DISABLED now also idles the sweep and skips injection"
```

---

### Task 6: M6 — emit `mail.read` so unread badges can clear

`markDelivered` silently flips unread→read; the UI refetches only on `mail.*` events, so badges show a stale count forever in a quiet system. Add a `mail.read` event (triage-ignored like its siblings) and tighten the UI filter (which today also matches the unrelated Gmail `mail.received`).

**Files:**
- Modify: `src/events.ts:26` (union), `src/heartbeat/triage.ts:83-84` (hard-guard), `src/mail/mailbox.ts:118-120` (`markDelivered`)
- Modify: `ui/src/App.tsx:38` and `ui/src/views/Org.tsx` `MailSection` (~line 205)
- Test: `test/mailbox.test.ts` + extend the existing triage-ignore pin

**Interfaces:**
- Produces: `{ type: "mail.read"; ids: string[] }` in the `AiosEvent` union.

- [ ] **Step 1: Write the failing tests**

In `test/mailbox.test.ts` (the file already wires an `onEvent` spy into `Mailbox` for the `mail.sent` assertions — reuse that pattern):

```ts
it("markDelivered emits mail.read with the committed ids; empty is silent (M6)", () => {
  // build mailbox with an onEvent vi.fn() and one unread note "n1" for vulcan
  const { ids } = mailbox.peekInbound("vulcan");
  mailbox.markDelivered(ids);
  expect(onEvent).toHaveBeenCalledWith({ type: "mail.read", ids });
  onEvent.mockClear();
  mailbox.markDelivered([]);
  expect(onEvent).not.toHaveBeenCalled();
});
```

Extend the existing triage hard-guard pin (it lives with the `mail.sent`/`mail.spawned` pins — grep `mail.spawned` in `test/`; currently `test/mail-store.test.ts` ~line 152): add a `{ type: "mail.read", ids: ["x"] }` case asserting it is ignored even with a matching user rule, exactly like its two siblings.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mailbox.test.ts test/mail-store.test.ts`
Expected: new cases FAIL (no event emitted; type error until the union gains `mail.read` — that's fine, it confirms the seam).

- [ ] **Step 3: Implement**

(a) `src/events.ts` — extend the union after `mail.spawned` (line 26):

```ts
  | { type: "mail.spawned"; mailId: string; goalId: string }
  | { type: "mail.read"; ids: string[] };
```

(b) `src/heartbeat/triage.ts` — add to the hard-guard (lines 83-84):

```ts
    if (event.type === "triage.decision" || event.type === "brief.sent" ||
        event.type === "mail.sent" || event.type === "mail.spawned" || event.type === "mail.read") return;
```

(c) `src/mail/mailbox.ts` — `markDelivered`:

```ts
  markDelivered(ids: string[]): void {
    if (!ids.length) return;
    this.deps.store.markMailRead(ids);
    this.deps.onEvent?.({ type: "mail.read", ids });
  }
```

(d) `ui/src/App.tsx` — replace the prefix filter (line 38). Add near the top of the file (module scope):

```ts
// Agent-mailbox events only — "mail." prefix would also match Gmail's mail.received.
const AGENT_MAIL_EVENTS = new Set(["mail.sent", "mail.spawned", "mail.read"]);
```

and change line 38 to:

```ts
  const lastMailEvt = useMemo(() => events.filter((e) => AGENT_MAIL_EVENTS.has(e.event.type)).at(-1)?.id, [events]);
```

(e) `ui/src/views/Org.tsx` — same substitution in `MailSection` (~line 205): add the same `AGENT_MAIL_EVENTS` module-scope const and replace `e.event.type.startsWith("mail.")` with `AGENT_MAIL_EVENTS.has(e.event.type)`.

- [ ] **Step 4: Run tests + UI typecheck**

Run: `npx vitest run test/mailbox.test.ts test/mail-store.test.ts && npx tsc --noEmit && cd ui && npx tsc --noEmit && cd ..`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/events.ts src/heartbeat/triage.ts src/mail/mailbox.ts ui/src/App.tsx ui/src/views/Org.tsx test/mailbox.test.ts test/mail-store.test.ts
git commit -m "fix(mail): emit mail.read on delivery so UI unread badges clear"
```

---

### Task 7: M7 — standup activity window must select by updated_at, not a created_at LIMIT

`activeDepartments` and `standupDigest` filter `updated_at >= since` over `listGoals(100)` = `ORDER BY created_at DESC LIMIT 100`. A weeks-old goal resumed yesterday (exactly what park-and-resume produces) ages out of the newest-100-created window → dept wrongly idle, digest incomplete.

**Files:**
- Modify: `src/store/db.ts` (new query next to `listGoals`), `src/heartbeat/standup.ts:19,36`
- Test: `test/standup.test.ts`

**Interfaces:**
- Produces: `Store.goalsUpdatedSince(sinceIso: string): GoalRow[]`.

- [ ] **Step 1: Write the failing test**

Add to `test/standup.test.ts` (reuse the file's existing store/registry fixtures; raw `db` access via cast is the established escape hatch for migration tests):

```ts
it("a weeks-old goal resumed recently still activates its department (M7)", () => {
  // 101 goals: g0 is the OLDEST-created but the only recently-updated one.
  for (let i = 0; i <= 100; i++) {
    store.insertGoal({
      id: `g${i}`, slug: `g${i}`, title: `G${i}`, request: "r", department: "engineering", lead: "athena",
      origin_channel: "t", origin_chat_id: "1", status: "done", project_dir: null, goal_dir: null,
      plan_summary: "graph", replans_used: 0, chain_depth: 0, error: null,
    });
  }
  const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  const old = new Date(Date.now() - 30 * 864e5).toISOString();
  // Everything is old...
  db.prepare("UPDATE goals SET created_at = ?, updated_at = ?").run(old, old);
  // ...except g0: ancient created_at, fresh updated_at (a just-resumed parked goal).
  db.prepare("UPDATE goals SET updated_at = ? WHERE id = 'g0'").run(new Date().toISOString());

  const since = new Date(Date.now() - 864e5).toISOString();
  expect(activeDepartments(store, registry, since)).toContain("engineering");
  expect(standupDigest(store, registry, "engineering", since)).toContain("G0");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/standup.test.ts -t "M7"`
Expected: FAIL — g0 is outside the newest-100-created window, dept reads inactive.

- [ ] **Step 3: Implement**

(a) `src/store/db.ts` — next to `listGoals` (~line 518):

```ts
  /** Goals touched since `sinceIso` — selected by updated_at in SQL, not a created_at-ordered
   *  LIMIT window (a weeks-old goal resumed yesterday must still count as recent activity). */
  goalsUpdatedSince(sinceIso: string): GoalRow[] {
    return this.db.prepare("SELECT * FROM goals WHERE updated_at >= ? ORDER BY updated_at DESC")
      .all(sinceIso) as unknown as GoalRow[];
  }
```

(b) `src/heartbeat/standup.ts` — line 19:

```ts
  const recentGoals = store.goalsUpdatedSince(sinceIso);
```

and line 36:

```ts
  const goals = store.goalsUpdatedSince(sinceIso).filter((g) => g.department === dept);
```

(the `updated_at >= sinceIso` post-filters on those lines are now redundant — remove them; keep the `department === dept` filter in `standupDigest`).

- [ ] **Step 4: Run test + whole file**

Run: `npx vitest run test/standup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts src/heartbeat/standup.ts test/standup.test.ts
git commit -m "fix(standup): select activity window by updated_at, not created_at LIMIT"
```

---

### Task 8: Pin the thread_id legacy backfill migration

`UPDATE mail SET thread_id = id WHERE thread_id IS NULL` (db.ts migration block) has no test — insert-time defaulting can never produce NULL, so the migration path is unexercised. Model on the `spawned_by_mail` reopen test at `test/goal-store.test.ts:123-134`.

**Files:**
- Test: `test/mail-store.test.ts`

- [ ] **Step 1: Write the test (it should PASS — this pins existing behavior)**

Add to `test/mail-store.test.ts` (add `mkdtempSync`/`tmpdir`/`join` imports if the file lacks them):

```ts
it("migration backfills thread_id = id for legacy rows (reopen)", () => {
  const f = join(mkdtempSync(join(tmpdir(), "mst-mig-")), "t.db");
  const s1 = new Store(f);
  s1.insertMail({
    id: "legacy", from_agent: "athena", to_agent: "vulcan", kind: "note", body: "old",
    goal_id: null, origin_channel: "t", origin_chat_id: "1", chain_depth: 1, status: "unread", error: null,
  });
  // Simulate a pre-thread_id row (insert-time defaulting can't produce this).
  (s1 as unknown as { db: import("node:sqlite").DatabaseSync }).db
    .prepare("UPDATE mail SET thread_id = NULL WHERE id = 'legacy'").run();
  const s2 = new Store(f); // reopen → constructor re-runs migration + backfill
  expect(s2.getMail("legacy")!.thread_id).toBe("legacy");
});
```

- [ ] **Step 2: Run it — must PASS first try**

Run: `npx vitest run test/mail-store.test.ts`
Expected: PASS. If it FAILS, STOP — that's a real migration bug; report back instead of "fixing" the test.

- [ ] **Step 3: Commit**

```bash
git add test/mail-store.test.ts
git commit -m "test(mail): pin thread_id legacy backfill via reopen migration test"
```

---

### Task 9: Full verification

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: **≥858 passed + 1 skipped** (849 baseline + ~9 new cases across Tasks 1–8), zero failures.

- [ ] **Step 2: Typechecks + UI build**

Run: `npx tsc --noEmit && cd ui && npx tsc --noEmit && npm run build && cd ..`
Expected: all clean.

- [ ] **Step 3: No dependency drift**

Run: `git diff main --stat -- package.json package-lock.json`
Expected: empty output.

---

## Explicitly out of scope (deferred, need design decisions)

- **M3** — sibling-failure during park window (dangling `awaiting_mail` on the re-plan path). Blocked on a user decision; the locked "no global onNodeFailure guard" rule constrains the fix shape.
- **M4** — `resume_<n>` DAG wiring for mid-graph asks (answer unreachable by dependents) + carrying the asking node's brief.
- All LOW findings (rowid tiebreaks, limit clamp, @mention ask parity pin, transaction nesting doc, standup inbox drain, injection fence) — batch later if wanted.
- Phase-4 spec §5 text update ratifying read-at-success (docs-only).
