# Phase 4a — Agent Mailbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Async agent-to-agent mail: a `request` mail spawns a single-node goal for the recipient through the existing GoalEngine, results auto-report back, and department leads write daily standups that feed the morning brief.

**Architecture:** New `mail` table + a `Mailbox` service (`src/mail/mailbox.ts`) exposed to every agent as a one-tool in-process MCP server (`aios-mail`), attached at the shared option-assembly seams (`makeRunSpecialist` via a pure `withMailOptions` helper; per-turn in `direct.ts` like the attachment server). GoalEngine's pump gains a mail sweep that converts queued requests into single-node goals (depth-capped, SpendGuard-gated, privacy-walled) and auto-mails a `report` on completion. A new `standup` heartbeat anchor runs one lead one-shot per ACTIVE department; standups land as mail to hermes and render in the morning brief.

**Tech Stack:** TypeScript, node:sqlite, Claude Agent SDK `query()` via existing `makeRunSpecialist`, vitest, zod.

**Spec:** `docs/superpowers/specs/2026-07-04-phase4-agent-mailbox-design.md` (§1–8, §10–12). UI (§9) is plan 4b.

## Global Constraints

- No new npm dependencies. node:sqlite only. Subscription auth (CLAUDE_CODE_OAUTH_TOKEN) untouched.
- Chain depth cap is the ONLY runaway bound (`AIOS_MAIL_MAX_DEPTH`, default 2) — user-accepted risk; do NOT add quotas.
- Mail-goals are single `run` nodes, no workspace (`project_dir` null); code work still enters ONLY via `code_task`.
- `report`/`standup` mail kinds are system-generated only — the tool schema must not accept them.
- Private-recipient wall via shared `isPrivateOrigin` (fail-closed when primaryChat unset), enforced at send AND at sweep.
- Departments with `privateMemo: true` (finance) never run standups.
- `mcp__aios-mail__send_mail` must be in `allowedTools` BEFORE `withDenialObserver` wraps (StructuredOutput lesson); `guardOptions` already passes `mcp__*` tools.
- New events `mail.sent`/`mail.spawned` get explicit triage default `ignore`.
- Startup sweeps stay startup-only; anchor kv stamp-before-run preserved; anchors array keeps morning before evening.
- Suite baseline 778 pass + 1 skip; `npx vitest run`, `npx tsc --noEmit`, `npm run build`, `cd ui && npm run build` clean after every task.
- Run vitest from the WORKTREE root only (a live worktree under `.claude/worktrees` double-collects from the main checkout).
- Worktree caveat: EnterWorktree branches from origin/main — spec commit `5fa06ac` is already pushed.
- Deploy after merge: `npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`.

## File Structure

- Create: `src/mail/mailbox.ts` — `Mailbox` service (send validation, injection block, read-marking).
- Create: `src/mail/server.ts` — `buildMailServer` (per-run `aios-mail` MCP server) + `MAIL_TOOL`.
- Create: `src/heartbeat/standup.ts` — `activeDepartments`, `standupDigest`, `runStandups`.
- Modify: `src/store/db.ts` — mail table + CRUD, `goals.chain_depth` column + migration, `transaction()`.
- Modify: `src/events.ts` — `mail.sent`, `mail.spawned` union members.
- Modify: `src/heartbeat/triage.ts` — ignore defaults for `mail.*`.
- Modify: `src/agents/runner.ts` — `RunOptions.mailCtx`, `withMailOptions`, wire into `makeRunSpecialist`.
- Modify: `src/agents/direct.ts` — per-turn mail server + prompt-injected mail block.
- Modify: `src/moderator/handoff.ts` — thread `mailCtx` (depth-0 origin).
- Modify: `src/engine/goals.ts` — `sweepMail` in pump, `spawnFromMail`, `mailReport`, `chain_depth` threading, `MAIL_PREFIX`.
- Modify: `src/heartbeat/clock.ts` — `"standup"` anchor union.
- Modify: `src/heartbeat/briefs.ts` — `standups` + `hermesMail` sections; mark-read in `runBrief`.
- Modify: `src/moderator/tools.ts` + `src/moderator/session.ts` — hermes `send_mail` tool + allowlist entry.
- Modify: `src/config.ts` — `mailMaxDepth`, `mailDisabled`, `standupDisabled`, `anchorStandup`.
- Modify: `src/index.ts` — Mailbox construction, deps threading, standup anchor branch.
- Modify: `src/web/goals-view.ts` + `src/web/server.ts` — `buildMailView`, `/api/mail`, `spawnedBy` in goal detail.
- Tests: `test/mail-store.test.ts`, `test/mailbox.test.ts`, `test/mail-runner.test.ts`, `test/mail-sweep.test.ts`, `test/standup.test.ts`, `test/standup-brief.test.ts`, `test/mail-endpoints.test.ts`, additions to `test/triage.test.ts`-adjacent pins.

Shared test fixture: reuse the registry-fixture pattern from `test/validate-graph.test.ts` (tmp-dir `loadRegistry` with engineering [athena lead, vulcan, odin] + finance [midas private lead, `privateMemo: true` dept]).

**Type-ripple warning (Task 1):** adding `chain_depth` to `GoalRow` makes every `Omit<GoalRow, "created_at"|"updated_at">` literal in existing tests fail tsc. `grep -rn "insertGoal(" test/ src/` and add `chain_depth: 0` to each goal literal/helper (same drill as the `job_dir` column).

---

### Task 1: Store layer — mail table, chain_depth, transaction + events + triage defaults

**Files:**
- Modify: `src/store/db.ts` (types near `GoalRow`; `mail` table in constructor `exec`; `ALTER TABLE goals` migration next to the `receipt_path` migration at ~line 207; methods after `budgetSpentCents` ~line 552)
- Modify: `src/events.ts:24` (union additions)
- Modify: `src/heartbeat/triage.ts:39` (ignore defaults)
- Test: `test/mail-store.test.ts`

**Interfaces:**
- Produces (later tasks rely on these exact names):

```typescript
export type MailKind = "request" | "note" | "report" | "standup";
export type MailStatus = "queued" | "spawned" | "refused" | "unread" | "read";
export interface MailRow {
  id: string; from_agent: string; to_agent: string; kind: MailKind; body: string;
  goal_id: string | null; origin_channel: string; origin_chat_id: string;
  chain_depth: number; status: MailStatus; error: string | null;
  created_at: string; read_at: string | null;
}
```

- `GoalRow` gains `chain_depth: number` (and the goals CREATE TABLE + a try/catch ALTER for existing DBs).
- Store methods: `insertMail(m: Omit<MailRow, "created_at" | "read_at">)`, `getMail(id): MailRow | undefined`, `listMail(agent?: string, limit = 50): MailRow[]` (from OR to = agent, newest first), `unreadMailFor(agent): MailRow[]` (status unread, to_agent, oldest first), `refusedMailFrom(agent): MailRow[]` (status refused, from_agent, read_at IS NULL, oldest first), `markMailRead(ids: string[])` (stamps read_at; unread→read, refused keeps status), `queuedRequests(): MailRow[]` (kind request + status queued, oldest first), `markMailSpawned(id, goalId)`, `refuseMail(id, error)`, `downgradeMailToNote(id, reason)` (kind→note, status→unread, error=reason), `transaction<T>(fn: () => T): T` (BEGIN IMMEDIATE/COMMIT/ROLLBACK).
- Events union additions:

```typescript
  | { type: "mail.sent"; id: string; from: string; to: string; kind: string }
  | { type: "mail.spawned"; mailId: string; goalId: string }
```

- Triage: both types added to the `"ignore"` case group in `defaultVerdict`.

- [ ] **Step 1: Write the failing test**

Create `test/mail-store.test.ts`:

```typescript
// test/mail-store.test.ts
import { describe, it, expect } from "vitest";
import { Store, type MailRow } from "../src/store/db.js";
import { defaultVerdict } from "../src/heartbeat/triage.js";

function mail(over: Partial<MailRow> = {}): Omit<MailRow, "created_at" | "read_at"> {
  return {
    id: over.id ?? "m1", from_agent: "athena", to_agent: "vulcan", kind: "request",
    body: "build the thing", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
    chain_depth: 1, status: "queued", error: null, ...over,
  } as Omit<MailRow, "created_at" | "read_at">;
}

describe("mail store", () => {
  it("round-trips mail and lists by agent from either side", () => {
    const s = new Store(":memory:");
    s.insertMail(mail());
    s.insertMail(mail({ id: "m2", from_agent: "vulcan", to_agent: "athena", kind: "note", status: "unread" }));
    expect(s.getMail("m1")!.body).toBe("build the thing");
    expect(s.listMail("athena").map((m) => m.id).sort()).toEqual(["m1", "m2"]);
    expect(s.listMail("vulcan").length).toBe(2);
    expect(s.listMail(undefined, 1).length).toBe(1);
  });

  it("request lifecycle: queued → spawned; refused; downgrade to note", () => {
    const s = new Store(":memory:");
    s.insertMail(mail());
    s.insertMail(mail({ id: "m2" }));
    s.insertMail(mail({ id: "m3" }));
    expect(s.queuedRequests().map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    s.markMailSpawned("m1", "g1");
    expect(s.getMail("m1")).toMatchObject({ status: "spawned", goal_id: "g1" });
    s.refuseMail("m2", "private wall");
    expect(s.getMail("m2")).toMatchObject({ status: "refused", error: "private wall" });
    s.downgradeMailToNote("m3", "downgraded: chain too deep");
    expect(s.getMail("m3")).toMatchObject({ kind: "note", status: "unread", error: "downgraded: chain too deep" });
    expect(s.queuedRequests()).toEqual([]);
  });

  it("unread/refused feeds + markMailRead", () => {
    const s = new Store(":memory:");
    s.insertMail(mail({ id: "n1", kind: "note", status: "unread", to_agent: "vulcan" }));
    s.insertMail(mail({ id: "r1", status: "refused", from_agent: "vulcan", to_agent: "midas", error: "wall" }));
    expect(s.unreadMailFor("vulcan").map((m) => m.id)).toEqual(["n1"]);
    expect(s.refusedMailFrom("vulcan").map((m) => m.id)).toEqual(["r1"]);
    s.markMailRead(["n1", "r1"]);
    expect(s.unreadMailFor("vulcan")).toEqual([]);
    expect(s.refusedMailFrom("vulcan")).toEqual([]); // read_at stamped = acknowledged
    expect(s.getMail("n1")!.status).toBe("read");
    expect(s.getMail("r1")!.status).toBe("refused"); // status preserved, only acked
  });

  it("goals carry chain_depth (default 0)", () => {
    const s = new Store(":memory:");
    s.insertGoal({
      id: "g1", slug: "x", title: "X", request: "x", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "running", project_dir: null,
      goal_dir: null, plan_summary: "", replans_used: 0, error: null, chain_depth: 2,
    });
    expect(s.getGoal("g1")!.chain_depth).toBe(2);
  });

  it("transaction rolls back on throw", () => {
    const s = new Store(":memory:");
    expect(() =>
      s.transaction(() => {
        s.insertMail(mail());
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.getMail("m1")).toBeUndefined();
  });
});

describe("mail triage defaults", () => {
  it("mail.sent and mail.spawned are ignore", () => {
    expect(defaultVerdict({ type: "mail.sent", id: "m", from: "a", to: "b", kind: "note" })).toBe("ignore");
    expect(defaultVerdict({ type: "mail.spawned", mailId: "m", goalId: "g" })).toBe("ignore");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mail-store.test.ts`
Expected: FAIL — `insertMail is not a function` / type errors.

- [ ] **Step 3: Implement**

In `src/store/db.ts`:

(a) After the `GoalRow`/`NewTaskNode` type block add the `MailKind`/`MailStatus`/`MailRow` types exactly as in **Interfaces**. Add `chain_depth: number;` to `GoalRow` (after `replans_used`).

(b) In the constructor `exec`, add `chain_depth INTEGER NOT NULL DEFAULT 0,` to the `goals` CREATE TABLE (after `replans_used`), and after the `budget_ledger` table add:

```sql
      CREATE TABLE IF NOT EXISTS mail (
        id TEXT PRIMARY KEY,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        goal_id TEXT,
        origin_channel TEXT NOT NULL,
        origin_chat_id TEXT NOT NULL,
        chain_depth INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        read_at TEXT
      );
```

(c) Next to the existing `receipt_path` migration (~line 207) add the idempotent column migration:

```typescript
    try {
      this.db.exec("ALTER TABLE goals ADD COLUMN chain_depth INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* column already exists */
    }
```

(d) In `insertGoal`, add `chain_depth` to the column list and `g.chain_depth` to the values (16 → 17 placeholders).

(e) Methods after `budgetSpentCents`:

```typescript
  insertMail(m: Omit<MailRow, "created_at" | "read_at">): void {
    this.db.prepare(
      `INSERT INTO mail (id, from_agent, to_agent, kind, body, goal_id, origin_channel, origin_chat_id,
                         chain_depth, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.id, m.from_agent, m.to_agent, m.kind, m.body, m.goal_id, m.origin_channel, m.origin_chat_id,
          m.chain_depth, m.status, m.error, new Date().toISOString());
  }

  getMail(id: string): MailRow | undefined {
    return this.db.prepare("SELECT * FROM mail WHERE id = ?").get(id) as MailRow | undefined;
  }

  listMail(agent?: string, limit = 50): MailRow[] {
    if (agent) {
      return this.db.prepare(
        "SELECT * FROM mail WHERE from_agent = ? OR to_agent = ? ORDER BY created_at DESC LIMIT ?",
      ).all(agent, agent, limit) as unknown as MailRow[];
    }
    return this.db.prepare("SELECT * FROM mail ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as MailRow[];
  }

  unreadMailFor(agent: string): MailRow[] {
    return this.db.prepare(
      "SELECT * FROM mail WHERE to_agent = ? AND status = 'unread' ORDER BY created_at ASC",
    ).all(agent) as unknown as MailRow[];
  }

  refusedMailFrom(agent: string): MailRow[] {
    return this.db.prepare(
      "SELECT * FROM mail WHERE from_agent = ? AND status = 'refused' AND read_at IS NULL ORDER BY created_at ASC",
    ).all(agent) as unknown as MailRow[];
  }

  /** Stamps read_at (unread → read; refused keeps its status — read_at doubles as the ack). */
  markMailRead(ids: string[]): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "UPDATE mail SET read_at = ?, status = CASE WHEN status = 'unread' THEN 'read' ELSE status END WHERE id = ?",
    );
    for (const id of ids) stmt.run(now, id);
  }

  queuedRequests(): MailRow[] {
    return this.db.prepare(
      "SELECT * FROM mail WHERE kind = 'request' AND status = 'queued' ORDER BY created_at ASC",
    ).all() as unknown as MailRow[];
  }

  markMailSpawned(id: string, goalId: string): void {
    this.db.prepare("UPDATE mail SET status = 'spawned', goal_id = ? WHERE id = ?").run(goalId, id);
  }

  refuseMail(id: string, error: string): void {
    this.db.prepare("UPDATE mail SET status = 'refused', error = ? WHERE id = ?").run(error, id);
  }

  /** Depth-exceeded requests deliver as ordinary notes — fail-soft, nothing runs. */
  downgradeMailToNote(id: string, reason: string): void {
    this.db.prepare("UPDATE mail SET kind = 'note', status = 'unread', error = ? WHERE id = ?").run(reason, id);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
```

In `src/events.ts`, add the two union members after `node.status` (exact lines in **Interfaces**).

In `src/heartbeat/triage.ts` `defaultVerdict`, add to the ignore group (before `return "ignore";`):

```typescript
    case "mail.sent":     // internal machinery — never a user ping
    case "mail.spawned":
```

(f) Fix the type ripple: `grep -rn "insertGoal(" test/ src/` — add `chain_depth: 0` to every goal literal (e.g. `test/goal-store.test.ts`'s `goal()` helper, `test/goal-runner.test.ts`'s harness, any others the grep finds).

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/mail-store.test.ts && npx tsc --noEmit`
Expected: 6 pass, tsc clean.

- [ ] **Step 5: Run the FULL suite (type-ripple check)**

Run: `npx vitest run`
Expected: 784 pass + 1 skip (778 baseline + 6 new), no failures from goal literals.

- [ ] **Step 6: Commit**

```bash
git add src/store/db.ts src/events.ts src/heartbeat/triage.ts test/ && git commit -m "feat(store): mail table, goals.chain_depth, transaction helper + mail events triage-ignored"
```

---

### Task 2: Mailbox service + aios-mail MCP server

**Files:**
- Create: `src/mail/mailbox.ts`
- Create: `src/mail/server.ts`
- Test: `test/mailbox.test.ts`

**Interfaces:**
- Consumes: Store mail methods (Task 1), `LoadedRegistry`, `isPrivateOrigin` from `src/agents/direct.js`.
- Produces:

```typescript
// src/mail/mailbox.ts
export interface MailboxDeps {
  store: Store; registry: LoadedRegistry;
  maxDepth: number;            // AIOS_MAIL_MAX_DEPTH (depth check itself happens at sweep; kept here for future use)
  disabled: boolean;           // AIOS_MAIL_DISABLED
  primaryChat?: { channel: string; chatId: string };
  onEvent?: (e: AiosEvent) => void;
  onQueued?: () => void;       // wired to goals.pump() so a fresh request is swept promptly
}
export interface MailSendCtx { from: string; origin: { channel: string; chatId: string }; goalDepth: number }
export class Mailbox {
  constructor(deps: MailboxDeps);
  send(ctx: MailSendCtx, args: { to: string; kind: "request" | "note"; body: string }): string; // human-readable result
  injectionFor(canonical: string): string; // "" when nothing to show; marks rendered mail read
}
// src/mail/server.ts
export const MAIL_TOOL = "mcp__aios-mail__send_mail";
export function buildMailServer(mailbox: Mailbox, ctx: MailSendCtx): ReturnType<typeof createSdkMcpServer>;
```

Semantics: `send` refuses when disabled / unknown recipient / self-send / private recipient from non-private origin (shared `isPrivateOrigin`, fail-closed). On success inserts mail with `chain_depth = ctx.goalDepth + 1`, status `queued` (request) or `unread` (note), emits `mail.sent`, fires `onQueued` for requests. `injectionFor` renders up to 5 items — unread inbound (`unreadMailFor`) first, then own refusals (`refusedMailFrom`) — bodies truncated at 500 chars, marks all rendered ids read. `request` rows never inject (their delivery IS the spawned goal's brief).

- [ ] **Step 1: Write the failing test**

```typescript
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

describe("Mailbox.injectionFor", () => {
  it("renders unread inbound + own refusals, truncates, caps at 5, marks read", () => {
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
    const block = mb.injectionFor("vulcan");
    expect(block).toContain("# Mail");
    expect(block).toContain("from athena");
    expect(block).not.toContain("y".repeat(501));   // truncated at 500
    expect(block).not.toContain("refused");          // cap 5 hit by the unread notes first
    expect(store.unreadMailFor("vulcan")).toEqual([]);
    // second call now surfaces the refusal ack
    const block2 = mb.injectionFor("vulcan");
    expect(block2).toContain("your request to midas was refused: private wall");
    expect(mb.injectionFor("vulcan")).toBe("");      // everything acked
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run test/mailbox.test.ts` → module not found.

- [ ] **Step 3: Implement `src/mail/mailbox.ts`**

```typescript
// src/mail/mailbox.ts — agent-to-agent mail: validation, persistence, context injection.
import { randomUUID } from "node:crypto";
import type { Store } from "../store/db.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { AiosEvent } from "../events.js";
import { isPrivateOrigin } from "../agents/direct.js";

export interface MailboxDeps {
  store: Store;
  registry: LoadedRegistry;
  maxDepth: number;
  disabled: boolean;
  primaryChat?: { channel: string; chatId: string };
  onEvent?: (e: AiosEvent) => void;
  onQueued?: () => void;
}

export interface MailSendCtx {
  from: string;
  origin: { channel: string; chatId: string };
  goalDepth: number;
}

const INJECT_CAP = 5;
const BODY_TRUNCATE = 500;
const clip = (s: string) => (s.length <= BODY_TRUNCATE ? s : `${s.slice(0, BODY_TRUNCATE)}…`);

export class Mailbox {
  constructor(private deps: MailboxDeps) {}

  /** Tool-friendly: always returns a human-readable string, never throws. */
  send(ctx: MailSendCtx, args: { to: string; kind: "request" | "note"; body: string }): string {
    if (this.deps.disabled) return "Refused: the mailbox is disabled (AIOS_MAIL_DISABLED).";
    const canonical = this.deps.registry.agentOf.get(args.to);
    const def = canonical ? this.deps.registry.agents.get(canonical) : undefined;
    if (!canonical || !def) return `Refused: Unknown recipient "${args.to}".`;
    if (canonical === ctx.from) return "Refused: you can't mail yourself.";
    if (def.manifest.visibility === "private" &&
        !isPrivateOrigin(this.deps.primaryChat, ctx.origin.channel, ctx.origin.chatId)) {
      return `Refused: ${canonical} is private — this chat's origin can't reach them.`;
    }
    const id = randomUUID();
    this.deps.store.insertMail({
      id, from_agent: ctx.from, to_agent: canonical, kind: args.kind, body: args.body,
      goal_id: null, origin_channel: ctx.origin.channel, origin_chat_id: ctx.origin.chatId,
      chain_depth: ctx.goalDepth + 1,
      status: args.kind === "request" ? "queued" : "unread",
      error: null,
    });
    this.deps.onEvent?.({ type: "mail.sent", id, from: ctx.from, to: canonical, kind: args.kind });
    if (args.kind === "request") this.deps.onQueued?.();
    return args.kind === "request"
      ? `Mail sent — ${canonical} will run this as a goal and the result reports back to you.`
      : `Note delivered to ${canonical}.`;
  }

  /** System-prompt block: unread inbound first, then own refusal acks. Marks rendered mail read. */
  injectionFor(canonical: string): string {
    const inbound = this.deps.store.unreadMailFor(canonical);
    const refusals = this.deps.store.refusedMailFrom(canonical);
    const picked = [...inbound, ...refusals].slice(0, INJECT_CAP);
    if (!picked.length) return "";
    const lines = picked.map((m) =>
      m.status === "refused"
        ? `- your request to ${m.to_agent} was refused: ${m.error ?? "unknown reason"}`
        : `- from ${m.from_agent} (${m.kind}, ${m.created_at.slice(0, 16)}): ${clip(m.body)}`,
    );
    this.deps.store.markMailRead(picked.map((m) => m.id));
    return `# Mail\nYou have ${picked.length} message(s):\n${lines.join("\n")}`;
  }
}
```

Implement `src/mail/server.ts`:

```typescript
// src/mail/server.ts — per-run aios-mail MCP server; sender identity/origin/depth baked, non-spoofable.
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Mailbox, MailSendCtx } from "./mailbox.js";

export const MAIL_TOOL = "mcp__aios-mail__send_mail";

export function buildMailServer(mailbox: Mailbox, ctx: MailSendCtx) {
  const sendMail = tool(
    "send_mail",
    "Send mail to another staff agent. kind=request: they run it as a goal later and the result " +
      "reports back to you automatically. kind=note: FYI only, nothing runs.",
    { to: z.string(), kind: z.enum(["request", "note"]), body: z.string() },
    async (a) => ({ content: [{ type: "text" as const, text: mailbox.send(ctx, a) }] }),
  );
  return createSdkMcpServer({ name: "aios-mail", version: "0.1.0", tools: [sendMail] });
}
```

- [ ] **Step 4: Run + typecheck** — `npx vitest run test/mailbox.test.ts && npx tsc --noEmit` → 7 pass, clean.

- [ ] **Step 5: Commit**

```bash
git add src/mail/ test/mailbox.test.ts && git commit -m "feat(mail): Mailbox service + aios-mail MCP server (validation, privacy wall, injection)"
```

---

### Task 3: Runner seams — withMailOptions in makeRunSpecialist, direct chats, hand_off

**Files:**
- Modify: `src/agents/runner.ts` (RunOptions + `withMailOptions` + makeRunSpecialist deps)
- Modify: `src/agents/direct.ts` (per-turn server + prompt block, ~line 78-112)
- Modify: `src/moderator/handoff.ts:57` (mailCtx threading)
- Test: `test/mail-runner.test.ts`

**Interfaces:**
- Consumes: `Mailbox`, `buildMailServer`, `MAIL_TOOL` (Task 2).
- Produces:

```typescript
// runner.ts additions
export interface RunOptions {
  /* existing fields unchanged, plus: */
  mailCtx?: { origin: { channel: string; chatId: string }; goalDepth: number };
}
/** Pure merge: aios-mail server + allowlist entry + unread-mail prompt block. Exported for parity pins. */
export function withMailOptions(base: Options, mailbox: Mailbox, ctx: MailSendCtx): Options;
// makeRunSpecialist deps gain: mailbox?: Mailbox
// DirectChatsDeps gain: mailbox?: Mailbox
```

- [ ] **Step 1: Write the failing test**

```typescript
// test/mail-runner.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { Mailbox } from "../src/mail/mailbox.js";
import { withMailOptions } from "../src/agents/runner.js";
import { MAIL_TOOL } from "../src/mail/server.js";
import { guardOptions } from "../src/agents/guards/index.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "mr-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  mkdirSync(eng, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  writeFileSync(join(eng, "vulcan.yaml"),
    "name: vulcan\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n");
  writeFileSync(join(eng, "athena.yaml"),
    "name: athena\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n");
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();
const CTX = { from: "vulcan", origin: { channel: "telegram", chatId: "1" }, goalDepth: 0 };

function mailbox(store = new Store(":memory:")) {
  return { store, mb: new Mailbox({ store, registry, maxDepth: 2, disabled: false, primaryChat: CTX.origin }) };
}

describe("withMailOptions", () => {
  it("adds server + allowlist entry, preserves existing tools/servers", () => {
    const { mb } = mailbox();
    const base: Options = { allowedTools: ["Read"], mcpServers: {}, systemPrompt: "persona" };
    const out = withMailOptions(base, mb, CTX);
    expect(out.allowedTools).toContain(MAIL_TOOL);
    expect(out.allowedTools).toContain("Read");
    expect(Object.keys(out.mcpServers ?? {})).toContain("aios-mail");
    expect(base.allowedTools).toEqual(["Read"]); // pure — no mutation
  });

  it("appends unread mail to the system prompt and marks it read", () => {
    const { store, mb } = mailbox();
    store.insertMail({
      id: "n1", from_agent: "athena", to_agent: "vulcan", kind: "note", body: "heads up",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "unread", error: null,
    });
    const out = withMailOptions({ systemPrompt: "persona" } as Options, mb, CTX);
    expect(String(out.systemPrompt)).toContain("# Mail");
    expect(String(out.systemPrompt)).toContain("heads up");
    expect(store.unreadMailFor("vulcan")).toEqual([]);
    const again = withMailOptions({ systemPrompt: "persona" } as Options, mb, CTX);
    expect(String(again.systemPrompt)).not.toContain("# Mail");
  });

  it("fallback-deny guards do not block the mail tool (mcp__ passes)", () => {
    const g = guardOptions({}, "deny");
    // canUseTool is the programmatic gate — mcp__ tools must pass a deny-fallback guard
    return (g.canUseTool!(MAIL_TOOL, {}, { signal: new AbortController().signal }) as Promise<{ behavior: string }>)
      .then((v) => expect(v.behavior).toBe("allow"));
  });
});
```

- [ ] **Step 2: Run to verify fail** — `withMailOptions is not exported`.

- [ ] **Step 3: Implement**

(a) `src/agents/runner.ts` — imports + RunOptions + pure helper:

```typescript
import { buildMailServer, MAIL_TOOL } from "../mail/server.js";
import type { Mailbox, MailSendCtx } from "../mail/mailbox.js";
```

Add to `RunOptions`:

```typescript
  /** When set (with a mailbox in deps), the run gets send_mail + its unread-mail block.
   *  goalDepth = the running goal's chain_depth (0 for chat/hand_off/standup runs). */
  mailCtx?: { origin: { channel: string; chatId: string }; goalDepth: number };
```

Add after `specialistOptions`:

```typescript
/** Merge the aios-mail server into run options: server + allowlist entry + unread-mail prompt
 *  block. Pure. MUST be applied BEFORE withDenialObserver wraps (the observer denies from the
 *  allowlist it captures at wrap time — the StructuredOutput lesson). */
export function withMailOptions(base: Options, mailbox: Mailbox, ctx: MailSendCtx): Options {
  const injection = mailbox.injectionFor(ctx.from);
  return {
    ...base,
    mcpServers: { ...(base.mcpServers ?? {}), "aios-mail": buildMailServer(mailbox, ctx) },
    allowedTools: [...new Set([...(base.allowedTools ?? []), MAIL_TOOL])],
    ...(injection ? { systemPrompt: `${base.systemPrompt}\n\n${injection}` } : {}),
  };
}
```

(b) `makeRunSpecialist` — widen deps and apply before the schema/observer block:

```typescript
export function makeRunSpecialist(deps: { store: Store; bus: EventBus; registry: LoadedRegistry; mailbox?: Mailbox }): SpecialistRunFn {
```

and inside, replace the `const merged = specialistOptions(...)` line with:

```typescript
      let merged = specialistOptions(role, canonical, opts, deps.store);
      if (deps.mailbox && opts.mailCtx) {
        merged = withMailOptions(merged, deps.mailbox, { from: canonical, ...opts.mailCtx });
      }
```

(c) `src/agents/direct.ts` — `DirectChatsDeps` gains `mailbox?: Mailbox` (import type from `../mail/mailbox.js`; value import `buildMailServer`, `MAIL_TOOL` from `../mail/server.js`). In `handle()` after the `const observed = withDenialObserver(...)` line region, follow the attachment-server per-turn pattern: build the server + widen the allowlist BEFORE `withDenialObserver` is called — concretely, change the assembly to:

```typescript
      let options = withEffectiveTools(withPack, canonical, this.deps.store);
      let mailBlock = "";
      const mailServers: Record<string, ReturnType<typeof buildMailServer>> = {};
      if (this.deps.mailbox) {
        const ctx = { from: canonical, origin: { channel, chatId }, goalDepth: 0 };
        mailServers["aios-mail"] = buildMailServer(this.deps.mailbox, ctx);
        options = { ...options, allowedTools: [...new Set([...(options.allowedTools ?? []), MAIL_TOOL])] };
        mailBlock = this.deps.mailbox.injectionFor(canonical);
      }
      const observed = withDenialObserver(options, canonical, (e) => this.deps.bus.emit({ type: "tool.denied", ...e }));
```

then merge `...mailServers` wherever the attachment server lands in the final options' `mcpServers`, and prepend the mail block to the per-turn prompt (system prompt is fixed on resumed sessions):

```typescript
      const prompt =
        (mailBlock ? `${mailBlock}\n\n` : "") +
        from +
        (attachmentLines.length ? `${attachmentLines.join("\n")}\n` : "") +
        userText;
```

(d) `src/moderator/handoff.ts:57` — thread depth-0 mailCtx:

```typescript
    const res = await deps.runSpecialist(agent, task, {
      cwd: deps.projectsRoot, model: deps.model, pack,
      mailCtx: { origin, goalDepth: 0 },
    });
```

- [ ] **Step 4: Run + typecheck** — `npx vitest run test/mail-runner.test.ts && npx tsc --noEmit` → 3 pass, clean.

- [ ] **Step 5: Commit**

```bash
git add src/agents/runner.ts src/agents/direct.ts src/moderator/handoff.ts test/mail-runner.test.ts
git commit -m "feat(mail): send_mail + unread-mail injection at every agent entry path (parity)"
```

---

### Task 4: GoalEngine — mail sweep, spawn, report, no-ping

**Files:**
- Modify: `src/engine/goals.ts` (deps, `MAIL_PREFIX`, `sweepMail`, `spawnFromMail`, `mailReport`, `complete` branch, `runAgent` mailCtx, `insertGoal` chainDepth)
- Test: `test/mail-sweep.test.ts`

**Interfaces:**
- Consumes: Store mail methods + `transaction` (Task 1), `isPrivateOrigin` (existing), `RunOptions.mailCtx` (Task 3).
- Produces:

```typescript
export const MAIL_PREFIX = "mail:";          // goal.plan_summary marker for mail-spawned goals
// GoalEngineDeps gains: mailMaxDepth: number
// private sweepMail(): void — called first in pump()
// private spawnFromMail(m: MailRow, canonical: string, department: string): GoalRow
// private mailReport(goal: GoalRow, ok: boolean, error: string | undefined, files: string[]): void
```

Semantics (spec §4–5): sweep FIFO over `queuedRequests()`; depth > cap → `downgradeMailToNote`; `!spendGuard.allow()` → return (stays queued, drains after the midnight `resumeBudgetPaused` tick because that pumps); unknown recipient / private wall → `refuseMail`; else spawn in ONE `store.transaction` (goal + single run node `task` + `markMailSpawned`), emit `mail.spawned`, `void startGoal(goal)`. `complete()` branches on `MAIL_PREFIX`: mail-goals insert a `report` mail back to the sender (never call `deps.onComplete` — no chat ping); chain-root goals unchanged. `runAgent` passes `mailCtx: { origin: goal origin, goalDepth: goal.chain_depth }`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/mail-sweep.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type MailRow } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { GoalEngine, MAIL_PREFIX } from "../src/engine/goals.js";
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

function harness(run: SpecialistRunFn, capUsd?: number) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "ms-vault-")));
  if (capUsd !== undefined) store.budgetAdd(new Date().toISOString().slice(0, 10), Math.round(capUsd * 100));
  const onComplete = vi.fn(async () => {});
  const engine = new GoalEngine({
    store, vault, run, registry,
    playbooks: new Map(), wallTimeMs: 60_000, maxConcurrentNodes: 2,
    spendGuard: new SpendGuard({ store, capUsd }),
    onComplete,
    resolveDeptFor: () => undefined,
    primaryChat: PRIMARY,
    mailMaxDepth: 2,
  });
  return { store, vault, engine, onComplete };
}

const okRun: SpecialistRunFn = async (_r, brief) => {
  return { text: `done: ${brief.slice(0, 20)}`, costUsd: 0.01, numTurns: 1 };
};

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
    expect(seen).toEqual({ origin: { channel: "telegram", chatId: "1" }, goalDepth: 2 });
  });
});
```

- [ ] **Step 2: Run to verify fail** — `MAIL_PREFIX` not exported / `mailMaxDepth` unknown.

- [ ] **Step 3: Implement in `src/engine/goals.ts`**

(a) Imports: add `MailRow` to the db.js type import; `import { isPrivateOrigin } from "../agents/direct.js";`

(b) Export the marker next to `FACADE_PREFIX` and widen deps:

```typescript
export const MAIL_PREFIX = "mail:";
```

`GoalEngineDeps` gains:

```typescript
  /** Chain-depth cap for mail-spawned goals (AIOS_MAIL_MAX_DEPTH). */
  mailMaxDepth: number;
```

(c) `insertGoal` gains an optional `chainDepth`:

```typescript
  private insertGoal(p: {
    title: string; request: string; department: string; lead: string;
    origin: { channel: string; chatId: string }; projectDir?: string; planSummary: string;
    chainDepth?: number;
  }): GoalRow {
```

and pass `chain_depth: p.chainDepth ?? 0` in the `store.insertGoal` literal.

(d) `runAgent` — thread mailCtx into the run (in the `deps.run(role, brief, {...})` call):

```typescript
      mailCtx: { origin: { channel: goal.origin_channel, chatId: goal.origin_chat_id }, goalDepth: goal.chain_depth },
```

(e) `pump()` — first line: `this.sweepMail();`

(f) New private methods (after `pauseForBudget`):

```typescript
  /** Convert queued request mail into single-node goals (spec §4). FIFO; fail-soft per item. */
  private sweepMail(): void {
    for (const m of this.deps.store.queuedRequests()) {
      if (m.chain_depth > this.deps.mailMaxDepth) {
        this.deps.store.downgradeMailToNote(m.id, `downgraded: chain too deep (cap ${this.deps.mailMaxDepth})`);
        continue;
      }
      if (!this.deps.spendGuard.allow()) return; // stays queued; midnight resume pumps again
      const canonical = this.deps.registry.agentOf.get(m.to_agent);
      const def = canonical ? this.deps.registry.agents.get(canonical) : undefined;
      if (!canonical || !def) {
        this.deps.store.refuseMail(m.id, `unknown recipient "${m.to_agent}"`);
        continue;
      }
      // Defense in depth: re-check the private wall against the stored provenance (send-time raced).
      if (def.manifest.visibility === "private" &&
          !isPrivateOrigin(this.deps.primaryChat, m.origin_channel, m.origin_chat_id)) {
        this.deps.store.refuseMail(m.id, `${canonical} is private — origin not the private chat`);
        continue;
      }
      const goal = this.spawnFromMail(m, canonical, def.department);
      void this.startGoal(goal);
    }
  }

  private spawnFromMail(m: MailRow, canonical: string, department: string): GoalRow {
    const lead = this.deps.registry.departments.get(department)?.lead ?? "hermes";
    const title = (m.body.split("\n")[0] ?? "").slice(0, 80) || `mail from ${m.from_agent}`;
    let goal!: GoalRow;
    this.deps.store.transaction(() => {
      goal = this.insertGoal({
        title, request: m.body, department, lead,
        origin: { channel: m.origin_channel, chatId: m.origin_chat_id },
        planSummary: `${MAIL_PREFIX}${m.id}`, chainDepth: m.chain_depth,
      });
      this.deps.store.insertNodes(goal.id, [{
        node_key: "task", type: "run", agent: canonical, critic: null,
        brief: `Requested by ${m.from_agent} via mail ${m.id}. Your result is automatically reported back to them.`,
        depends_on: [], max_rounds: 1,
      }]);
      this.deps.store.markMailSpawned(m.id, goal.id);
    });
    this.emit({ type: "mail.spawned", mailId: m.id, goalId: goal.id });
    return goal;
  }

  /** The report REPLACES the origin-chat ping for mail-spawned goals (spec §5). */
  private mailReport(goal: GoalRow, ok: boolean, error: string | undefined, files: string[]): void {
    const src = this.deps.store.getMail(goal.plan_summary.slice(MAIL_PREFIX.length));
    if (!src) return;
    const refs = files.map((f) => `goals/${goal.goal_dir}/${f}`).join(", ");
    const body = ok
      ? `Done: ${goal.title}\nArtifacts: ${refs || "(none)"}`
      : `Failed: ${goal.title}\n${error ?? "unknown error"}`;
    const id = randomUUID();
    this.deps.store.insertMail({
      id, from_agent: src.to_agent, to_agent: src.from_agent, kind: "report", body,
      goal_id: goal.id, origin_channel: goal.origin_channel, origin_chat_id: goal.origin_chat_id,
      chain_depth: goal.chain_depth, status: "unread", error: null,
    });
    this.emit({ type: "mail.sent", id, from: src.to_agent, to: src.from_agent, kind: "report" });
  }
```

(g) `complete()` — branch before `deps.onComplete`:

```typescript
  private async complete(goal: GoalRow, ok: boolean, error?: string): Promise<void> {
    const fresh = this.deps.store.getGoal(goal.id)!;
    const files = this.deps.store.listNodes(goal.id).filter((n) => n.artifact).map((n) => n.artifact!);
    if (fresh.plan_summary.startsWith(MAIL_PREFIX)) {
      this.mailReport(fresh, ok, error, files);
      return;
    }
    try {
      await this.deps.onComplete({ goal: fresh, ok, error, goalDirName: fresh.goal_dir ?? "", artifactFiles: files });
    } catch (err) {
      this.deps.log?.(`[${goal.slug}] onComplete failed: ${(err as Error).message}`);
    }
  }
```

(h) Fix compile fallout: every `new GoalEngine({...})` in src/tests needs `mailMaxDepth` — `grep -rn "new GoalEngine(" src/ test/` and add `mailMaxDepth: 2` (index.ts gets the config value in Task 7).

- [ ] **Step 4: Run + typecheck** — `npx vitest run test/mail-sweep.test.ts && npx tsc --noEmit` → 6 pass, clean.

- [ ] **Step 5: Run full suite** — `npx vitest run` → no regressions (existing goal-engine tests still green with the new dep).

- [ ] **Step 6: Commit**

```bash
git add src/engine/goals.ts test/ && git commit -m "feat(engine): mail sweep — request mail spawns single-node goals, reports replace chat pings"
```

---

### Task 5: Standups — active-dept detection, digest, lead runs, anchor

**Files:**
- Create: `src/heartbeat/standup.ts`
- Modify: `src/heartbeat/clock.ts:5,14` (`"standup"` in both unions)
- Modify: `src/config.ts` (4 knobs — also consumed by Task 7 wiring)
- Test: `test/standup.test.ts`

**Interfaces:**
- Consumes: Store (`listGoals`, `listMail`, `listNodes`, `queuedRequests`, `insertMail`), `LoadedRegistry`, `SpecialistRunFn`, `SpendGuard`, `localParts`.
- Produces:

```typescript
export function activeDepartments(store: Store, registry: LoadedRegistry, sinceIso: string): string[];
export function standupDigest(store: Store, registry: LoadedRegistry, dept: string, sinceIso: string): string;
export interface StandupDeps {
  store: Store; registry: LoadedRegistry; run: SpecialistRunFn;
  spendGuard: SpendGuard; onEvent?: (e: AiosEvent) => void; log?: (l: string) => void; nowFn?: () => Date;
}
export async function runStandups(deps: StandupDeps): Promise<number>; // count of standups written
```

Semantics (spec §6): active = dept with a `goals` row `updated_at >= sinceIso` OR mail `created_at >= sinceIso` from a dept member; departments with `privateMemo: true` are excluded ALWAYS. Digest reads goals/task_nodes/mail ONLY. One lead one-shot per active dept (SpendGuard-checked per dept, `break` at cap); result inserted as `standup` mail lead→hermes (`origin system/standup`, `chain_depth 1`, status `unread`); per-dept try/catch. Config: `anchorStandup` (AIOS_ANCHOR_STANDUP, "07:15"), `mailMaxDepth` (AIOS_MAIL_MAX_DEPTH, 2), `mailDisabled` (AIOS_MAIL_DISABLED === "1"), `standupDisabled` (AIOS_STANDUP_DISABLED === "1").

- [ ] **Step 1: Write the failing test**

```typescript
// test/standup.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { SpendGuard } from "../src/engine/budget.js";
import { activeDepartments, standupDigest, runStandups } from "../src/heartbeat/standup.js";
import type { SpecialistRunFn } from "../src/agents/runner.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "su-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  const fin = join(agentsDir, "finance");
  mkdirSync(eng, { recursive: true });
  mkdirSync(fin, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  writeFileSync(join(eng, "athena.yaml"),
    "name: athena\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n");
  writeFileSync(join(eng, "vulcan.yaml"),
    "name: vulcan\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n");
  writeFileSync(join(fin, "department.yaml"),
    "department: finance\nmission: Money.\nlead: midas\nmemoDomain: money\nplaybooks: []\nprivateMemo: true\n");
  writeFileSync(join(fin, "midas.yaml"),
    "name: midas\ntitle: CFO\ndepartment: finance\ncharter: c.\npersona: p.\nprompt: x.\ntools: []\nvisibility: private\n");
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();
const SINCE = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

function goalRow(store: Store, over: Record<string, unknown> = {}) {
  store.insertGoal({
    id: (over.id as string) ?? "g1", slug: "x", title: (over.title as string) ?? "Build X", request: "x",
    department: (over.department as string) ?? "engineering", lead: "athena",
    origin_channel: "telegram", origin_chat_id: "1", status: (over.status as never) ?? "done",
    project_dir: null, goal_dir: null, plan_summary: "", replans_used: 0,
    error: (over.error as string | null) ?? null, chain_depth: 0,
  });
}

describe("activeDepartments", () => {
  it("goal activity OR member mail marks a dept active; finance (privateMemo) always excluded", () => {
    const store = new Store(":memory:");
    expect(activeDepartments(store, registry, SINCE)).toEqual([]);
    goalRow(store);
    expect(activeDepartments(store, registry, SINCE)).toEqual(["engineering"]);
    // finance goal exists but privateMemo excludes the dept
    goalRow(store, { id: "g2", department: "finance" });
    expect(activeDepartments(store, registry, SINCE)).toEqual(["engineering"]);
  });

  it("mail from a member activates; old activity does not", () => {
    const store = new Store(":memory:");
    store.insertMail({
      id: "m1", from_agent: "vulcan", to_agent: "athena", kind: "note", body: "x", goal_id: null,
      origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "unread", error: null,
    });
    expect(activeDepartments(store, registry, SINCE)).toEqual(["engineering"]);
    expect(activeDepartments(store, registry, new Date(Date.now() + 1000).toISOString())).toEqual([]);
  });
});

describe("standupDigest", () => {
  it("includes goal titles, statuses, costs, failures, mail counts", () => {
    const store = new Store(":memory:");
    goalRow(store);
    goalRow(store, { id: "g2", title: "Broken Y", status: "failed", error: "exploded badly" });
    store.insertNodes("g1", [{ node_key: "a", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: [], max_rounds: 1 }]);
    store.addNodeCost("g1", "a", 92);
    store.insertMail({
      id: "m1", from_agent: "vulcan", to_agent: "athena", kind: "note", body: "x", goal_id: null,
      origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "unread", error: null,
    });
    const d = standupDigest(store, registry, "engineering", SINCE);
    expect(d).toContain("Build X");
    expect(d).toContain("$0.92");
    expect(d).toContain("Broken Y");
    expect(d).toContain("exploded badly");
    expect(d).toContain("mail sent: 1");
  });
});

describe("runStandups", () => {
  it("runs the lead once per active dept and mails the standup to hermes", async () => {
    const store = new Store(":memory:");
    goalRow(store);
    const calls: string[] = [];
    const run: SpecialistRunFn = async (role, brief) => {
      calls.push(role);
      expect(brief).toContain("Build X");
      return { text: "done: X / today: Y / blockers: none", costUsd: 0.01, numTurns: 1 };
    };
    const n = await runStandups({ store, registry, run, spendGuard: new SpendGuard({ store }) });
    expect(n).toBe(1);
    expect(calls).toEqual(["athena"]);
    const m = store.unreadMailFor("hermes")[0];
    expect(m).toMatchObject({ kind: "standup", from_agent: "athena" });
    expect(m.body).toContain("blockers: none");
  });

  it("SpendGuard at cap skips; lead failure is contained", async () => {
    const store = new Store(":memory:");
    goalRow(store);
    store.budgetAdd(new Date().toISOString().slice(0, 10), 100);
    const run: SpecialistRunFn = async () => { throw new Error("nope"); };
    expect(await runStandups({ store, registry, run, spendGuard: new SpendGuard({ store, capUsd: 1 }) })).toBe(0);
    expect(await runStandups({ store, registry, run, spendGuard: new SpendGuard({ store }) })).toBe(0); // failure contained
    expect(store.unreadMailFor("hermes")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify fail** — module not found.

- [ ] **Step 3: Implement `src/heartbeat/standup.ts`**

```typescript
// src/heartbeat/standup.ts — daily lead standups (spec §6). Deterministic digest, one lead
// one-shot per ACTIVE department, result lands as standup mail to hermes.
import { randomUUID } from "node:crypto";
import type { Store, GoalRow } from "../store/db.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { SpecialistRunFn } from "../agents/runner.js";
import type { SpendGuard } from "../engine/budget.js";
import type { AiosEvent } from "../events.js";

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function membersOf(registry: LoadedRegistry, dept: string): Set<string> {
  return new Set([...registry.agents.entries()].filter(([, a]) => a.department === dept).map(([n]) => n));
}

/** Departments with last-24h activity. privateMemo departments (finance) NEVER run standups —
 *  brief notes are vaulted + recall-indexed; private-dept content there would breach the money wall. */
export function activeDepartments(store: Store, registry: LoadedRegistry, sinceIso: string): string[] {
  const recentGoals = store.listGoals(100).filter((g) => g.updated_at >= sinceIso);
  const recentMail = store.listMail(undefined, 500).filter((m) => m.created_at >= sinceIso);
  const out: string[] = [];
  for (const [dept, def] of registry.departments) {
    if (def.privateMemo) continue;
    const members = membersOf(registry, dept);
    const active =
      recentGoals.some((g) => g.department === dept) ||
      recentMail.some((m) => members.has(m.from_agent));
    if (active) out.push(dept);
  }
  return out;
}

/** Pure data digest — reads goals/task_nodes/mail ONLY (never personal_*, never email content). */
export function standupDigest(store: Store, registry: LoadedRegistry, dept: string, sinceIso: string): string {
  const members = membersOf(registry, dept);
  const goals = store.listGoals(100).filter((g) => g.department === dept && g.updated_at >= sinceIso);
  const line = (g: GoalRow) => {
    const cost = store.listNodes(g.id).reduce((s, n) => s + n.cost_cents, 0);
    return `- ${g.title} [${g.status}]${cost ? ` ${usd(cost)}` : ""}${g.error ? ` — ${g.error.slice(0, 200)}` : ""}`;
  };
  const finished = goals.filter((g) => ["done", "failed", "abandoned"].includes(g.status));
  const open = goals.filter((g) => !["done", "failed", "abandoned"].includes(g.status));
  const mail = store.listMail(undefined, 500).filter((m) => m.created_at >= sinceIso);
  const sent = mail.filter((m) => members.has(m.from_agent)).length;
  const received = mail.filter((m) => members.has(m.to_agent)).length;
  const queued = store.queuedRequests().filter((m) => members.has(m.to_agent)).length;
  return [
    "# Yesterday", ...(finished.length ? finished.map(line) : ["- (nothing finished)"]),
    "# In flight", ...(open.length ? open.map(line) : ["- (nothing running)"]),
    `# Mail\n- mail sent: ${sent}, received: ${received}, queued requests for your team: ${queued}`,
  ].join("\n");
}

export interface StandupDeps {
  store: Store;
  registry: LoadedRegistry;
  run: SpecialistRunFn;
  spendGuard: SpendGuard;
  onEvent?: (e: AiosEvent) => void;
  log?: (l: string) => void;
  nowFn?: () => Date;
}

const PROMPT =
  "Write your department's daily standup for the chief of staff — exactly 3 lines: " +
  "done / today / blockers. Max 60 words total, plain text. Your department's last-24h data:\n\n";

/** One lead one-shot per active dept; standup lands as mail lead→hermes. Returns count written. */
export async function runStandups(deps: StandupDeps): Promise<number> {
  const now = (deps.nowFn ?? (() => new Date()))();
  const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  let written = 0;
  for (const dept of activeDepartments(deps.store, deps.registry, since)) {
    if (!deps.spendGuard.allow()) {
      deps.log?.(`standups: budget cap reached, skipping remaining departments`);
      break;
    }
    const lead = deps.registry.departments.get(dept)?.lead;
    if (!lead) continue;
    try {
      const res = await deps.run(lead, PROMPT + standupDigest(deps.store, deps.registry, dept, since), {
        cwd: process.cwd(),
        mailCtx: { origin: { channel: "system", chatId: "standup" }, goalDepth: 0 },
      });
      const id = randomUUID();
      deps.store.insertMail({
        id, from_agent: lead, to_agent: "hermes", kind: "standup", body: res.text.slice(0, 1200),
        goal_id: null, origin_channel: "system", origin_chat_id: "standup",
        chain_depth: 1, status: "unread", error: null,
      });
      deps.onEvent?.({ type: "mail.sent", id, from: lead, to: "hermes", kind: "standup" });
      written++;
    } catch (err) {
      deps.log?.(`standup for ${dept} failed: ${(err as Error).message}`); // fail-silent per dept
    }
  }
  return written;
}
```

In `src/heartbeat/clock.ts`, widen both unions (lines 5 and 14):

```typescript
  name: "morning" | "evening" | "dream" | "speculate" | "standup";
  onAnchor: (name: "morning" | "evening" | "dream" | "speculate" | "standup") => Promise<void>;
```

In `src/config.ts`, add to the `Config` interface (after `anchorSpeculate`/speculate block):

```typescript
  /** Local time "HH:MM" for the pre-brief department standups. */
  anchorStandup: string;
  /** Max mail chain depth: a request whose chain_depth exceeds this downgrades to a note. */
  mailMaxDepth: number;
  /** Kill-switch: send_mail refuses, sweep idles, injection skipped (standups die too — mail is their substrate). */
  mailDisabled: boolean;
  /** Kill-switch for standups only. */
  standupDisabled: boolean;
```

and in the loader (next to `anchorSpeculate`):

```typescript
    anchorStandup: env.AIOS_ANCHOR_STANDUP ?? "07:15",
    mailMaxDepth: Number(env.AIOS_MAIL_MAX_DEPTH ?? 2),
    mailDisabled: env.AIOS_MAIL_DISABLED === "1",
    standupDisabled: env.AIOS_STANDUP_DISABLED === "1",
```

- [ ] **Step 4: Run + typecheck** — `npx vitest run test/standup.test.ts && npx tsc --noEmit` → 5 pass, clean.

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/standup.ts src/heartbeat/clock.ts src/config.ts test/standup.test.ts
git commit -m "feat(standup): active-dept detection, deterministic digest, lead one-shots to hermes mail"
```

---

### Task 6: Morning brief — Standups + Mailroom sections

**Files:**
- Modify: `src/heartbeat/briefs.ts` (BriefData fields, assemble, isEmpty, render, runBrief mark-read)
- Test: `test/standup-brief.test.ts`

**Interfaces:**
- Consumes: `unreadMailFor("hermes")`, `markMailRead` (Task 1).
- Produces (BriefData additions):

```typescript
  /** Department lead standups (standup mail to hermes) — morning brief only. */
  standups?: Array<{ lead: string; text: string }>;
  /** Hermes's other unread mail (reports/notes), one line each — morning brief only. */
  hermesMail?: Array<{ from: string; kind: string; line: string }>;
```

Note: spec §6 says `{department, lead, text}` — `assembleBrief` has no registry, so the view carries `{lead, text}`; the lead name identifies the department to the user (documented deviation).

- [ ] **Step 1: Write the failing test**

```typescript
// test/standup-brief.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { assembleBrief, isEmptyBrief, renderBriefNote } from "../src/heartbeat/briefs.js";

function hermesMail(store: Store, over: Record<string, unknown> = {}) {
  store.insertMail({
    id: (over.id as string) ?? "s1", from_agent: (over.from as string) ?? "athena", to_agent: "hermes",
    kind: (over.kind as never) ?? "standup", body: (over.body as string) ?? "done: X / today: Y / blockers: none",
    goal_id: null, origin_channel: "system", origin_chat_id: "standup",
    chain_depth: 1, status: "unread", error: null,
  });
}

describe("brief standups + mailroom", () => {
  it("morning brief carries standups and hermes mail lines; counts as non-empty", () => {
    const store = new Store(":memory:");
    hermesMail(store);
    hermesMail(store, { id: "r1", from: "vulcan", kind: "report", body: "Done: mail goal X\nArtifacts: ..." });
    const d = assembleBrief(store, "morning", new Date().toISOString(), null);
    expect(d.standups).toEqual([{ lead: "athena", text: "done: X / today: Y / blockers: none" }]);
    expect(d.hermesMail).toEqual([{ from: "vulcan", kind: "report", line: "Done: mail goal X" }]);
    expect(isEmptyBrief(d)).toBe(false);
    const note = renderBriefNote(d, "narration");
    expect(note).toContain("## Standups");
    expect(note).toContain("athena: done: X / today: Y / blockers: none");
    expect(note).toContain("## Mailroom");
  });

  it("evening brief ignores hermes mail; empty morning stays empty", () => {
    const store = new Store(":memory:");
    hermesMail(store);
    const evening = assembleBrief(store, "evening", new Date().toISOString(), null);
    expect(evening.standups).toBeUndefined();
    const emptyStore = new Store(":memory:");
    const d = assembleBrief(emptyStore, "morning", new Date().toISOString(), null);
    expect(isEmptyBrief(d)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `standups` undefined on BriefData.

- [ ] **Step 3: Implement in `src/heartbeat/briefs.ts`**

(a) BriefData: add the two fields from **Interfaces** (after `openLoops`).

(b) In `assembleBrief`, after the `openLoops` block:

```typescript
  let standups: BriefData["standups"];
  let hermesMail: BriefData["hermesMail"];
  if (anchor === "morning") {
    const unread = store.unreadMailFor("hermes");
    const su = unread.filter((m) => m.kind === "standup")
      .map((m) => ({ lead: m.from_agent, text: m.body.replace(/\n+/g, " / ").slice(0, 400) }));
    if (su.length) standups = su;
    const other = unread.filter((m) => m.kind !== "standup")
      .map((m) => ({ from: m.from_agent, kind: m.kind, line: (m.body.split("\n")[0] ?? "").slice(0, 120) }));
    if (other.length) hermesMail = other;
  }
```

and include `standups, hermesMail,` in the returned object.

(c) `isEmptyBrief`: add two clauses:

```typescript
    (d.standups?.length ?? 0) === 0 &&
    (d.hermesMail?.length ?? 0) === 0 &&
```

(d) `renderBriefNote`: after the Open loops block:

```typescript
  section("Standups", (d.standups ?? []).map((s) => `${s.lead}: ${s.text}`));
  section("Mailroom", (d.hermesMail ?? []).map((m) => `${m.from} (${m.kind}): ${m.line}`));
```

(e) `runBrief`: after the vault write + primary send (before the Vector C block), mark hermes mail read:

```typescript
  // Hermes's inbox is read via the brief — briefed mail is acknowledged.
  if (anchor === "morning") {
    const briefed = deps.store.unreadMailFor("hermes").map((m) => m.id);
    if (briefed.length) deps.store.markMailRead(briefed);
  }
```

- [ ] **Step 4: Run + typecheck** — `npx vitest run test/standup-brief.test.ts && npx tsc --noEmit` → 2 pass, clean.

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/briefs.ts test/standup-brief.test.ts
git commit -m "feat(briefs): morning Standups + Mailroom sections from hermes mail"
```

---

### Task 7: Wiring — hermes send_mail, index.ts, /api/mail, spawnedBy

**Files:**
- Modify: `src/moderator/tools.ts` (deps + tool) and `src/moderator/session.ts:25-34` (MCP_TOOLS entry)
- Modify: `src/index.ts` (Mailbox construction, deps threading, standup anchor)
- Modify: `src/web/goals-view.ts` (`buildMailView`, `spawnedBy`) and `src/web/server.ts` (`/api/mail`)
- Test: `test/mail-endpoints.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

```typescript
// goals-view.ts
export interface MailView {
  id: string; from: string; to: string; kind: string; status: string; body: string;
  goalId: string | null; chainDepth: number; createdAt: string; readAt: string | null; error: string | null;
}
export function buildMailView(store: Store, registry: LoadedRegistry, agent?: string, limit?: number): MailView[];
// buildGoalDetail return gains: spawnedBy: { mailId: string; from: string } | null
```

- [ ] **Step 1: Write the failing test**

```typescript
// test/mail-endpoints.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildMailView, buildGoalDetail } from "../src/web/goals-view.js";
import { MAIL_PREFIX } from "../src/engine/goals.js";

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

describe("goal detail spawnedBy", () => {
  it("mail-spawned goal exposes provenance; normal goal null", () => {
    const store = new Store(":memory:");
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "me-vault-")));
    store.insertMail({
      id: "m1", from_agent: "athena", to_agent: "vulcan", kind: "request", body: "x", goal_id: "g1",
      origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "spawned", error: null,
    });
    store.insertGoal({
      id: "g1", slug: "x", title: "X", request: "x", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "done", project_dir: null, goal_dir: null,
      plan_summary: `${MAIL_PREFIX}m1`, replans_used: 0, error: null, chain_depth: 1,
    });
    store.insertGoal({
      id: "g2", slug: "y", title: "Y", request: "y", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "done", project_dir: null, goal_dir: null,
      plan_summary: "planned", replans_used: 0, error: null, chain_depth: 0,
    });
    expect(buildGoalDetail(store, vault, "g1")!.spawnedBy).toEqual({ mailId: "m1", from: "athena" });
    expect(buildGoalDetail(store, vault, "g2")!.spawnedBy).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify fail** — `buildMailView` not exported.

- [ ] **Step 3: Implement**

(a) `src/web/goals-view.ts`:

```typescript
import { MAIL_PREFIX } from "../engine/goals.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";

export interface MailView {
  id: string; from: string; to: string; kind: string; status: string; body: string;
  goalId: string | null; chainDepth: number; createdAt: string; readAt: string | null; error: string | null;
}

export function buildMailView(store: Store, registry: LoadedRegistry, agent?: string, limit = 50): MailView[] {
  const canonical = agent ? registry.agentOf.get(agent) ?? agent : undefined;
  return store.listMail(canonical, limit).map((m) => ({
    id: m.id, from: m.from_agent, to: m.to_agent, kind: m.kind, status: m.status, body: m.body,
    goalId: m.goal_id, chainDepth: m.chain_depth, createdAt: m.created_at, readAt: m.read_at, error: m.error,
  }));
}
```

and in `buildGoalDetail`, compute provenance before the return:

```typescript
  const spawnedBy = g.plan_summary.startsWith(MAIL_PREFIX)
    ? (() => {
        const m = store.getMail(g.plan_summary.slice(MAIL_PREFIX.length));
        return m ? { mailId: m.id, from: m.from_agent } : null;
      })()
    : null;
  return { ...goalView(g, store), artifacts, spawnedBy };
```

(b) `src/web/server.ts` — inside the token-gated branch next to `/api/goals`:

```typescript
        if (path === "/api/mail" && req.method === "GET") {
          return json(res, 200, buildMailView(store, registry,
            url.searchParams.get("agent") ?? undefined,
            Number(url.searchParams.get("limit") ?? 50)));
        }
```

(import `buildMailView` from `./goals-view.js`; `registry` is already in server deps — verify with grep, thread it if the handler scope lacks it).

(c) `src/moderator/tools.ts` — `ModeratorToolsDeps` gains `mailbox?: Mailbox` (type import from `../mail/mailbox.js`). Add after `handOff` tool:

```typescript
  const sendMail = tool(
    "send_mail",
    "Send mail to a staff agent. kind=request: they run it as a background goal and the result " +
      "reports back (surfaced in your morning brief). kind=note: FYI only. Prefer hand_off when " +
      "you need the answer inline NOW; use mail for work that can run later.",
    { to: z.enum(deps.agentNames as [string, ...string[]]), kind: z.enum(["request", "note"]), body: z.string() },
    async (a) =>
      text(deps.mailbox
        ? deps.mailbox.send({ from: "hermes", origin: deps.origin, goalDepth: 0 }, a)
        : "Refused: the mailbox is disabled."),
  );
```

and add `sendMail` to the server's tools array. In `src/moderator/session.ts` MCP_TOOLS list add `"mcp__aios__send_mail",`.

(d) `src/index.ts`:

- Construct the mailbox BEFORE `makeRunSpecialist` (line ~74). `goals` is declared later in the same scope — the arrow closure is evaluated at call time, after init:

```typescript
  const mailbox = new Mailbox({
    store, registry,
    maxDepth: config.mailMaxDepth, disabled: config.mailDisabled,
    primaryChat: config.primaryChat,
    onEvent: (e) => bus.emit(e),
    onQueued: () => goals.pump(),   // fresh requests sweep promptly (goals initialized before any send)
  });
  const runSpecialist = makeRunSpecialist({ store, bus, registry, mailbox });
```

- `GoalEngine` deps: add `mailMaxDepth: config.mailMaxDepth,`.
- `Moderator` deps: pass `mailbox` (thread through `ModeratorDeps` → `buildModeratorServer`).
- `DirectChats` deps: add `mailbox,`.
- Clock anchors array (order matters — standup BEFORE morning):

```typescript
      { name: "standup", hhmm: config.anchorStandup },
```

inserted between speculate and morning. `onAnchor` gains, before the morning/evening fallthrough:

```typescript
      if (name === "standup") {
        if (config.standupDisabled || config.mailDisabled) return;
        // fire-and-forget: lead one-shots must not block the clock tick / reminders.
        void runStandups({ store, registry, run: runSpecialist, spendGuard, onEvent: (e) => bus.emit(e), log })
          .catch((err) => log(`standups failed: ${(err as Error).message}`));
        return;
      }
```

(import `runStandups` from `./heartbeat/standup.js`, `Mailbox` from `./mail/mailbox.js`).

- Note: `Moderator`'s deps interface (`src/moderator/session.ts` `ModeratorDeps`) also gains `mailbox?: Mailbox`, passed through to `buildModeratorServer`.

- [ ] **Step 4: Run + typecheck + builds**

Run: `npx vitest run test/mail-endpoints.test.ts && npx tsc --noEmit && npm run build && (cd ui && npm run build)`
Expected: 3 pass, all clean (ui untouched but must stay green).

- [ ] **Step 5: Commit**

```bash
git add src/moderator/ src/index.ts src/web/ src/config.ts test/mail-endpoints.test.ts
git commit -m "feat(mail): hermes send_mail, standup anchor wiring, /api/mail, goal spawnedBy provenance"
```

---

### Task 8: Cross-cutting pins + full-suite gate

**Files:**
- Test: `test/mail-pins.test.ts`

Pins that don't belong to any single module: capability parity (the mail option merge is the SAME pure function at every seam), triage hard-guard coverage, standup digest privacy.

- [ ] **Step 1: Write the pin tests**

```typescript
// test/mail-pins.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("mail invariant pins", () => {
  it("all three entry paths use withMailOptions/buildMailServer (capability parity)", () => {
    const runner = readFileSync("src/agents/runner.ts", "utf8");
    const direct = readFileSync("src/agents/direct.ts", "utf8");
    const handoff = readFileSync("src/moderator/handoff.ts", "utf8");
    expect(runner).toContain("withMailOptions(merged");           // node runs + hand_off runs
    expect(direct).toContain("buildMailServer(this.deps.mailbox"); // @mention turns
    expect(handoff).toContain("mailCtx: { origin, goalDepth: 0 }"); // hand_off threads ctx
  });

  it("mail allowlist widening happens BEFORE the denial observer wraps", () => {
    const runner = readFileSync("src/agents/runner.ts", "utf8");
    const mailIdx = runner.indexOf("withMailOptions(merged");
    const observerIdx = runner.indexOf("withDenialObserver(withSchema");
    expect(mailIdx).toBeGreaterThan(-1);
    expect(observerIdx).toBeGreaterThan(mailIdx);
  });

  it("standup digest reads no personal_* or email sources", () => {
    const standup = readFileSync("src/heartbeat/standup.ts", "utf8");
    expect(standup).not.toMatch(/personal_|listTasks|listTransactions|gmail|email/i);
  });

  it("report/standup kinds are not sendable via the tool schema", () => {
    const server = readFileSync("src/mail/server.ts", "utf8");
    expect(server).toContain('z.enum(["request", "note"])');
    expect(server).not.toContain('"report"');
  });
});
```

- [ ] **Step 2: Run pins** — `npx vitest run test/mail-pins.test.ts` → 4 pass (fix any seam the pin catches).

- [ ] **Step 3: Full gate**

Run: `npx vitest run && npx tsc --noEmit && npm run build && (cd ui && npm run build)`
Expected: 778 baseline + ~36 new = ~814 pass + 1 skip, zero failures, all builds clean.

- [ ] **Step 4: Commit**

```bash
git add test/mail-pins.test.ts && git commit -m "test(mail): parity, widen-before-wrap, privacy, and kind-forgery pins"
```

---

## Execution notes

- Build in a worktree via superpowers:using-git-worktrees (EnterWorktree branches from origin/main — spec+plan must be pushed first).
- Finish: whole-branch review subagent → FF merge → push → deploy (`npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`) → live smoke: telegram "@hermes mail vulcan a request to summarize X" → watch /api/mail + goals tab → next morning check standup in brief (or fire the anchor manually by clearing kv `anchor:standup:last`).
- 4b (UI: profile Mail section, goal provenance line, unread badges) is a separate plan after 4a ships.
