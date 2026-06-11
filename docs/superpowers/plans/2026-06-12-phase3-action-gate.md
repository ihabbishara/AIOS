# Phase 3 — Action Gate, Trust Ledger, Approval Queue, Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every outward effect of AI-OS passes through a single trust-gated chokepoint (the Action Gate); approvals/rejections train a per-action-type trust ledger that graduates categories from supervised to autonomous, with full audit history.

**Architecture:** New `src/kernel/` module (pure trust state machine + executor registry + gate class) persisted via two new SQLite tables in the existing `Store`. The gate emits typed events on the existing `EventBus`; approvals arrive via `/approve`-`/reject` chat commands (all channels), Telegram inline buttons, and new web API endpoints + two Mission Control views. The moderator's `vault_write` tool is routed through the gate, and a new `propose_action` tool lets the moderator submit any registered action.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 23 `node:sqlite` (NOT better-sqlite3 — it fails to build on this machine), zod v4, grammY (Telegram), vitest, React 18 + Vite (existing `ui/`).

**Spec:** `docs/superpowers/specs/2026-06-11-cognitive-kernel-design.md`

**Conventions that already exist (follow them):**
- `Store` in `src/store/db.ts` is a single class; tables created in the constructor with `CREATE TABLE IF NOT EXISTS`; one prepared statement per method; ISO-8601 strings for timestamps.
- Imports use `.js` extensions (ESM): `import { Store } from "../store/db.js"`.
- Tests: vitest, `test/*.test.ts`, run with `npm test` (`vitest run`). In-memory DB via `new Store(":memory:")`.
- Events: typed union `AiosEvent` in `src/events.ts`, emitted via `EventBus` (also persists to the `events` table).
- zod is v4: `z.record()` requires two args — `z.record(z.string(), z.unknown())`.

---

### Task 1: Trust state machine (pure logic)

**Files:**
- Create: `src/kernel/trust.ts`
- Test: `test/trust.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/trust.test.ts
import { describe, it, expect } from "vitest";
import {
  newRecord, decide, recordApproval, recordRejection, promote, demote,
  type TrustPolicy,
} from "../src/kernel/trust.js";

const NOW = "2026-06-12T10:00:00.000Z";
const LATER = "2026-07-13T10:00:00.000Z"; // 31 days after NOW

const policy: TrustPolicy = {
  graduationStreak: 3,
  graduationAgeDays: 30,
  alwaysSupervised: new Set(["trust.promote", "purchase.buy"]),
};

describe("decide", () => {
  it("queues when no record exists (unknown type failsafe)", () => {
    expect(decide(undefined, policy)).toBe("queue");
  });

  it("queues supervised and graduating types", () => {
    const rec = newRecord("email.send", NOW);
    expect(decide(rec, policy)).toBe("queue");
    expect(decide({ ...rec, state: "graduating" }, policy)).toBe("queue");
  });

  it("executes autonomous types", () => {
    const rec = { ...newRecord("vault.write", NOW), state: "autonomous" as const };
    expect(decide(rec, policy)).toBe("execute");
  });

  it("hard ceiling: alwaysSupervised queues even when autonomous", () => {
    const rec = { ...newRecord("purchase.buy", NOW), state: "autonomous" as const };
    expect(decide(rec, policy)).toBe("queue");
  });
});

describe("recordApproval", () => {
  it("increments approvals and streak", () => {
    const { record } = recordApproval(newRecord("email.send", NOW), policy, NOW);
    expect(record.approvals).toBe(1);
    expect(record.streak).toBe(1);
    expect(record.state).toBe("supervised");
  });

  it("flags graduation when streak AND age thresholds met", () => {
    let rec = newRecord("email.send", NOW);
    let ready = false;
    for (let i = 0; i < 3; i++) ({ record: rec, graduationReady: ready } = recordApproval(rec, policy, LATER));
    expect(ready).toBe(true);
    expect(rec.state).toBe("graduating");
  });

  it("does NOT graduate before the age threshold", () => {
    let rec = newRecord("email.send", NOW);
    let ready = false;
    for (let i = 0; i < 5; i++) ({ record: rec, graduationReady: ready } = recordApproval(rec, policy, NOW));
    expect(ready).toBe(false);
    expect(rec.state).toBe("supervised");
  });

  it("never graduates alwaysSupervised types", () => {
    let rec = newRecord("purchase.buy", NOW);
    let ready = false;
    for (let i = 0; i < 10; i++) ({ record: rec, graduationReady: ready } = recordApproval(rec, policy, LATER));
    expect(ready).toBe(false);
    expect(rec.state).toBe("supervised");
  });

  it("only flags graduation once (graduating state does not re-flag)", () => {
    let rec = newRecord("email.send", NOW);
    for (let i = 0; i < 3; i++) ({ record: rec } = recordApproval(rec, policy, LATER));
    expect(rec.state).toBe("graduating");
    const { graduationReady } = recordApproval(rec, policy, LATER);
    expect(graduationReady).toBe(false);
  });
});

describe("recordRejection", () => {
  it("resets streak, demotes to supervised, stamps lastRejection", () => {
    const auto = { ...newRecord("email.send", NOW), state: "autonomous" as const, streak: 7, graduatedAt: NOW };
    const rec = recordRejection(auto, LATER);
    expect(rec.state).toBe("supervised");
    expect(rec.streak).toBe(0);
    expect(rec.rejections).toBe(1);
    expect(rec.lastRejection).toBe(LATER);
    expect(rec.graduatedAt).toBeNull();
  });
});

describe("promote / demote", () => {
  it("promote sets autonomous + graduatedAt", () => {
    const rec = promote(newRecord("email.send", NOW), LATER);
    expect(rec.state).toBe("autonomous");
    expect(rec.graduatedAt).toBe(LATER);
  });

  it("demote returns to supervised and clears graduatedAt", () => {
    const rec = demote(promote(newRecord("email.send", NOW), LATER));
    expect(rec.state).toBe("supervised");
    expect(rec.graduatedAt).toBeNull();
    expect(rec.streak).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/trust.test.ts`
Expected: FAIL — `Cannot find module '../src/kernel/trust.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/kernel/trust.ts
export type TrustState = "supervised" | "graduating" | "autonomous";

export interface TrustRecord {
  actionType: string;
  state: TrustState;
  approvals: number;
  rejections: number;
  /** Consecutive approvals since the last rejection/demotion. */
  streak: number;
  /** ISO timestamp of the first time this type was proposed. */
  firstSeen: string;
  lastRejection: string | null;
  graduatedAt: string | null;
}

export interface TrustPolicy {
  /** Consecutive approvals required before a promotion is proposed. */
  graduationStreak: number;
  /** Minimum days since firstSeen before a promotion is proposed. */
  graduationAgeDays: number;
  /** Hard ceiling: types that can never execute autonomously. */
  alwaysSupervised: Set<string>;
}

export const DEFAULT_POLICY: TrustPolicy = {
  graduationStreak: 10,
  graduationAgeDays: 30,
  alwaysSupervised: new Set(["trust.promote"]),
};

export function newRecord(actionType: string, now: string): TrustRecord {
  return {
    actionType, state: "supervised", approvals: 0, rejections: 0, streak: 0,
    firstSeen: now, lastRejection: null, graduatedAt: null,
  };
}

function ageDays(fromIso: string, nowIso: string): number {
  return (Date.parse(nowIso) - Date.parse(fromIso)) / 86_400_000;
}

/** What the gate does with a proposed action of this type. Fail-closed: no record → queue. */
export function decide(record: TrustRecord | undefined, policy: TrustPolicy): "execute" | "queue" {
  if (!record) return "queue";
  if (policy.alwaysSupervised.has(record.actionType)) return "queue";
  return record.state === "autonomous" ? "execute" : "queue";
}

export function recordApproval(
  record: TrustRecord, policy: TrustPolicy, now: string,
): { record: TrustRecord; graduationReady: boolean } {
  const next: TrustRecord = { ...record, approvals: record.approvals + 1, streak: record.streak + 1 };
  const graduationReady =
    next.state === "supervised" &&
    !policy.alwaysSupervised.has(next.actionType) &&
    next.streak >= policy.graduationStreak &&
    ageDays(next.firstSeen, now) >= policy.graduationAgeDays;
  if (graduationReady) next.state = "graduating";
  return { record: next, graduationReady };
}

export function recordRejection(record: TrustRecord, now: string): TrustRecord {
  return {
    ...record, rejections: record.rejections + 1, streak: 0,
    lastRejection: now, state: "supervised", graduatedAt: null,
  };
}

export function promote(record: TrustRecord, now: string): TrustRecord {
  return { ...record, state: "autonomous", graduatedAt: now, streak: 0 };
}

export function demote(record: TrustRecord): TrustRecord {
  return { ...record, state: "supervised", streak: 0, graduatedAt: null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/trust.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/kernel/trust.ts test/trust.test.ts
git commit -m "feat(kernel): trust state machine — earned autonomy core"
```

---

### Task 2: Action types + executor registry

**Files:**
- Create: `src/kernel/actions.ts`
- Test: `test/actions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/actions.test.ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ExecutorRegistry, type Executor } from "../src/kernel/actions.js";

describe("ExecutorRegistry", () => {
  it("registers and retrieves executors by type", () => {
    const reg = new ExecutorRegistry();
    const exec: Executor = {
      type: "test.op",
      schema: z.object({ v: z.string() }),
      execute: async () => "ok",
    };
    reg.register(exec);
    expect(reg.get("test.op")).toBe(exec);
    expect(reg.get("missing")).toBeUndefined();
    expect(reg.types()).toEqual(["test.op"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/actions.test.ts`
Expected: FAIL — `Cannot find module '../src/kernel/actions.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/kernel/actions.ts
import type { z } from "zod";

export type ActionStatus = "proposed" | "executed" | "failed" | "rejected" | "expired";

export interface ActionInput {
  /** Namespaced action type, e.g. "vault.write", "email.send". */
  type: string;
  payload: Record<string, unknown>;
  /** Human-readable one-liner shown in approval requests and the audit log. */
  preview: string;
}

/** Persisted action — doubles as the approval queue (status=proposed) and the audit log (terminal statuses). */
export interface ActionRow {
  id: string;
  type: string;
  /** JSON-encoded payload. */
  payload: string;
  preview: string;
  status: ActionStatus;
  origin_channel: string;
  origin_chat_id: string;
  /** Trust state at proposal time — part of the audit record. */
  trust_state: string;
  verdict_by: string | null;
  reject_reason: string | null;
  result: string | null;
  created_at: string;
  resolved_at: string | null;
  expires_at: string;
}

export interface Executor {
  type: string;
  /** Validates the payload at propose() time — invalid payloads never enter the queue. */
  schema: z.ZodTypeAny;
  /** Performs the outward effect. Returns a short result summary for audit/chat. */
  execute(payload: unknown): Promise<string>;
}

export class ExecutorRegistry {
  private executors = new Map<string, Executor>();

  register(e: Executor): void {
    this.executors.set(e.type, e);
  }

  get(type: string): Executor | undefined {
    return this.executors.get(type);
  }

  types(): string[] {
    return [...this.executors.keys()];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/actions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/kernel/actions.ts test/actions.test.ts
git commit -m "feat(kernel): action types and executor registry"
```

---

### Task 3: Store — trust + actions tables

**Files:**
- Modify: `src/store/db.ts`
- Test: `test/store-kernel.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/store-kernel.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { newRecord } from "../src/kernel/trust.js";
import type { ActionRow } from "../src/kernel/actions.js";

const NOW = "2026-06-12T10:00:00.000Z";

function row(id: string, over: Partial<ActionRow> = {}): ActionRow {
  return {
    id, type: "test.echo", payload: JSON.stringify({ text: "hi" }), preview: "Echo hi",
    status: "proposed", origin_channel: "cli", origin_chat_id: "local",
    trust_state: "supervised", verdict_by: null, reject_reason: null, result: null,
    created_at: NOW, resolved_at: null, expires_at: "2026-06-13T10:00:00.000Z",
    ...over,
  };
}

describe("Store trust", () => {
  it("upserts and reads trust records (round-trip, camelCase)", () => {
    const store = new Store(":memory:");
    expect(store.getTrust("email.send")).toBeUndefined();
    const rec = newRecord("email.send", NOW);
    store.upsertTrust(rec);
    expect(store.getTrust("email.send")).toEqual(rec);
    store.upsertTrust({ ...rec, state: "autonomous", approvals: 5, graduatedAt: NOW });
    const updated = store.getTrust("email.send")!;
    expect(updated.state).toBe("autonomous");
    expect(updated.approvals).toBe(5);
    expect(store.listTrust()).toHaveLength(1);
  });
});

describe("Store actions", () => {
  it("inserts, gets, lists by status", () => {
    const store = new Store(":memory:");
    store.insertAction(row("aaa11111"));
    store.insertAction(row("bbb22222", { status: "executed", result: "done", resolved_at: NOW }));
    expect(store.getAction("aaa11111")?.preview).toBe("Echo hi");
    expect(store.listActions("proposed")).toHaveLength(1);
    expect(store.listActions()).toHaveLength(2);
  });

  it("resolveAction updates verdict fields", () => {
    const store = new Store(":memory:");
    store.insertAction(row("ccc33333"));
    store.resolveAction("ccc33333", {
      status: "rejected", verdict_by: "ihab", reject_reason: "too pricey", result: null, resolved_at: NOW,
    });
    const a = store.getAction("ccc33333")!;
    expect(a.status).toBe("rejected");
    expect(a.verdict_by).toBe("ihab");
    expect(a.reject_reason).toBe("too pricey");
  });

  it("expireActions marks only overdue proposed rows", () => {
    const store = new Store(":memory:");
    store.insertAction(row("ddd44444", { expires_at: "2026-06-12T09:00:00.000Z" })); // overdue
    store.insertAction(row("eee55555", { expires_at: "2026-06-13T10:00:00.000Z" })); // fine
    store.insertAction(row("fff66666", { status: "executed", expires_at: "2026-06-12T09:00:00.000Z" }));
    const expired = store.expireActions(NOW);
    expect(expired).toEqual(["ddd44444"]);
    expect(store.getAction("ddd44444")?.status).toBe("expired");
    expect(store.getAction("eee55555")?.status).toBe("proposed");
    expect(store.getAction("fff66666")?.status).toBe("executed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/store-kernel.test.ts`
Expected: FAIL — `store.getTrust is not a function`

- [ ] **Step 3: Add tables and methods to Store**

In `src/store/db.ts`, add imports at the top:

```ts
import type { TrustRecord } from "../kernel/trust.js";
import type { ActionRow } from "../kernel/actions.js";
```

In the constructor, after the existing `events` table exec, add:

```ts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trust (
        action_type TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        approvals INTEGER NOT NULL DEFAULT 0,
        rejections INTEGER NOT NULL DEFAULT 0,
        streak INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT NOT NULL,
        last_rejection TEXT,
        graduated_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        preview TEXT NOT NULL,
        status TEXT NOT NULL,
        origin_channel TEXT NOT NULL,
        origin_chat_id TEXT NOT NULL,
        trust_state TEXT NOT NULL,
        verdict_by TEXT,
        reject_reason TEXT,
        result TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
    `);
```

Add methods to the `Store` class (before `close()`):

```ts
  // ---- trust ledger ----

  getTrust(actionType: string): TrustRecord | undefined {
    const r = this.db.prepare("SELECT * FROM trust WHERE action_type = ?").get(actionType) as
      | Record<string, unknown>
      | undefined;
    return r ? toTrustRecord(r) : undefined;
  }

  listTrust(): TrustRecord[] {
    return (this.db.prepare("SELECT * FROM trust ORDER BY action_type").all() as unknown as
      Array<Record<string, unknown>>).map(toTrustRecord);
  }

  upsertTrust(t: TrustRecord): void {
    this.db
      .prepare(
        `INSERT INTO trust (action_type, state, approvals, rejections, streak, first_seen, last_rejection, graduated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(action_type) DO UPDATE SET
           state=excluded.state, approvals=excluded.approvals, rejections=excluded.rejections,
           streak=excluded.streak, last_rejection=excluded.last_rejection,
           graduated_at=excluded.graduated_at, updated_at=excluded.updated_at`,
      )
      .run(
        t.actionType, t.state, t.approvals, t.rejections, t.streak,
        t.firstSeen, t.lastRejection, t.graduatedAt, new Date().toISOString(),
      );
  }

  // ---- actions (approval queue + audit log) ----

  insertAction(a: ActionRow): void {
    this.db
      .prepare(
        `INSERT INTO actions (id, type, payload, preview, status, origin_channel, origin_chat_id,
                              trust_state, verdict_by, reject_reason, result, created_at, resolved_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id, a.type, a.payload, a.preview, a.status, a.origin_channel, a.origin_chat_id,
        a.trust_state, a.verdict_by, a.reject_reason, a.result, a.created_at, a.resolved_at, a.expires_at,
      );
  }

  getAction(id: string): ActionRow | undefined {
    return this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as ActionRow | undefined;
  }

  listActions(status?: string, limit = 100): ActionRow[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM actions WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit)
      : this.db.prepare("SELECT * FROM actions ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows as unknown as ActionRow[];
  }

  resolveAction(
    id: string,
    f: { status: string; verdict_by: string | null; reject_reason: string | null; result: string | null; resolved_at: string },
  ): void {
    this.db
      .prepare("UPDATE actions SET status = ?, verdict_by = ?, reject_reason = ?, result = ?, resolved_at = ? WHERE id = ?")
      .run(f.status, f.verdict_by, f.reject_reason, f.result, f.resolved_at, id);
  }

  expireActions(nowIso: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM actions WHERE status = 'proposed' AND expires_at < ? ORDER BY created_at")
      .all(nowIso) as unknown as Array<{ id: string }>;
    for (const r of rows) {
      this.db.prepare("UPDATE actions SET status = 'expired', resolved_at = ? WHERE id = ?").run(nowIso, r.id);
    }
    return rows.map((r) => r.id);
  }
```

Add the row-mapping helper at module level (bottom of the file, outside the class):

```ts
function toTrustRecord(r: Record<string, unknown>): TrustRecord {
  return {
    actionType: r.action_type as string,
    state: r.state as TrustRecord["state"],
    approvals: r.approvals as number,
    rejections: r.rejections as number,
    streak: r.streak as number,
    firstSeen: r.first_seen as string,
    lastRejection: (r.last_rejection as string) ?? null,
    graduatedAt: (r.graduated_at as string) ?? null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/store-kernel.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: all existing tests still PASS

- [ ] **Step 6: Commit**

```bash
git add src/store/db.ts test/store-kernel.test.ts
git commit -m "feat(store): trust and actions tables (approval queue + audit log)"
```

---

### Task 4: Gate event types

**Files:**
- Modify: `src/events.ts:4-12`

- [ ] **Step 1: Extend the AiosEvent union**

In `src/events.ts`, the union currently ends with the `chat.out` variant. Replace:

```ts
  | { type: "chat.in"; channel: string; chatId: string; text: string; sender?: string }
  | { type: "chat.out"; channel: string; chatId: string; text: string };
```

with:

```ts
  | { type: "chat.in"; channel: string; chatId: string; text: string; sender?: string }
  | { type: "chat.out"; channel: string; chatId: string; text: string }
  | { type: "action.proposed"; actionId: string; actionType: string; preview: string }
  | { type: "action.executed"; actionId: string; actionType: string; auto: boolean; ok: boolean }
  | { type: "action.resolved"; actionId: string; actionType: string; verdict: "approved" | "rejected" | "expired" }
  | { type: "trust.changed"; actionType: string; state: string };
```

- [ ] **Step 2: Verify it compiles and nothing breaks**

Run: `npx tsc --noEmit && npm test`
Expected: clean compile, all tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/events.ts
git commit -m "feat(events): action gate and trust event types"
```

---

### Task 5: Built-in executors (vault.write, test.echo, trust.promote)

**Files:**
- Create: `src/kernel/executors.ts`
- Test: `test/executors.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/executors.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { VaultWriter } from "../src/vault/writer.js";
import { newRecord } from "../src/kernel/trust.js";
import { vaultWriteExecutor, echoExecutor, trustPromoteExecutor } from "../src/kernel/executors.js";

describe("echoExecutor", () => {
  it("echoes the payload text", async () => {
    const result = await echoExecutor().execute({ text: "hello" });
    expect(result).toBe("echo: hello");
  });

  it("schema rejects payloads without text", () => {
    expect(() => echoExecutor().schema.parse({})).toThrow();
  });
});

describe("vaultWriteExecutor", () => {
  it("writes a note through the vault", async () => {
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "aios-vault-")), "AIOS");
    vault.init();
    const exec = vaultWriteExecutor(vault);
    const result = await exec.execute({ path: "notes/gate-test.md", content: "# hi" });
    expect(result).toContain("notes/gate-test.md");
    expect(vault.readNote("notes/gate-test.md")).toBe("# hi");
  });
});

describe("trustPromoteExecutor", () => {
  it("promotes the target type to autonomous", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    store.upsertTrust(newRecord("email.send", "2026-06-12T10:00:00.000Z"));
    const exec = trustPromoteExecutor(store, bus);
    await exec.execute({ action_type: "email.send" });
    expect(store.getTrust("email.send")?.state).toBe("autonomous");
  });

  it("throws for unknown types", async () => {
    const store = new Store(":memory:");
    const exec = trustPromoteExecutor(store, new EventBus(store));
    await expect(exec.execute({ action_type: "nope" })).rejects.toThrow("no trust record");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/executors.test.ts`
Expected: FAIL — `Cannot find module '../src/kernel/executors.js'`

Note: if `VaultWriter`'s constructor or method names differ from `(vaultPath, subdir)` / `init()` / `writeNote()` / `readNote()`, check `src/vault/writer.ts` and adjust the test to the real API — `src/moderator/tools.ts:96` shows `vault.writeNote(path, content)` returns the saved path string.

- [ ] **Step 3: Write the implementation**

```ts
// src/kernel/executors.ts
import { z } from "zod";
import type { Executor } from "./actions.js";
import type { VaultWriter } from "../vault/writer.js";
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import { promote } from "./trust.js";

export function vaultWriteExecutor(vault: VaultWriter): Executor {
  return {
    type: "vault.write",
    schema: z.object({ path: z.string(), content: z.string() }),
    async execute(payload) {
      const p = payload as { path: string; content: string };
      return `Saved: ${vault.writeNote(p.path, p.content)}`;
    },
  };
}

/** Harmless supervised action used for demos and end-to-end tests of the approval loop. */
export function echoExecutor(): Executor {
  return {
    type: "test.echo",
    schema: z.object({ text: z.string() }),
    async execute(payload) {
      return `echo: ${(payload as { text: string }).text}`;
    },
  };
}

/** Approving this action is what actually promotes a type — the gate never auto-promotes. */
export function trustPromoteExecutor(store: Store, bus: EventBus): Executor {
  return {
    type: "trust.promote",
    schema: z.object({ action_type: z.string() }),
    async execute(payload) {
      const type = (payload as { action_type: string }).action_type;
      const record = store.getTrust(type);
      if (!record) throw new Error(`no trust record for ${type}`);
      store.upsertTrust(promote(record, new Date().toISOString()));
      bus.emit({ type: "trust.changed", actionType: type, state: "autonomous" });
      return `${type} promoted to autonomous`;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/executors.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/kernel/executors.ts test/executors.test.ts
git commit -m "feat(kernel): built-in executors — vault.write, test.echo, trust.promote"
```

---

### Task 6: The Action Gate

**Files:**
- Create: `src/kernel/gate.ts`
- Test: `test/gate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/gate.test.ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Store } from "../src/store/db.js";
import { EventBus, type StoredEvent } from "../src/events.js";
import { ExecutorRegistry, type Executor } from "../src/kernel/actions.js";
import { trustPromoteExecutor } from "../src/kernel/executors.js";
import { newRecord, promote, type TrustPolicy } from "../src/kernel/trust.js";
import { ActionGate } from "../src/kernel/gate.js";

const ORIGIN = { channel: "cli", chatId: "local" };
const NOW = "2026-06-12T10:00:00.000Z";

function setup(opts: { expiryMs?: number; streak?: number; ageDays?: number } = {}) {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const events: StoredEvent[] = [];
  bus.on((e) => events.push(e));
  const calls: unknown[] = [];
  const registry = new ExecutorRegistry();
  const fake: Executor = {
    type: "fake.op",
    schema: z.object({ v: z.string() }),
    async execute(p) { calls.push(p); return `did ${(p as { v: string }).v}`; },
  };
  const failing: Executor = {
    type: "fake.fail",
    schema: z.object({}),
    async execute() { throw new Error("boom"); },
  };
  registry.register(fake);
  registry.register(failing);
  registry.register(trustPromoteExecutor(store, bus));
  const policy: TrustPolicy = {
    graduationStreak: opts.streak ?? 3,
    graduationAgeDays: opts.ageDays ?? 0,
    alwaysSupervised: new Set(["trust.promote"]),
  };
  const gate = new ActionGate({ store, registry, policy, bus, expiryMs: opts.expiryMs ?? 60_000 });
  return { store, bus, events, calls, gate };
}

describe("ActionGate.propose", () => {
  it("queues unknown-trust types as supervised (fail closed)", async () => {
    const { gate, store, calls, events } = setup();
    const row = await gate.propose({ type: "fake.op", payload: { v: "x" }, preview: "do x" }, ORIGIN);
    expect(row.status).toBe("proposed");
    expect(calls).toHaveLength(0);
    expect(store.getTrust("fake.op")?.state).toBe("supervised");
    expect(events.some((e) => e.event.type === "action.proposed")).toBe(true);
  });

  it("executes autonomous types immediately and audits them", async () => {
    const { gate, store, calls } = setup();
    store.upsertTrust(promote(newRecord("fake.op", NOW), NOW));
    const row = await gate.propose({ type: "fake.op", payload: { v: "x" }, preview: "do x" }, ORIGIN);
    expect(row.status).toBe("executed");
    expect(row.result).toBe("did x");
    expect(calls).toHaveLength(1);
    expect(store.getAction(row.id)?.status).toBe("executed");
  });

  it("rejects unregistered action types", async () => {
    const { gate } = setup();
    await expect(gate.propose({ type: "nope", payload: {}, preview: "?" }, ORIGIN))
      .rejects.toThrow("no executor registered");
  });

  it("rejects payloads that fail the executor schema", async () => {
    const { gate } = setup();
    await expect(gate.propose({ type: "fake.op", payload: { wrong: 1 }, preview: "?" }, ORIGIN))
      .rejects.toThrow();
  });
});

describe("ActionGate.resolve", () => {
  it("approve executes, records verdict, and trains trust", async () => {
    const { gate, store, calls } = setup();
    const row = await gate.propose({ type: "fake.op", payload: { v: "x" }, preview: "do x" }, ORIGIN);
    const done = await gate.resolve(row.id, "approve", { by: "ihab" });
    expect(done.status).toBe("executed");
    expect(done.verdict_by).toBe("ihab");
    expect(calls).toHaveLength(1);
    expect(store.getTrust("fake.op")?.approvals).toBe(1);
    expect(store.getTrust("fake.op")?.streak).toBe(1);
  });

  it("reject records reason and resets trust streak", async () => {
    const { gate, store } = setup();
    const row = await gate.propose({ type: "fake.op", payload: { v: "x" }, preview: "do x" }, ORIGIN);
    const done = await gate.resolve(row.id, "reject", { by: "ihab", reason: "not now" });
    expect(done.status).toBe("rejected");
    expect(done.reject_reason).toBe("not now");
    expect(store.getTrust("fake.op")?.rejections).toBe(1);
    expect(store.getTrust("fake.op")?.streak).toBe(0);
  });

  it("approve counts even when execution fails (status=failed)", async () => {
    const { gate, store } = setup();
    const row = await gate.propose({ type: "fake.fail", payload: {}, preview: "will fail" }, ORIGIN);
    const done = await gate.resolve(row.id, "approve", { by: "ihab" });
    expect(done.status).toBe("failed");
    expect(done.result).toBe("boom");
    expect(store.getTrust("fake.fail")?.approvals).toBe(1);
  });

  it("cannot resolve twice", async () => {
    const { gate } = setup();
    const row = await gate.propose({ type: "fake.op", payload: { v: "x" }, preview: "do x" }, ORIGIN);
    await gate.resolve(row.id, "approve", { by: "ihab" });
    await expect(gate.resolve(row.id, "approve", { by: "ihab" })).rejects.toThrow("already");
  });

  it("expired actions cannot be resolved and get marked expired", async () => {
    const { gate, store } = setup({ expiryMs: -1000 }); // born expired
    const row = await gate.propose({ type: "fake.op", payload: { v: "x" }, preview: "do x" }, ORIGIN);
    await expect(gate.resolve(row.id, "approve", { by: "ihab" })).rejects.toThrow("expired");
    expect(store.getAction(row.id)?.status).toBe("expired");
  });
});

describe("graduation loop", () => {
  it("streak threshold proposes a trust.promote action; approving it makes the type autonomous", async () => {
    const { gate, store, calls } = setup({ streak: 3, ageDays: 0 });
    for (let i = 0; i < 3; i++) {
      const row = await gate.propose({ type: "fake.op", payload: { v: `r${i}` }, preview: `run ${i}` }, ORIGIN);
      await gate.resolve(row.id, "approve", { by: "ihab" });
    }
    expect(store.getTrust("fake.op")?.state).toBe("graduating");
    const pending = store.listActions("proposed");
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe("trust.promote");

    await gate.resolve(pending[0].id, "approve", { by: "ihab" });
    expect(store.getTrust("fake.op")?.state).toBe("autonomous");

    // Next proposal of fake.op executes without approval.
    const auto = await gate.propose({ type: "fake.op", payload: { v: "free" }, preview: "free run" }, ORIGIN);
    expect(auto.status).toBe("executed");
    expect(calls).toHaveLength(4); // 3 approved + 1 autonomous
  });

  it("rejecting the promotion sends the target type back to supervised", async () => {
    const { gate, store } = setup({ streak: 3, ageDays: 0 });
    for (let i = 0; i < 3; i++) {
      const row = await gate.propose({ type: "fake.op", payload: { v: `r${i}` }, preview: `run ${i}` }, ORIGIN);
      await gate.resolve(row.id, "approve", { by: "ihab" });
    }
    const promo = store.listActions("proposed")[0];
    await gate.resolve(promo.id, "reject", { by: "ihab" });
    const trust = store.getTrust("fake.op")!;
    expect(trust.state).toBe("supervised");
    expect(trust.streak).toBe(0);
    // promotion rejection must not pollute the trust.promote type's own ledger
    expect(store.getTrust("trust.promote")?.rejections ?? 0).toBe(0);
  });
});

describe("manual demote + sweep", () => {
  it("demoteType drops an autonomous type to supervised", async () => {
    const { gate, store } = setup();
    store.upsertTrust(promote(newRecord("fake.op", NOW), NOW));
    gate.demoteType("fake.op");
    expect(store.getTrust("fake.op")?.state).toBe("supervised");
  });

  it("sweepExpired marks overdue proposals", async () => {
    const { gate, store } = setup({ expiryMs: -1000 });
    await gate.propose({ type: "fake.op", payload: { v: "x" }, preview: "do x" }, ORIGIN);
    expect(gate.sweepExpired()).toBe(1);
    expect(store.listActions("expired")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/gate.test.ts`
Expected: FAIL — `Cannot find module '../src/kernel/gate.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/kernel/gate.ts
import { randomUUID } from "node:crypto";
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import type { ActionInput, ActionRow, ExecutorRegistry } from "./actions.js";
import {
  decide, demote, newRecord, recordApproval, recordRejection, type TrustPolicy,
} from "./trust.js";

export interface GateDeps {
  store: Store;
  registry: ExecutorRegistry;
  policy: TrustPolicy;
  bus: EventBus;
  /** How long a queued approval stays valid (ms). */
  expiryMs: number;
  log?: (line: string) => void;
}

export interface Origin {
  channel: string;
  chatId: string;
}

/**
 * The only door out: every outward effect passes through here.
 * Autonomous types execute immediately (and are audited); everything else
 * queues for a user verdict. Verdicts train the trust ledger.
 */
export class ActionGate {
  constructor(private deps: GateDeps) {}

  /** Submit an action. Executes immediately when trusted, otherwise queues for approval. */
  async propose(input: ActionInput, origin: Origin): Promise<ActionRow> {
    const { store, registry, policy, bus, expiryMs } = this.deps;
    const executor = registry.get(input.type);
    if (!executor) throw new Error(`no executor registered for action type "${input.type}"`);
    executor.schema.parse(input.payload);

    const now = new Date().toISOString();
    let trust = store.getTrust(input.type);
    if (!trust) {
      trust = newRecord(input.type, now);
      store.upsertTrust(trust);
    }

    const row: ActionRow = {
      id: randomUUID().slice(0, 8),
      type: input.type,
      payload: JSON.stringify(input.payload),
      preview: input.preview,
      status: "proposed",
      origin_channel: origin.channel,
      origin_chat_id: origin.chatId,
      trust_state: trust.state,
      verdict_by: null,
      reject_reason: null,
      result: null,
      created_at: now,
      resolved_at: null,
      expires_at: new Date(Date.now() + expiryMs).toISOString(),
    };
    store.insertAction(row);

    if (decide(trust, policy) === "execute") {
      return this.runExecutor(row, true, null);
    }

    bus.emit({ type: "action.proposed", actionId: row.id, actionType: row.type, preview: row.preview });
    return row;
  }

  /** Apply a user verdict to a queued action. */
  async resolve(id: string, verdict: "approve" | "reject", opts: { by: string; reason?: string }): Promise<ActionRow> {
    const { store, bus } = this.deps;
    const row = store.getAction(id);
    if (!row) throw new Error(`no action ${id}`);
    if (row.status !== "proposed") throw new Error(`action ${id} already ${row.status}`);

    const now = new Date().toISOString();
    if (row.expires_at < now) {
      store.resolveAction(id, { status: "expired", verdict_by: null, reject_reason: null, result: null, resolved_at: now });
      bus.emit({ type: "action.resolved", actionId: id, actionType: row.type, verdict: "expired" });
      throw new Error(`action ${id} expired`);
    }

    if (verdict === "reject") {
      store.resolveAction(id, {
        status: "rejected", verdict_by: opts.by, reject_reason: opts.reason ?? null, result: null, resolved_at: now,
      });
      this.trainOnReject(row, now);
      bus.emit({ type: "action.resolved", actionId: id, actionType: row.type, verdict: "rejected" });
      return store.getAction(id)!;
    }

    const executed = await this.runExecutor(row, false, opts.by);
    this.trainOnApprove(row, now);
    bus.emit({ type: "action.resolved", actionId: id, actionType: row.type, verdict: "approved" });
    return executed;
  }

  /** Manual demotion from the UI — no rejection counted, just state. */
  demoteType(actionType: string): void {
    const trust = this.deps.store.getTrust(actionType);
    if (!trust) return;
    this.deps.store.upsertTrust(demote(trust));
    this.deps.bus.emit({ type: "trust.changed", actionType, state: "supervised" });
  }

  /** Mark overdue proposals expired. Called on an interval by the daemon. */
  sweepExpired(): number {
    const ids = this.deps.store.expireActions(new Date().toISOString());
    for (const id of ids) {
      const row = this.deps.store.getAction(id)!;
      this.deps.bus.emit({ type: "action.resolved", actionId: id, actionType: row.type, verdict: "expired" });
    }
    return ids.length;
  }

  private async runExecutor(row: ActionRow, auto: boolean, verdictBy: string | null): Promise<ActionRow> {
    const { store, registry, bus } = this.deps;
    const executor = registry.get(row.type)!;
    let status: "executed" | "failed";
    let result: string;
    try {
      result = await executor.execute(JSON.parse(row.payload));
      status = "executed";
    } catch (err) {
      result = (err as Error).message;
      status = "failed";
    }
    store.resolveAction(row.id, {
      status, verdict_by: verdictBy, reject_reason: null, result, resolved_at: new Date().toISOString(),
    });
    bus.emit({ type: "action.executed", actionId: row.id, actionType: row.type, auto, ok: status === "executed" });
    return store.getAction(row.id)!;
  }

  private trainOnApprove(row: ActionRow, now: string): void {
    // Promotions carry their own bookkeeping (the executor flips the target type).
    if (row.type === "trust.promote") return;
    const { store, policy, bus } = this.deps;
    const trust = store.getTrust(row.type) ?? newRecord(row.type, now);
    const { record, graduationReady } = recordApproval(trust, policy, now);
    store.upsertTrust(record);
    if (graduationReady) {
      bus.emit({ type: "trust.changed", actionType: row.type, state: "graduating" });
      void this.propose(
        {
          type: "trust.promote",
          payload: { action_type: row.type },
          preview: `Promote ${row.type} to autonomous (${record.streak} consecutive approvals)`,
        },
        { channel: row.origin_channel, chatId: row.origin_chat_id },
      ).catch((err) => this.deps.log?.(`promotion proposal failed: ${(err as Error).message}`));
    }
  }

  private trainOnReject(row: ActionRow, now: string): void {
    const { store, bus } = this.deps;
    if (row.type === "trust.promote") {
      // Rejecting a promotion: target type back to supervised, streak reset.
      // Does NOT count as a rejection against trust.promote itself.
      const target = (JSON.parse(row.payload) as { action_type: string }).action_type;
      const trust = store.getTrust(target);
      if (trust) {
        store.upsertTrust(demote(trust));
        bus.emit({ type: "trust.changed", actionType: target, state: "supervised" });
      }
      return;
    }
    const trust = store.getTrust(row.type) ?? newRecord(row.type, now);
    store.upsertTrust(recordRejection(trust, now));
    bus.emit({ type: "trust.changed", actionType: row.type, state: "supervised" });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/gate.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/kernel/gate.ts test/gate.test.ts
git commit -m "feat(kernel): action gate — trust-gated execution with earned-autonomy training"
```

---

### Task 7: Config — gate policy, expiry, trust seeds

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts` (append new describe block)

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.ts`:

```ts
import { parseTrustSeeds } from "../src/config.js"; // merge into existing imports

describe("parseTrustSeeds", () => {
  it("parses type=state pairs", () => {
    const seeds = parseTrustSeeds("vault.write=autonomous, test.echo=supervised");
    expect(seeds.get("vault.write")).toBe("autonomous");
    expect(seeds.get("test.echo")).toBe("supervised");
  });

  it("ignores malformed entries and unknown states", () => {
    const seeds = parseTrustSeeds("bad, x=wat, =autonomous");
    expect(seeds.size).toBe(0);
  });

  it("handles undefined", () => {
    expect(parseTrustSeeds(undefined).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `parseTrustSeeds` is not exported

- [ ] **Step 3: Implement config additions**

In `src/config.ts`:

Add import at the top:

```ts
import type { TrustPolicy, TrustState } from "./kernel/trust.js";
```

Add to the `Config` interface (after `uiDist: string;`):

```ts
  /** How long a queued approval stays valid (ms). */
  actionExpiryMs: number;
  trustPolicy: TrustPolicy;
  /** Initial trust states applied at startup for types with no existing record. */
  trustSeeds: Map<string, TrustState>;
```

Add the parser (module level, near `parseBindings`):

```ts
/** Parses "vault.write=autonomous,test.echo=supervised" — unknown states are ignored. */
export function parseTrustSeeds(raw: string | undefined): Map<string, TrustState> {
  const map = new Map<string, TrustState>();
  for (const pair of (raw ?? "").split(",")) {
    const [type, state] = pair.split("=").map((s) => s.trim());
    if (type && (state === "autonomous" || state === "supervised")) map.set(type, state);
  }
  return map;
}
```

Add to the object returned by `loadConfig` (after `uiDist: ...`):

```ts
    actionExpiryMs: Number(process.env.AIOS_ACTION_EXPIRY_MS ?? 24 * 60 * 60 * 1000),
    trustPolicy: {
      graduationStreak: Number(process.env.AIOS_GRADUATION_STREAK ?? 10),
      graduationAgeDays: Number(process.env.AIOS_GRADUATION_AGE_DAYS ?? 30),
      // trust.promote is ALWAYS in the ceiling set — promotions must always be human-approved.
      alwaysSupervised: new Set([
        "trust.promote",
        ...(process.env.AIOS_ALWAYS_SUPERVISED ?? "")
          .split(",").map((s) => s.trim()).filter(Boolean),
      ]),
    },
    trustSeeds: parseTrustSeeds(process.env.AIOS_TRUST_SEED ?? "vault.write=autonomous"),
```

Default seed rationale: `vault.write` is an internal, low-risk artifact write the moderator
performs constantly — supervising it from day one would spam approvals. Everything else
starts supervised.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): gate policy, action expiry, trust seeds"
```

---

### Task 8: Router — /approve and /reject commands

**Files:**
- Modify: `src/router.ts`
- Test: `test/router-gate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/router-gate.test.ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { ExecutorRegistry, type Executor } from "../src/kernel/actions.js";
import { ActionGate } from "../src/kernel/gate.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { MessageRouter } from "../src/router.js";

function setup() {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const registry = new ExecutorRegistry();
  const echo: Executor = {
    type: "test.echo",
    schema: z.object({ text: z.string() }),
    async execute(p) { return `echo: ${(p as { text: string }).text}`; },
  };
  registry.register(echo);
  const gate = new ActionGate({ store, registry, policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
  // Stubs: gate commands must short-circuit before any agent is consulted.
  const router = new MessageRouter({
    moderator: { handle: async () => "moderator-reply" } as never,
    directChats: { handle: async () => "direct-reply" } as never,
    finance: { handle: async () => "finance-reply" } as never,
    chatBindings: new Map(),
    gate,
  });
  return { store, gate, router };
}

describe("router gate commands", () => {
  it("/approve executes the queued action", async () => {
    const { gate, router, store } = setup();
    const row = await gate.propose(
      { type: "test.echo", payload: { text: "hi" }, preview: "Echo hi" },
      { channel: "cli", chatId: "local" },
    );
    const reply = await router.handle({ channel: "cli", chatId: "local", text: `/approve ${row.id}` });
    expect(reply).toContain("Executed");
    expect(reply).toContain("echo: hi");
    expect(store.getAction(row.id)?.status).toBe("executed");
  });

  it("/reject records the reason", async () => {
    const { gate, router, store } = setup();
    const row = await gate.propose(
      { type: "test.echo", payload: { text: "hi" }, preview: "Echo hi" },
      { channel: "cli", chatId: "local" },
    );
    const reply = await router.handle({ channel: "cli", chatId: "local", text: `/reject ${row.id} too noisy` });
    expect(reply).toContain("Rejected");
    expect(store.getAction(row.id)?.reject_reason).toBe("too noisy");
  });

  it("unknown id returns a gate error, not a crash", async () => {
    const { router } = setup();
    const reply = await router.handle({ channel: "cli", chatId: "local", text: "/approve zzzzzzzz" });
    expect(reply).toContain("no action");
  });

  it("normal messages still reach the moderator", async () => {
    const { router } = setup();
    const reply = await router.handle({ channel: "cli", chatId: "local", text: "hello there" });
    expect(reply).toBe("moderator-reply");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/router-gate.test.ts`
Expected: FAIL — `gate` is not a known property of RouterDeps (TS error) or commands fall through to moderator

- [ ] **Step 3: Implement the intercept**

In `src/router.ts`:

Add import:

```ts
import type { ActionGate } from "./kernel/gate.js";
```

Add to `RouterDeps`:

```ts
  gate?: ActionGate;
```

In `handle()`, directly after the `bus?.emit({ type: "chat.in", ... })` call, add:

```ts
    // Gate verdicts short-circuit all routing: /approve <id>, /reject <id> [reason]
    const gateCmd = /^\/(approve|reject)\s+([\w-]+)(?:\s+([\s\S]+))?$/i.exec(msg.text.trim());
    if (gateCmd && this.deps.gate) {
      const [, verb, id, reason] = gateCmd;
      let reply: string;
      try {
        const row = await this.deps.gate.resolve(id, verb.toLowerCase() as "approve" | "reject", {
          by: msg.sender?.username ?? msg.sender?.name ?? msg.channel,
          reason: reason?.trim(),
        });
        reply =
          row.status === "executed" ? `✓ Executed [${row.type}] — ${row.result}`
          : row.status === "failed" ? `⚠ Approved, but execution failed [${row.type}] — ${row.result}`
          : `✗ Rejected [${row.type}]${row.reject_reason ? ` — ${row.reject_reason}` : ""}`;
      } catch (err) {
        reply = `Gate: ${(err as Error).message}`;
      }
      bus?.emit({ type: "chat.out", channel: msg.channel, chatId: msg.chatId, text: reply.slice(0, 300) });
      return reply;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/router-gate.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/router.ts test/router-gate.test.ts
git commit -m "feat(router): /approve and /reject gate commands on every channel"
```

---

### Task 9: Moderator — vault_write through the gate + propose_action tool

**Files:**
- Modify: `src/moderator/tools.ts`
- Modify: `src/moderator/session.ts:9-17` (MCP_TOOLS list), `src/moderator/session.ts:22-31` (deps), `src/moderator/session.ts:58-69` (turn wiring)
- Modify: `src/index.ts:57-66` (Moderator construction — add gate)

No unit test: SDK MCP tool handlers are thin shims over the gate (already covered by
`test/gate.test.ts`); they're exercised in the Task 11 smoke test.

- [ ] **Step 1: Update `src/moderator/tools.ts`**

Add import:

```ts
import type { ActionGate } from "../kernel/gate.js";
```

Add to `ModeratorToolsDeps`:

```ts
  gate: ActionGate;
```

Replace the existing `vaultWrite` tool definition with:

```ts
  const vaultWrite = tool(
    "vault_write",
    "Write a markdown note to the Obsidian vault (audited through the action gate). " +
      "Path is relative to the AIOS folder, e.g. notes/idea-x.md or knowledge/topic.md",
    {
      path: z.string(),
      content: z.string(),
    },
    async (args) => {
      const row = await deps.gate.propose(
        { type: "vault.write", payload: { path: args.path, content: args.content }, preview: `Write vault note ${args.path}` },
        deps.origin,
      );
      if (row.status === "executed") return text(row.result!);
      if (row.status === "failed") return text(`Write failed: ${row.result}`);
      return text(`Queued for user approval (action ${row.id}). The note is NOT written until the user approves.`);
    },
  );
```

Also add to `ModeratorToolsDeps`:

```ts
  /** Registered executor types, for the tool description. */
  actionTypes: string[];
```

Add the new tool after `vaultList`:

```ts
  const proposeAction = tool(
    "propose_action",
    "Propose an outward action through the trust gate. Trusted action types execute " +
      "immediately; everything else is queued for the user to approve. " +
      `Registered types: ${deps.actionTypes.join(", ")}`,
    {
      type: z.string().describe("Registered action type, e.g. test.echo"),
      payload: z.record(z.string(), z.unknown()).describe("Payload matching the action type's schema"),
      preview: z.string().describe("One-line human summary shown in the approval request"),
    },
    async (args) => {
      try {
        const row = await deps.gate.propose(
          { type: args.type, payload: args.payload as Record<string, unknown>, preview: args.preview },
          deps.origin,
        );
        if (row.status === "executed") return text(`Executed: ${row.result}`);
        if (row.status === "failed") return text(`Execution failed: ${row.result}`);
        return text(`Queued for user approval: action ${row.id} [${row.type}] ${row.preview}`);
      } catch (err) {
        return text(`Gate refused: ${(err as Error).message}`);
      }
    },
  );
```

Finally, register the tool in the server (replace the existing `tools:` array):

```ts
    tools: [runPlaybook, jobStatus, listPlaybooks, askSpecialist, vaultWrite, vaultRead, vaultList, proposeAction],
```

- [ ] **Step 2: Update `src/moderator/session.ts`**

Add `"mcp__aios__propose_action"` to the `MCP_TOOLS` array.

Add to `ModeratorDeps`:

```ts
  gate: ActionGate;
  actionTypes: string[];
```

with import:

```ts
import type { ActionGate } from "../kernel/gate.js";
```

In `turn()`, pass them to `buildModeratorServer`:

```ts
    const server = buildModeratorServer({
      jobs,
      store,
      vault,
      projectsRoot,
      gate: this.deps.gate,
      actionTypes: this.deps.actionTypes,
      origin: this.origin,
      consult: (role, question) =>
        this.deps.run(role, question, { cwd: projectsRoot, model: this.deps.specialistModel }),
    });
```

- [ ] **Step 3: Update the Moderator construction in `src/index.ts`**

This step only compiles once Task 11 wires the gate — do Task 11's index.ts changes
together with this if working sequentially; the construction gains:

```ts
  const moderator = new Moderator({
    store,
    jobs,
    vault,
    run: runSpecialist,
    projectsRoot: config.projectsRoot,
    gate,
    actionTypes: registry.types(),
    model: config.moderatorModel,
    specialistModel: config.specialistModel,
    log,
  });
```

- [ ] **Step 4: Verify compile (after Task 11) and commit**

Run: `npx tsc --noEmit`
Expected: clean

```bash
git add src/moderator/tools.ts src/moderator/session.ts
git commit -m "feat(moderator): vault_write through gate + propose_action tool"
```

---

### Task 10: Channel interface + Telegram inline approval buttons

**Files:**
- Modify: `src/channels/types.ts`
- Modify: `src/channels/telegram.ts`

No unit test (requires a live bot); verified in Task 11/12 smoke tests and once the bot
token arrives. Keep the logic thin — all decisions live in the gate.

- [ ] **Step 1: Extend `src/channels/types.ts`**

Add to the `ChannelAdapter` interface:

```ts
  /** Rich approval request (e.g. inline buttons). Channels without it get a plain-text fallback. */
  sendApprovalRequest?(chatId: string, approval: { id: string; type: string; preview: string }): Promise<void>;
  /** Wire the verdict callback (button taps). Returns the user-facing outcome line. */
  setVerdictHandler?(
    handler: (v: { actionId: string; verdict: "approve" | "reject"; by: string }) => Promise<string>,
  ): void;
```

- [ ] **Step 2: Implement in `src/channels/telegram.ts`**

Update the grammy import:

```ts
import { Bot, InputFile, InlineKeyboard, type Context } from "grammy";
```

Add a field to `TelegramChannel`:

```ts
  private verdictHandler?: (v: { actionId: string; verdict: "approve" | "reject"; by: string }) => Promise<string>;
```

Add the two methods (after `sendFile`):

```ts
  setVerdictHandler(
    handler: (v: { actionId: string; verdict: "approve" | "reject"; by: string }) => Promise<string>,
  ): void {
    this.verdictHandler = handler;
  }

  async sendApprovalRequest(chatId: string, a: { id: string; type: string; preview: string }): Promise<void> {
    const kb = new InlineKeyboard()
      .text("✓ Approve", `act:${a.id}:approve`)
      .text("✗ Reject", `act:${a.id}:reject`);
    await this.bot.api.sendMessage(
      Number(chatId),
      `⚖ Approval needed [${a.type}]\n${a.preview}\n\nOr reply: /approve ${a.id} · /reject ${a.id} <reason>`,
      { reply_markup: kb },
    );
  }
```

In `start()`, register the callback handler (before `void this.bot.start();`):

```ts
    this.bot.on("callback_query:data", async (ctx) => {
      const m = /^act:([\w-]+):(approve|reject)$/.exec(ctx.callbackQuery.data);
      if (!m || !this.verdictHandler) return void (await ctx.answerCallbackQuery());
      if (this.allowedUserIds.length && !this.allowedUserIds.includes(ctx.from.id)) {
        return void (await ctx.answerCallbackQuery({ text: "Not authorized" }));
      }
      const outcome = await this.verdictHandler({
        actionId: m[1],
        verdict: m[2] as "approve" | "reject",
        by: ctx.from.username ?? String(ctx.from.id),
      });
      await ctx.answerCallbackQuery({ text: outcome.slice(0, 190) });
      // Append the outcome to the original message and drop the buttons.
      const original = ctx.callbackQuery.message?.text ?? "";
      await ctx.editMessageText(`${original}\n\n→ ${outcome}`).catch(() => {});
    });
```

- [ ] **Step 3: Verify compile**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add src/channels/types.ts src/channels/telegram.ts
git commit -m "feat(telegram): inline approve/reject buttons for gate approvals"
```

---

### Task 11: Daemon wiring — gate, seeds, notifier, sweep

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Wire the kernel into `main()`**

Add imports at the top of `src/index.ts`:

```ts
import { ExecutorRegistry } from "./kernel/actions.js";
import { vaultWriteExecutor, echoExecutor, trustPromoteExecutor } from "./kernel/executors.js";
import { ActionGate } from "./kernel/gate.js";
import { newRecord } from "./kernel/trust.js";
```

After `const playbooks = loadPlaybooks(...)` / before `const channels = new Map(...)`, add:

```ts
  // ---- action gate (the only door out) ----
  const registry = new ExecutorRegistry();
  registry.register(vaultWriteExecutor(vault));
  registry.register(echoExecutor());
  registry.register(trustPromoteExecutor(store, bus));

  const gate = new ActionGate({
    store, registry, policy: config.trustPolicy, bus, expiryMs: config.actionExpiryMs, log,
  });

  // Seed initial trust states (only for types with no existing record).
  for (const [type, state] of config.trustSeeds) {
    if (!store.getTrust(type)) {
      const rec = newRecord(type, new Date().toISOString());
      store.upsertTrust(state === "autonomous" ? { ...rec, state, graduatedAt: rec.firstSeen } : rec);
      log(`trust seed: ${type} -> ${state}`);
    }
  }
```

Update the `Moderator` construction per Task 9 Step 3 (add `gate` and `actionTypes: registry.types()`).

Update the `MessageRouter` construction — add `gate`:

```ts
  const router = new MessageRouter({
    moderator,
    directChats,
    finance,
    chatBindings: config.chatBindings,
    bus,
    gate,
  });
```

After the channel start loop (`for (const [name, ch] of channels) { ... }`), add:

```ts
  // Approval delivery: pings the chat that originated a queued action.
  bus.on((e) => {
    if (e.event.type !== "action.proposed") return;
    const row = store.getAction(e.event.actionId);
    if (!row) return;
    const ch = channels.get(row.origin_channel);
    if (!ch) return; // e.g. web-originated — visible in the dashboard approval inbox
    void (async () => {
      if (ch.sendApprovalRequest) {
        await ch.sendApprovalRequest(row.origin_chat_id, { id: row.id, type: row.type, preview: row.preview });
      } else {
        await ch.send(
          row.origin_chat_id,
          `⚖ Approval needed [${row.type}] ${row.preview}\nReply: /approve ${row.id} or /reject ${row.id} <reason>`,
        );
      }
    })().catch((err) => log(`approval notify failed: ${(err as Error).message}`));
  });

  // Button verdicts from channels go straight to the gate.
  for (const ch of channels.values()) {
    ch.setVerdictHandler?.(async (v) => {
      try {
        const row = await gate.resolve(v.actionId, v.verdict, { by: v.by });
        return row.status === "executed" ? `✓ Executed — ${row.result}`
          : row.status === "failed" ? `⚠ Execution failed — ${row.result}`
          : `✗ Rejected`;
      } catch (err) {
        return `Gate: ${(err as Error).message}`;
      }
    });
  }

  // Expiry sweep — fail-closed cleanup for stale approvals.
  setInterval(() => {
    const n = gate.sweepExpired();
    if (n) log(`expired ${n} stale approval(s)`);
  }, 60_000);
```

Update `startWebServer` call to pass the gate (Task 12 adds it to `WebDeps`):

```ts
  startWebServer(
    { store, bus, jobs, vault, config, router, finance, gate, envPath: config.envPath, uiDist: config.uiDist, log },
    config.uiPort,
  );
```

- [ ] **Step 2: Verify compile + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: tsc fails ONLY on the missing `gate` property in `WebDeps` if Task 12 isn't done yet — in that case temporarily omit `gate` from the `startWebServer` call and add it in Task 12. Tests: all PASS.

- [ ] **Step 3: CLI smoke test (end-to-end through a real daemon)**

Run: `npm run dev` (CLI channel), then type:

```
Use propose_action with type "test.echo", payload {"text":"kernel lives"}, preview "Echo kernel lives"
```

Expected: moderator replies that the action is queued with an 8-char id, AND the CLI
receives the plain-text approval ping (`⚖ Approval needed [test.echo] ...`).

Then type:

```
/approve <that-id>
```

Expected: `✓ Executed [test.echo] — echo: kernel lives`

Then verify the audit row and trust ledger:

```bash
sqlite3 data/aios.sqlite "SELECT id,type,status,verdict_by FROM actions ORDER BY created_at DESC LIMIT 3;"
sqlite3 data/aios.sqlite "SELECT action_type,state,approvals,streak FROM trust;"
```

Expected: the echo action `executed` with your verdict recorded; `test.echo` supervised with `approvals=1, streak=1`; `vault.write` seeded `autonomous`.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(daemon): wire action gate — seeds, approval pings, verdict handlers, expiry sweep"
```

---

### Task 12: Web API — actions, trust, resolve, demote

**Files:**
- Modify: `src/web/server.ts`

- [ ] **Step 1: Add gate to WebDeps and endpoints**

In `src/web/server.ts`:

Add import:

```ts
import type { ActionGate } from "../kernel/gate.js";
```

Add to `WebDeps`:

```ts
  gate: ActionGate;
```

Destructure it in `startWebServer` (`const { store, bus, jobs, vault, config, router, gate, log = () => {} } = deps;`).

Add endpoints inside the `/api/` block, after the `/api/costs` handler:

```ts
        // ---- action gate ----
        if (path === "/api/actions" && req.method === "GET") {
          const status = url.searchParams.get("status") ?? undefined;
          return json(res, 200, store.listActions(status, Number(url.searchParams.get("limit") ?? 100)));
        }

        const resolveMatch = /^\/api\/actions\/([\w-]+)\/resolve$/.exec(path);
        if (resolveMatch && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { verdict: "approve" | "reject"; reason?: string };
          if (body.verdict !== "approve" && body.verdict !== "reject") {
            return json(res, 400, { error: "verdict must be approve or reject" });
          }
          try {
            const row = await gate.resolve(resolveMatch[1], body.verdict, { by: "ui", reason: body.reason });
            return json(res, 200, row);
          } catch (err) {
            return json(res, 400, { error: (err as Error).message });
          }
        }

        if (path === "/api/trust" && req.method === "GET") {
          return json(res, 200, store.listTrust());
        }

        const demoteMatch = /^\/api\/trust\/([\w.-]+)\/demote$/.exec(path);
        if (demoteMatch && req.method === "POST") {
          gate.demoteType(demoteMatch[1]);
          return json(res, 200, { ok: true });
        }
```

Also add the two new env keys to `CONFIG_KEYS` (so they're editable from the Config view):

```ts
  { key: "AIOS_TRUST_SEED", secret: false },
  { key: "AIOS_ALWAYS_SUPERVISED", secret: false },
```

- [ ] **Step 2: Verify compile + manual curl check**

Run: `npx tsc --noEmit` — expected clean. Then with the daemon running (`npm run dev` in another terminal; queue an echo action as in Task 11 Step 3):

```bash
curl -s localhost:4280/api/actions?status=proposed | head -c 400
curl -s localhost:4280/api/trust | head -c 400
curl -s -X POST localhost:4280/api/actions/<id>/resolve -d '{"verdict":"approve"}' | head -c 400
```

Expected: pending action JSON; trust ledger JSON (camelCase fields); resolve returns the executed row.
(If `AIOS_UI_TOKEN` is set, add `-H "Authorization: Bearer $AIOS_UI_TOKEN"`.)

- [ ] **Step 3: Commit**

```bash
git add src/web/server.ts
git commit -m "feat(web): action gate API — approvals, trust ledger, resolve, demote"
```

---

### Task 13: Mission Control — Approvals + Trust views

**Files:**
- Modify: `ui/src/api.ts`
- Create: `ui/src/views/Approvals.tsx`
- Create: `ui/src/views/Trust.tsx`
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Extend `ui/src/api.ts`**

Add interfaces (after `StoredEvent`):

```ts
export interface ActionInfo {
  id: string;
  type: string;
  payload: string;
  preview: string;
  status: string;
  origin_channel: string;
  origin_chat_id: string;
  trust_state: string;
  verdict_by: string | null;
  reject_reason: string | null;
  result: string | null;
  created_at: string;
  resolved_at: string | null;
  expires_at: string;
}

export interface TrustInfo {
  actionType: string;
  state: "supervised" | "graduating" | "autonomous";
  approvals: number;
  rejections: number;
  streak: number;
  firstSeen: string;
  lastRejection: string | null;
  graduatedAt: string | null;
}
```

Add to the `api` object:

```ts
  actions: (status?: string) =>
    request<ActionInfo[]>(`/api/actions${status ? `?status=${status}` : ""}`),
  resolveAction: (id: string, verdict: "approve" | "reject", reason?: string) =>
    request<ActionInfo>(`/api/actions/${id}/resolve`, { method: "POST", body: JSON.stringify({ verdict, reason }) }),
  trust: () => request<TrustInfo[]>("/api/trust"),
  demoteTrust: (type: string) =>
    request<{ ok: boolean }>(`/api/trust/${type}/demote`, { method: "POST" }),
```

- [ ] **Step 2: Create `ui/src/views/Approvals.tsx`**

```tsx
import { useMemo, useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { usePoll } from "../hooks.js";

export function Approvals({ events }: { events: StoredEvent[] }) {
  const lastActionEvent = useMemo(
    () => events.filter((e) => e.event.type.startsWith("action.")).at(-1)?.id,
    [events],
  );
  const { data, reload } = usePoll(() => api.actions("proposed"), [lastActionEvent]);
  const [busy, setBusy] = useState<string>();

  const decideAction = async (id: string, verdict: "approve" | "reject") => {
    const reason = verdict === "reject" ? prompt("Reason (optional — trains the ledger)") ?? undefined : undefined;
    setBusy(id);
    try {
      await api.resolveAction(id, verdict, reason);
    } catch (e) {
      alert((e as Error).message);
    }
    setBusy(undefined);
    reload();
  };

  if (!data) return <div className="text-dim">loading…</div>;
  return (
    <div className="flex flex-col gap-3 max-w-3xl">
      <div className="label">Approval inbox — {data.length} pending</div>
      {data.length === 0 && <div className="text-dim text-[11px]">nothing waiting on you</div>}
      {data.map((a) => (
        <div key={a.id} className="hud p-4 boot flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-[11px] text-amber">
              {a.type} · {a.id} · via {a.origin_channel}
            </div>
            <div className="text-fg">{a.preview}</div>
            <div className="text-[10px] text-dim">expires {a.expires_at.slice(0, 16).replace("T", " ")}</div>
          </div>
          <button
            disabled={busy === a.id}
            onClick={() => decideAction(a.id, "approve")}
            className="border border-phosphor text-phosphor px-3 py-1.5 text-[11px] font-display uppercase tracking-widest hover:bg-phosphor hover:text-void transition-colors"
          >
            Approve
          </button>
          <button
            disabled={busy === a.id}
            onClick={() => decideAction(a.id, "reject")}
            className="border border-alert text-alert px-3 py-1.5 text-[11px] font-display uppercase tracking-widest hover:bg-alert hover:text-void transition-colors"
          >
            Reject
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create `ui/src/views/Trust.tsx`**

```tsx
import { useMemo } from "react";
import { api, type StoredEvent } from "../api.js";
import { usePoll } from "../hooks.js";

const STATE_COLOR: Record<string, string> = {
  autonomous: "text-cyan",
  graduating: "text-amber",
  supervised: "text-dim",
};

export function Trust({ events }: { events: StoredEvent[] }) {
  const lastTrustEvent = useMemo(
    () =>
      events
        .filter((e) => e.event.type === "trust.changed" || e.event.type.startsWith("action."))
        .at(-1)?.id,
    [events],
  );
  const { data, reload } = usePoll(() => api.trust(), [lastTrustEvent]);
  if (!data) return <div className="text-dim">loading…</div>;

  const demote = async (type: string) => {
    if (!confirm(`Demote ${type} back to supervised?`)) return;
    await api.demoteTrust(type);
    reload();
  };

  return (
    <div className="max-w-3xl">
      <div className="label mb-3">Trust ledger — autonomy is earned, never assumed</div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="label text-left">
            <th className="pb-2">Action type</th>
            <th>State</th>
            <th>✓</th>
            <th>✗</th>
            <th>Streak</th>
            <th>Last rejection</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.map((t) => (
            <tr key={t.actionType} className="border-t border-line">
              <td className="py-2 text-fg">{t.actionType}</td>
              <td className={STATE_COLOR[t.state] ?? ""}>{t.state}</td>
              <td>{t.approvals}</td>
              <td>{t.rejections}</td>
              <td>{t.streak}</td>
              <td className="text-dim">{t.lastRejection?.slice(0, 10) ?? "—"}</td>
              <td className="text-right">
                {t.state !== "supervised" && (
                  <button
                    onClick={() => demote(t.actionType)}
                    className="border border-line text-dim px-2 py-1 text-[10px] uppercase hover:text-alert hover:border-alert transition-colors"
                  >
                    demote
                  </button>
                )}
              </td>
            </tr>
          ))}
          {data.length === 0 && (
            <tr>
              <td colSpan={7} className="py-4 text-dim">
                no actions proposed yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Register tabs in `ui/src/App.tsx`**

Add imports:

```ts
import { Approvals } from "./views/Approvals.js";
import { Trust } from "./views/Trust.js";
```

Change the tabs constant:

```ts
const TABS = ["board", "approvals", "trust", "agents", "chat", "config", "costs"] as const;
```

Add the two view mounts inside `<main>` (after the board div, same hidden-not-destroyed pattern):

```tsx
          <div className={tab === "approvals" ? "" : "hidden"}><Approvals events={events} /></div>
          <div className={tab === "trust" ? "" : "hidden"}><Trust events={events} /></div>
```

- [ ] **Step 5: Build and eyeball**

Run: `cd ui && npm run build && cd ..`
Expected: clean Vite build.

With the daemon running, open `http://localhost:4280`, queue a `test.echo` action from
the chat view (`Use propose_action ...`), switch to **approvals** — the card appears live
(SSE-driven). Approve it; switch to **trust** — `test.echo` shows `approvals: 1`.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api.ts ui/src/views/Approvals.tsx ui/src/views/Trust.tsx ui/src/App.tsx
git commit -m "feat(ui): approval inbox and trust ledger views"
```

---

### Task 14: Final verification

- [ ] **Step 1: Full test suite + typecheck + UI build**

Run: `npm test && npx tsc --noEmit && (cd ui && npm run build)`
Expected: everything green.

- [ ] **Step 2: Graduation end-to-end (fast-forwarded)**

Temporary env makes graduation reachable in one sitting:

```bash
AIOS_GRADUATION_STREAK=3 AIOS_GRADUATION_AGE_DAYS=0 npm run dev
```

Propose + `/approve` a `test.echo` action 3 times (Task 11 Step 3 flow). After the third
approval, expect a NEW approval ping: `⚖ Approval needed [trust.promote] Promote
test.echo to autonomous (3 consecutive approvals)`. Approve it, then propose a fourth
echo — it must execute WITHOUT asking. Then in the dashboard trust view, hit **demote**
on `test.echo` and confirm a fifth echo queues for approval again.

- [ ] **Step 3: Commit any straggler fixes and update the daily log**

```bash
git add -A && git commit -m "chore: phase 3 verification fixes" || true
```

---

## Self-review notes (already applied)

- **Spec coverage:** action schema ✓ (risk_tier/reversible deferred — no executor needs
  them until Phase 5+; YAGNI), trust states + graduation + demotion ✓, hard ceilings ✓
  (`alwaysSupervised`; the €50 purchase ceiling lands with the purchase executor in
  Phase 7), approval UX ✓ (chat commands + Telegram buttons + dashboard; ✎ edit deferred
  — approve/reject covers Phase 3), expiry ✓, audit ✓ (actions table is the log),
  undo window → Phase 8 per spec.
- **Type consistency:** `TrustRecord`/`TrustPolicy`/`ActionRow`/`ActionInput`/`Executor`
  names match across tasks 1–13; store returns camelCase `TrustRecord`, raw snake_case
  `ActionRow` (mirrors existing `JobRow` convention).
- **Known risk:** `VaultWriter` exact API — verified `writeNote/readNote/listNotes` usage
  from `src/moderator/tools.ts`; constructor `(vaultPath, subdir)` + `init()` from
  `src/index.ts:26-27`.
