# Scheduling & Routines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `routines` primitive (recurring schedule + prompt payload) fired by the existing Clock, plus a dedicated Schedule section in ui2 showing anchors (editable), routines (CRUD + run-now), and reminders (cancel).

**Architecture:** Routines live in a new SQLite table; the Clock's existing 30s tick due-tests them with pure functions and CAS-stamps before firing (at-most-once, crash-safe — same guarantees as anchors/reminders). A fire emits `routine.due` on the bus; a subscriber builds a synthetic `InboundMessage` and feeds it to the daemon's `onMessage` — the exact entry point chat messages use, so routing, playbooks, trust gates, and reply delivery apply unchanged. Anchor time overrides live in the existing `kv` table and are resolved per-tick, so UI edits take effect without restart.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), node:sqlite via existing `Store`, vitest, React 18 + hash router in ui2. Spec: `docs/superpowers/specs/2026-07-15-scheduling-routines-design.md`.

## Global Constraints

- **No new dependencies.** Subscription-pure; hand-roll everything (no cron lib).
- Recurrence kinds exactly: `daily` / `weekdays` / `weekly` / `interval`. No cron strings.
- `HH:MM` validation regex: `/^([01]\d|2[0-3]):[0-5]\d$/` (24h, zero-padded).
- Local daemon clock only — no timezone handling.
- Reminders table and semantics untouched (one-shot; only a cancel API route is added).
- Manual run stamps neither `last_fired_date` nor `last_fired_at`.
- `src/heartbeat/routines.ts` must import **only** `../channels/types.js` (pure types) — it is pulled into ui2's type graph via `dto.ts`; importing `db.ts` or `clock.ts` from it is a build break / import cycle.
- Commit style: `feat(scope): lowercase summary` — match `git log`.
- All daemon tests: `npx vitest run <file>` from repo root. ui2 tests: `npx vitest run <file>` from `ui2/`.

---

### Task 1: Recurrence primitives + fire handler (`src/heartbeat/routines.ts`)

**Files:**
- Create: `src/heartbeat/routines.ts`
- Test: `test/routines.test.ts`

**Interfaces:**
- Consumes: `InboundMessage` from `src/channels/types.ts` (type-only).
- Produces (later tasks rely on exact names):
  - `type Recurrence = { kind: "daily"; hhmm: string } | { kind: "weekdays"; hhmm: string } | { kind: "weekly"; dow: number; hhmm: string } | { kind: "interval"; everyMinutes: number }`
  - `interface RoutineLike { enabled: number; recurrence: string; last_fired_at: string | null; last_fired_date: string | null }`
  - `parseRecurrence(raw: unknown): Recurrence | null`
  - `routineDue(now: Date, r: RoutineLike): boolean`
  - `nextFire(now: Date, r: RoutineLike): string | null` (local `"YYYY-MM-DD HH:MM"`, display-only)
  - `makeRoutineFire(deps: { onMessage: (msg: InboundMessage) => Promise<void>; primaryChat?: { channel: string; chatId: string }; log: (line: string) => void }): (ev: { id: number; name: string; prompt: string; channel: string; chatId: string }) => void`

- [ ] **Step 1: Write the failing test**

Create `test/routines.test.ts`:

```ts
// test/routines.test.ts
import { describe, it, expect, vi } from "vitest";
import { parseRecurrence, routineDue, nextFire, makeRoutineFire, type RoutineLike } from "../src/heartbeat/routines.js";

const base: RoutineLike = { enabled: 1, recurrence: "", last_fired_at: null, last_fired_date: null };
const rec = (r: unknown): string => JSON.stringify(r);

describe("parseRecurrence", () => {
  it("accepts each valid kind", () => {
    expect(parseRecurrence({ kind: "daily", hhmm: "09:00" })).toEqual({ kind: "daily", hhmm: "09:00" });
    expect(parseRecurrence({ kind: "weekdays", hhmm: "23:59" })).toEqual({ kind: "weekdays", hhmm: "23:59" });
    expect(parseRecurrence({ kind: "weekly", dow: 1, hhmm: "09:00" })).toEqual({ kind: "weekly", dow: 1, hhmm: "09:00" });
    expect(parseRecurrence({ kind: "interval", everyMinutes: 90 })).toEqual({ kind: "interval", everyMinutes: 90 });
  });
  it("accepts a JSON string form (as stored)", () => {
    expect(parseRecurrence('{"kind":"daily","hhmm":"07:30"}')).toEqual({ kind: "daily", hhmm: "07:30" });
  });
  it("rejects malformed shapes", () => {
    expect(parseRecurrence(null)).toBeNull();
    expect(parseRecurrence("not json")).toBeNull();
    expect(parseRecurrence({ kind: "daily", hhmm: "24:00" })).toBeNull();
    expect(parseRecurrence({ kind: "daily", hhmm: "9:00" })).toBeNull();
    expect(parseRecurrence({ kind: "weekly", dow: 7, hhmm: "09:00" })).toBeNull();
    expect(parseRecurrence({ kind: "interval", everyMinutes: 0 })).toBeNull();
    expect(parseRecurrence({ kind: "cron", expr: "* * * * *" })).toBeNull();
  });
});

describe("routineDue", () => {
  // Wed Jul 15 2026 09:30 local
  const now = new Date(2026, 6, 15, 9, 30);

  it("daily: due when time passed and not fired today", () => {
    const r = { ...base, recurrence: rec({ kind: "daily", hhmm: "09:00" }) };
    expect(routineDue(now, r)).toBe(true);
    expect(routineDue(now, { ...r, last_fired_date: "2026-07-15" })).toBe(false);
    expect(routineDue(new Date(2026, 6, 15, 8, 59), r)).toBe(false);
  });
  it("daily: catch-up after downtime fires once (fired yesterday, hours late today)", () => {
    const r = { ...base, recurrence: rec({ kind: "daily", hhmm: "07:00" }), last_fired_date: "2026-07-14" };
    expect(routineDue(new Date(2026, 6, 15, 23, 0), r)).toBe(true);
  });
  it("weekdays: fires Wed, not Sat", () => {
    const r = { ...base, recurrence: rec({ kind: "weekdays", hhmm: "09:00" }) };
    expect(routineDue(now, r)).toBe(true); // Jul 15 2026 = Wednesday
    expect(routineDue(new Date(2026, 6, 18, 9, 30), r)).toBe(false); // Jul 18 = Saturday
  });
  it("weekly: only on matching dow", () => {
    const r = { ...base, recurrence: rec({ kind: "weekly", dow: 3, hhmm: "09:00" }) };
    expect(routineDue(now, r)).toBe(true); // Wed = 3
    expect(routineDue(new Date(2026, 6, 16, 9, 30), r)).toBe(false); // Thu
  });
  it("interval: first fire immediately, then only after the gap", () => {
    const r = { ...base, recurrence: rec({ kind: "interval", everyMinutes: 60 }) };
    expect(routineDue(now, r)).toBe(true); // never fired
    const at = new Date(2026, 6, 15, 9, 0).toISOString();
    expect(routineDue(now, { ...r, last_fired_at: at })).toBe(false); // 30m < 60m
    expect(routineDue(new Date(2026, 6, 15, 10, 0), { ...r, last_fired_at: at })).toBe(true);
  });
  it("disabled or unparseable never fires", () => {
    const r = { ...base, recurrence: rec({ kind: "daily", hhmm: "09:00" }) };
    expect(routineDue(now, { ...r, enabled: 0 })).toBe(false);
    expect(routineDue(now, { ...r, recurrence: "garbage" })).toBe(false);
  });
});

describe("nextFire", () => {
  const now = new Date(2026, 6, 15, 9, 30); // Wed 09:30

  it("daily before the time → today; after → tomorrow", () => {
    expect(nextFire(now, { ...base, recurrence: rec({ kind: "daily", hhmm: "10:00" }) })).toBe("2026-07-15 10:00");
    expect(nextFire(now, { ...base, recurrence: rec({ kind: "daily", hhmm: "09:00" }) })).toBe("2026-07-16 09:00");
  });
  it("weekly skips to the matching day; fired-today pushes a week", () => {
    expect(nextFire(now, { ...base, recurrence: rec({ kind: "weekly", dow: 5, hhmm: "08:00" }) })).toBe("2026-07-17 08:00");
    expect(nextFire(now, { ...base, recurrence: rec({ kind: "weekly", dow: 3, hhmm: "23:00" }), last_fired_date: "2026-07-15" })).toBe("2026-07-22 23:00");
  });
  it("interval: last fire + gap, floored at now; never-fired → now", () => {
    const at = new Date(2026, 6, 15, 9, 0).toISOString();
    expect(nextFire(now, { ...base, recurrence: rec({ kind: "interval", everyMinutes: 60 }), last_fired_at: at })).toBe("2026-07-15 10:00");
    expect(nextFire(now, { ...base, recurrence: rec({ kind: "interval", everyMinutes: 60 }) })).toBe("2026-07-15 09:30");
  });
  it("unparseable → null", () => {
    expect(nextFire(now, { ...base, recurrence: "garbage" })).toBeNull();
  });
});

describe("makeRoutineFire", () => {
  const ev = { id: 1, name: "standup", prompt: "post standup summary", channel: "", chatId: "" };

  it("routes to the event origin when present", async () => {
    const onMessage = vi.fn(async () => {});
    makeRoutineFire({ onMessage, log: () => {} })({ ...ev, channel: "telegram", chatId: "42" });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    expect(onMessage).toHaveBeenCalledWith({ channel: "telegram", chatId: "42", text: "post standup summary" });
  });
  it("falls back to primary chat when origin is empty", async () => {
    const onMessage = vi.fn(async () => {});
    makeRoutineFire({ onMessage, primaryChat: { channel: "slack", chatId: "C1" }, log: () => {} })(ev);
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    expect(onMessage).toHaveBeenCalledWith({ channel: "slack", chatId: "C1", text: "post standup summary" });
  });
  it("no origin and no primary chat → logged skip, no dispatch", () => {
    const onMessage = vi.fn(async () => {});
    const lines: string[] = [];
    makeRoutineFire({ onMessage, log: (l) => lines.push(l) })(ev);
    expect(onMessage).not.toHaveBeenCalled();
    expect(lines[0]).toContain("routine 1");
  });
  it("onMessage rejection is caught and logged, not thrown", async () => {
    const lines: string[] = [];
    const onMessage = vi.fn(async () => { throw new Error("boom"); });
    makeRoutineFire({ onMessage, primaryChat: { channel: "cli", chatId: "local" }, log: (l) => lines.push(l) })(ev);
    await vi.waitFor(() => expect(lines.some((l) => l.includes("boom"))).toBe(true));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routines.test.ts`
Expected: FAIL — `Cannot find module '../src/heartbeat/routines.js'`

- [ ] **Step 3: Write the implementation**

Create `src/heartbeat/routines.ts`:

```ts
// src/heartbeat/routines.ts — recurrence primitives + fire handler for routines
// (spec docs/superpowers/specs/2026-07-15-scheduling-routines-design.md).
// IMPORTANT: this file is pulled into ui2's type graph via web/dto.ts — it may
// import ONLY pure-type modules (channels/types), never db.ts or clock.ts.
import type { InboundMessage } from "../channels/types.js";

export type Recurrence =
  | { kind: "daily"; hhmm: string }
  | { kind: "weekdays"; hhmm: string }
  | { kind: "weekly"; dow: number; hhmm: string }
  | { kind: "interval"; everyMinutes: number };

/** Structural subset of RoutineRow — keeps this module free of db.ts imports. */
export interface RoutineLike {
  enabled: number;
  recurrence: string;
  last_fired_at: string | null;
  last_fired_date: string | null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// Private duplicate of clock.ts localParts — importing clock here would cycle.
function parts(d: Date): { date: string; hhmm: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Validates an untrusted recurrence value (API boundary / stored JSON). Null on any malformed shape. */
export function parseRecurrence(raw: unknown): Recurrence | null {
  const r = typeof raw === "string" ? safeJson(raw) : raw;
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  switch (o.kind) {
    case "daily":
    case "weekdays":
      return typeof o.hhmm === "string" && HHMM.test(o.hhmm) ? { kind: o.kind, hhmm: o.hhmm } : null;
    case "weekly":
      return typeof o.hhmm === "string" && HHMM.test(o.hhmm) &&
        typeof o.dow === "number" && Number.isInteger(o.dow) && o.dow >= 0 && o.dow <= 6
        ? { kind: "weekly", dow: o.dow, hhmm: o.hhmm }
        : null;
    case "interval":
      return typeof o.everyMinutes === "number" && Number.isInteger(o.everyMinutes) && o.everyMinutes >= 1
        ? { kind: "interval", everyMinutes: o.everyMinutes }
        : null;
    default:
      return null;
  }
}

/**
 * Due-test, pure. Time-of-day kinds mirror anchorDue (time passed + not fired
 * today → catch-up after downtime fires once, not N times); interval fires when
 * the gap since last_fired_at has elapsed.
 */
export function routineDue(now: Date, r: RoutineLike): boolean {
  if (!r.enabled) return false;
  const rec = parseRecurrence(r.recurrence);
  if (!rec) return false;
  const p = parts(now);
  switch (rec.kind) {
    case "daily":
      return p.hhmm >= rec.hhmm && r.last_fired_date !== p.date;
    case "weekdays":
      return now.getDay() >= 1 && now.getDay() <= 5 && p.hhmm >= rec.hhmm && r.last_fired_date !== p.date;
    case "weekly":
      return now.getDay() === rec.dow && p.hhmm >= rec.hhmm && r.last_fired_date !== p.date;
    case "interval":
      return r.last_fired_at === null ||
        now.getTime() - new Date(r.last_fired_at).getTime() >= rec.everyMinutes * 60_000;
  }
}

/** Next scheduled fire as local "YYYY-MM-DD HH:MM" — display-only, null when unparseable. */
export function nextFire(now: Date, r: RoutineLike): string | null {
  const rec = parseRecurrence(r.recurrence);
  if (!rec) return null;
  if (rec.kind === "interval") {
    const base = r.last_fired_at
      ? new Date(r.last_fired_at).getTime() + rec.everyMinutes * 60_000
      : now.getTime();
    const p = parts(new Date(Math.max(base, now.getTime())));
    return `${p.date} ${p.hhmm}`;
  }
  const matches = (d: Date): boolean =>
    rec.kind === "daily" ? true
    : rec.kind === "weekdays" ? d.getDay() >= 1 && d.getDay() <= 5
    : d.getDay() === rec.dow;
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const p = parts(d);
    if (!matches(d)) continue;
    if (r.last_fired_date === p.date) continue;
    if (i === 0 && parts(now).hhmm >= rec.hhmm) continue;
    return `${p.date} ${rec.hhmm}`;
  }
  return null;
}

export interface RoutineFireDeps {
  onMessage: (msg: InboundMessage) => Promise<void>;
  primaryChat?: { channel: string; chatId: string };
  log: (line: string) => void;
}

/**
 * The routine.due subscriber body: injects the prompt into the kernel as a
 * synthetic inbound message — the exact entry point chat messages use, so
 * routing, playbooks, trust gates, and reply delivery apply unchanged.
 * Origin falls back to the primary chat; with neither, the fire is dropped
 * with a log line (fire-and-forget, same posture as reminders).
 */
export function makeRoutineFire(deps: RoutineFireDeps) {
  return (ev: { id: number; name: string; prompt: string; channel: string; chatId: string }): void => {
    const channel = ev.channel || deps.primaryChat?.channel || "";
    const chatId = ev.chatId || deps.primaryChat?.chatId || "";
    if (!channel || !chatId) {
      deps.log(`routine ${ev.id} (${ev.name}) skipped: no origin chat and no primary chat`);
      return;
    }
    void deps.onMessage({ channel, chatId, text: ev.prompt })
      .catch((err) => deps.log(`routine ${ev.id} (${ev.name}) failed: ${(err as Error).message}`));
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/routines.test.ts`
Expected: PASS (all describes green)

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/routines.ts test/routines.test.ts
git commit -m "feat(routines): recurrence primitives + kernel fire handler (spec 2026-07-15)"
```

---

### Task 2: Store — `routines` table, CRUD, CAS stamp

**Files:**
- Modify: `src/store/db.ts` (schema block near the `reminders` CREATE TABLE ~line 413; `RoutineRow` interface after `ReminderRow` ~line 117; methods after the `// ---- reminders ----` block ~line 1290)
- Test: `test/routines-store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface RoutineRow { id: number; name: string; prompt: string; recurrence: string; enabled: number; last_fired_at: string | null; last_fired_date: string | null; origin_channel: string | null; origin_chat_id: string | null; created_at: string }` (satisfies Task 1's `RoutineLike`)
  - `Store.addRoutine(r: { name: string; prompt: string; recurrence: string; originChannel?: string; originChatId?: string }): number`
  - `Store.getRoutine(id: number): RoutineRow | undefined`
  - `Store.listRoutines(): RoutineRow[]`
  - `Store.updateRoutine(id: number, patch: { name?: string; prompt?: string; recurrence?: string; enabled?: boolean }): boolean`
  - `Store.deleteRoutine(id: number): boolean`
  - `Store.stampRoutineFired(id: number, expectLastFiredAt: string | null, dateLocal: string, atIso: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `test/routines-store.test.ts`:

```ts
// test/routines-store.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

const add = (store: Store) =>
  store.addRoutine({ name: "standup", prompt: "post summary", recurrence: '{"kind":"daily","hhmm":"09:00"}' });

describe("routines store", () => {
  it("add/get/list round-trips with defaults", () => {
    const store = new Store(":memory:");
    const id = add(store);
    const r = store.getRoutine(id)!;
    expect(r.name).toBe("standup");
    expect(r.enabled).toBe(1);
    expect(r.last_fired_at).toBeNull();
    expect(r.last_fired_date).toBeNull();
    expect(r.origin_channel).toBeNull();
    expect(store.listRoutines()).toHaveLength(1);
  });

  it("updateRoutine patches only provided fields; false for unknown id", () => {
    const store = new Store(":memory:");
    const id = add(store);
    expect(store.updateRoutine(id, { enabled: false })).toBe(true);
    const r = store.getRoutine(id)!;
    expect(r.enabled).toBe(0);
    expect(r.name).toBe("standup"); // untouched
    expect(store.updateRoutine(999, { name: "x" })).toBe(false);
  });

  it("deleteRoutine removes; false for unknown id", () => {
    const store = new Store(":memory:");
    const id = add(store);
    expect(store.deleteRoutine(id)).toBe(true);
    expect(store.getRoutine(id)).toBeUndefined();
    expect(store.deleteRoutine(id)).toBe(false);
  });

  it("stampRoutineFired is CAS on last_fired_at — second claim with a stale expectation loses", () => {
    const store = new Store(":memory:");
    const id = add(store);
    expect(store.stampRoutineFired(id, null, "2026-07-15", "2026-07-15T09:00:00.000Z")).toBe(true);
    // same expectation again (stale read) must not double-fire
    expect(store.stampRoutineFired(id, null, "2026-07-15", "2026-07-15T09:00:30.000Z")).toBe(false);
    const r = store.getRoutine(id)!;
    expect(r.last_fired_date).toBe("2026-07-15");
    expect(r.last_fired_at).toBe("2026-07-15T09:00:00.000Z");
    // next fire with the fresh expectation succeeds
    expect(store.stampRoutineFired(id, "2026-07-15T09:00:00.000Z", "2026-07-16", "2026-07-16T09:00:00.000Z")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routines-store.test.ts`
Expected: FAIL — `store.addRoutine is not a function`

- [ ] **Step 3: Implement in `src/store/db.ts`**

Add the interface directly after `ReminderRow` (line ~117):

```ts
export interface RoutineRow {
  id: number;
  name: string;
  prompt: string;
  /** JSON — parse with parseRecurrence (heartbeat/routines.ts). */
  recurrence: string;
  enabled: number;
  last_fired_at: string | null;
  last_fired_date: string | null;
  origin_channel: string | null;
  origin_chat_id: string | null;
  created_at: string;
}
```

Add to the schema exec block that creates `reminders` (after the `idx_reminders_due` index, inside the same template literal):

```sql
      CREATE TABLE IF NOT EXISTS routines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        recurrence TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_fired_at TEXT,
        last_fired_date TEXT,
        origin_channel TEXT,
        origin_chat_id TEXT,
        created_at TEXT NOT NULL
      );
```

Add methods after the reminders block (`claimDueReminders`), before `// ---- triage rules ----`:

```ts
  // ---- routines (spec 2026-07-15) ----

  addRoutine(r: { name: string; prompt: string; recurrence: string; originChannel?: string; originChatId?: string }): number {
    const res = this.db
      .prepare(
        `INSERT INTO routines (name, prompt, recurrence, origin_channel, origin_chat_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.name, r.prompt, r.recurrence, r.originChannel ?? null, r.originChatId ?? null, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  getRoutine(id: number): RoutineRow | undefined {
    return this.db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as RoutineRow | undefined;
  }

  listRoutines(): RoutineRow[] {
    return this.db.prepare("SELECT * FROM routines ORDER BY id").all() as unknown as RoutineRow[];
  }

  updateRoutine(id: number, patch: { name?: string; prompt?: string; recurrence?: string; enabled?: boolean }): boolean {
    const row = this.getRoutine(id);
    if (!row) return false;
    const res = this.db
      .prepare("UPDATE routines SET name = ?, prompt = ?, recurrence = ?, enabled = ? WHERE id = ?")
      .run(
        patch.name ?? row.name,
        patch.prompt ?? row.prompt,
        patch.recurrence ?? row.recurrence,
        patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
        id,
      );
    return res.changes > 0;
  }

  deleteRoutine(id: number): boolean {
    return this.db.prepare("DELETE FROM routines WHERE id = ?").run(id).changes > 0;
  }

  /**
   * CAS stamp before fire (at-most-once, mirrors claimDueReminders): guards on
   * the exact last_fired_at the due-test saw, so a stale read can never
   * double-fire. `IS ?` handles the NULL initial state.
   */
  stampRoutineFired(id: number, expectLastFiredAt: string | null, dateLocal: string, atIso: string): boolean {
    const res = this.db
      .prepare("UPDATE routines SET last_fired_date = ?, last_fired_at = ? WHERE id = ? AND last_fired_at IS ?")
      .run(dateLocal, atIso, id, expectLastFiredAt);
    return res.changes > 0;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routines-store.test.ts test/store-heartbeat.test.ts`
Expected: PASS (new file green; existing store tests unaffected)

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts test/routines-store.test.ts
git commit -m "feat(store): routines table + CRUD + CAS fire stamp"
```

---

### Task 3: Clock fires routines; live anchor overrides; `routine.due` event; triage ignore

**Files:**
- Modify: `src/heartbeat/clock.ts` (deps + tick)
- Modify: `src/events.ts` (`AiosEvent` union, after the `reminder.due` member)
- Modify: `src/heartbeat/triage.ts` (`defaultVerdict` switch)
- Test: extend `test/clock.test.ts`; extend `test/triage.test.ts`

**Interfaces:**
- Consumes: `routineDue` from Task 1; `RoutineRow`, `listRoutines`, `stampRoutineFired` from Task 2.
- Produces:
  - `ClockDeps.onRoutineDue?: (routine: RoutineRow) => void`
  - Anchor override kv key convention: `` `anchor:${name}:hhmm` `` — resolved per tick, `kvGet(...) ?? anchor.hhmm`.
  - Bus event: `{ type: "routine.due"; id: number; name: string; prompt: string; channel: string; chatId: string }`
  - `defaultVerdict` returns `"ignore"` for `routine.due`.

- [ ] **Step 1: Write the failing tests**

Append to `test/clock.test.ts` (inside the file, new describes at the bottom; reuse the existing imports and add `import { routineDue } from "../src/heartbeat/routines.js"` only if needed — the tests below don't need it):

```ts
describe("Clock.tick — routines", () => {
  function setupRoutines(nowLocal: Date) {
    const store = new Store(":memory:");
    const fired: Array<{ id: number; name: string }> = [];
    const clock = new Clock({
      store,
      anchors: [],
      onAnchor: async () => {},
      onReminderDue: () => {},
      onRoutineDue: (r) => { fired.push({ id: r.id, name: r.name }); },
      nowFn: () => nowLocal,
    });
    return { store, clock, fired };
  }

  it("fires a due routine once and stamps; second tick is a no-op", async () => {
    const { store, clock, fired } = setupRoutines(new Date(2026, 6, 15, 9, 30));
    const id = store.addRoutine({ name: "r1", prompt: "p", recurrence: '{"kind":"daily","hhmm":"09:00"}' });
    await clock.tick();
    await clock.tick();
    expect(fired).toEqual([{ id, name: "r1" }]);
    expect(store.getRoutine(id)!.last_fired_date).toBe("2026-07-15");
  });

  it("disabled routine never fires", async () => {
    const { store, clock, fired } = setupRoutines(new Date(2026, 6, 15, 9, 30));
    const id = store.addRoutine({ name: "r1", prompt: "p", recurrence: '{"kind":"daily","hhmm":"09:00"}' });
    store.updateRoutine(id, { enabled: false });
    await clock.tick();
    expect(fired).toEqual([]);
  });

  it("a throwing onRoutineDue does not kill the tick", async () => {
    const store = new Store(":memory:");
    store.addRoutine({ name: "bad", prompt: "p", recurrence: '{"kind":"daily","hhmm":"09:00"}' });
    store.addReminder({ text: "after", dueAt: "2026-07-15T00:00:00.000Z", originChannel: "cli", originChatId: "x" });
    const remindersFired: string[] = [];
    const clock = new Clock({
      store,
      anchors: [],
      onAnchor: async () => {},
      onReminderDue: (r) => { remindersFired.push(r.text); },
      onRoutineDue: () => { throw new Error("boom"); },
      nowFn: () => new Date(2026, 6, 15, 9, 30),
    });
    await clock.tick();
    expect(remindersFired).toEqual(["after"]); // reminders ran despite the throw
  });
});

describe("Clock.tick — anchor kv override", () => {
  it("kv override moves an anchor's effective time without restart", async () => {
    const store = new Store(":memory:");
    const anchorsFired: string[] = [];
    const clock = new Clock({
      store,
      anchors: [{ name: "morning", hhmm: "07:30" }],
      onAnchor: async (name) => { anchorsFired.push(name); },
      onReminderDue: () => {},
      nowFn: () => new Date(2026, 6, 15, 8, 0), // 08:00
    });
    store.kvSet("anchor:morning:hhmm", "09:00"); // pushed later than now
    await clock.tick();
    expect(anchorsFired).toEqual([]); // 08:00 < 09:00 override
    store.kvSet("anchor:morning:hhmm", "07:00"); // pulled earlier
    await clock.tick();
    expect(anchorsFired).toEqual(["morning"]);
  });
});
```

Append to `test/triage.test.ts` (find the existing `defaultVerdict` describe and add):

```ts
  it("routine.due is ignored — the kernel injection handles it, no notify ping", () => {
    expect(defaultVerdict({ type: "routine.due", id: 1, name: "r", prompt: "p", channel: "", chatId: "" })).toBe("ignore");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/clock.test.ts test/triage.test.ts`
Expected: FAIL — `onRoutineDue` not in `ClockDeps` (type error) / `routine.due` not assignable to `AiosEvent` / verdict undefined.

- [ ] **Step 3: Implement**

`src/events.ts` — add to the `AiosEvent` union directly after the `reminder.due` line:

```ts
  | { type: "routine.due"; id: number; name: string; prompt: string; channel: string; chatId: string }
```

`src/heartbeat/triage.ts` — in `defaultVerdict`, add next to the `reminder.due` case:

```ts
    case "routine.due":
      return "ignore"; // fires inject a kernel message directly — a ping here would double-notify
```

`src/heartbeat/clock.ts`:

1. Extend imports: `import type { Store, ReminderRow, RoutineRow } from "../store/db.js";` and add `import { routineDue } from "./routines.js";`
2. Add to `ClockDeps` after `onReminderDue`:

```ts
  /** Optional — routines fire only when wired (tests that don't care omit it). */
  onRoutineDue?: (routine: RoutineRow) => void;
```

3. In `tick()`, replace the anchor loop's due-check line to resolve kv overrides:

```ts
      for (const anchor of this.deps.anchors) {
        const key = `anchor:${anchor.name}:last`;
        const hhmm = this.deps.store.kvGet(`anchor:${anchor.name}:hhmm`) ?? anchor.hhmm;
        if (!anchorDue(parts, hhmm, this.deps.store.kvGet(key))) continue;
```

(the rest of the anchor loop body is unchanged)

4. Add after the reminders loop, before `this.deps.onTick?.();`:

```ts
      if (this.deps.onRoutineDue) {
        for (const routine of this.deps.store.listRoutines()) {
          if (!routineDue(now, routine)) continue;
          // CAS stamp BEFORE the fire — same fire-once-through-crashes property as anchors.
          if (!this.deps.store.stampRoutineFired(routine.id, routine.last_fired_at, parts.date, now.toISOString())) continue;
          try {
            this.deps.onRoutineDue(routine);
          } catch (err) {
            this.deps.log?.(`routine ${routine.id} dispatch failed: ${(err as Error).message}`);
          }
        }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/clock.test.ts test/triage.test.ts test/heartbeat-e2e.test.ts`
Expected: PASS (new describes green; existing anchor/reminder/e2e tests unaffected)

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/clock.ts src/events.ts src/heartbeat/triage.ts test/clock.test.ts test/triage.test.ts
git commit -m "feat(clock): routine firing on the tick + live anchor kv overrides + routine.due event"
```

---

### Task 4: Daemon wiring in `src/index.ts`

**Files:**
- Modify: `src/index.ts` (two additions: bus subscriber near `onMessage`; `onRoutineDue` in the `new Clock({...})` deps at ~line 590)

**Interfaces:**
- Consumes: `makeRoutineFire` (Task 1), `ClockDeps.onRoutineDue` + `routine.due` event (Task 3), existing `onMessage` (line ~388) and `config.primaryChat`.
- Produces: nothing new — composition only. No unit test (composition root, matching repo convention); `test/heartbeat-e2e.test.ts` + typecheck guard it.

- [ ] **Step 1: Add the import**

With the other heartbeat imports at the top of `src/index.ts`:

```ts
import { makeRoutineFire } from "./heartbeat/routines.js";
```

- [ ] **Step 2: Subscribe the fire handler**

Directly AFTER the `onMessage` const closes (after its closing `};`, ~line 416):

```ts
  // Routines inject their prompt as a synthetic inbound message — full kernel path (spec 2026-07-15).
  const routineFire = makeRoutineFire({ onMessage, primaryChat: config.primaryChat, log });
  bus.on((e) => {
    if (e.event.type === "routine.due") routineFire(e.event);
  });
```

- [ ] **Step 3: Wire the Clock dep**

In the `new Clock({ ... })` literal, after the `onReminderDue` entry:

```ts
    onRoutineDue: (r) =>
      bus.emit({
        type: "routine.due", id: r.id, name: r.name, prompt: r.prompt,
        channel: r.origin_channel ?? "", chatId: r.origin_chat_id ?? "",
      }),
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx vitest run test/heartbeat-e2e.test.ts`
Expected: clean typecheck, e2e PASS.

(`config.primaryChat` is `{ channel: string; chatId: string } | undefined` — passes straight into `makeRoutineFire`'s optional `primaryChat`.)

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(daemon): wire routine.due — clock emits, subscriber injects prompt via onMessage"
```

---

### Task 5: Schedule view builder + DTOs + write validation

**Files:**
- Create: `src/web/schedule-view.ts`
- Modify: `src/web/dto.ts` (append schedule types)
- Test: `test/schedule-view.test.ts`

**Interfaces:**
- Consumes: `parseRecurrence`, `nextFire`, `Recurrence` (Task 1); `listRoutines`, `listReminders`, `kvGet` (Store); `Config` anchor fields `anchorMorning/anchorEvening/anchorDream/anchorSpeculate/anchorStandup`.
- Produces:
  - dto: `AnchorView { name: string; hhmm: string; overridden: boolean; firedToday: boolean }`, `RoutineView { id: number; name: string; prompt: string; recurrence: Recurrence; enabled: boolean; lastFiredAt: string | null; nextFire: string | null }`, `ScheduleReminderView { id: number; text: string; dueAt: string; origin: string }`, `ScheduleView { anchors: AnchorView[]; routines: RoutineView[]; reminders: ScheduleReminderView[] }`; dto re-exports `Recurrence`.
  - `ANCHOR_NAMES = ["morning", "evening", "dream", "speculate", "standup"] as const`
  - `anchorOverrideKey(name: string): string` → `` `anchor:${name}:hhmm` ``
  - `isValidHHMM(s: unknown): s is string`
  - `validateRoutineBody(body: unknown, partial: boolean): { ok: true; fields: { name?: string; prompt?: string; recurrence?: string; enabled?: boolean } } | { ok: false; error: string }`
  - `buildScheduleView(store: Store, config: Config, now: Date): ScheduleView`

- [ ] **Step 1: Write the failing test**

Create `test/schedule-view.test.ts`:

```ts
// test/schedule-view.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { buildConfig } from "../src/config.js";
import { buildScheduleView, validateRoutineBody, isValidHHMM, anchorOverrideKey, ANCHOR_NAMES } from "../src/web/schedule-view.js";

// buildConfig({}) yields all defaults — anchorMorning "07:30" etc.; only anchor* fields matter here.
const config = buildConfig({});
const now = new Date(2026, 6, 15, 9, 30);

describe("buildScheduleView", () => {
  it("lists all five anchors with override + firedToday flags", () => {
    const store = new Store(":memory:");
    store.kvSet(anchorOverrideKey("morning"), "08:15");
    store.kvSet("anchor:evening:last", "2026-07-15");
    const v = buildScheduleView(store, config, now);
    expect(v.anchors.map((a) => a.name)).toEqual([...ANCHOR_NAMES]);
    const morning = v.anchors.find((a) => a.name === "morning")!;
    expect(morning).toMatchObject({ hhmm: "08:15", overridden: true });
    expect(v.anchors.find((a) => a.name === "evening")!.firedToday).toBe(true);
    expect(v.anchors.find((a) => a.name === "dream")!.overridden).toBe(false);
  });

  it("routines carry parsed recurrence, enabled bool, and nextFire", () => {
    const store = new Store(":memory:");
    store.addRoutine({ name: "r1", prompt: "p", recurrence: '{"kind":"daily","hhmm":"10:00"}' });
    const [r] = buildScheduleView(store, config, now).routines;
    expect(r.recurrence).toEqual({ kind: "daily", hhmm: "10:00" });
    expect(r.enabled).toBe(true);
    expect(r.nextFire).toBe("2026-07-15 10:00");
  });

  it("only pending reminders appear", () => {
    const store = new Store(":memory:");
    const id = store.addReminder({ text: "call", dueAt: "2026-07-16T09:00:00.000Z", originChannel: "cli", originChatId: "x" });
    store.addReminder({ text: "gone", dueAt: "2026-07-16T09:00:00.000Z", originChannel: "cli", originChatId: "x" });
    store.cancelReminder(id + 1);
    const v = buildScheduleView(store, config, now);
    expect(v.reminders).toHaveLength(1);
    expect(v.reminders[0]).toMatchObject({ text: "call", origin: "cli:x" });
  });
});

describe("validateRoutineBody", () => {
  it("full body: all three required", () => {
    expect(validateRoutineBody({ name: "n", prompt: "p", recurrence: { kind: "daily", hhmm: "09:00" } }, false))
      .toEqual({ ok: true, fields: { name: "n", prompt: "p", recurrence: '{"kind":"daily","hhmm":"09:00"}' } });
    expect(validateRoutineBody({ name: "n", prompt: "p" }, false)).toMatchObject({ ok: false });
    expect(validateRoutineBody({ name: " ", prompt: "p", recurrence: { kind: "daily", hhmm: "09:00" } }, false)).toMatchObject({ ok: false });
  });
  it("partial: any subset, but present fields must be valid", () => {
    expect(validateRoutineBody({ enabled: false }, true)).toEqual({ ok: true, fields: { enabled: false } });
    expect(validateRoutineBody({ recurrence: { kind: "cron" } }, true)).toMatchObject({ ok: false });
    expect(validateRoutineBody("nope", true)).toMatchObject({ ok: false });
  });
});

describe("isValidHHMM", () => {
  it("accepts 24h zero-padded, rejects everything else", () => {
    expect(isValidHHMM("07:30")).toBe(true);
    expect(isValidHHMM("23:59")).toBe(true);
    expect(isValidHHMM("24:00")).toBe(false);
    expect(isValidHHMM("7:30")).toBe(false);
    expect(isValidHHMM(730)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/schedule-view.test.ts`
Expected: FAIL — `Cannot find module '../src/web/schedule-view.js'`

- [ ] **Step 3: Implement**

Append to `src/web/dto.ts`:

```ts
// ---- schedule (spec 2026-07-15) ----
export type { Recurrence } from "../heartbeat/routines.js";
import type { Recurrence as RecurrenceT } from "../heartbeat/routines.js";

export interface AnchorView {
  name: string;
  /** Effective time — kv override when set, config default otherwise. */
  hhmm: string;
  overridden: boolean;
  firedToday: boolean;
}

export interface RoutineView {
  id: number;
  name: string;
  prompt: string;
  recurrence: RecurrenceT;
  enabled: boolean;
  lastFiredAt: string | null;
  /** Local "YYYY-MM-DD HH:MM", display-only. */
  nextFire: string | null;
}

export interface ScheduleReminderView {
  id: number;
  text: string;
  dueAt: string;
  origin: string;
}

export interface ScheduleView {
  anchors: AnchorView[];
  routines: RoutineView[];
  reminders: ScheduleReminderView[];
}
```

Create `src/web/schedule-view.ts`:

```ts
// src/web/schedule-view.ts — GET /api/schedule builder + routine/anchor write validation (spec 2026-07-15).
import type { Store } from "../store/db.js";
import type { Config } from "../config.js";
import { parseRecurrence, nextFire } from "../heartbeat/routines.js";
import type { ScheduleView, AnchorView } from "./dto.js";

export const ANCHOR_NAMES = ["morning", "evening", "dream", "speculate", "standup"] as const;
export type AnchorName = (typeof ANCHOR_NAMES)[number];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function anchorOverrideKey(name: string): string {
  return `anchor:${name}:hhmm`;
}

export function isValidHHMM(s: unknown): s is string {
  return typeof s === "string" && HHMM.test(s);
}

function anchorDefaults(config: Config): Record<AnchorName, string> {
  return {
    morning: config.anchorMorning,
    evening: config.anchorEvening,
    dream: config.anchorDream,
    speculate: config.anchorSpeculate,
    standup: config.anchorStandup,
  };
}

export interface RoutineFields {
  name?: string;
  prompt?: string;
  /** Normalized JSON of a validated Recurrence. */
  recurrence?: string;
  enabled?: boolean;
}

/** Validates POST (partial=false: name/prompt/recurrence required) and PATCH (partial=true) bodies. */
export function validateRoutineBody(
  body: unknown,
  partial: boolean,
): { ok: true; fields: RoutineFields } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const fields: RoutineFields = {};
  if (b.name !== undefined) {
    if (typeof b.name !== "string" || !b.name.trim()) return { ok: false, error: "name must be a non-empty string" };
    fields.name = b.name.trim();
  }
  if (b.prompt !== undefined) {
    if (typeof b.prompt !== "string" || !b.prompt.trim()) return { ok: false, error: "prompt must be a non-empty string" };
    fields.prompt = b.prompt.trim();
  }
  if (b.recurrence !== undefined) {
    const rec = parseRecurrence(b.recurrence);
    if (!rec) return { ok: false, error: "recurrence must be daily/weekdays/weekly/interval with valid fields" };
    fields.recurrence = JSON.stringify(rec);
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    fields.enabled = b.enabled;
  }
  if (!partial) {
    if (!fields.name) return { ok: false, error: "name is required" };
    if (!fields.prompt) return { ok: false, error: "prompt is required" };
    if (!fields.recurrence) return { ok: false, error: "recurrence is required" };
  }
  return { ok: true, fields };
}

export function buildScheduleView(store: Store, config: Config, now: Date): ScheduleView {
  const defaults = anchorDefaults(config);
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const anchors: AnchorView[] = ANCHOR_NAMES.map((name) => {
    const override = store.kvGet(anchorOverrideKey(name));
    return {
      name,
      hhmm: override ?? defaults[name],
      overridden: override !== undefined,
      firedToday: store.kvGet(`anchor:${name}:last`) === today,
    };
  });
  return {
    anchors,
    routines: store.listRoutines().map((r) => {
      const rec = parseRecurrence(r.recurrence);
      return {
        id: r.id,
        name: r.name,
        prompt: r.prompt,
        // rec is null only for hand-edited DB rows — surface something renderable.
        recurrence: rec ?? { kind: "daily" as const, hhmm: "00:00" },
        enabled: !!r.enabled,
        lastFiredAt: r.last_fired_at,
        nextFire: nextFire(now, r),
      };
    }),
    reminders: store.listReminders("pending").map((r) => ({
      id: r.id,
      text: r.text,
      dueAt: r.due_at,
      origin: `${r.origin_channel}:${r.origin_chat_id}`,
    })),
  };
}
```

(`store.kvGet` returns `string | undefined` — the `overridden: override !== undefined` check is correct as written.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/schedule-view.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/schedule-view.ts src/web/dto.ts test/schedule-view.test.ts
git commit -m "feat(web): schedule view builder + routine validation + DTOs"
```

---

### Task 6: HTTP routes in `src/web/server.ts`

**Files:**
- Modify: `src/web/server.ts` (import block + route handlers after the goals section, near line ~480)

**Interfaces:**
- Consumes: everything from Task 5; `store.addRoutine/updateRoutine/deleteRoutine/getRoutine/cancelReminder/kvSet`; `bus.emit`; destructured `store`, `bus`, `config` already in scope in the handler.
- Produces routes (ui2 api client in Task 7 calls these exact paths):
  - `GET /api/schedule` → `ScheduleView`
  - `POST /api/routines` → `{ id: number }` | 400
  - `PATCH /api/routines/:id` → `{ ok: true }` | 400 | 404
  - `DELETE /api/routines/:id` → `{ ok: true }` | 404
  - `POST /api/routines/:id/run` → `{ ok: true }` | 404
  - `PATCH /api/anchors/:name` body `{ hhmm }` → `{ ok: true }` | 400 | 404
  - `DELETE /api/reminders/:id` → `{ ok: true }` | 404

Route wiring is thin and untested by convention (this repo tests builders/validators, not the HTTP dispatcher — see `test/goal-endpoints.test.ts`). All logic lives in Task 5's tested functions.

- [ ] **Step 1: Add imports**

In the import block of `src/web/server.ts`:

```ts
import { buildScheduleView, validateRoutineBody, isValidHHMM, anchorOverrideKey, ANCHOR_NAMES } from "./schedule-view.js";
```

- [ ] **Step 2: Add routes**

After the goals route group (after the `/api/budget` GET handler is fine — keep the section comment):

```ts
        // ---- schedule: anchors + routines + reminders (spec 2026-07-15) ----
        if (path === "/api/schedule" && req.method === "GET") {
          return json(res, 200, buildScheduleView(store, config, new Date()));
        }

        if (path === "/api/routines" && req.method === "POST") {
          const v = validateRoutineBody(JSON.parse(await readBody(req)), false);
          if (!v.ok) return json(res, 400, { error: v.error });
          const id = store.addRoutine({ name: v.fields.name!, prompt: v.fields.prompt!, recurrence: v.fields.recurrence! });
          return json(res, 200, { id });
        }

        const routineMatch = /^\/api\/routines\/(\d+)$/.exec(path);
        if (routineMatch && req.method === "PATCH") {
          const v = validateRoutineBody(JSON.parse(await readBody(req)), true);
          if (!v.ok) return json(res, 400, { error: v.error });
          if (!store.updateRoutine(Number(routineMatch[1]), v.fields)) return json(res, 404, { error: "unknown routine" });
          return json(res, 200, { ok: true });
        }
        if (routineMatch && req.method === "DELETE") {
          if (!store.deleteRoutine(Number(routineMatch[1]))) return json(res, 404, { error: "unknown routine" });
          return json(res, 200, { ok: true });
        }

        const routineRun = /^\/api\/routines\/(\d+)\/run$/.exec(path);
        if (routineRun && req.method === "POST") {
          const r = store.getRoutine(Number(routineRun[1]));
          if (!r) return json(res, 404, { error: "unknown routine" });
          // Manual fire: same bus event as the clock, no stamping — scheduled cadence unaffected.
          bus.emit({
            type: "routine.due", id: r.id, name: r.name, prompt: r.prompt,
            channel: r.origin_channel ?? "", chatId: r.origin_chat_id ?? "",
          });
          return json(res, 200, { ok: true });
        }

        const anchorPatch = /^\/api\/anchors\/([a-z]+)$/.exec(path);
        if (anchorPatch && req.method === "PATCH") {
          if (!(ANCHOR_NAMES as readonly string[]).includes(anchorPatch[1])) {
            return json(res, 404, { error: "unknown anchor" });
          }
          const body = JSON.parse(await readBody(req)) as { hhmm?: unknown };
          if (!isValidHHMM(body.hhmm)) return json(res, 400, { error: "hhmm must be HH:MM (24h, zero-padded)" });
          store.kvSet(anchorOverrideKey(anchorPatch[1]), body.hhmm);
          return json(res, 200, { ok: true });
        }

        const reminderDel = /^\/api\/reminders\/(\d+)$/.exec(path);
        if (reminderDel && req.method === "DELETE") {
          if (!store.cancelReminder(Number(reminderDel[1]))) return json(res, 404, { error: "unknown or non-pending reminder" });
          return json(res, 200, { ok: true });
        }
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx vitest run test/schedule-view.test.ts`
Expected: clean. (`store`, `bus`, `config` are already destructured from `deps` at `src/web/server.ts:130` — bare names are correct.)

- [ ] **Step 4: Commit**

```bash
git add src/web/server.ts
git commit -m "feat(web): schedule/routines/anchors/reminders API routes"
```

---

### Task 7: ui2 plumbing — section, nav, api client

**Files:**
- Modify: `ui2/src/lib/router.ts` (SECTIONS)
- Modify: `ui2/src/components/BottomTabs.tsx` (ICONS)
- Modify: `ui2/src/App.tsx` (JUMPS, import, mount)
- Modify: `ui2/src/api.ts` (types + methods)
- Test: extend `ui2/test/router.test.ts`

**Interfaces:**
- Consumes: route DTOs from Task 5 via `src/web/dto.ts`; routes from Task 6.
- Produces (Task 8 relies on):
  - `api.schedule(): Promise<ScheduleView>`
  - `api.addRoutine(r: { name: string; prompt: string; recurrence: Recurrence }): Promise<{ id: number }>`
  - `api.updateRoutine(id: number, patch: { name?: string; prompt?: string; recurrence?: Recurrence; enabled?: boolean }): Promise<{ ok: true }>`
  - `api.deleteRoutine(id: number): Promise<{ ok: true }>`
  - `api.runRoutine(id: number): Promise<{ ok: true }>`
  - `api.setAnchor(name: string, hhmm: string): Promise<{ ok: true }>`
  - `api.cancelReminder(id: number): Promise<{ ok: true }>`
  - Section id `"schedule"`, jump key `r`, tab icon `◷`.

- [ ] **Step 1: Write the failing test**

Append to `ui2/test/router.test.ts`:

```ts
it("schedule is a section", () => {
  expect(parseHash("#/schedule").section).toBe("schedule");
});
```

(If `parseHash` isn't already imported in that file, add it to the existing import from `../src/lib/router.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui2 && npx vitest run test/router.test.ts`
Expected: FAIL — section resolves to `"home"`.

- [ ] **Step 3: Implement**

`ui2/src/lib/router.ts`:

```ts
export const SECTIONS = ["home", "goals", "staff", "mail", "schedule", "system"] as const;
```

`ui2/src/components/BottomTabs.tsx`:

```ts
const ICONS: Record<string, string> = { home: "◉", goals: "◎", staff: "▤", mail: "✉", schedule: "◷", system: "⚙" };
```

`ui2/src/App.tsx` — three edits:

```ts
const JUMPS: Record<string, string> = { h: "home", g: "goals", s: "staff", m: "mail", r: "schedule", y: "system" };
```

```ts
import { Schedule } from "./views/Schedule.js";
```

Mount between mail and system (Task 8 creates the file — a placeholder `export function Schedule() { return null; }` in `ui2/src/views/Schedule.tsx` keeps this task compiling if executed standalone):

```tsx
      <div className={show("schedule")}><Schedule /></div>
```

Also update the shell comment on line 1 (`5 sections` → `6 sections`) and the jump-keys comment (`g then h/g/s/m/y` → `g then h/g/s/m/r/y`).

`ui2/src/api.ts` — add to BOTH the `export type {...}` re-export and the `import type {...}` lists: `ScheduleView, RoutineView, AnchorView, ScheduleReminderView, Recurrence`. Then add to the `api` object:

```ts
  schedule: () => request<ScheduleView>("/api/schedule"),
  addRoutine: (r: { name: string; prompt: string; recurrence: Recurrence }) =>
    request<{ id: number }>("/api/routines", { method: "POST", body: JSON.stringify(r) }),
  updateRoutine: (id: number, patch: { name?: string; prompt?: string; recurrence?: Recurrence; enabled?: boolean }) =>
    request<{ ok: true }>(`/api/routines/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteRoutine: (id: number) => request<{ ok: true }>(`/api/routines/${id}`, { method: "DELETE" }),
  runRoutine: (id: number) => request<{ ok: true }>(`/api/routines/${id}/run`, { method: "POST" }),
  setAnchor: (name: string, hhmm: string) =>
    request<{ ok: true }>(`/api/anchors/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ hhmm }) }),
  cancelReminder: (id: number) => request<{ ok: true }>(`/api/reminders/${id}`, { method: "DELETE" }),
```

Create placeholder `ui2/src/views/Schedule.tsx` (replaced in Task 8):

```tsx
// ui2/src/views/Schedule.tsx — placeholder, implemented in the next task.
export function Schedule() {
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui2 && npx vitest run && npx tsc --noEmit`
Expected: router test green, no other suite broken, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add ui2/src/lib/router.ts ui2/src/components/BottomTabs.tsx ui2/src/App.tsx ui2/src/api.ts ui2/src/views/Schedule.tsx ui2/test/router.test.ts
git commit -m "feat(ui2): schedule section plumbing — route, tabs, jump key, api client"
```

---

### Task 8: Schedule view UI

**Files:**
- Modify (replace placeholder): `ui2/src/views/Schedule.tsx`
- Test: `ui2/test/schedule-render.test.tsx`

**Interfaces:**
- Consumes: `api.*` methods and types from Task 7; `useFetch` from `ui2/src/hooks.ts`; `SectionLabel`, `Empty`, `Button`, `Tag` from `ui2/src/components/ui.tsx`; `TwoStepButton` from `ui2/src/components/TwoStepButton.tsx` (props: `{ label, confirmLabel?, disabled?, onConfirm, className? }`).
- Produces: `export function Schedule()` — no props.

- [ ] **Step 1: Write the failing test**

Create `ui2/test/schedule-render.test.tsx`:

```tsx
// ui2/test/schedule-render.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Schedule } from "../src/views/Schedule.js";
import { stubApi } from "./stubs.js";

afterEach(cleanup);

const SCHEDULE = {
  anchors: [
    { name: "morning", hhmm: "07:30", overridden: false, firedToday: true },
    { name: "evening", hhmm: "21:00", overridden: true, firedToday: false },
  ],
  routines: [
    {
      id: 1, name: "weekly market scan", prompt: "run research playbook on X",
      recurrence: { kind: "weekly", dow: 1, hhmm: "09:00" }, enabled: true,
      lastFiredAt: null, nextFire: "2026-07-20 09:00",
    },
  ],
  reminders: [{ id: 5, text: "call accountant", dueAt: "2026-07-16T09:00:00.000Z", origin: "telegram:42" }],
};

describe("Schedule view", () => {
  it("renders all three groups", async () => {
    stubApi({ "/api/schedule": SCHEDULE });
    render(<Schedule />);
    expect(await screen.findByText("weekly market scan")).toBeTruthy();
    expect(screen.getByText("call accountant")).toBeTruthy();
    expect(screen.getByText("morning")).toBeTruthy();
    expect(screen.getByText("2026-07-20 09:00")).toBeTruthy();
  });

  it("creates a routine through the form", async () => {
    stubApi({ "/api/schedule": SCHEDULE, "/api/routines": { id: 2 } });
    render(<Schedule />);
    await screen.findByText("weekly market scan");
    fireEvent.change(screen.getByPlaceholderText("Routine name"), { target: { value: "daily digest" } });
    fireEvent.change(screen.getByPlaceholderText("Prompt — what should run"), { target: { value: "summarize inbox" } });
    fireEvent.click(screen.getByText("Create routine"));
    // POST accepted → form clears (input back to empty)
    expect(((await screen.findByPlaceholderText("Routine name")) as HTMLInputElement).value).toBe("");
  });

  it("run-now button exists per routine", async () => {
    stubApi({ "/api/schedule": SCHEDULE, "/api/routines/1/run": { ok: true } });
    render(<Schedule />);
    await screen.findByText("weekly market scan");
    expect(screen.getByText("Run now")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui2 && npx vitest run test/schedule-render.test.tsx`
Expected: FAIL — placeholder renders null, `findByText` times out.

- [ ] **Step 3: Implement `ui2/src/views/Schedule.tsx`**

```tsx
// ui2/src/views/Schedule.tsx — Scheduling & Routines: anchors, routines, reminders (spec 2026-07-15).
import { useState } from "react";
import { api } from "../api.js";
import type { Recurrence, RoutineView } from "../api.js";
import { useFetch } from "../hooks.js";
import { SectionLabel, Empty, Button, Tag } from "../components/ui.js";
import { TwoStepButton } from "../components/TwoStepButton.js";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function recurrenceLabel(r: Recurrence): string {
  switch (r.kind) {
    case "daily": return `daily ${r.hhmm}`;
    case "weekdays": return `weekdays ${r.hhmm}`;
    case "weekly": return `${DOW[r.dow]} ${r.hhmm}`;
    case "interval": return `every ${r.everyMinutes}m`;
  }
}

function AnchorRow({ name, hhmm, overridden, firedToday, onSave }: {
  name: string; hhmm: string; overridden: boolean; firedToday: boolean; onSave: (v: string) => void;
}) {
  const [value, setValue] = useState(hhmm);
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-line">
      <span className="w-24 text-bright">{name}</span>
      <input
        className="bg-transparent border border-line rounded px-1.5 py-0.5 w-20 text-bright"
        value={value}
        aria-label={`${name} time`}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => value !== hhmm && onSave(value)}
        onKeyDown={(e) => e.key === "Enter" && value !== hhmm && onSave(value)}
      />
      {overridden && <Tag tone="accent">override</Tag>}
      {firedToday && <Tag tone="ok">fired today</Tag>}
    </div>
  );
}

function RecurrenceInputs({ rec, setRec }: { rec: Recurrence; setRec: (r: Recurrence) => void }) {
  const timeInput = "hhmm" in rec && (
    <input className="bg-transparent border border-line rounded px-1.5 py-0.5 w-20" value={rec.hhmm}
      aria-label="time" onChange={(e) => setRec({ ...rec, hhmm: e.target.value })} />
  );
  return (
    <div className="flex items-center gap-2">
      <select
        className="bg-surface border border-line rounded px-1.5 py-0.5"
        value={rec.kind}
        aria-label="recurrence kind"
        onChange={(e) => {
          const kind = e.target.value as Recurrence["kind"];
          setRec(
            kind === "interval" ? { kind, everyMinutes: 60 }
            : kind === "weekly" ? { kind, dow: 1, hhmm: "09:00" }
            : { kind, hhmm: "09:00" },
          );
        }}
      >
        <option value="daily">daily</option>
        <option value="weekdays">weekdays</option>
        <option value="weekly">weekly</option>
        <option value="interval">interval</option>
      </select>
      {rec.kind === "weekly" && (
        <select className="bg-surface border border-line rounded px-1.5 py-0.5" value={rec.dow}
          aria-label="day of week" onChange={(e) => setRec({ ...rec, dow: Number(e.target.value) })}>
          {DOW.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
      )}
      {timeInput}
      {rec.kind === "interval" && (
        <span className="flex items-center gap-1">
          every
          <input className="bg-transparent border border-line rounded px-1.5 py-0.5 w-16" type="number" min={1}
            value={rec.everyMinutes} aria-label="minutes"
            onChange={(e) => setRec({ ...rec, everyMinutes: Number(e.target.value) })} />
          min
        </span>
      )}
    </div>
  );
}

function RoutineRowView({ r, onChanged }: { r: RoutineView; onChanged: () => void }) {
  const [err, setErr] = useState<string>();
  const act = (p: Promise<unknown>) => p.then(onChanged).catch((e) => setErr((e as Error).message));
  return (
    <div className="py-2 border-b border-line">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-bright">{r.name}</span>
        <Tag tone={r.enabled ? "ok" : "dim"}>{r.enabled ? "on" : "off"}</Tag>
        <Tag tone="dim">{recurrenceLabel(r.recurrence)}</Tag>
        {r.nextFire && <span className="text-dim text-xs">{r.nextFire}</span>}
        <span className="flex-1" />
        <Button onClick={() => act(api.runRoutine(r.id))}>Run now</Button>
        <Button onClick={() => act(api.updateRoutine(r.id, { enabled: !r.enabled }))}>
          {r.enabled ? "Disable" : "Enable"}
        </Button>
        <TwoStepButton label="Delete" onConfirm={() => act(api.deleteRoutine(r.id))} />
      </div>
      <div className="text-dim text-xs mt-1 truncate">{r.prompt}</div>
      {err && <div className="text-xs mt-1" style={{ color: "var(--err, #e5484d)" }}>{err}</div>}
    </div>
  );
}

function CreateRoutine({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [rec, setRec] = useState<Recurrence>({ kind: "daily", hhmm: "09:00" });
  const [err, setErr] = useState<string>();
  const submit = () => {
    api.addRoutine({ name, prompt, recurrence: rec })
      .then(() => { setName(""); setPrompt(""); setErr(undefined); onCreated(); })
      .catch((e) => setErr((e as Error).message));
  };
  return (
    <div className="flex flex-col gap-2 py-2">
      <input className="bg-transparent border border-line rounded px-2 py-1" placeholder="Routine name"
        value={name} onChange={(e) => setName(e.target.value)} />
      <textarea className="bg-transparent border border-line rounded px-2 py-1 min-h-16"
        placeholder="Prompt — what should run" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="flex items-center gap-3 flex-wrap">
        <RecurrenceInputs rec={rec} setRec={setRec} />
        <Button variant="primary" disabled={!name.trim() || !prompt.trim()} onClick={submit}>Create routine</Button>
      </div>
      {err && <div className="text-xs" style={{ color: "var(--err, #e5484d)" }}>{err}</div>}
    </div>
  );
}

export function Schedule() {
  const { data, error, reload } = useFetch(() => api.schedule(), []);
  const [anchorErr, setAnchorErr] = useState<string>();
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Empty>Loading…</Empty>;
  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 max-w-3xl w-full mx-auto">
      <SectionLabel>Anchors</SectionLabel>
      {data.anchors.map((a) => (
        <AnchorRow key={a.name} {...a}
          onSave={(hhmm) => api.setAnchor(a.name, hhmm).then(reload).catch((e) => setAnchorErr((e as Error).message))} />
      ))}
      {anchorErr && <div className="text-xs mt-1" style={{ color: "var(--err, #e5484d)" }}>{anchorErr}</div>}

      <div className="mt-6"><SectionLabel>Routines</SectionLabel></div>
      {data.routines.length === 0 && <Empty>No routines yet.</Empty>}
      {data.routines.map((r) => <RoutineRowView key={r.id} r={r} onChanged={reload} />)}
      <CreateRoutine onCreated={reload} />

      <div className="mt-6"><SectionLabel>Reminders</SectionLabel></div>
      {data.reminders.length === 0 && <Empty>No pending reminders.</Empty>}
      {data.reminders.map((rem) => (
        <div key={rem.id} className="flex items-center gap-3 py-1.5 border-b border-line">
          <span className="text-bright flex-1">{rem.text}</span>
          <span className="text-dim text-xs">{rem.dueAt}</span>
          <span className="text-dim text-xs">{rem.origin}</span>
          <TwoStepButton label="Cancel" onConfirm={() => api.cancelReminder(rem.id).then(reload).catch(() => {})} />
        </div>
      ))}
    </div>
  );
}
```

`Button` variants are `"primary" | "ghost" | "danger"` (`ui2/src/components/ui.tsx:5`). Visual polish follows existing views (`Staff.tsx` is the closest reference).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui2 && npx vitest run test/schedule-render.test.tsx && npx tsc --noEmit`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add ui2/src/views/Schedule.tsx ui2/test/schedule-render.test.tsx
git commit -m "feat(ui2): Schedule view — anchors editable, routine CRUD + run-now, reminder cancel"
```

---

### Task 9: Full verification

**Files:** none new.

- [ ] **Step 1: Full daemon suite**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 2: Full ui2 suite + typechecks**

Run: `cd ui2 && npx vitest run && npx tsc --noEmit && cd .. && npx tsc --noEmit`
Expected: all green, both typechecks clean.

- [ ] **Step 3: Smoke the running daemon (if the user's daemon is running)**

```bash
curl -s -H "Authorization: Bearer $AIOS_UI_TOKEN" http://localhost:PORT/api/schedule | head -c 400
```

Expected: JSON with `anchors` (5 entries), `routines: []`, `reminders`. (Port/token from the user's env — skip if not running; the vitest suites are the gate.)

- [ ] **Step 4: Final commit if anything was fixed**

```bash
git status --short
```

Expected: clean tree (all work committed per-task).
