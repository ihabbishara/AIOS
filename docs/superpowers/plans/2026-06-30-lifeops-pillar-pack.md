# Lifeops Pillar Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a private personal task/errand manager as the 4th pillar pack — a new `jasmine` role over a `personal_tasks` table, surfaced by a morning-brief section and intra-day overdue/due-soon/stale nudges.

**Architecture:** Mirror the money pack exactly: a greenfield SQLite table + Store accessors, pure ops, an ungated direct-CRUD MCP tool server, a `privateOnly` role, a pack manifest, a `startWatcher` that pushes transport-only to the primary chat, and a morning-brief section. No new security surface — reuses the cfo privacy guard, the money-signals watcher shape, and the dream/speculate brief-section pattern.

**Tech Stack:** TypeScript, Node 23 `node:sqlite`, Claude Agent SDK (`tool`/`createSdkMcpServer`), zod, vitest.

## Global Constraints

- **Subscription auth only** — never read or require `ANTHROPIC_API_KEY`; the daemon runs on `CLAUDE_CODE_OAUTH_TOKEN`. No code path may add an API-key dependency.
- **`node:sqlite`, no FTS5** — plain tables + prepared statements; no `better-sqlite3`, no virtual tables.
- **Greenfield table only** — `CREATE TABLE IF NOT EXISTS`; **no migration** of existing rows.
- **Privacy parity with money (load-bearing):** `personal_tasks` is never indexed into recall; the pack has `actions: []` (no gate, no outward effect); the role is `privateOnly`; the watcher push is transport-only (no vault write, no `bus.emit`, no agent turn).
- **money / code / research manifests stay byte-unchanged.**
- **TDD, frequent commits.** Each task: failing test → run-fail → minimal impl → run-pass → commit. Run a single test file with `npx vitest run <path>`; full build with `npm run build` (tsc).
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

| file | responsibility |
|---|---|
| `src/store/db.ts` (modify) | `personal_tasks` table + `PersonalTaskRow` + 6 accessors |
| `src/lifeops/ops.ts` (create) | pure `openLoopsForBrief`, `computeLifeopsSignals` + their types |
| `src/lifeops/server.ts` (create) | `buildLifeopsServer` — 5 direct-CRUD tools |
| `src/agents/roles/index.ts` (modify) | `jasmine` RoleDef (`privateOnly`) |
| `playbooks/lifeops/pack.yaml` (create) | pack manifest |
| `src/config.ts` (modify) | 3 env knobs |
| `src/index.ts` (modify) | register `lifeops` toolServer + `startWatcher("lifeops")` |
| `src/heartbeat/briefs.ts` (modify) | `openLoops` in `BriefData` + assemble + isEmpty + render section |
| `test/lifeops-*.test.ts` (create) | per-unit tests + privacy pins |

---

## Task 1: `personal_tasks` table + Store accessors

**Files:**
- Modify: `src/store/db.ts` (table block near the other `CREATE TABLE IF NOT EXISTS` ~line 279; `PersonalTaskRow` interface near `ResearchSourceRow` ~line 106; accessors near `addResearchSource` ~line 843)
- Test: `test/lifeops-store.test.ts`

**Interfaces:**
- Produces:
  - `interface PersonalTaskRow { id: number; title: string; status: "open"|"waiting"|"done"|"dismissed"; project: string|null; due_date: string|null; next_action: string|null; notes: string|null; created_at: string; updated_at: string }`
  - `addTask(t: { title: string; status?: PersonalTaskRow["status"]; project?: string|null; due_date?: string|null; next_action?: string|null; notes?: string|null }): number`
  - `listTasks(status?: PersonalTaskRow["status"], project?: string): PersonalTaskRow[]`
  - `getTask(id: number): PersonalTaskRow | undefined`
  - `updateTask(id: number, fields: Partial<Pick<PersonalTaskRow,"title"|"status"|"project"|"due_date"|"next_action"|"notes">>): void`
  - `completeTask(id: number): void` / `dismissTask(id: number): void`

- [ ] **Step 1: Write the failing test**

Create `test/lifeops-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/db.js";

function freshStore(): Store {
  return new Store(":memory:"); // mirror money-store.test.ts construction
}

describe("personal_tasks store", () => {
  let store: Store;
  beforeEach(() => { store = freshStore(); });

  it("adds a task with defaults and lists it", () => {
    const id = store.addTask({ title: "Renew passport" });
    const rows = store.listTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].title).toBe("Renew passport");
    expect(rows[0].status).toBe("open");
    expect(rows[0].due_date).toBeNull();
  });

  it("filters by status and project", () => {
    store.addTask({ title: "a", project: "home" });
    const w = store.addTask({ title: "b", status: "waiting", project: "work" });
    expect(store.listTasks("waiting").map((t) => t.id)).toEqual([w]);
    expect(store.listTasks(undefined, "home").map((t) => t.title)).toEqual(["a"]);
  });

  it("updateTask changes fields and bumps updated_at", async () => {
    const id = store.addTask({ title: "x" });
    const before = store.getTask(id)!.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    store.updateTask(id, { next_action: "call office", due_date: "2026-07-01" });
    const after = store.getTask(id)!;
    expect(after.next_action).toBe("call office");
    expect(after.due_date).toBe("2026-07-01");
    expect(after.updated_at >= before).toBe(true);
  });

  it("complete/dismiss set terminal status", () => {
    const a = store.addTask({ title: "a" });
    const b = store.addTask({ title: "b" });
    store.completeTask(a);
    store.dismissTask(b);
    expect(store.getTask(a)!.status).toBe("done");
    expect(store.getTask(b)!.status).toBe("dismissed");
    expect(store.listTasks("open")).toHaveLength(0);
  });
});
```

> Note: check how `money-store.test.ts` constructs its `Store` (in-memory path vs temp file) and match it exactly; adjust `freshStore()` if the constructor signature differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lifeops-store.test.ts`
Expected: FAIL — `store.addTask is not a function`.

- [ ] **Step 3: Add the table**

In `src/store/db.ts`, alongside the other `CREATE TABLE IF NOT EXISTS` statements (~line 279):

```ts
      CREATE TABLE IF NOT EXISTS personal_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        project TEXT,
        due_date TEXT,
        next_action TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_personal_tasks_status_due ON personal_tasks(status, due_date);
```

- [ ] **Step 4: Add the row type + accessors**

`PersonalTaskRow` near `ResearchSourceRow` (~line 106):

```ts
export interface PersonalTaskRow {
  id: number;
  title: string;
  status: "open" | "waiting" | "done" | "dismissed";
  project: string | null;
  due_date: string | null;
  next_action: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
```

Accessors near `addResearchSource` (~line 843):

```ts
  addTask(t: {
    title: string; status?: PersonalTaskRow["status"]; project?: string | null;
    due_date?: string | null; next_action?: string | null; notes?: string | null;
  }): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO personal_tasks (title, status, project, due_date, next_action, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.title, t.status ?? "open", t.project ?? null, t.due_date ?? null,
           t.next_action ?? null, t.notes ?? null, now, now);
    return Number(info.lastInsertRowid);
  }

  listTasks(status?: PersonalTaskRow["status"], project?: string): PersonalTaskRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (status) { where.push("status = ?"); args.push(status); }
    if (project) { where.push("project = ?"); args.push(project); }
    const sql = `SELECT * FROM personal_tasks${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY (due_date IS NULL), due_date ASC, id ASC`;
    return this.db.prepare(sql).all(...args) as unknown as PersonalTaskRow[];
  }

  getTask(id: number): PersonalTaskRow | undefined {
    return this.db.prepare("SELECT * FROM personal_tasks WHERE id = ?").get(id) as unknown as PersonalTaskRow | undefined;
  }

  updateTask(id: number, fields: Partial<Pick<PersonalTaskRow,
    "title" | "status" | "project" | "due_date" | "next_action" | "notes">>): void {
    const cols = Object.keys(fields);
    if (!cols.length) return;
    const set = cols.map((c) => `${c} = ?`).join(", ");
    const args = cols.map((c) => (fields as Record<string, unknown>)[c]);
    this.db.prepare(`UPDATE personal_tasks SET ${set}, updated_at = ? WHERE id = ?`)
      .run(...args, new Date().toISOString(), id);
  }

  completeTask(id: number): void { this.updateTask(id, { status: "done" }); }
  dismissTask(id: number): void { this.updateTask(id, { status: "dismissed" }); }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/lifeops-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/store/db.ts test/lifeops-store.test.ts
git commit -m "feat(lifeops): personal_tasks table + Store accessors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Pure ops — open loops + signals

**Files:**
- Create: `src/lifeops/ops.ts`
- Test: `test/lifeops-ops.test.ts`

**Interfaces:**
- Consumes: `PersonalTaskRow` (Task 1).
- Produces:
  - `interface OpenLoops { overdue: Array<{ title: string; due_date: string }>; dueToday: string[]; openCount: number }`
  - `interface LifeopsSignal { key: string; text: string }`
  - `interface LifeopsSignalConfig { lifeopsSoonDays: number; lifeopsStaleDays: number }`
  - `openLoopsForBrief(openTasks: PersonalTaskRow[], today: string): OpenLoops`
  - `computeLifeopsSignals(openTasks: PersonalTaskRow[], now: Date, cfg: LifeopsSignalConfig): LifeopsSignal[]`

> Both functions take **already-fetched `status==='open'` rows** (the caller passes `store.listTasks("open")`). They never touch the DB.

- [ ] **Step 1: Write the failing test**

Create `test/lifeops-ops.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openLoopsForBrief, computeLifeopsSignals } from "../src/lifeops/ops.js";
import type { PersonalTaskRow } from "../src/store/db.js";

function task(p: Partial<PersonalTaskRow>): PersonalTaskRow {
  return {
    id: 1, title: "t", status: "open", project: null, due_date: null,
    next_action: null, notes: null, created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z", ...p,
  };
}

describe("openLoopsForBrief", () => {
  it("partitions overdue vs due-today and counts", () => {
    const rows = [
      task({ id: 1, title: "late", due_date: "2026-06-28" }),
      task({ id: 2, title: "today", due_date: "2026-06-30" }),
      task({ id: 3, title: "future", due_date: "2026-07-05" }),
      task({ id: 4, title: "someday", due_date: null }),
    ];
    const ol = openLoopsForBrief(rows, "2026-06-30");
    expect(ol.overdue).toEqual([{ title: "late", due_date: "2026-06-28" }]);
    expect(ol.dueToday).toEqual(["today"]);
    expect(ol.openCount).toBe(4);
  });
});

describe("computeLifeopsSignals", () => {
  const cfg = { lifeopsSoonDays: 2, lifeopsStaleDays: 14 };
  const now = new Date("2026-06-30T09:00:00.000Z"); // today = 2026-06-30

  it("flags overdue with a today-keyed kv key", () => {
    const sigs = computeLifeopsSignals([task({ id: 7, title: "tax", due_date: "2026-06-25" })], now, cfg);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].key).toBe("lifeops:overdue:7:2026-06-30");
    expect(sigs[0].text).toContain("tax");
  });

  it("flags due-soon within the horizon, keyed by due_date", () => {
    const sigs = computeLifeopsSignals([task({ id: 8, title: "dentist", due_date: "2026-07-01" })], now, cfg);
    expect(sigs[0].key).toBe("lifeops:soon:8:2026-07-01");
  });

  it("does not flag a far-future task", () => {
    expect(computeLifeopsSignals([task({ id: 9, due_date: "2026-07-20" })], now, cfg)).toEqual([]);
  });

  it("flags stale (no due date, untouched > staleDays)", () => {
    const old = task({ id: 5, title: "reorg garage", due_date: null, updated_at: "2026-06-10T00:00:00.000Z" });
    const fresh = task({ id: 6, title: "new", due_date: null, updated_at: "2026-06-29T00:00:00.000Z" });
    const sigs = computeLifeopsSignals([old, fresh], now, cfg);
    expect(sigs.map((s) => s.key)).toEqual(["lifeops:stale:5:2026-06-30"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lifeops-ops.test.ts`
Expected: FAIL — cannot find module `../src/lifeops/ops.js`.

- [ ] **Step 3: Write the implementation**

Create `src/lifeops/ops.ts`:

```ts
import type { PersonalTaskRow } from "../store/db.js";

const DAY = 24 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface OpenLoops {
  overdue: Array<{ title: string; due_date: string }>;
  dueToday: string[];
  openCount: number;
}

export interface LifeopsSignal { key: string; text: string }
export interface LifeopsSignalConfig { lifeopsSoonDays: number; lifeopsStaleDays: number }

/** Partition already-fetched open tasks for the morning brief. `today` is YYYY-MM-DD. */
export function openLoopsForBrief(openTasks: PersonalTaskRow[], today: string): OpenLoops {
  const overdue = openTasks
    .filter((t) => t.due_date && t.due_date < today)
    .map((t) => ({ title: t.title, due_date: t.due_date! }));
  const dueToday = openTasks.filter((t) => t.due_date === today).map((t) => t.title);
  return { overdue, dueToday, openCount: openTasks.length };
}

/**
 * Proactive nudges over already-fetched open tasks. Each signal's `key` embeds a date so a task
 * fires once per transition (per-day for overdue/stale, per-due-date for soon). The caller checks
 * each key against kv, sends `text` to the private chat, then stamps the key.
 */
export function computeLifeopsSignals(
  openTasks: PersonalTaskRow[], now: Date, cfg: LifeopsSignalConfig,
): LifeopsSignal[] {
  const today = iso(now);
  const soonMax = iso(new Date(now.getTime() + cfg.lifeopsSoonDays * DAY));
  const out: LifeopsSignal[] = [];
  for (const t of openTasks) {
    if (t.due_date && t.due_date < today) {
      out.push({
        key: `lifeops:overdue:${t.id}:${today}`,
        text: `Overdue: "${t.title}"${t.next_action ? ` — next: ${t.next_action}` : ""} (was due ${t.due_date}).`,
      });
    } else if (t.due_date && t.due_date >= today && t.due_date <= soonMax) {
      out.push({ key: `lifeops:soon:${t.id}:${t.due_date}`, text: `Due ${t.due_date}: "${t.title}".` });
    } else if (!t.due_date && Date.parse(t.updated_at) < now.getTime() - cfg.lifeopsStaleDays * DAY) {
      out.push({
        key: `lifeops:stale:${t.id}:${today}`,
        text: `Stale open loop (${cfg.lifeopsStaleDays}d untouched): "${t.title}".`,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lifeops-ops.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lifeops/ops.ts test/lifeops-ops.test.ts
git commit -m "feat(lifeops): pure open-loop + nudge-signal ops

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `lifeops` MCP tool server

**Files:**
- Create: `src/lifeops/server.ts`
- Test: `test/lifeops-server.test.ts`

**Interfaces:**
- Consumes: `Store` task accessors (Task 1).
- Produces: `buildLifeopsServer(deps: { store: Store })` → SDK MCP server named `"lifeops"` with tools `add_task`, `list_tasks`, `update_task`, `complete_task`, `dismiss_task`. (Ungated; mirrors `buildResearchServer`/`buildMoneyServer`. `vault_read` is NOT here — it comes from the framework's scoped `aios-pack` server via the manifest.)

- [ ] **Step 1: Write the failing test**

Create `test/lifeops-server.test.ts` (mirrors `research-server.test.ts` — drives the registered handler directly):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/db.js";
import { buildLifeopsServer } from "../src/lifeops/server.js";

// Mirror research-server.test.ts: pull handlers off the built server's _registeredTools.
function handlers(store: Store) {
  const server = buildLifeopsServer({ store }) as unknown as {
    instance: { _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }> };
  };
  return server.instance._registeredTools;
}
const callText = async (h: { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }, a: unknown) =>
  (await h.handler(a)).content[0].text;

describe("lifeops MCP server", () => {
  let store: Store;
  let t: ReturnType<typeof handlers>;
  beforeEach(() => { store = new Store(":memory:"); t = handlers(store); });

  it("add_task → list_tasks round-trip", async () => {
    await callText(t.add_task, { title: "Book MOT", due_date: "2026-07-02" });
    const out = await callText(t.list_tasks, {});
    expect(out).toContain("Book MOT");
    expect(store.listTasks()).toHaveLength(1);
  });

  it("update_task edits fields", async () => {
    await callText(t.add_task, { title: "x" });
    const id = store.listTasks()[0].id;
    await callText(t.update_task, { id, next_action: "ring garage" });
    expect(store.getTask(id)!.next_action).toBe("ring garage");
  });

  it("complete_task / dismiss_task set status", async () => {
    await callText(t.add_task, { title: "a" });
    await callText(t.add_task, { title: "b" });
    const [a, b] = store.listTasks().map((r) => r.id);
    await callText(t.complete_task, { id: a });
    await callText(t.dismiss_task, { id: b });
    expect(store.listTasks("open")).toHaveLength(0);
  });
});
```

> Confirm the `_registeredTools` access path matches `research-server.test.ts` in this repo; copy its exact accessor if it differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lifeops-server.test.ts`
Expected: FAIL — cannot find module `../src/lifeops/server.js`.

- [ ] **Step 3: Write the implementation**

Create `src/lifeops/server.ts`:

```ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store, PersonalTaskRow } from "../store/db.js";

function text(s: string) { return { content: [{ type: "text" as const, text: s }] }; }

function fmt(rows: PersonalTaskRow[]): string {
  return rows.map((r) =>
    `  #${r.id} [${r.status}] ${r.title}` +
    `${r.due_date ? ` (due ${r.due_date})` : ""}` +
    `${r.project ? ` {${r.project}}` : ""}` +
    `${r.next_action ? `\n    next: ${r.next_action}` : ""}`,
  ).join("\n") || "(no tasks)";
}

export interface LifeopsServerDeps { store: Store; }

/** Direct-CRUD MCP server for the private task list. No gate, no outward effects. */
export function buildLifeopsServer(deps: LifeopsServerDeps) {
  const { store } = deps;

  const addTask = tool(
    "add_task", "Add an open loop / errand / follow-up to the private task list.",
    {
      title: z.string(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      project: z.string().optional(),
      next_action: z.string().optional(),
      notes: z.string().optional(),
    },
    async (a) => {
      const id = store.addTask({
        title: a.title, due_date: a.due_date ?? null, project: a.project ?? null,
        next_action: a.next_action ?? null, notes: a.notes ?? null,
      });
      return text(`Added task #${id}: ${a.title}.`);
    },
  );

  const listTasks = tool(
    "list_tasks", "List tasks, optionally filtered by status (open/waiting/done/dismissed) and/or project.",
    { status: z.enum(["open", "waiting", "done", "dismissed"]).optional(), project: z.string().optional() },
    async (a) => text(fmt(store.listTasks(a.status, a.project))),
  );

  const updateTask = tool(
    "update_task", "Update fields of a task by id (any subset).",
    {
      id: z.number().int(),
      title: z.string().optional(),
      status: z.enum(["open", "waiting", "done", "dismissed"]).optional(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      project: z.string().nullable().optional(),
      next_action: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    },
    async (a) => {
      const { id, ...fields } = a;
      store.updateTask(id, fields);
      return text(`Task #${id} updated.`);
    },
  );

  const completeTask = tool("complete_task", "Mark a task done by id.", { id: z.number().int() },
    async (a) => { store.completeTask(a.id); return text(`Task #${a.id} done.`); });
  const dismissTask = tool("dismiss_task", "Dismiss a task (no longer relevant) by id.", { id: z.number().int() },
    async (a) => { store.dismissTask(a.id); return text(`Task #${a.id} dismissed.`); });

  return createSdkMcpServer({
    name: "lifeops", version: "0.1.0",
    tools: [addTask, listTasks, updateTask, completeTask, dismissTask],
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lifeops-server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lifeops/server.ts test/lifeops-server.test.ts
git commit -m "feat(lifeops): direct-CRUD MCP tool server (5 task tools)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `jasmine` role + pack manifest

**Files:**
- Modify: `src/agents/roles/index.ts` (add `jasmine` to the `roles` record, next to `cfo`)
- Create: `playbooks/lifeops/pack.yaml`
- Test: `test/lifeops-role.test.ts`

**Interfaces:**
- Consumes: `RoleDef` (existing), the `lifeops` tool ids (Task 3).
- Produces: `roles.jasmine` (a `privateOnly` RoleDef) and a loadable lifeops pack manifest binding `jasmine` → pillar `lifeops`.

- [ ] **Step 1: Write the failing test**

Create `test/lifeops-role.test.ts` (mirrors `cfo-role.test.ts` + `research-analyst-role.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { roles } from "../src/agents/roles/index.js";
import { loadPacks } from "../src/packs/loader.js";

describe("jasmine role", () => {
  it("exists, is privateOnly, and carries no write tools", () => {
    const j = roles.jasmine;
    expect(j).toBeDefined();
    expect(j.privateOnly).toBe(true);
    expect(j.permissionMode).toBe("dontAsk");
    // no Bash/Edit/Write on the base role (pack manifest replaces allowedTools at resolve time)
    expect(j.allowedTools).not.toContain("Bash");
    expect(j.allowedTools).not.toContain("Edit");
    expect(j.allowedTools).not.toContain("Write");
  });
});

describe("lifeops pack manifest", () => {
  it("loads, binds jasmine solo to lifeops, actions empty, not sandboxed", () => {
    const { packs, roleOf } = loadPacks("playbooks");
    const lifeops = packs.get("lifeops");
    expect(lifeops).toBeDefined();
    expect(lifeops!.actions).toEqual([]);
    expect(lifeops!.sandbox ?? false).toBe(false);
    expect(lifeops!.toolServer).toBe("lifeops");
    expect(roleOf("jasmine")).toBe("lifeops");
  });
});
```

> Match `loadPacks` arg + the `packs`/`roleOf` accessor shape to `research-pack.test.ts` / `pack-loader.test.ts`; adjust if `loadPacks` returns a plain object instead of a `Map`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lifeops-role.test.ts`
Expected: FAIL — `roles.jasmine` is undefined.

- [ ] **Step 3: Add the `jasmine` RoleDef**

In `src/agents/roles/index.ts`, add to the `roles` record (next to `cfo`):

```ts
  jasmine: {
    name: "jasmine",
    description: "Private personal operations aide — your task list, errands, and follow-ups.",
    systemPrompt:
      "You are Jasmine, the user's personal operations aide. You track their open loops — errands, " +
      "follow-ups, deadlines — in a private task list (via the lifeops tools). Always surface the " +
      "concrete next action. Personal-life topics are private: discuss them ONLY with the user in " +
      "private; if addressed from a shared/group context, refuse and say it's private. Use add_task " +
      "when the user mentions something they need to do, update_task/complete_task/dismiss_task as " +
      "things move, and list_tasks to review. Be concise and concrete.",
    allowedTools: [],
    permissionMode: "dontAsk",
    privateOnly: true,
    maxTurns: 20,
  },
```

- [ ] **Step 4: Create the pack manifest**

Create `playbooks/lifeops/pack.yaml`:

```yaml
pillar: lifeops
persona: |
  You are Jasmine, the user's personal operations aide. You track their open loops — errands,
  follow-ups, deadlines — in their private task list. Always surface the concrete next action.
  Personal-life topics are private — refuse in any shared context. Be concise.
memoDomain: lifeops
toolServer: lifeops
roles: [jasmine]
actions: []
tools:
  - mcp__lifeops__add_task
  - mcp__lifeops__list_tasks
  - mcp__lifeops__update_task
  - mcp__lifeops__complete_task
  - mcp__lifeops__dismiss_task
  - vault_read
playbooks: []
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/lifeops-role.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Guard against regressions in existing pack tests**

Some tests assert the full pillar/role set (e.g. `pack-loader.test.ts`, `pack-regression.test.ts`). Run them:

Run: `npx vitest run test/pack-loader.test.ts test/pack-regression.test.ts test/pack-killswitch.test.ts`
Expected: PASS — if any asserts an exact pillar list (e.g. `["code","money","research"]`) or role-binding set, update it to include `lifeops`/`jasmine`. Make only that additive edit; do not change money/code/research assertions otherwise.

- [ ] **Step 7: Commit**

```bash
git add src/agents/roles/index.ts playbooks/lifeops/pack.yaml test/lifeops-role.test.ts test/pack-loader.test.ts test/pack-regression.test.ts test/pack-killswitch.test.ts
git commit -m "feat(lifeops): jasmine privateOnly role + pack manifest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Config knobs + index wiring (toolServer + watcher)

**Files:**
- Modify: `src/config.ts` (type fields ~line 95; values ~line 232)
- Modify: `src/index.ts` (imports; `toolServers` registry ~line 169; watcher block inside `if (config.primaryChat)` ~line 519)
- Test: `test/config.test.ts` (extend)

**Interfaces:**
- Consumes: `buildLifeopsServer` (Task 3), `computeLifeopsSignals` (Task 2), the `startWatcher`/`sendVia` locals already in `index.ts`.
- Produces: `config.lifeopsPollSeconds`, `config.lifeopsSoonDays`, `config.lifeopsStaleDays`; a registered `lifeops` tool server; a live `lifeops` watcher. The `config` object structurally satisfies `LifeopsSignalConfig`.

- [ ] **Step 1: Write the failing test**

In `test/config.test.ts`, add (match the existing assertion style in that file):

```ts
it("defaults the lifeops knobs", () => {
  delete process.env.AIOS_LIFEOPS_POLL_SECONDS;
  delete process.env.AIOS_LIFEOPS_SOON_DAYS;
  delete process.env.AIOS_LIFEOPS_STALE_DAYS;
  const c = loadConfig(); // use the same loader the other cases in this file use
  expect(c.lifeopsPollSeconds).toBe(21600);
  expect(c.lifeopsSoonDays).toBe(2);
  expect(c.lifeopsStaleDays).toBe(14);
});
```

> Use whatever config entry point the existing tests call (e.g. `loadConfig()` / `buildConfig()`); copy their import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `c.lifeopsPollSeconds` is `undefined`.

- [ ] **Step 3: Add the config fields + defaults**

In `src/config.ts`, in the `Config` interface near the money knobs (~line 95):

```ts
  lifeopsPollSeconds: number;
  lifeopsSoonDays: number;
  lifeopsStaleDays: number;
```

In the object literal near the money values (~line 232):

```ts
    lifeopsPollSeconds: Number(process.env.AIOS_LIFEOPS_POLL_SECONDS ?? 21600),
    lifeopsSoonDays: Number(process.env.AIOS_LIFEOPS_SOON_DAYS ?? 2),
    lifeopsStaleDays: Number(process.env.AIOS_LIFEOPS_STALE_DAYS ?? 14),
```

- [ ] **Step 4: Run config test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the tool server**

In `src/index.ts`, add the imports near the money imports (~lines 44/46):

```ts
import { buildLifeopsServer } from "./lifeops/server.js";
import { computeLifeopsSignals } from "./lifeops/ops.js";
```

Extend the `toolServers` registry (~line 169) — keep money/research entries unchanged:

```ts
    { store, vault, gate, toolServers: {
      money: (d) => buildMoneyServer({ store: d.store, categorize }),
      research: (d) => buildResearchServer({ store: d.store }),
      lifeops: (d) => buildLifeopsServer({ store: d.store }),
    } },
```

- [ ] **Step 6: Add the watcher**

In `src/index.ts`, inside the `if (config.primaryChat) { … }` block, right after the `startWatcher("money", …)` push (~line 528):

```ts
    stops.push(startWatcher("lifeops", config.lifeopsPollSeconds * 1000, async () => {
      const signals = computeLifeopsSignals(store.listTasks("open"), new Date(), config);
      for (const sig of signals) {
        if (store.kvGet(sig.key)) continue;               // fire once
        await sendVia(config.primaryChat!.channel, config.primaryChat!.chatId, sig.text);
        store.kvSet(sig.key, new Date().toISOString());   // stamp AFTER send
      }
    }, () => {}, () => {}));
```

- [ ] **Step 7: Build to verify wiring compiles**

Run: `npm run build`
Expected: tsc exits clean (no output). The `AIOS_LIFEOPS_DISABLED` kill-switch needs no new code — the generic `AIOS_<PILLAR>_DISABLED` boot loop (index.ts ~line 75) + `dropPack` already cover it.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/index.ts test/config.test.ts
git commit -m "feat(lifeops): config knobs + register toolServer + nudge watcher

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Morning-brief "Open loops" section

**Files:**
- Modify: `src/heartbeat/briefs.ts` (`BriefData` ~line 7; `assembleBrief` morning block ~line 150; `isEmptyBrief` ~line 180; `renderBriefNote` ~line 222)
- Test: `test/lifeops-brief.test.ts` (mirrors `dream-brief.test.ts`)

**Interfaces:**
- Consumes: `openLoopsForBrief` + `OpenLoops` (Task 2), `store.listTasks` (Task 1).
- Produces: `BriefData.openLoops?: OpenLoops`, rendered "Open loops" section, emptiness keyed on overdue+due-today.

- [ ] **Step 1: Write the failing test**

Create `test/lifeops-brief.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { assembleBrief, isEmptyBrief, renderBriefNote } from "../src/heartbeat/briefs.js";

const NOW = "2026-06-30T07:30:00.000Z"; // local date 2026-06-30 (UTC test env)

describe("brief Open loops section", () => {
  it("morning brief surfaces overdue + due-today; section renders; not empty", () => {
    const store = new Store(":memory:");
    store.addTask({ title: "tax return", due_date: "2026-06-20" }); // overdue
    store.addTask({ title: "call dentist", due_date: "2026-06-30" }); // today
    store.addTask({ title: "someday", due_date: null });             // open, not actionable
    const data = assembleBrief(store, "morning", NOW, null);
    expect(data.openLoops!.overdue).toEqual([{ title: "tax return", due_date: "2026-06-20" }]);
    expect(data.openLoops!.dueToday).toEqual(["call dentist"]);
    expect(data.openLoops!.openCount).toBe(3);
    expect(isEmptyBrief(data)).toBe(false);
    const note = renderBriefNote(data, "narration");
    expect(note).toContain("## Open loops");
    expect(note).toContain("tax return");
    expect(note).toContain("3 open loops total");
  });

  it("evening brief omits open loops", () => {
    const store = new Store(":memory:");
    store.addTask({ title: "x", due_date: "2026-06-20" });
    const data = assembleBrief(store, "evening", NOW, null);
    expect(data.openLoops).toBeUndefined();
  });

  it("only someday tasks (no overdue/due-today) → empty brief", () => {
    const store = new Store(":memory:");
    store.addTask({ title: "someday", due_date: null });
    const data = assembleBrief(store, "morning", NOW, null);
    expect(isEmptyBrief(data)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lifeops-brief.test.ts`
Expected: FAIL — `data.openLoops` is `undefined`.

- [ ] **Step 3: Add the `BriefData` field + import**

At the top of `src/heartbeat/briefs.ts`:

```ts
import { openLoopsForBrief, type OpenLoops } from "../lifeops/ops.js";
```

In `interface BriefData`, after `emailDraftsPending?`:

```ts
  /** Private task list — morning brief only; overdue + due-today + open count. */
  openLoops?: OpenLoops;
```

- [ ] **Step 4: Fill it in `assembleBrief` (morning-only)**

After the `emailDraftsPending` block (~line 153), before the `return {`:

```ts
  let openLoops: BriefData["openLoops"];
  if (anchor === "morning") {
    const ol = openLoopsForBrief(store.listTasks("open"), localDateOf(nowIso));
    if (ol.openCount) openLoops = ol;
  }
```

Add `openLoops,` to the returned object (next to `emailDraftsPending,`).

- [ ] **Step 5: Count it in `isEmptyBrief`**

Emptiness keys on *actionable* loops (overdue + due-today), so a someday-pile doesn't force a daily brief. Add before the closing `)`:

```ts
    && ((d.openLoops?.overdue.length ?? 0) + (d.openLoops?.dueToday.length ?? 0)) === 0
```

- [ ] **Step 6: Render the section**

In `renderBriefNote`, after the `section("Speculate — email drafts", …)` call:

```ts
  {
    const ol = d.openLoops;
    const rows = [
      ...(ol?.overdue ?? []).map((t) => `⚠ overdue: ${t.title} (was due ${t.due_date})`),
      ...(ol?.dueToday ?? []).map((t) => `due today: ${t}`),
    ];
    if (rows.length) rows.push(`${ol!.openCount} open loops total`);
    section("Open loops", rows);
  }
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/lifeops-brief.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add src/heartbeat/briefs.ts test/lifeops-brief.test.ts
git commit -m "feat(lifeops): morning-brief Open loops section

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Privacy invariants + full verification

**Files:**
- Test: `test/lifeops-privacy.test.ts` (create — mirrors `bunq-recall-exclusion.test.ts` + `cfo-role.test.ts`'s refusal test)

**Interfaces:**
- Consumes: everything prior.
- Produces: pinned regression guards for the two load-bearing walls (recall-exclusion, private-reach).

- [ ] **Step 1: Write the privacy test**

Create `test/lifeops-privacy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { recall } from "../src/memory/recall.js"; // match recall.test.ts import + signature

describe("lifeops privacy: tasks never enter recall", () => {
  it("a task title is not retrievable via recall", () => {
    const store = new Store(":memory:");
    store.addTask({ title: "Schedule colonoscopy", notes: "private medical errand" });
    // The indexer never reads personal_* tables, so nothing was indexed.
    const hits = recall(store, "colonoscopy"); // adapt to recall()'s real (store, query, domain?) signature
    expect(hits).toEqual([]);
  });
});
```

> Open `test/recall.test.ts` first and copy the exact `recall` import path and call signature (it may be `recall(store, query)` or `recall(store, query, domain)`). The assertion is just "no hit for a string only present in `personal_tasks`."

For the private-reach guard, add a case mirroring `cfo-role.test.ts`'s "refused from a non-private origin" test, swapping the target role to `jasmine`. Copy that test's harness verbatim (it constructs `DirectChats` with `primaryChat` set and asserts a non-primary origin is refused); only change the role name and the expected refusal applies.

- [ ] **Step 2: Run it to verify it passes (guards an already-correct property)**

Run: `npx vitest run test/lifeops-privacy.test.ts`
Expected: PASS. If recall returns a hit, STOP — the indexer is reading `personal_*` somewhere and the privacy wall is broken; fix the indexer, do not weaken the test.

- [ ] **Step 3: Full suite + build**

Run: `npx vitest run`
Expected: 0 failures. (Ignore any inflated count from a live `.worktrees/*` double-scan — the 0-failures is the signal.)

Run: `npm run build`
Expected: tsc clean.

- [ ] **Step 4: Manual smoke (document results in the commit body)**

Confirm the pack loads and the role answers privately. With the daemon NOT yet redeployed, a quick check is enough; full deploy is a separate step the user runs.

- `npx tsx -e 'import {loadPacks} from "./src/packs/loader.js"; const p=loadPacks("playbooks"); console.log([...p.packs.keys()].sort())'` → expect `lifeops` present alongside `code`, `money`, `research`.

- [ ] **Step 5: Commit**

```bash
git add test/lifeops-privacy.test.ts
git commit -m "test(lifeops): pin recall-exclusion + private-reach invariants

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Deploy (after merge — the user runs this)

```bash
npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios
```

Verify boot: `data/aios.log` shows `packs: code, lifeops, money, research` + `aios daemon running` (lands ~50–65s after kickstart with slack enabled — don't panic on an early empty tail). Then DM `@jasmine` privately to smoke-test: "add a task: book dentist by friday" → `list_tasks`.

---

## Self-Review

**Spec coverage:**
- Data model (§1) → Task 1. ✓
- Pure ops (§2) → Task 2. ✓
- Tools (§3) → Task 3. ✓
- Role (§4) + manifest (§5) → Task 4. ✓
- Watcher + brief (§6) → Tasks 5 (watcher) + 6 (brief). ✓
- Wiring + config (§7, Config) → Task 5. ✓
- Privacy invariants 1 & 3 → Task 7; invariant 2 (`actions: []`, no outward tool) → Task 4 manifest + Task 3 server (no gate import); invariant 4 (transport-only) → Task 5 watcher uses `sendVia`, no vault/bus. ✓
- Framework consequences (solo bind, byte-unaffected, kill-switch) → Task 4 (roleOf) + Task 5 Step 7 note. ✓
- Testing (§Testing) → ops/server/privacy/brief tasks. ✓

**Placeholder scan:** every code step shows real code; "match the existing test's harness" notes point at named in-repo files to copy, not vague instructions. No TBD/TODO.

**Type consistency:** `PersonalTaskRow` (Task 1) ↔ consumed in Tasks 2/3/6. `OpenLoops`/`LifeopsSignal`/`LifeopsSignalConfig` (Task 2) ↔ `BriefData.openLoops: OpenLoops` (Task 6) ↔ `computeLifeopsSignals(store.listTasks("open"), now, config)` (Task 5). `buildLifeopsServer({ store })` (Task 3) ↔ registry entry (Task 5). `config.lifeops*` (Task 5) structurally satisfies `LifeopsSignalConfig`. Consistent.
