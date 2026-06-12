# Phase 4 — Heartbeat (Clock, Anchors, Triage, Briefs, Reminders) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the daemon a pulse — a 30-second tick drives morning/evening briefs (moderator-narrated, delivered to a primary chat, archived in the vault) and user reminders, with a triage layer deciding which bus events interrupt immediately versus wait for the next brief.

**Architecture:** Three new modules under `src/heartbeat/` (clock, triage, briefs) driven by one `setInterval` inside the existing daemon. All state in SQLite (`reminders`, `triage_rules` tables; anchor stamps and brief window in existing `kv`). Triage checks DB rules first (user corrections), then code defaults, then a Haiku one-shot; `batch` means "stay silent — the next brief queries the events table since the last brief." No batch queue table.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` imports), Node 23 `node:sqlite` (NEVER better-sqlite3), `@anthropic-ai/claude-agent-sdk` `query()` for the triage classifier, zod v4 (`z.record` needs two args), vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-phase4-heartbeat-design.md`

**Phase 3 conventions to follow (already in the codebase):**
- `Store` (`src/store/db.ts`): tables created in constructor, one prepared statement per method, ISO-8601 strings, snake_case row interfaces, claim-style atomic UPDATE for at-most-once semantics (see `claimAction`).
- `EventBus` (`src/events.ts`): typed `AiosEvent` union; `bus.on(listener)` returns unsubscribe; every emit persists to the `events` table.
- Tests: vitest, `new Store(":memory:")`, no mocks for store/bus — stub only LLM calls and channels.
- `Moderator.handle(channel, chatId, text): Promise<string>` is how system notices get narrated (see `[JOB-COMPLETE]` flow in `src/index.ts:33-42`).
- `VaultWriter.writeNote(relPath, content)` — traversal-guarded, returns saved path.

---

### Task 1: Store — reminders + triage_rules tables, events window query

**Files:**
- Modify: `src/store/db.ts`
- Test: `test/store-heartbeat.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/store-heartbeat.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

const NOW = "2026-06-12T10:00:00.000Z";
const LATER = "2026-06-12T11:00:00.000Z";

describe("Store reminders", () => {
  it("adds, lists, cancels", () => {
    const store = new Store(":memory:");
    const id = store.addReminder({
      text: "call accountant", dueAt: LATER, originChannel: "cli", originChatId: "local",
    });
    expect(id).toBeGreaterThan(0);
    const all = store.listReminders();
    expect(all).toHaveLength(1);
    expect(all[0].text).toBe("call accountant");
    expect(all[0].status).toBe("pending");
    expect(store.cancelReminder(id)).toBe(true);
    expect(store.listReminders("pending")).toHaveLength(0);
    expect(store.listReminders("cancelled")).toHaveLength(1);
  });

  it("cancel only affects pending reminders", () => {
    const store = new Store(":memory:");
    const id = store.addReminder({ text: "x", dueAt: NOW, originChannel: "cli", originChatId: "local" });
    store.claimDueReminders(LATER); // fires it
    expect(store.cancelReminder(id)).toBe(false);
    expect(store.listReminders("fired")).toHaveLength(1);
  });

  it("claimDueReminders fires due pending rows exactly once", () => {
    const store = new Store(":memory:");
    store.addReminder({ text: "due", dueAt: NOW, originChannel: "telegram", originChatId: "42" });
    store.addReminder({ text: "future", dueAt: "2026-06-13T10:00:00.000Z", originChannel: "cli", originChatId: "local" });
    const claimed = store.claimDueReminders(LATER);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].text).toBe("due");
    expect(claimed[0].origin_channel).toBe("telegram");
    // second claim: nothing (at-most-once)
    expect(store.claimDueReminders(LATER)).toHaveLength(0);
    expect(store.listReminders("fired")).toHaveLength(1);
    expect(store.listReminders("pending")).toHaveLength(1); // the future one
  });
});

describe("Store triage rules", () => {
  it("adds and lists rules; same event_type upserts", () => {
    const store = new Store(":memory:");
    store.addTriageRule({ eventType: "action.*", verdict: "batch", source: "manual" });
    store.addTriageRule({ eventType: "reminder.due", verdict: "notify_now", source: "manual" });
    expect(store.listTriageRules()).toHaveLength(2);
    store.addTriageRule({ eventType: "action.*", verdict: "ignore", source: "correction" });
    const rules = store.listTriageRules();
    expect(rules).toHaveLength(2);
    expect(rules.find((r) => r.event_type === "action.*")?.verdict).toBe("ignore");
    expect(rules.find((r) => r.event_type === "action.*")?.source).toBe("correction");
  });
});

describe("Store events window", () => {
  it("listEventsSince returns rows strictly after the timestamp", () => {
    const store = new Store(":memory:");
    store.addEvent(JSON.stringify({ type: "chat.in", channel: "cli", chatId: "x", text: "a" }));
    const cutoff = new Date().toISOString();
    store.addEvent(JSON.stringify({ type: "trust.changed", actionType: "t", state: "supervised" }));
    const rows = store.listEventsSince(cutoff);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload).type).toBe("trust.changed");
    expect(store.listEventsSince("2099-01-01T00:00:00.000Z")).toHaveLength(0);
  });
});
```

Note: `listEventsSince` uses `ts > ?`; `addEvent` stamps `new Date().toISOString()`. Two `addEvent` calls within the same millisecond as `cutoff` could flake — if the first assertion is flaky, insert a 2ms `await new Promise(r => setTimeout(r, 2))` before taking `cutoff` and after; keep the test deterministic.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/store-heartbeat.test.ts`
Expected: FAIL — `store.addReminder is not a function`

- [ ] **Step 3: Implement in `src/store/db.ts`**

Add row interfaces near the top (after the existing `StageRow`):

```ts
export interface ReminderRow {
  id: number;
  text: string;
  due_at: string;
  origin_channel: string;
  origin_chat_id: string;
  status: "pending" | "fired" | "cancelled";
  created_at: string;
}

export interface TriageRuleRow {
  id: number;
  /** Exact event type ("reminder.due") or glob prefix ("action.*"). */
  event_type: string;
  verdict: "ignore" | "batch" | "notify_now";
  source: "manual" | "correction";
  created_at: string;
}
```

In the constructor, AFTER the actions/trust `this.db.exec` block from Phase 3, add:

```ts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        due_at TEXT NOT NULL,
        origin_channel TEXT NOT NULL,
        origin_chat_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);
      CREATE TABLE IF NOT EXISTS triage_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL UNIQUE,
        verdict TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
```

Add methods to the `Store` class (before `close()`):

```ts
  // ---- reminders ----

  addReminder(r: { text: string; dueAt: string; originChannel: string; originChatId: string }): number {
    const res = this.db
      .prepare(
        `INSERT INTO reminders (text, due_at, origin_channel, origin_chat_id, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(r.text, r.dueAt, r.originChannel, r.originChatId, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  listReminders(status?: string): ReminderRow[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM reminders WHERE status = ? ORDER BY due_at").all(status)
      : this.db.prepare("SELECT * FROM reminders ORDER BY due_at").all();
    return rows as unknown as ReminderRow[];
  }

  cancelReminder(id: number): boolean {
    const res = this.db
      .prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
      .run(id);
    return res.changes > 0;
  }

  /** Atomically flip due pending reminders to fired; returns the claimed rows (at-most-once). */
  claimDueReminders(nowIso: string): ReminderRow[] {
    const rows = this.db
      .prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at")
      .all(nowIso) as unknown as ReminderRow[];
    const fire = this.db.prepare("UPDATE reminders SET status = 'fired' WHERE id = ? AND status = 'pending'");
    return rows.filter((r) => fire.run(r.id).changes === 1);
  }

  // ---- triage rules ----

  addTriageRule(r: { eventType: string; verdict: TriageRuleRow["verdict"]; source: TriageRuleRow["source"] }): number {
    const res = this.db
      .prepare(
        `INSERT INTO triage_rules (event_type, verdict, source, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(event_type) DO UPDATE SET verdict=excluded.verdict, source=excluded.source, created_at=excluded.created_at`,
      )
      .run(r.eventType, r.verdict, r.source, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  listTriageRules(): TriageRuleRow[] {
    return this.db
      .prepare("SELECT * FROM triage_rules ORDER BY id")
      .all() as unknown as TriageRuleRow[];
  }

  // ---- events window (brief assembly) ----

  listEventsSince(tsIso: string, limit = 1000): Array<{ id: number; ts: string; payload: string }> {
    return this.db
      .prepare("SELECT * FROM events WHERE ts > ? ORDER BY id LIMIT ?")
      .all(tsIso, limit) as unknown as Array<{ id: number; ts: string; payload: string }>;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/store-heartbeat.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Full suite, then commit**

Run: `npm test` — all existing tests still pass.

```bash
git add src/store/db.ts test/store-heartbeat.test.ts
git commit -m "feat(store): reminders, triage rules, events window query"
```

---

### Task 2: Heartbeat event types

**Files:**
- Modify: `src/events.ts`

- [ ] **Step 1: Extend the AiosEvent union**

The union currently ends with the `trust.changed` variant (Phase 3). Replace:

```ts
  | { type: "trust.changed"; actionType: string; state: string };
```

with:

```ts
  | { type: "trust.changed"; actionType: string; state: string }
  | { type: "reminder.due"; id: number; text: string; channel: string; chatId: string }
  | { type: "brief.sent"; anchor: "morning" | "evening"; chatKey: string | null }
  | { type: "triage.decision"; eventType: string; verdict: string; via: "rule" | "default" | "model" };
```

- [ ] **Step 2: Verify compile + suite**

Run: `npx tsc --noEmit && npm test`
Expected: clean, all PASS

- [ ] **Step 3: Commit**

```bash
git add src/events.ts
git commit -m "feat(events): reminder, brief, and triage event types"
```

---

### Task 3: Config — primary chat, anchors, triage model

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.ts` (merge `parsePrimaryChat` into the existing import from `../src/config.js`):

```ts
describe("parsePrimaryChat", () => {
  it("parses channel:chatId", () => {
    expect(parsePrimaryChat("telegram:12345")).toEqual({ channel: "telegram", chatId: "12345" });
  });

  it("splits on the FIRST colon only (negative group ids keep their dash, ids may contain colons)", () => {
    expect(parsePrimaryChat("telegram:-100987")).toEqual({ channel: "telegram", chatId: "-100987" });
    expect(parsePrimaryChat("web:ui:main")).toEqual({ channel: "web", chatId: "ui:main" });
  });

  it("returns undefined for empty/malformed input", () => {
    expect(parsePrimaryChat(undefined)).toBeUndefined();
    expect(parsePrimaryChat("")).toBeUndefined();
    expect(parsePrimaryChat("justachannel")).toBeUndefined();
    expect(parsePrimaryChat(":nochannnel")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `parsePrimaryChat` is not exported

- [ ] **Step 3: Implement in `src/config.ts`**

Add to the `Config` interface (after the Phase 3 `trustSeeds` field):

```ts
  /** Where briefs and notify_now pings go ("channel:chatId"). Unset: vault-only briefs. */
  primaryChat?: { channel: string; chatId: string };
  /** Local times, "HH:MM". */
  anchorMorning: string;
  anchorEvening: string;
  /** Model for the triage classifier one-shot. */
  triageModel: string;
```

Add the parser at module level (near `parseTrustSeeds`):

```ts
/** Parses "telegram:12345" → {channel, chatId}. Splits on the FIRST colon only. */
export function parsePrimaryChat(raw: string | undefined): { channel: string; chatId: string } | undefined {
  if (!raw) return undefined;
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) return undefined;
  return { channel: raw.slice(0, idx), chatId: raw.slice(idx + 1) };
}
```

Add to the object returned by `loadConfig` (after `trustSeeds: ...`):

```ts
    primaryChat: parsePrimaryChat(process.env.AIOS_PRIMARY_CHAT),
    anchorMorning: process.env.AIOS_ANCHOR_MORNING ?? "07:30",
    anchorEvening: process.env.AIOS_ANCHOR_EVENING ?? "21:00",
    triageModel: process.env.AIOS_TRIAGE_MODEL ?? "claude-haiku-4-5-20251001",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): primary chat, anchor times, triage model"
```

---

### Task 4: Clock — anchors + reminder scan

**Files:**
- Create: `src/heartbeat/clock.ts`
- Test: `test/clock.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/clock.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { localParts, anchorDue, Clock } from "../src/heartbeat/clock.js";
import type { ReminderRow } from "../src/store/db.js";

describe("localParts", () => {
  it("formats local date and HH:MM with zero padding", () => {
    const d = new Date(2026, 0, 5, 7, 5); // Jan 5 2026, 07:05 LOCAL
    expect(localParts(d)).toEqual({ date: "2026-01-05", hhmm: "07:05" });
  });
});

describe("anchorDue", () => {
  const now = { date: "2026-06-12", hhmm: "07:30" };
  it("due when time reached and not yet fired today", () => {
    expect(anchorDue(now, "07:30", undefined)).toBe(true);
    expect(anchorDue(now, "07:30", "2026-06-11")).toBe(true);
  });
  it("not due before the anchor time", () => {
    expect(anchorDue({ ...now, hhmm: "07:29" }, "07:30", undefined)).toBe(false);
  });
  it("not due when already fired today (fire-once)", () => {
    expect(anchorDue(now, "07:30", "2026-06-12")).toBe(false);
  });
  it("catch-up: hours past the anchor still fires once", () => {
    expect(anchorDue({ ...now, hhmm: "23:59" }, "07:30", undefined)).toBe(true);
  });
});

describe("Clock.tick", () => {
  function setup(nowLocal: Date) {
    const store = new Store(":memory:");
    const anchorsFired: string[] = [];
    const remindersFired: ReminderRow[] = [];
    const clock = new Clock({
      store,
      anchors: [
        { name: "morning", hhmm: "07:30" },
        { name: "evening", hhmm: "21:00" },
      ],
      onAnchor: async (name) => { anchorsFired.push(name); },
      onReminderDue: (r) => { remindersFired.push(r); },
      nowFn: () => nowLocal,
    });
    return { store, clock, anchorsFired, remindersFired };
  }

  it("fires a due anchor once and stamps kv", async () => {
    const { store, clock, anchorsFired } = setup(new Date(2026, 5, 12, 8, 0));
    await clock.tick();
    expect(anchorsFired).toEqual(["morning"]);
    expect(store.kvGet("anchor:morning:last")).toBe("2026-06-12");
    await clock.tick();
    expect(anchorsFired).toEqual(["morning"]); // no refire
  });

  it("double catch-up fires morning first, then evening", async () => {
    const { clock, anchorsFired } = setup(new Date(2026, 5, 12, 22, 0));
    await clock.tick();
    expect(anchorsFired).toEqual(["morning", "evening"]);
  });

  it("stamps BEFORE running so a crashing brief does not retry", async () => {
    const store = new Store(":memory:");
    let calls = 0;
    const clock = new Clock({
      store,
      anchors: [{ name: "morning", hhmm: "07:30" }],
      onAnchor: async () => { calls++; throw new Error("brief exploded"); },
      onReminderDue: () => {},
      nowFn: () => new Date(2026, 5, 12, 8, 0),
    });
    await clock.tick();
    await clock.tick();
    expect(calls).toBe(1);
    expect(store.kvGet("anchor:morning:last")).toBe("2026-06-12");
  });

  it("claims and emits due reminders", async () => {
    const { store, clock, remindersFired } = setup(new Date(2026, 5, 12, 6, 0)); // before anchors
    store.addReminder({ text: "due now", dueAt: "2026-06-12T00:00:00.000Z", originChannel: "cli", originChatId: "local" });
    await clock.tick();
    expect(remindersFired).toHaveLength(1);
    expect(remindersFired[0].text).toBe("due now");
    await clock.tick();
    expect(remindersFired).toHaveLength(1); // at-most-once
  });

  it("a throwing tick body never propagates", async () => {
    const store = new Store(":memory:");
    const clock = new Clock({
      store,
      anchors: [{ name: "morning", hhmm: "07:30" }],
      onAnchor: async () => {},
      onReminderDue: () => { throw new Error("listener exploded"); },
      nowFn: () => new Date(2026, 5, 12, 6, 0),
    });
    store.addReminder({ text: "x", dueAt: "2026-06-12T00:00:00.000Z", originChannel: "cli", originChatId: "local" });
    await expect(clock.tick()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/clock.test.ts`
Expected: FAIL — `Cannot find module '../src/heartbeat/clock.js'`

- [ ] **Step 3: Implement `src/heartbeat/clock.ts`**

```ts
// src/heartbeat/clock.ts
import type { Store, ReminderRow } from "../store/db.js";

export interface AnchorConfig {
  name: "morning" | "evening";
  /** Local time "HH:MM". */
  hhmm: string;
}

export interface ClockDeps {
  store: Store;
  /** Checked in order — keep morning before evening for the double-catch-up case. */
  anchors: AnchorConfig[];
  onAnchor: (name: "morning" | "evening") => Promise<void>;
  onReminderDue: (reminder: ReminderRow) => void;
  log?: (line: string) => void;
  /** Injectable clock for tests. */
  nowFn?: () => Date;
}

export function localParts(d: Date): { date: string; hhmm: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Due when the local clock has passed the anchor time and it hasn't fired today. */
export function anchorDue(
  now: { date: string; hhmm: string },
  anchorHHMM: string,
  lastFiredDate: string | undefined,
): boolean {
  return now.hhmm >= anchorHHMM && lastFiredDate !== now.date;
}

/**
 * The daemon's pulse: one cheap tick checks due anchors and due reminders.
 * Anchor stamps are written BEFORE the brief runs (fire-once even through
 * crashes); reminder claiming is atomic (at-most-once).
 */
export class Clock {
  private timer?: NodeJS.Timeout;

  constructor(private deps: ClockDeps) {}

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    try {
      const now = (this.deps.nowFn ?? (() => new Date()))();
      const parts = localParts(now);

      for (const anchor of this.deps.anchors) {
        const key = `anchor:${anchor.name}:last`;
        if (!anchorDue(parts, anchor.hhmm, this.deps.store.kvGet(key))) continue;
        this.deps.store.kvSet(key, parts.date); // stamp first — never retry a crashed brief
        try {
          await this.deps.onAnchor(anchor.name);
        } catch (err) {
          this.deps.log?.(`anchor ${anchor.name} failed: ${(err as Error).message}`);
        }
      }

      for (const reminder of this.deps.store.claimDueReminders(now.toISOString())) {
        try {
          this.deps.onReminderDue(reminder);
        } catch (err) {
          this.deps.log?.(`reminder ${reminder.id} dispatch failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.deps.log?.(`heartbeat tick error: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/clock.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/clock.ts test/clock.test.ts
git commit -m "feat(heartbeat): clock — anchor scheduling and reminder firing"
```

---

### Task 5: Triage — rules, defaults, model fallback

**Files:**
- Create: `src/heartbeat/triage.ts`
- Test: `test/triage.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/triage.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus, type AiosEvent } from "../src/events.js";
import { matchRule, defaultVerdict, Triage, type TriageVerdict } from "../src/heartbeat/triage.js";

describe("matchRule", () => {
  const rules = [
    { id: 1, event_type: "action.*", verdict: "batch" as const, source: "manual" as const, created_at: "" },
    { id: 2, event_type: "action.executed", verdict: "notify_now" as const, source: "correction" as const, created_at: "" },
  ];
  it("exact match beats glob", () => {
    expect(matchRule(rules, "action.executed")?.verdict).toBe("notify_now");
  });
  it("glob prefix matches", () => {
    expect(matchRule(rules, "action.proposed")?.verdict).toBe("batch");
  });
  it("no match returns undefined", () => {
    expect(matchRule(rules, "job.status")).toBeUndefined();
  });
});

describe("defaultVerdict", () => {
  it("reminder.due → notify_now", () => {
    expect(defaultVerdict({ type: "reminder.due", id: 1, text: "x", channel: "cli", chatId: "l" })).toBe("notify_now");
  });
  it("autonomous executions batch; approved ones are ignored (already confirmed in chat)", () => {
    expect(defaultVerdict({ type: "action.executed", actionId: "a", actionType: "t", auto: true, ok: true })).toBe("batch");
    expect(defaultVerdict({ type: "action.executed", actionId: "a", actionType: "t", auto: false, ok: true })).toBe("ignore");
  });
  it("failed jobs interrupt; other job statuses are ignored", () => {
    expect(defaultVerdict({ type: "job.status", jobId: "j", status: "failed" })).toBe("notify_now");
    expect(defaultVerdict({ type: "job.status", jobId: "j", status: "done" })).toBe("ignore");
  });
  it("trust changes batch; chat/agent/proposal noise is ignored", () => {
    expect(defaultVerdict({ type: "trust.changed", actionType: "t", state: "supervised" })).toBe("batch");
    expect(defaultVerdict({ type: "chat.in", channel: "cli", chatId: "l", text: "hi" })).toBe("ignore");
    expect(defaultVerdict({ type: "agent.start", agent: "m", context: "c" })).toBe("ignore");
    expect(defaultVerdict({ type: "action.proposed", actionId: "a", actionType: "t", preview: "p" })).toBe("ignore");
  });
  it("its own outputs are ignored (no feedback loop)", () => {
    expect(defaultVerdict({ type: "triage.decision", eventType: "x", verdict: "batch", via: "rule" })).toBe("ignore");
    expect(defaultVerdict({ type: "brief.sent", anchor: "morning", chatKey: null })).toBe("ignore");
  });
});

describe("Triage.handle", () => {
  function setup(classify?: (e: AiosEvent) => Promise<TriageVerdict>) {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const notified: AiosEvent[] = [];
    const classified: AiosEvent[] = [];
    const triage = new Triage({
      store,
      bus,
      classify: classify ?? (async (e) => { classified.push(e); return "notify_now"; }),
      notify: async (e) => { notified.push(e); },
    });
    return { store, bus, triage, notified, classified };
  }

  it("DB rule wins over default", async () => {
    const { store, triage, notified } = setup();
    store.addTriageRule({ eventType: "trust.changed", verdict: "notify_now", source: "correction" });
    await triage.handle({ type: "trust.changed", actionType: "t", state: "supervised" });
    expect(notified).toHaveLength(1);
  });

  it("default verdict used when no rule; notify_now calls notify", async () => {
    const { triage, notified, classified } = setup();
    await triage.handle({ type: "reminder.due", id: 1, text: "x", channel: "cli", chatId: "l" });
    expect(notified).toHaveLength(1);
    expect(classified).toHaveLength(0); // model never called for known types
  });

  it("emits triage.decision for non-ignored events only", async () => {
    const { triage, bus, store } = setup();
    const events: string[] = [];
    bus.on((e) => events.push(e.event.type));
    await triage.handle({ type: "trust.changed", actionType: "t", state: "supervised" }); // batch
    await triage.handle({ type: "chat.in", channel: "cli", chatId: "l", text: "hi" });   // ignore
    expect(events.filter((t) => t === "triage.decision")).toHaveLength(1);
  });

  it("classifier failure falls back to batch (fail-quiet)", async () => {
    const { triage, notified, bus } = setup(async () => { throw new Error("model down"); });
    const decisions: Array<Record<string, unknown>> = [];
    bus.on((e) => { if (e.event.type === "triage.decision") decisions.push(e.event as never); });
    // unknown future event type → no default → model → throws → batch
    await triage.handle({ type: "mail.received" } as never);
    expect(notified).toHaveLength(0);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].verdict).toBe("batch");
    expect(decisions[0].via).toBe("model");
  });

  it("malformed classifier output falls back to batch", async () => {
    const { triage, notified } = setup(async () => "panic!!!" as never);
    await triage.handle({ type: "mail.received" } as never);
    expect(notified).toHaveLength(0);
  });

  it("a throwing notify never propagates", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const triage = new Triage({
      store, bus,
      classify: async () => "batch",
      notify: async () => { throw new Error("channel down"); },
    });
    await expect(
      triage.handle({ type: "reminder.due", id: 1, text: "x", channel: "cli", chatId: "l" }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/triage.test.ts`
Expected: FAIL — `Cannot find module '../src/heartbeat/triage.js'`

- [ ] **Step 3: Implement `src/heartbeat/triage.ts`**

```ts
// src/heartbeat/triage.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Store, TriageRuleRow } from "../store/db.js";
import type { AiosEvent, EventBus } from "../events.js";

export type TriageVerdict = "ignore" | "batch" | "notify_now";

const VERDICTS: readonly TriageVerdict[] = ["ignore", "batch", "notify_now"];

/** First matching rule wins; exact match beats glob ("action.*" matches "action.executed"). */
export function matchRule(rules: TriageRuleRow[], eventType: string): TriageRuleRow | undefined {
  const exact = rules.find((r) => r.event_type === eventType);
  if (exact) return exact;
  return rules.find(
    (r) => r.event_type.endsWith(".*") && eventType.startsWith(r.event_type.slice(0, -1)),
  );
}

/**
 * Built-in defaults for every known event type (payload-aware — a rules table
 * can't see inside payloads). Unknown future types return undefined → model.
 */
export function defaultVerdict(event: AiosEvent): TriageVerdict | undefined {
  switch (event.type) {
    case "reminder.due":
      return "notify_now";
    case "action.executed":
      return event.auto ? "batch" : "ignore"; // approved ones were confirmed in chat already
    case "trust.changed":
      return "batch";
    case "job.status":
      return event.status === "failed" ? "notify_now" : "ignore";
    case "job.created":
    case "stage.start":
    case "stage.finish":
    case "agent.start":
    case "agent.end":
    case "chat.in":
    case "chat.out":
    case "action.proposed": // Phase 3 notifier already pings proposals — no double-ping
    case "action.resolved":
    case "triage.decision": // own output — never feed back
    case "brief.sent":
      return "ignore";
  }
  return undefined;
}

export interface TriageDeps {
  store: Store;
  bus: EventBus;
  /** Model classifier for unknown event types. Injectable for tests. */
  classify: (event: AiosEvent) => Promise<TriageVerdict>;
  /** Immediate ping delivery (routing decided by the caller/wiring). */
  notify: (event: AiosEvent) => Promise<void>;
  log?: (line: string) => void;
}

/** Interrupt gatekeeper: rules → defaults → model. batch = stay silent until the next brief. */
export class Triage {
  private unsubscribe?: () => void;

  constructor(private deps: TriageDeps) {}

  start(): void {
    this.unsubscribe = this.deps.bus.on((stored) => void this.handle(stored.event));
  }

  stop(): void {
    this.unsubscribe?.();
  }

  async handle(event: AiosEvent): Promise<void> {
    try {
      let verdict: TriageVerdict | undefined;
      let via: "rule" | "default" | "model";

      const rule = matchRule(this.deps.store.listTriageRules(), event.type);
      if (rule) {
        verdict = rule.verdict;
        via = "rule";
      } else {
        verdict = defaultVerdict(event);
        via = "default";
      }
      if (!verdict) {
        via = "model";
        try {
          const v = await this.deps.classify(event);
          verdict = VERDICTS.includes(v) ? v : "batch";
        } catch (err) {
          this.deps.log?.(`triage classify failed: ${(err as Error).message}`);
          verdict = "batch"; // fail-quiet: surfaces in the next brief, never lost or spamming
        }
      }

      if (verdict !== "ignore") {
        this.deps.bus.emit({ type: "triage.decision", eventType: event.type, verdict, via });
      }
      if (verdict === "notify_now") {
        try {
          await this.deps.notify(event);
        } catch (err) {
          this.deps.log?.(`triage notify failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.deps.log?.(`triage error on ${event.type}: ${(err as Error).message}`);
    }
  }
}

/** Real classifier: one-shot, no tools, strict JSON verdict. */
export function modelClassifier(model: string): (event: AiosEvent) => Promise<TriageVerdict> {
  return async (event) => {
    const q = query({
      prompt: `Event:\n${JSON.stringify(event)}\n\nHow should this be handled for the user?`,
      options: {
        systemPrompt:
          "You triage events for a personal AI OS. Verdicts: notify_now (interrupt the user — urgent or time-sensitive), " +
          "batch (include in the next scheduled brief), ignore (noise).",
        allowedTools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        model,
        outputFormat: {
          type: "json_schema" as const,
          schema: {
            type: "object",
            properties: { verdict: { enum: ["ignore", "batch", "notify_now"] } },
            required: ["verdict"],
            additionalProperties: false,
          },
        },
      },
    });
    for await (const msg of q) {
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          const v = (msg.structured_output as { verdict?: string } | undefined)?.verdict;
          if (v === "ignore" || v === "batch" || v === "notify_now") return v;
        }
        break;
      }
    }
    return "batch";
  };
}
```

Note: `modelClassifier` is not unit-tested live (needs auth + tokens); its parsing guard is the same shape as the tested malformed-output path, and the e2e in Task 9 never reaches the model (all Phase 4 types have defaults). If `outputFormat`'s exact option shape differs in the installed SDK version, check how `src/agents/runner.ts:87-89` builds it — copy that exact pattern.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/triage.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/triage.ts test/triage.test.ts
git commit -m "feat(heartbeat): triage — rules, payload-aware defaults, model fallback"
```

---

### Task 6: Briefs — assembly + rendering

**Files:**
- Create: `src/heartbeat/briefs.ts`
- Test: `test/briefs.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/briefs.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { assembleBrief, isEmptyBrief, renderBriefNote, type BriefData } from "../src/heartbeat/briefs.js";
import type { ActionRow } from "../src/kernel/actions.js";

const NOW = "2026-06-12T10:00:00.000Z";

function action(id: string, over: Partial<ActionRow> = {}): ActionRow {
  return {
    id, type: "test.echo", payload: "{}", preview: `preview ${id}`,
    status: "proposed", origin_channel: "cli", origin_chat_id: "local",
    trust_state: "supervised", verdict_by: null, reject_reason: null, result: null,
    created_at: NOW, resolved_at: null, expires_at: "2026-06-13T09:00:00.000Z",
    ...over,
  };
}

describe("assembleBrief", () => {
  it("collects approvals, splitting promotions, flagging expiring-soon", () => {
    const store = new Store(":memory:");
    store.insertAction(action("aaaa1111", { expires_at: "2026-06-12T15:00:00.000Z" })); // < 12h
    store.insertAction(action("bbbb2222", { type: "trust.promote", preview: "Promote test.echo" }));
    store.insertAction(action("cccc3333", { status: "executed" })); // not pending
    const data = assembleBrief(store, "morning", NOW, null);
    expect(data.pendingApprovals).toHaveLength(1);
    expect(data.pendingApprovals[0].expiringSoon).toBe(true);
    expect(data.graduationProposals).toHaveLength(1);
    expect(data.graduationProposals[0].preview).toBe("Promote test.echo");
  });

  it("digests events since the window start", () => {
    const store = new Store(":memory:");
    store.insertJob({
      id: "j1", slug: "demo", title: "Demo job", playbook: "echo", request: "r",
      project_dir: null, channel: "cli", chat_id: "local", status: "done", error: null,
    });
    store.addEvent(JSON.stringify({ type: "action.executed", actionId: "x", actionType: "vault.write", auto: true, ok: true }));
    store.addEvent(JSON.stringify({ type: "action.executed", actionId: "y", actionType: "vault.write", auto: true, ok: true }));
    store.addEvent(JSON.stringify({ type: "action.executed", actionId: "z", actionType: "vault.write", auto: false, ok: true }));
    store.addEvent(JSON.stringify({ type: "job.status", jobId: "j1", status: "done" }));
    store.addEvent(JSON.stringify({ type: "job.status", jobId: "j1", status: "failed", error: "boom" }));
    store.addEvent(JSON.stringify({ type: "trust.changed", actionType: "test.echo", state: "graduating" }));
    const data = assembleBrief(store, "evening", NOW, "2020-01-01T00:00:00.000Z");
    expect(data.autonomousDigest).toEqual([{ type: "vault.write", count: 2 }]); // auto only
    expect(data.jobsFinished).toEqual([{ title: "Demo job", status: "done" }]);
    expect(data.jobsFailed).toEqual([{ title: "Demo job", error: "boom" }]);
    expect(data.trustChanges).toEqual([{ type: "test.echo", state: "graduating" }]);
  });

  it("null window (first ever brief) digests nothing", () => {
    const store = new Store(":memory:");
    store.addEvent(JSON.stringify({ type: "trust.changed", actionType: "t", state: "supervised" }));
    const data = assembleBrief(store, "morning", NOW, null);
    expect(data.trustChanges).toHaveLength(0);
    expect(data.sinceLastBrief).toBeNull();
  });

  it("morning lists today's pending reminders; evening lists tomorrow's", () => {
    const store = new Store(":memory:");
    store.addReminder({ text: "today", dueAt: "2026-06-12T18:00:00.000Z", originChannel: "cli", originChatId: "l" });
    store.addReminder({ text: "tomorrow", dueAt: "2026-06-13T09:00:00.000Z", originChannel: "cli", originChatId: "l" });
    store.addReminder({ text: "next week", dueAt: "2026-06-19T09:00:00.000Z", originChannel: "cli", originChatId: "l" });
    const morning = assembleBrief(store, "morning", NOW, null);
    expect(morning.remindersToday.map((r) => r.text)).toEqual(["today"]);
    const evening = assembleBrief(store, "evening", NOW, null);
    expect(evening.remindersToday.map((r) => r.text)).toEqual(["tomorrow"]);
  });
});

describe("isEmptyBrief", () => {
  it("true only when every section is empty", () => {
    const store = new Store(":memory:");
    expect(isEmptyBrief(assembleBrief(store, "morning", NOW, null))).toBe(true);
    store.insertAction(action("dddd4444"));
    expect(isEmptyBrief(assembleBrief(store, "morning", NOW, null))).toBe(false);
  });
});

describe("renderBriefNote", () => {
  it("narration on top, data sections below", () => {
    const data: BriefData = {
      anchor: "morning",
      pendingApprovals: [{ id: "a", type: "test.echo", preview: "p", expires_at: NOW, expiringSoon: false }],
      graduationProposals: [], autonomousDigest: [{ type: "vault.write", count: 3 }],
      jobsFinished: [], jobsFailed: [], trustChanges: [], remindersToday: [],
      sinceLastBrief: null,
    };
    const md = renderBriefNote(data, "Morning. One approval waiting.");
    expect(md).toContain("Morning. One approval waiting.");
    expect(md).toContain("## Pending approvals");
    expect(md).toContain("test.echo");
    expect(md).toContain("vault.write × 3");
    expect(md.indexOf("Morning. One approval")).toBeLessThan(md.indexOf("## Pending approvals"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/briefs.test.ts`
Expected: FAIL — `Cannot find module '../src/heartbeat/briefs.js'`

- [ ] **Step 3: Implement `src/heartbeat/briefs.ts` (assembly + render half)**

```ts
// src/heartbeat/briefs.ts
import type { Store } from "../store/db.js";
import type { AiosEvent, EventBus } from "../events.js";
import type { VaultWriter } from "../vault/writer.js";
import { localParts } from "./clock.js";

export interface BriefData {
  anchor: "morning" | "evening";
  pendingApprovals: Array<{ id: string; type: string; preview: string; expires_at: string; expiringSoon: boolean }>;
  graduationProposals: Array<{ id: string; preview: string }>;
  autonomousDigest: Array<{ type: string; count: number }>;
  jobsFinished: Array<{ title: string; status: string }>;
  jobsFailed: Array<{ title: string; error: string }>;
  trustChanges: Array<{ type: string; state: string }>;
  remindersToday: Array<{ id: number; text: string; due_at: string }>;
  sinceLastBrief: string | null;
}

const TWELVE_H = 12 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/** Local YYYY-MM-DD for an ISO timestamp. */
function localDateOf(iso: string): string {
  return localParts(new Date(iso)).date;
}

export function assembleBrief(
  store: Store,
  anchor: "morning" | "evening",
  nowIso: string,
  sinceTs: string | null,
): BriefData {
  const nowMs = Date.parse(nowIso);

  const pending = store.listActions("proposed");
  const pendingApprovals = pending
    .filter((a) => a.type !== "trust.promote")
    .map((a) => ({
      id: a.id, type: a.type, preview: a.preview, expires_at: a.expires_at,
      expiringSoon: Date.parse(a.expires_at) - nowMs < TWELVE_H,
    }));
  const graduationProposals = pending
    .filter((a) => a.type === "trust.promote")
    .map((a) => ({ id: a.id, preview: a.preview }));

  const autoCounts = new Map<string, number>();
  const jobsFinished: BriefData["jobsFinished"] = [];
  const jobsFailed: BriefData["jobsFailed"] = [];
  const trustChanges: BriefData["trustChanges"] = [];
  if (sinceTs) {
    for (const row of store.listEventsSince(sinceTs)) {
      let event: AiosEvent;
      try {
        event = JSON.parse(row.payload) as AiosEvent;
      } catch {
        continue;
      }
      if (event.type === "action.executed" && event.auto && event.ok) {
        autoCounts.set(event.actionType, (autoCounts.get(event.actionType) ?? 0) + 1);
      } else if (event.type === "job.status") {
        const title = store.getJob(event.jobId)?.title ?? event.jobId;
        if (event.status === "failed") jobsFailed.push({ title, error: event.error ?? "unknown" });
        else if (event.status === "done") jobsFinished.push({ title, status: event.status });
      } else if (event.type === "trust.changed") {
        trustChanges.push({ type: event.actionType, state: event.state });
      }
    }
  }

  // morning: reminders due today; evening: due tomorrow (local dates)
  const targetDate = localDateOf(
    anchor === "morning" ? nowIso : new Date(nowMs + DAY).toISOString(),
  );
  const remindersToday = store
    .listReminders("pending")
    .filter((r) => localDateOf(r.due_at) === targetDate)
    .map((r) => ({ id: r.id, text: r.text, due_at: r.due_at }));

  return {
    anchor,
    pendingApprovals,
    graduationProposals,
    autonomousDigest: [...autoCounts.entries()].map(([type, count]) => ({ type, count })),
    jobsFinished,
    jobsFailed,
    trustChanges,
    remindersToday,
    sinceLastBrief: sinceTs,
  };
}

export function isEmptyBrief(d: BriefData): boolean {
  return (
    d.pendingApprovals.length === 0 &&
    d.graduationProposals.length === 0 &&
    d.autonomousDigest.length === 0 &&
    d.jobsFinished.length === 0 &&
    d.jobsFailed.length === 0 &&
    d.trustChanges.length === 0 &&
    d.remindersToday.length === 0
  );
}

/** Vault note: human narration on top, machine-readable sections below. */
export function renderBriefNote(d: BriefData, narration: string): string {
  const lines: string[] = [narration, ""];
  const section = (title: string, rows: string[]) => {
    if (!rows.length) return;
    lines.push(`## ${title}`, ...rows.map((r) => `- ${r}`), "");
  };
  section("Pending approvals", d.pendingApprovals.map(
    (a) => `[${a.id}] ${a.type} — ${a.preview}${a.expiringSoon ? " ⚠ expiring soon" : ""}`,
  ));
  section("Graduation proposals", d.graduationProposals.map((g) => `[${g.id}] ${g.preview}`));
  section("Autonomous actions", d.autonomousDigest.map((x) => `${x.type} × ${x.count}`));
  section("Jobs finished", d.jobsFinished.map((j) => `${j.title} (${j.status})`));
  section("Jobs failed", d.jobsFailed.map((j) => `${j.title} — ${j.error}`));
  section("Trust changes", d.trustChanges.map((t) => `${t.type} → ${t.state}`));
  section(d.anchor === "morning" ? "Reminders today" : "Reminders tomorrow",
    d.remindersToday.map((r) => `#${r.id} ${r.text} (${r.due_at})`));
  return lines.join("\n");
}
```

(The `runBrief` half comes in Task 7 — same file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/briefs.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/briefs.ts test/briefs.test.ts
git commit -m "feat(heartbeat): brief assembly and vault rendering"
```

---

### Task 7: Brief runner — narrate, deliver, archive

**Files:**
- Modify: `src/heartbeat/briefs.ts` (append)
- Test: `test/briefs.test.ts` (append)

- [ ] **Step 1: Append the failing tests to `test/briefs.test.ts`**

Add imports to the existing import block:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/events.js";
import { VaultWriter } from "../src/vault/writer.js";
import { runBrief, type BriefRunnerDeps } from "../src/heartbeat/briefs.js";
```

Append:

```ts
describe("runBrief", () => {
  function setup(over: Partial<BriefRunnerDeps> = {}) {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "aios-brief-")), "AIOS");
    vault.init();
    const sent: Array<{ channel: string; chatId: string; text: string }> = [];
    const deps: BriefRunnerDeps = {
      store, bus, vault,
      narrate: async (_anchor, _dataJson) => "Narrated brief.",
      send: async (channel, chatId, text) => { sent.push({ channel, chatId, text }); },
      primary: { channel: "cli", chatId: "local" },
      nowFn: () => new Date(2026, 5, 12, 7, 30),
      ...over,
    };
    return { store, bus, vault, sent, deps };
  }

  it("non-empty morning: narrates, sends, archives, stamps window, emits brief.sent", async () => {
    const { store, bus, vault, sent, deps } = setup();
    store.insertAction(action("eeee5555"));
    const emitted: string[] = [];
    bus.on((e) => emitted.push(e.event.type));
    await runBrief(deps, "morning");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("Narrated brief.");
    expect(vault.readNote("briefs/2026-06-12-morning.md")).toContain("Narrated brief.");
    expect(store.kvGet("brief:last-ts")).toBeTruthy();
    expect(emitted).toContain("brief.sent");
  });

  it("empty morning sends the canned one-liner without narrating", async () => {
    let narrated = 0;
    const { sent, deps, vault } = setup({ narrate: async () => { narrated++; return "x"; } });
    await runBrief(deps, "morning");
    expect(narrated).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Quiet");
    expect(vault.readNote("briefs/2026-06-12-morning.md")).toContain("Quiet");
  });

  it("empty evening is skipped entirely (no send, no vault note)", async () => {
    const { sent, deps, vault, store } = setup();
    await runBrief(deps, "evening");
    expect(sent).toHaveLength(0);
    expect(vault.readNote("briefs/2026-06-12-evening.md")).toBeUndefined();
    expect(store.kvGet("brief:last-ts")).toBeTruthy(); // window still advances
  });

  it("narration failure: archives raw + sends fallback line", async () => {
    const { store, sent, deps, vault } = setup({ narrate: async () => { throw new Error("SDK down"); } });
    store.insertAction(action("ffff6666"));
    await runBrief(deps, "morning");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("narration failed");
    expect(vault.readNote("briefs/2026-06-12-morning.md")).toContain("Pending approvals");
  });

  it("no primary chat: vault-only, no narration call, no send", async () => {
    let narrated = 0;
    const { store, sent, deps, vault } = setup({
      primary: undefined,
      narrate: async () => { narrated++; return "x"; },
    });
    store.insertAction(action("gggg7777"));
    await runBrief(deps, "morning");
    expect(narrated).toBe(0);
    expect(sent).toHaveLength(0);
    expect(vault.readNote("briefs/2026-06-12-morning.md")).toContain("Pending approvals");
  });

  it("send failure does not throw and the archive still exists", async () => {
    const { store, deps, vault } = setup({ send: async () => { throw new Error("channel down"); } });
    store.insertAction(action("hhhh8888"));
    await expect(runBrief(deps, "morning")).resolves.toBeUndefined();
    expect(vault.readNote("briefs/2026-06-12-morning.md")).toBeTruthy();
  });
});
```

Note: `vault.readNote` returns `undefined`/`null` for missing notes — check `src/vault/writer.ts` and match the actual sentinel in the "empty evening" assertion (use `toBeFalsy()` if it returns `null`).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/briefs.test.ts`
Expected: existing 7 PASS, new 6 FAIL — `runBrief` not exported

- [ ] **Step 3: Append to `src/heartbeat/briefs.ts`**

```ts
export interface BriefRunnerDeps {
  store: Store;
  bus: EventBus;
  vault: VaultWriter;
  /** Moderator narration: (anchor, BriefData JSON) → chat-ready text. Only called when primary is set and the brief is non-empty. */
  narrate: (anchor: "morning" | "evening", dataJson: string) => Promise<string>;
  /** Channel delivery. */
  send: (channel: string, chatId: string, text: string) => Promise<void>;
  primary?: { channel: string; chatId: string };
  log?: (line: string) => void;
  nowFn?: () => Date;
}

export async function runBrief(deps: BriefRunnerDeps, anchor: "morning" | "evening"): Promise<void> {
  const now = (deps.nowFn ?? (() => new Date()))();
  const since = deps.store.kvGet("brief:last-ts") ?? null;
  const data = assembleBrief(deps.store, anchor, now.toISOString(), since);
  deps.store.kvSet("brief:last-ts", now.toISOString()); // window always advances — no overlaps, no gaps

  const empty = isEmptyBrief(data);
  if (empty && anchor === "evening") {
    deps.log?.("evening brief skipped (empty)");
    return;
  }

  let narration: string;
  if (empty) {
    narration = "Quiet night. Nothing needs you.";
  } else if (!deps.primary) {
    narration = "(no primary chat configured — raw brief below)";
  } else {
    try {
      narration = await deps.narrate(anchor, JSON.stringify(data));
    } catch (err) {
      narration = `(narration failed: ${(err as Error).message} — raw brief below)`;
      deps.log?.(`brief narration failed: ${(err as Error).message}`);
    }
  }

  const notePath = `briefs/${localParts(now).date}-${anchor}.md`;
  deps.vault.writeNote(notePath, renderBriefNote(data, narration));

  if (deps.primary) {
    try {
      await deps.send(deps.primary.channel, deps.primary.chatId, narration);
    } catch (err) {
      deps.log?.(`brief delivery failed: ${(err as Error).message}`);
    }
  }

  deps.bus.emit({
    type: "brief.sent",
    anchor,
    chatKey: deps.primary ? `${deps.primary.channel}:${deps.primary.chatId}` : null,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/briefs.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — all PASS.

```bash
git add src/heartbeat/briefs.ts test/briefs.test.ts
git commit -m "feat(heartbeat): brief runner — narration, delivery, vault archive"
```

---

### Task 8: Moderator tools — reminders + triage rule

**Files:**
- Modify: `src/moderator/tools.ts`
- Modify: `src/moderator/session.ts` (MCP_TOOLS only)

No new deps needed (`store` and `origin` are already in `ModeratorToolsDeps`). Do NOT touch `src/moderator/prompt.ts` — tool descriptions self-document. No unit tests (thin shims over store methods already covered by Task 1); exercised in the Task 9 e2e + manual smoke.

- [ ] **Step 1: Add four tools in `src/moderator/tools.ts`** (after `proposeAction`)

```ts
  const addReminder = tool(
    "add_reminder",
    "Schedule a reminder for the user. Convert natural-language times to an absolute " +
      "ISO-8601 timestamp WITH timezone offset BEFORE calling (e.g. 2026-06-13T15:00:00+02:00). " +
      "Always confirm the resolved time back to the user.",
    {
      due_at: z.string().describe("Absolute ISO-8601 timestamp with timezone offset"),
      text: z.string().describe("What to remind the user about"),
    },
    async (args) => {
      const due = new Date(args.due_at);
      if (Number.isNaN(due.getTime())) return text(`Invalid due_at: ${args.due_at}`);
      if (due.getTime() <= Date.now()) return text(`due_at is in the past: ${args.due_at}`);
      const id = deps.store.addReminder({
        text: args.text,
        dueAt: due.toISOString(),
        originChannel: deps.origin.channel,
        originChatId: deps.origin.chatId,
      });
      return text(`Reminder #${id} set for ${args.due_at}: "${args.text}". Tell the user the resolved time so misparses surface.`);
    },
  );

  const listReminders = tool(
    "list_reminders",
    "List the user's reminders (pending by default).",
    { status: z.enum(["pending", "fired", "cancelled"]).optional() },
    async (args) => {
      const rows = deps.store.listReminders(args.status ?? "pending");
      if (!rows.length) return text("No reminders.");
      return text(rows.map((r) => `#${r.id} [${r.status}] ${r.due_at} — ${r.text}`).join("\n"));
    },
  );

  const cancelReminder = tool(
    "cancel_reminder",
    "Cancel a pending reminder by id.",
    { id: z.number() },
    async (args) =>
      text(deps.store.cancelReminder(args.id) ? `Reminder #${args.id} cancelled.` : `No pending reminder #${args.id}.`),
  );

  const addTriageRule = tool(
    "add_triage_rule",
    "Persist a notification rule when the user asks to change how event types interrupt them " +
      '(e.g. "stop pinging me about failed jobs" → event_type "job.status", verdict "batch"). ' +
      'event_type is exact ("reminder.due") or a glob prefix ("action.*").',
    {
      event_type: z.string(),
      verdict: z.enum(["ignore", "batch", "notify_now"]),
    },
    async (args) => {
      deps.store.addTriageRule({ eventType: args.event_type, verdict: args.verdict, source: "correction" });
      return text(`Rule saved: ${args.event_type} → ${args.verdict}. This overrides defaults from now on.`);
    },
  );
```

Register them — replace the `tools:` array:

```ts
    tools: [
      runPlaybook, jobStatus, listPlaybooks, askSpecialist,
      vaultWrite, vaultRead, vaultList, proposeAction,
      addReminder, listReminders, cancelReminder, addTriageRule,
    ],
```

- [ ] **Step 2: Add the four names to `MCP_TOOLS` in `src/moderator/session.ts`**

```ts
  "mcp__aios__add_reminder",
  "mcp__aios__list_reminders",
  "mcp__aios__cancel_reminder",
  "mcp__aios__add_triage_rule",
```

- [ ] **Step 3: Verify compile + suite**

Run: `npx tsc --noEmit && npm test`
Expected: clean, all PASS

- [ ] **Step 4: Commit**

```bash
git add src/moderator/tools.ts src/moderator/session.ts
git commit -m "feat(moderator): reminder and triage-rule tools"
```

---

### Task 9: Daemon wiring + heartbeat e2e

**Files:**
- Modify: `src/index.ts`
- Test: `test/heartbeat-e2e.test.ts`

- [ ] **Step 1: Write the failing e2e test**

This test wires Clock + Triage + runBrief together exactly as `src/index.ts` will, with a fake channel and stub narration — proving the full loop without any LLM.

```ts
// test/heartbeat-e2e.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { EventBus, type AiosEvent } from "../src/events.js";
import { VaultWriter } from "../src/vault/writer.js";
import { Clock } from "../src/heartbeat/clock.js";
import { Triage } from "../src/heartbeat/triage.js";
import { runBrief } from "../src/heartbeat/briefs.js";
import type { ActionRow } from "../src/kernel/actions.js";

describe("heartbeat end-to-end (no LLM)", () => {
  it("anchor fires brief; reminder flows clock → bus → triage → origin ping", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "aios-hb-")), "AIOS");
    vault.init();
    const sent: Array<{ channel: string; chatId: string; text: string }> = [];
    const send = async (channel: string, chatId: string, text: string) => {
      sent.push({ channel, chatId, text });
    };
    const primary = { channel: "cli", chatId: "local" };

    // index.ts-style notify routing: reminders → origin chat; everything else → primary
    const notify = async (e: AiosEvent): Promise<void> => {
      if (e.type === "reminder.due") return send(e.channel, e.chatId, `⏰ Reminder: ${e.text}`);
      return send(primary.channel, primary.chatId, `🔔 ${e.type}`);
    };

    const triage = new Triage({
      store, bus, notify,
      classify: async () => { throw new Error("model must not be called in this test"); },
    });
    triage.start();

    let fakeNow = new Date(2026, 5, 12, 7, 31); // 07:31 local
    const clock = new Clock({
      store,
      anchors: [{ name: "morning", hhmm: "07:30" }, { name: "evening", hhmm: "21:00" }],
      onAnchor: (name) =>
        runBrief({ store, bus, vault, narrate: async () => "Narrated.", send, primary, nowFn: () => fakeNow }, name),
      onReminderDue: (r) =>
        bus.emit({ type: "reminder.due", id: r.id, text: r.text, channel: r.origin_channel, chatId: r.origin_chat_id }),
      nowFn: () => fakeNow,
    });

    // seed: one pending approval + one due reminder (origin = telegram chat 42)
    const action: ActionRow = {
      id: "e2e11111", type: "test.echo", payload: "{}", preview: "Echo hi",
      status: "proposed", origin_channel: "cli", origin_chat_id: "local",
      trust_state: "supervised", verdict_by: null, reject_reason: null, result: null,
      created_at: "2026-06-12T05:00:00.000Z", resolved_at: null, expires_at: "2026-06-13T05:00:00.000Z",
    };
    store.insertAction(action);
    store.addReminder({ text: "stretch", dueAt: "2026-06-12T05:25:00.000Z", originChannel: "telegram", originChatId: "42" });

    await clock.tick();
    // allow the async bus → triage chain to settle
    await new Promise((r) => setTimeout(r, 10));

    // morning brief delivered to primary + archived
    const briefMsgs = sent.filter((s) => s.text === "Narrated.");
    expect(briefMsgs).toHaveLength(1);
    expect(briefMsgs[0].chatId).toBe("local");
    expect(vault.readNote("briefs/2026-06-12-morning.md")).toContain("Echo hi");

    // reminder pinged at its ORIGIN chat
    const pings = sent.filter((s) => s.text.startsWith("⏰"));
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({ channel: "telegram", chatId: "42" });
    expect(store.listReminders("fired")).toHaveLength(1);

    // second tick same minute: nothing new fires
    const before = sent.length;
    await clock.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.length).toBe(before);

    // evening: advance to 21:01 — brief includes the brief.sent/triage noise? No: those are
    // ignore/batch; evening brief still has the pending approval → delivered
    fakeNow = new Date(2026, 5, 12, 21, 1);
    await clock.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.filter((s) => s.text === "Narrated.")).toHaveLength(2);
    expect(vault.readNote("briefs/2026-06-12-evening.md")).toBeTruthy();

    triage.stop();
    clock.stop();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/heartbeat-e2e.test.ts`
Expected: FAIL (Clock/Triage/runBrief exist from Tasks 4-7, so this should actually PASS if those tasks are done — if it passes, treat this step as the integration check and move on; if it fails, the failure shows a real seam bug to fix before wiring index.ts)

- [ ] **Step 3: Wire `src/index.ts`**

Add imports:

```ts
import { Clock } from "./heartbeat/clock.js";
import { Triage, modelClassifier } from "./heartbeat/triage.js";
import { runBrief } from "./heartbeat/briefs.js";
```

After the Phase 3 verdict-handler wiring block (`for (const ch of channels.values()) { ch.setVerdictHandler?.(...) }`) and BEFORE `startWebServer(...)`, add:

```ts
  // ---- heartbeat: anchors, briefs, reminders, triage ----
  if (!config.primaryChat) {
    log("WARNING: AIOS_PRIMARY_CHAT not set — briefs are vault-only, notify pings disabled");
  }

  const sendVia = async (channel: string, chatId: string, text: string): Promise<void> => {
    await channels.get(channel)?.send(chatId, text);
  };

  const notify = async (e: import("./events.js").AiosEvent): Promise<void> => {
    if (e.type === "reminder.due") {
      await sendVia(e.channel, e.chatId, `⏰ Reminder: ${e.text}`);
      return;
    }
    if (!config.primaryChat) return;
    const summary =
      e.type === "job.status"
        ? `🔔 Job ${e.jobId} ${e.status}${e.error ? `: ${e.error.slice(0, 200)}` : ""}`
        : `🔔 ${e.type}: ${JSON.stringify(e).slice(0, 200)}`;
    await sendVia(config.primaryChat.channel, config.primaryChat.chatId, summary);
  };

  const triage = new Triage({
    store,
    bus,
    classify: modelClassifier(config.triageModel),
    notify,
    log,
  });
  triage.start();

  const narrate = (anchor: "morning" | "evening", dataJson: string): Promise<string> => {
    const p = config.primaryChat!;
    return moderator.handle(
      p.channel,
      p.chatId,
      `[${anchor.toUpperCase()}-BRIEF] ${dataJson} — narrate this as my chief of staff: short, lead with what needs me, plain text.`,
    );
  };

  const clock = new Clock({
    store,
    anchors: [
      { name: "morning", hhmm: config.anchorMorning },
      { name: "evening", hhmm: config.anchorEvening },
    ],
    onAnchor: (name) =>
      runBrief(
        { store, bus, vault, narrate, send: sendVia, primary: config.primaryChat, log },
        name,
      ),
    onReminderDue: (r) =>
      bus.emit({ type: "reminder.due", id: r.id, text: r.text, channel: r.origin_channel, chatId: r.origin_chat_id }),
    log,
  });
  clock.start();
```

(`narrate` uses `config.primaryChat!` — safe: `runBrief` only calls `narrate` when `primary` is set, and `primary` is `config.primaryChat`.)

In the `shutdown` function, before `store.close()`, add:

```ts
    clock.stop();
    triage.stop();
```

- [ ] **Step 4: Verify compile + full suite + boot smoke**

Run: `npx tsc --noEmit && npm test` — clean, all PASS.

Boot smoke on a throwaway data dir (no LLM call happens at boot):

```bash
env TELEGRAM_BOT_TOKEN= SLACK_BOT_TOKEN= SLACK_APP_TOKEN= \
  AIOS_DATA_DIR=/tmp/aios-p4-data AIOS_UI_PORT=4297 \
  timeout 10 npx tsx src/index.ts --cli < /dev/null; echo "exit: $?"
```

Expected log lines: the primary-chat WARNING, `aios daemon running`, no crash before timeout (exit 124).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/heartbeat-e2e.test.ts
git commit -m "feat(daemon): heartbeat wiring — clock, triage, brief narration pipeline"
```

---

### Task 10: README + final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a heartbeat section to `README.md`**

After the "Earned autonomy (Action Gate)" section, add:

```markdown
### Heartbeat (briefs & reminders)

The daemon sends a **morning brief** (07:30) and **evening close** (21:00) to
`AIOS_PRIMARY_CHAT` (e.g. `telegram:12345`) — pending approvals, autonomous-action
digests, finished/failed jobs, trust changes, and the day's reminders, narrated by
the moderator. Raw briefs are archived in the vault under `briefs/`. Ask for
reminders in chat ("remind me Friday 15:00 to call the accountant") — they ping the
chat where you set them. Say "stop pinging me about X" to add a triage rule.
Anchor times: `AIOS_ANCHOR_MORNING` / `AIOS_ANCHOR_EVENING`.
```

Also add the four new env keys to the architecture diagram region only if they're listed there (they aren't — skip; the section above documents them).

- [ ] **Step 2: Final gates**

Run: `npm test && npx tsc --noEmit && (cd ui && npm run build)`
Expected: everything green (UI untouched this phase but build must stay clean).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: heartbeat briefs, reminders, triage rules in README"
```

---

## Self-review notes (already applied)

- **Spec coverage:** clock/anchors (Task 4: fire-once stamp-before-run, same-day catch-up, double-catch-up order, DST-safe local strings), triage (Task 5: DB rules > payload-aware code defaults > model, fail-quiet batch, no feedback loop, decisions emitted for non-ignored only — refinement of the spec's "every decision" to avoid event-table noise from ignored chat events), briefs (Tasks 6-7: assembly windows via kv, empty rules, narration fallback, vault archive, origin-vs-primary routing), reminders (Tasks 1, 8: claim-at-most-once, origin-chat ping, ISO-converting moderator tool), config (Task 3), events (Task 2), wiring + boot warning + shutdown (Task 9), README (Task 10).
- **Spec deviation (documented):** seeded defaults live in code (`defaultVerdict`) rather than seeded DB rows — payload-aware (job.status failed vs done; auto vs approved executions) which a type-only rules table cannot express. DB rules (user corrections) still override defaults, matching the spec's precedence intent.
- **Placeholder scan:** none.
- **Type consistency:** `ReminderRow`/`TriageRuleRow` snake_case (matches `ActionRow` convention); `claimDueReminders(nowIso)` used identically in clock and tests; `BriefRunnerDeps.narrate(anchor, dataJson)` matches index wiring; `localParts` shared clock→briefs.
