# Obsidian Daily-Log Repair Implementation Plan

> **STATUS: SUPERSEDED — DO NOT EXECUTE.** Implemented 2026-07-16 in commits `f8eb210` + `930001d` (deployed, backfill run, verified idempotent). All tasks below are satisfied, with two user-directed deviations beyond this plan's scope: timestamps/filenames switched to LOCAL time (this plan deferred the UTC quirk) and the dead `writeJobArtifact`/`readJobArtifact`/`jobDirName`/`jobDir` methods were deleted. Nothing here remains to build.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the vault's daily notes — goal lifecycle lines with wiki-links, live via a bus subscriber, plus a one-time idempotent backfill of the Jul 3–16 gap.

**Architecture:** New `src/vault/daily-log.ts` holds two pure-ish units: `makeDailyLogger` (a `bus.on` handler that appends goal started/terminal lines via `VaultWriter.appendDaily`) and `buildBackfillDays` (pure date→lines grouping for the backfill script). Wiring is two lines in `index.ts`; the backfill is a thin `scripts/backfill-daily.ts` runner.

**Tech Stack:** Node + TypeScript, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-16-obsidian-daily-log-design.md`

## Global Constraints

- No new npm dependencies.
- Trunk-based: every task commits to `main`; push after the final task.
- No new bus event types (unknown types hit the LLM triage classifier — routine.due precedent).
- The daily-log handler must never throw into the bus — wrap the whole body, log `daily-log: <message>`, swallow.
- Timestamps/filenames keep `appendDaily`'s existing UTC convention (`toISOString` slices) — the UTC-vs-local quirk is out of scope.
- `jobs/` stays untouched (retired archive); the expense path in `kernel/executors.ts` stays untouched.
- Backfill never appends to an existing `daily/<date>.md` — skip the whole date.
- Run root tests as `npx vitest run test/<file>.test.ts` from `/Users/ihabbishara/projects/AIOS`.

---

### Task 1: makeDailyLogger — live goal-lifecycle lines

**Files:**
- Create: `src/vault/daily-log.ts`
- Test: `test/daily-log.test.ts` (new)

**Interfaces:**
- Consumes: `StoredEvent` from `src/events.js` (`{ id, ts, event: AiosEvent }`); `Store.getGoal(id): GoalRow | undefined`; `VaultWriter.appendDaily(line)` (prepends `- HH:MM ` itself, creates the file with `# <date>` header).
- Produces: `makeDailyLogger(deps: { vault: VaultWriter; store: Store; log?: (m: string) => void }): (e: StoredEvent) => void` (consumed by Task 3's index.ts wiring). Also the module-private `TERMINAL` set and `goalLabel` helper reused by Task 2.

- [ ] **Step 1: Write the failing tests**

Create `test/daily-log.test.ts`:

```ts
// test/daily-log.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { makeDailyLogger } from "../src/vault/daily-log.js";
import type { StoredEvent } from "../src/events.js";

function harness() {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "daily-")), "AIOS");
  return { store, vault };
}

function evt(event: StoredEvent["event"]): StoredEvent {
  return { id: 1, ts: new Date().toISOString(), event } as StoredEvent;
}

function insertGoal(store: Store, over: Partial<Parameters<Store["insertGoal"]>[0]> = {}) {
  store.insertGoal({
    id: "g1", slug: "fix-auth", title: "Fix auth", request: "r", department: "engineering",
    lead: "athena", origin_channel: "telegram", origin_chat_id: "42", status: "running",
    project_dir: null, goal_dir: "2026-07-16-fix-auth", plan_summary: "", replans_used: 0,
    chain_depth: 0, error: null, ...over,
  });
}

function todayFile(vault: VaultWriter): string {
  const path = join(vault.root, "daily", `${new Date().toISOString().slice(0, 10)}.md`);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("makeDailyLogger", () => {
  it("goal.created with stamped goal_dir writes a linked started line", () => {
    const { store, vault } = harness();
    insertGoal(store);
    makeDailyLogger({ vault, store })(evt({ type: "goal.created", goalId: "g1", title: "Fix auth", department: "engineering" }));
    expect(todayFile(vault)).toContain("goal started: [[goals/2026-07-16-fix-auth/goal|Fix auth]]");
  });

  it("goal.created before goal_dir is stamped writes a plain-title line", () => {
    const { store, vault } = harness();
    insertGoal(store, { goal_dir: null });
    makeDailyLogger({ vault, store })(evt({ type: "goal.created", goalId: "g1", title: "Fix auth", department: "engineering" }));
    const f = todayFile(vault);
    expect(f).toContain("goal started: Fix auth");
    expect(f).not.toContain("[[");
  });

  it("terminal statuses write terminal lines; failed appends a truncated error", () => {
    const { store, vault } = harness();
    insertGoal(store, { status: "failed" });
    const log = makeDailyLogger({ vault, store });
    log(evt({ type: "goal.status", goalId: "g1", status: "done" }));
    log(evt({ type: "goal.status", goalId: "g1", status: "abandoned" }));
    log(evt({ type: "goal.status", goalId: "g1", status: "failed", error: "x".repeat(200) }));
    const f = todayFile(vault);
    expect(f).toContain("goal done: [[goals/2026-07-16-fix-auth/goal|Fix auth]]");
    expect(f).toContain("goal abandoned:");
    expect(f).toContain(`goal failed: [[goals/2026-07-16-fix-auth/goal|Fix auth]] — ${"x".repeat(80)}`);
    expect(f).not.toContain("x".repeat(81));
  });

  it("non-terminal statuses and non-goal events write nothing", () => {
    const { store, vault } = harness();
    insertGoal(store);
    const log = makeDailyLogger({ vault, store });
    log(evt({ type: "goal.status", goalId: "g1", status: "running" }));
    log(evt({ type: "agent.end", agent: "vulcan", context: "chat:t:1", ok: true }));
    expect(existsSync(join(vault.root, "daily"))).toBe(false);
  });

  it("unknown goalId falls back to the id prefix — line still written", () => {
    const { store, vault } = harness();
    makeDailyLogger({ vault, store })(evt({ type: "goal.created", goalId: "deadbeef-cafe", title: "T", department: "d" }));
    expect(todayFile(vault)).toContain("goal started: deadbeef");
  });

  it("a thrown write error is swallowed and logged", () => {
    const { store } = harness();
    const boom = { appendDaily: () => { throw new Error("disk full"); } } as unknown as VaultWriter;
    const lines: string[] = [];
    const log = makeDailyLogger({ vault: boom, store, log: (m) => lines.push(m) });
    insertGoal(store);
    expect(() => log(evt({ type: "goal.created", goalId: "g1", title: "Fix auth", department: "engineering" }))).not.toThrow();
    expect(lines).toEqual(["daily-log: disk full"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/daily-log.test.ts`
Expected: FAIL — cannot resolve `../src/vault/daily-log.js`.

- [ ] **Step 3: Implement makeDailyLogger**

Create `src/vault/daily-log.ts`:

```ts
// src/vault/daily-log.ts — daily-note writers (spec 2026-07-16-obsidian-daily-log).
// Live: makeDailyLogger subscribes to the bus and appends goal lifecycle lines.
// Backfill: buildBackfillDays (Task 2) reconstructs missed days from goal rows.
import type { StoredEvent } from "../events.js";
import type { Store, GoalRow } from "../store/db.js";
import type { VaultWriter } from "./writer.js";

const TERMINAL = new Set(["done", "failed", "abandoned"]);
const ERR_CAP = 80;

function label(g: { goal_dir: string | null; title: string } | undefined, goalId: string): string {
  if (!g) return goalId.slice(0, 8);
  return g.goal_dir ? `[[goals/${g.goal_dir}/goal|${g.title}]]` : g.title;
}

export function makeDailyLogger(deps: {
  vault: VaultWriter; store: Store; log?: (m: string) => void;
}): (e: StoredEvent) => void {
  const { vault, store, log = () => {} } = deps;
  return (e) => {
    try {
      const ev = e.event;
      if (ev.type === "goal.created") {
        vault.appendDaily(`goal started: ${label(store.getGoal(ev.goalId), ev.goalId)}`);
      } else if (ev.type === "goal.status" && TERMINAL.has(ev.status)) {
        const err = ev.status === "failed" && ev.error ? ` — ${ev.error.slice(0, ERR_CAP)}` : "";
        vault.appendDaily(`goal ${ev.status}: ${label(store.getGoal(ev.goalId), ev.goalId)}${err}`);
      }
    } catch (err) {
      // A daily-note miss must never break goal processing or the bus.
      log(`daily-log: ${(err as Error).message}`);
    }
  };
}
```

(`GoalRow` import is used by Task 2's `buildBackfillDays` — if tsc flags it unused after this task only, keep the import line; Task 2 lands in the same file minutes later.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/daily-log.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault/daily-log.ts test/daily-log.test.ts
git commit -m "feat(vault): makeDailyLogger — goal lifecycle lines into daily notes"
```

---

### Task 2: buildBackfillDays — pure gap reconstruction

**Files:**
- Modify: `src/vault/daily-log.ts` (append)
- Test: `test/daily-log.test.ts` (append)

**Interfaces:**
- Consumes: `GoalRow` fields `title`, `goal_dir`, `status`, `error`, `created_at`, `updated_at`; module-private `TERMINAL`, `label`, `ERR_CAP` from Task 1.
- Produces: `buildBackfillDays(goals: GoalRow[], existingDates: Set<string>): Map<string, string[]>` — date → full `- HH:MM …` lines, chronological, existing dates omitted (consumed by Task 3's script).

- [ ] **Step 1: Write the failing tests**

Append to `test/daily-log.test.ts` (add `buildBackfillDays` to the import from `../src/vault/daily-log.js`, and `import type { GoalRow } from "../src/store/db.js";`):

```ts
function goalRow(over: Partial<GoalRow>): GoalRow {
  return {
    id: "g1", slug: "s", title: "Fix auth", request: "r", department: "engineering",
    lead: "athena", origin_channel: "telegram", origin_chat_id: "42", status: "done",
    project_dir: null, goal_dir: "2026-07-10-fix-auth", plan_summary: "", replans_used: 0,
    chain_depth: 0, spawned_by_mail: null, error: null,
    created_at: "2026-07-10T09:15:00.000Z", updated_at: "2026-07-10T10:40:00.000Z",
    ...over,
  } as GoalRow;
}

describe("buildBackfillDays", () => {
  it("emits started + terminal lines grouped by UTC date, chronological", () => {
    const days = buildBackfillDays([goalRow({})], new Set());
    expect([...days.keys()]).toEqual(["2026-07-10"]);
    expect(days.get("2026-07-10")).toEqual([
      "- 09:15 goal started: [[goals/2026-07-10-fix-auth/goal|Fix auth]]",
      "- 10:40 goal done: [[goals/2026-07-10-fix-auth/goal|Fix auth]]",
    ]);
  });

  it("running goals get a started line only; failed goals carry the truncated error", () => {
    const days = buildBackfillDays([
      goalRow({ id: "g2", status: "running" }),
      goalRow({ id: "g3", status: "failed", error: "y".repeat(200), updated_at: "2026-07-10T11:00:00.000Z" }),
    ], new Set());
    const lines = days.get("2026-07-10")!;
    expect(lines.filter((l) => l.includes("goal started:"))).toHaveLength(2);
    expect(lines.find((l) => l.includes("goal failed:"))).toContain("y".repeat(80));
    expect(lines.some((l) => l.includes("y".repeat(81)))).toBe(false);
    expect(lines.some((l) => l.includes("goal done:"))).toBe(false);
  });

  it("terminal line landing on a later date goes to that date's file", () => {
    const days = buildBackfillDays([goalRow({ updated_at: "2026-07-12T08:00:00.000Z" })], new Set());
    expect(days.get("2026-07-10")).toEqual(["- 09:15 goal started: [[goals/2026-07-10-fix-auth/goal|Fix auth]]"]);
    expect(days.get("2026-07-12")).toEqual(["- 08:00 goal done: [[goals/2026-07-10-fix-auth/goal|Fix auth]]"]);
  });

  it("skips dates that already have a file — whole date, never partial", () => {
    const days = buildBackfillDays([goalRow({})], new Set(["2026-07-10"]));
    expect(days.size).toBe(0);
  });

  it("null goal_dir backfills as plain title", () => {
    const days = buildBackfillDays([goalRow({ goal_dir: null, status: "running" })], new Set());
    expect(days.get("2026-07-10")).toEqual(["- 09:15 goal started: Fix auth"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/daily-log.test.ts`
Expected: FAIL — `buildBackfillDays` is not exported.

- [ ] **Step 3: Implement buildBackfillDays**

Append to `src/vault/daily-log.ts`:

```ts
/**
 * Reconstruct missed daily notes from goal rows: date → ordered `- HH:MM …` lines.
 * Dates in existingDates are omitted entirely — the backfill never appends to a
 * file that already exists (idempotent, re-run safe).
 */
export function buildBackfillDays(
  goals: GoalRow[],
  existingDates: Set<string>,
): Map<string, string[]> {
  const entries: Array<{ date: string; hhmm: string; line: string }> = [];
  for (const g of goals) {
    const l = label(g, g.id);
    entries.push({ date: g.created_at.slice(0, 10), hhmm: g.created_at.slice(11, 16), line: `goal started: ${l}` });
    if (TERMINAL.has(g.status)) {
      const err = g.status === "failed" && g.error ? ` — ${g.error.slice(0, ERR_CAP)}` : "";
      entries.push({ date: g.updated_at.slice(0, 10), hhmm: g.updated_at.slice(11, 16), line: `goal ${g.status}: ${l}${err}` });
    }
  }
  entries.sort((a, b) => (`${a.date}T${a.hhmm}` < `${b.date}T${b.hhmm}` ? -1 : 1));
  const out = new Map<string, string[]>();
  for (const en of entries) {
    if (existingDates.has(en.date)) continue;
    if (!out.has(en.date)) out.set(en.date, []);
    out.get(en.date)!.push(`- ${en.hhmm} ${en.line}`);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/daily-log.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vault/daily-log.ts test/daily-log.test.ts
git commit -m "feat(vault): buildBackfillDays — reconstruct missed daily notes from goal rows"
```

---

### Task 3: Wiring + backfill script

**Files:**
- Modify: `src/index.ts` (after the routine.due subscriber, ~line 427)
- Create: `scripts/backfill-daily.ts`

**Interfaces:**
- Consumes: `makeDailyLogger`, `buildBackfillDays` (Tasks 1–2); `loadConfig`/`Store`/`VaultWriter` script pattern (see `scripts/smoke.ts` for precedent); `vault.root` (public readonly), `vault.writeFile(relPath, content)`.
- Produces: live subscription at boot; runnable `npx tsx scripts/backfill-daily.ts`.

- [ ] **Step 1: Wire the logger in index.ts**

In `src/index.ts`, add to the imports near the other vault import:

```ts
import { makeDailyLogger } from "./vault/daily-log.js";
```

Directly after the routine.due subscriber block (`bus.on((e) => { if (e.event.type === "routine.due") routineFire(e.event); });`, ~line 425-427), add:

```ts
  // Daily vault notes: goal lifecycle lines (spec 2026-07-16-obsidian-daily-log).
  bus.on(makeDailyLogger({ vault, store, log }));
```

- [ ] **Step 2: Create the backfill script**

Create `scripts/backfill-daily.ts`:

```ts
/**
 * One-time daily-note backfill for the gap after JobManager retirement
 * (2026-07-03 → today). Idempotent: a date whose daily/<date>.md already
 * exists is skipped entirely. Usage: npx tsx scripts/backfill-daily.ts
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { buildBackfillDays } from "../src/vault/daily-log.js";

const config = loadConfig();
const store = new Store(config.dbPath);
const vault = new VaultWriter(config.vaultPath, config.vaultSubdir);

const goals = store.listGoals(1000).filter((g) => g.created_at >= "2026-07-03");
const dailyDir = join(vault.root, "daily");
const existing = new Set(
  existsSync(dailyDir)
    ? readdirSync(dailyDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))
    : [],
);
const days = buildBackfillDays(goals, existing);
for (const [date, lines] of days) {
  vault.writeFile(`daily/${date}.md`, `# ${date}\n\n${lines.join("\n")}\n`);
  console.log(`wrote daily/${date}.md (${lines.length} lines)`);
}
console.log(`${days.size} files written; ${existing.size} existing dates skipped`);
```

- [ ] **Step 3: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean; suite green (wiring is thin and untested per repo convention).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts scripts/backfill-daily.ts
git commit -m "feat(daemon): wire daily-log bus subscriber + one-time backfill script"
```

---

### Task 4: Deploy, backfill, live smoke, push

**Files:** none (verification only)

- [ ] **Step 1: Build + restart daemon**

```bash
cd /Users/ihabbishara/projects/AIOS && npm run build \
  && launchctl kickstart -k gui/501/com.ihab.aios && sleep 6
```
(ui2 unchanged this cycle — no ui2 build needed. The sleep matters: curl exits 7 right after kickstart.)

- [ ] **Step 2: Run the backfill, twice**

```bash
npx tsx scripts/backfill-daily.ts
npx tsx scripts/backfill-daily.ts
```
Expected first run: files for gap days with goal activity (at least 2026-07-13/14/15/16 exist as goals). Expected second run: `0 files written` — idempotency proven. Then eyeball one file:

```bash
cat ~/Desktop/AI-Vault/AIOS/daily/2026-07-16.md
```
Expected: `# 2026-07-16` header + `- HH:MM goal started/done: [[goals/…]]` lines.

- [ ] **Step 3: Live smoke — real goal writes today's note**

Note: the backfill may have already created today's file; the live path APPENDS to it (appendDaily), so this still verifies cleanly. Fire the existing echo smoke goal via the schedule Run-now route or chat; simplest deterministic check — watch the file:

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"hermes","body":"quick echo smoke: create a tiny goal that just replies done"}' \
  http://localhost:4280/api/mail/compose
sleep 90
tail -5 ~/Desktop/AI-Vault/AIOS/daily/$(date -u +%F).md
```
Expected: a fresh `goal started:` (and, once the goal finishes, `goal done:`) line appended after the backfilled ones. If the goal takes longer than 90s, re-tail until the lines appear.

- [ ] **Step 4: Push**

```bash
git push origin main
```

---

## Self-Review Notes

- Spec coverage: makeDailyLogger + error swallow + fallbacks (T1), buildBackfillDays idempotent grouping (T2), index wiring + script (T3), deploy/backfill×2/live smoke/push (T4). jobs/ untouched, expenses untouched, no new event types — all constraints carried in Global Constraints.
- Type consistency: `makeDailyLogger({ vault, store, log })` matches T3 wiring; `buildBackfillDays(goals, existingDates)` matches T3 script; line formats identical between live (`appendDaily` prepends `- HH:MM `) and backfill (lines carry their own `- HH:MM `).
- Live smoke uses agent mail to spawn a goal (mail.compose → hermes) — deterministic enough; alternative is a chat message. Either produces goal.created/goal.status events.
