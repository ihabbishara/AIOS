# Phase 8 Dream Cycle (Propose) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A nightly 02:00 "dream" pass that scans non-sensitive accumulated state (reminders, calendar, decisions, failed jobs), ranks the top-N initiatives worth the operator's attention via one LLM pass, and surfaces them as a "Dream" section in the morning brief — read-only, never auto-acts.

**Architecture:** A new `src/heartbeat/dream.ts` provides a pure `collectObservations(store, now)` digest builder + a `runDreamCycle(deps)` that runs an injected one-shot LLM ranker (the distiller's `curateLLM` pattern, with JSON-schema output) and stores the result in kv `dream:latest`. A new "dream" heartbeat anchor fires it fire-and-forget; the morning brief reads `dream:latest` (date-matched) and renders the section. Money + email content are excluded by construction.

**Tech Stack:** TypeScript (NodeNext, `.js` specifiers), Node 23 `node:sqlite`, Claude Agent SDK (`query` one-shot with `outputFormat: json_schema`), vitest (`new Store(":memory:")`). Subscription auth. Model: `config.dreamModel` (defaults to specialist).

**File structure:**
- Create: `src/heartbeat/dream.ts` (`Initiative` type, `collectObservations`, `runDreamCycle`, `dreamRankLLM`).
- Modify: `src/config.ts` (`anchorDream`/`dreamTopN`/`dreamModel`), `src/heartbeat/clock.ts` (widen anchor-name union), `src/heartbeat/briefs.ts` (`BriefData.dreamInitiatives` + read + render + `isEmptyBrief`), `src/index.ts` (dream anchor + `onAnchor` branch).
- Tests: `test/dream-observations.test.ts`, `test/dream-cycle.test.ts`, `test/dream-brief.test.ts`.

---

## Stage 1 — Observations compiler

### Task 1: `collectObservations` (pure) + `Initiative` type

**Files:**
- Create: `src/heartbeat/dream.ts`
- Test: `test/dream-observations.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/dream-observations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { collectObservations } from "../src/heartbeat/dream.js";

const NOW = new Date("2026-06-17T02:00:00.000Z");

describe("collectObservations", () => {
  it("returns empty string when there is nothing to observe", () => {
    expect(collectObservations(new Store(":memory:"), NOW)).toBe("");
  });

  it("includes overdue and upcoming reminders", () => {
    const s = new Store(":memory:");
    s.addReminder({ text: "call dentist", dueAt: "2026-06-10T09:00:00.000Z", originChannel: "telegram", originChatId: "1" }); // overdue
    s.addReminder({ text: "submit report", dueAt: "2026-06-20T09:00:00.000Z", originChannel: "telegram", originChatId: "1" }); // upcoming (<7d)
    s.addReminder({ text: "far future", dueAt: "2026-09-01T09:00:00.000Z", originChannel: "telegram", originChatId: "1" }); // outside 7d → excluded
    const d = collectObservations(s, NOW);
    expect(d).toMatch(/REMINDERS:/);
    expect(d).toMatch(/OVERDUE.*call dentist/);
    expect(d).toMatch(/upcoming.*submit report/);
    expect(d).not.toMatch(/far future/);
  });

  it("includes next-7d meetings from gcal snapshots", () => {
    const s = new Store(":memory:");
    s.kvSet("gcal:work:snapshot", JSON.stringify({
      e1: { summary: "Standup", start: "2026-06-18T09:00:00.000Z", end: "2026-06-18T09:30:00.000Z", link: null },
      e2: { summary: "Old", start: "2026-01-01T09:00:00.000Z", end: "2026-01-01T10:00:00.000Z", link: null }, // past → excluded
    }));
    const d = collectObservations(s, NOW);
    expect(d).toMatch(/CALENDAR/);
    expect(d).toMatch(/Standup/);
    expect(d).not.toMatch(/Old/);
  });

  it("flags recurring rejections in the decision journal", () => {
    const s = new Store(":memory:");
    // Two rejected email.send decisions in the last 7d → recurring.
    for (let i = 0; i < 2; i++) {
      const id = s.insertAction({
        id: `r${i}`, type: "email.send", payload: "{}", preview: "send X", status: "rejected",
        origin_channel: "cli", origin_chat_id: "local", trust_state: "supervised", verdict_by: null,
        reject_reason: "no", result: null, created_at: "2026-06-16T10:00:00.000Z",
        resolved_at: "2026-06-16T10:01:00.000Z", expires_at: "2026-06-17T10:00:00.000Z",
      });
      void id;
    }
    const d = collectObservations(s, NOW);
    expect(d).toMatch(/DECISIONS:/);
    expect(d).toMatch(/rejected 2×: email\.send/);
  });

  it("includes failed jobs from recent events", () => {
    const s = new Store(":memory:");
    s.addEvent(JSON.stringify({ type: "job.status", jobId: "j1", status: "failed", error: "timeout" }));
    const d = collectObservations(s, NOW);
    expect(d).toMatch(/JOBS:/);
    expect(d).toMatch(/failed:.*timeout/);
  });
});
```

> Before running, confirm these Store method shapes against `src/store/db.ts`: `addReminder({text,dueAt,originChannel,originChatId})` returns an id; `insertAction(row: ActionRow)`; `addEvent(payload: string)`; `kvSet(key,value)`; `listReminders("pending")` → `ReminderRow[]` (`due_at`, `text`, `id`); `listDecisions(since)` → `DecisionRow[]` (`type`, `verdict:"rejected"|...`, `ts`); `listEventsSince(tsIso)` → `{id,ts,payload}[]`; `getJob(id)?.title`; `kvByPrefix("gcal:")` → `{key,value}[]`. Adjust the test's seeding calls to the real signatures if they differ (keep the assertions).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/dream-observations.test.ts`
Expected: FAIL — cannot find module `../src/heartbeat/dream.js`.

- [ ] **Step 3: Implement**

Create `src/heartbeat/dream.ts`:

```ts
import type { Store } from "../store/db.js";
import type { AiosEvent } from "../events.js";

export interface Initiative {
  title: string;
  why: string;
  suggestion: string;
}

const DAY_MS = 86_400_000;
function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

interface Meeting { summary: string; start: string; end: string }

/** Next-window meetings parsed from the `gcal:<account>:snapshot` kv entries. */
function collectMeetings(store: Store, fromIso: string, toIso: string): Meeting[] {
  const out: Meeting[] = [];
  for (const row of safe(() => store.kvByPrefix("gcal:"), [] as Array<{ key: string; value: string }>)) {
    if (!/^gcal:.+:snapshot$/.test(row.key)) continue;
    let snap: Record<string, { summary: string; start: string; end?: string }>;
    try { snap = JSON.parse(row.value) as never; } catch { continue; }
    for (const e of Object.values(snap)) {
      if (e.start >= fromIso && e.start <= toIso) out.push({ summary: e.summary, start: e.start, end: e.end ?? e.start });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Same-day overlapping meetings → conflict lines. */
function findConflicts(meetings: Meeting[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < meetings.length; i++) {
    const prev = meetings[i - 1], cur = meetings[i];
    if (prev.start.slice(0, 10) === cur.start.slice(0, 10) && prev.end > cur.start) {
      out.push(`${prev.summary} overlaps ${cur.summary} on ${cur.start.slice(0, 10)}`);
    }
  }
  return out;
}

/**
 * Compile a non-sensitive observations digest for the dream cycle.
 * Sources: pending reminders (overdue + upcoming 7d), next-7d calendar (+ conflicts),
 * recurring rejections (last 7d), failed jobs (last 24h). NEVER reads money tables or email content.
 * Returns "" when nothing is worth observing.
 */
export function collectObservations(store: Store, now: Date): string {
  const nowIso = now.toISOString();
  const in7d = new Date(now.getTime() + 7 * DAY_MS).toISOString();
  const sections: string[] = [];

  // Reminders
  const reminders = safe(() => store.listReminders("pending"), []);
  const overdue = reminders.filter((r) => r.due_at < nowIso);
  const upcoming = reminders.filter((r) => r.due_at >= nowIso && r.due_at <= in7d);
  if (overdue.length || upcoming.length) {
    const lines = [
      ...overdue.map((r) => `  OVERDUE #${r.id} ${r.text} (due ${r.due_at.slice(0, 10)})`),
      ...upcoming.map((r) => `  upcoming #${r.id} ${r.text} (due ${r.due_at.slice(0, 10)})`),
    ];
    sections.push(`REMINDERS:\n${lines.join("\n")}`);
  }

  // Calendar (next 7d)
  const meetings = collectMeetings(store, nowIso, in7d);
  if (meetings.length) {
    const lines = meetings.map((m) => `  ${m.start.slice(0, 16).replace("T", " ")} ${m.summary}`);
    const conflicts = findConflicts(meetings).map((c) => `  CONFLICT: ${c}`);
    sections.push(`CALENDAR (next 7d):\n${[...lines, ...conflicts].join("\n")}`);
  }

  // Decisions — recurring rejections in the last 7d
  const sevenAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const rejByType = new Map<string, number>();
  for (const d of safe(() => store.listDecisions(sevenAgo), [])) {
    if (d.verdict === "rejected") rejByType.set(d.type, (rejByType.get(d.type) ?? 0) + 1);
  }
  const recurring = [...rejByType.entries()].filter(([, n]) => n >= 2);
  if (recurring.length) {
    sections.push(`DECISIONS:\n${recurring.map(([t, n]) => `  rejected ${n}×: ${t}`).join("\n")}`);
  }

  // Jobs — failed in the last 24h
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const failed: string[] = [];
  for (const row of safe(() => store.listEventsSince(dayAgo), [] as Array<{ id: number; ts: string; payload: string }>)) {
    let e: AiosEvent;
    try { e = JSON.parse(row.payload) as AiosEvent; } catch { continue; }
    if (e.type === "job.status" && e.status === "failed") {
      failed.push(`  failed: ${store.getJob(e.jobId)?.title ?? e.jobId} — ${e.error ?? "unknown"}`);
    }
  }
  if (failed.length) sections.push(`JOBS:\n${failed.join("\n")}`);

  return sections.join("\n\n");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/dream-observations.test.ts`
Expected: PASS (5 tests).
Run: `npx vitest run` → green. `npm run build` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/dream.ts test/dream-observations.test.ts
git commit -m "feat(dream): observations compiler (reminders/calendar/decisions/jobs, non-sensitive)"
```

---

## Stage 2 — Dream cycle + anchor

### Task 2: `runDreamCycle` + `dreamRankLLM`

**Files:**
- Modify: `src/heartbeat/dream.ts` (append)
- Test: `test/dream-cycle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/dream-cycle.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { runDreamCycle, type Initiative } from "../src/heartbeat/dream.js";

const NOW = new Date("2026-06-17T02:00:00.000Z");
function seedReminder(s: Store) {
  s.addReminder({ text: "call dentist", dueAt: "2026-06-10T09:00:00.000Z", originChannel: "telegram", originChatId: "1" });
}
const RANKED: Initiative[] = [
  { title: "Overdue: dentist", why: "10 days late", suggestion: "book today" },
  { title: "B", why: "y", suggestion: "z" },
  { title: "C", why: "y", suggestion: "z" },
  { title: "D", why: "y", suggestion: "z" },
];

describe("runDreamCycle", () => {
  it("stores ranked initiatives (capped at topN) with today's date when there are observations", async () => {
    const s = new Store(":memory:"); seedReminder(s);
    await runDreamCycle({ store: s, rank: async () => RANKED, topN: 3, nowFn: () => NOW });
    const saved = JSON.parse(s.kvGet("dream:latest")!);
    expect(saved.date).toBe("2026-06-17");
    expect(saved.initiatives).toHaveLength(3); // capped
    expect(saved.initiatives[0].title).toBe("Overdue: dentist");
  });

  it("does nothing when there are no observations (no kv write)", async () => {
    const s = new Store(":memory:");
    await runDreamCycle({ store: s, rank: async () => RANKED, topN: 3, nowFn: () => NOW });
    expect(s.kvGet("dream:latest")).toBeUndefined();
  });

  it("is fail-silent: a throwing ranker writes nothing", async () => {
    const s = new Store(":memory:"); seedReminder(s);
    await runDreamCycle({ store: s, rank: async () => { throw new Error("llm down"); }, topN: 3, nowFn: () => NOW });
    expect(s.kvGet("dream:latest")).toBeUndefined();
  });

  it("passes last night's initiatives to the ranker as anti-repeat context", async () => {
    const s = new Store(":memory:"); seedReminder(s);
    s.kvSet("dream:latest", JSON.stringify({ date: "2026-06-16", initiatives: [{ title: "yesterday", why: "", suggestion: "" }] }));
    let seenLast: Initiative[] = [];
    await runDreamCycle({ store: s, rank: async (_digest, last) => { seenLast = last; return RANKED; }, topN: 3, nowFn: () => NOW });
    expect(seenLast.map((i) => i.title)).toEqual(["yesterday"]);
  });
});
```

> Confirm `addReminder`'s arg shape against db.ts (Task 1 note) and adjust if needed.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/dream-cycle.test.ts`
Expected: FAIL — `runDreamCycle` is not exported.

- [ ] **Step 3: Implement** — append to `src/heartbeat/dream.ts`:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { localParts } from "./clock.js";

export interface DreamDeps {
  store: Store;
  /** Injected one-shot ranker. The real one is `dreamRankLLM`; tests pass a stub. */
  rank: (digest: string, last: Initiative[]) => Promise<Initiative[]>;
  topN: number;
  nowFn?: () => Date;
  log?: (line: string) => void;
}

/**
 * The nightly propose pass: compile observations → rank top-N → store kv `dream:latest`.
 * Read-only: never proposes an action, never writes the vault. Fail-silent (no write on
 * empty digest or ranker failure), so a bad night just yields no morning Dream section.
 */
export async function runDreamCycle(deps: DreamDeps): Promise<void> {
  const now = (deps.nowFn ?? (() => new Date()))();
  const digest = collectObservations(deps.store, now);
  if (!digest.trim()) { deps.log?.("dream: nothing to observe"); return; }

  let last: Initiative[] = [];
  try {
    const prev = deps.store.kvGet("dream:latest");
    if (prev) last = (JSON.parse(prev).initiatives ?? []) as Initiative[];
  } catch { /* bad prior value → no anti-repeat context */ }

  let initiatives: Initiative[];
  try {
    initiatives = await deps.rank(digest, last);
  } catch (err) {
    deps.log?.(`dream rank failed: ${(err as Error).message}`);
    return; // fail-silent
  }
  if (!Array.isArray(initiatives) || !initiatives.length) return;

  const top = initiatives.slice(0, deps.topN);
  deps.store.kvSet("dream:latest", JSON.stringify({ date: localParts(now).date, initiatives: top }));
}

/** Real one-shot LLM ranker (chief-of-staff persona, JSON-schema output). Mirrors the distiller's curateLLM. */
export function dreamRankLLM(model: string | undefined): (digest: string, last: Initiative[]) => Promise<Initiative[]> {
  return async (digest, last) => {
    const antiRepeat = last.map((i) => `- ${i.title}`).join("\n") || "(none)";
    const q = query({
      prompt: `Observations:\n${digest}\n\nYou suggested these recently — do NOT repeat unless still pressing:\n${antiRepeat}\n\nRank the most worthwhile initiatives for me to consider.`,
      options: {
        systemPrompt:
          "You are the operator's chief of staff. From the observations, pick the few things most worth their " +
          "attention right now. For each: a short title, why it matters now, and one concrete suggested next step. " +
          "Do NOT repeat recently-suggested or already-dismissed items. Be specific and brief.",
        allowedTools: [],
        permissionMode: "dontAsk",
        settingSources: [],
        persistSession: false,
        maxTurns: 1,
        ...(model ? { model } : {}),
        outputFormat: {
          type: "json_schema" as const,
          schema: {
            type: "object",
            properties: {
              initiatives: {
                type: "array",
                items: {
                  type: "object",
                  properties: { title: { type: "string" }, why: { type: "string" }, suggestion: { type: "string" } },
                  required: ["title", "why", "suggestion"],
                  additionalProperties: false,
                },
              },
            },
            required: ["initiatives"],
            additionalProperties: false,
          },
        },
      },
    });
    for await (const msg of q) {
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          const out = (msg.structured_output as { initiatives?: Initiative[] } | undefined)?.initiatives;
          if (Array.isArray(out)) return out;
        }
        break;
      }
    }
    return [];
  };
}
```

> Mirror `src/heartbeat/triage.ts` `modelClassifier` / `src/money/categorize.ts` `categoryClassifier` if tsc complains about the `structured_output` cast or the `outputFormat` shape — they use the identical pattern.

- [ ] **Step 4: Run + commit**

Run: `npx vitest run test/dream-cycle.test.ts` → 4 pass. `npx vitest run` → green. `npm run build` → clean.

```bash
git add src/heartbeat/dream.ts test/dream-cycle.test.ts
git commit -m "feat(dream): runDreamCycle + dreamRankLLM (one-shot ranked initiatives, fail-silent)"
```

---

### Task 3: Config fields + dream anchor + wiring

**Files:**
- Modify: `src/config.ts` (interface near `anchorEvening`/`curatorModel`; builder near `anchorEvening`/`curatorModel`)
- Modify: `src/heartbeat/clock.ts` (`AnchorConfig.name` + `ClockDeps.onAnchor` unions)
- Modify: `src/index.ts` (anchors array + `onAnchor` branch + imports)
- Verified by build (the anchor union + wiring); no new unit test (the dream cycle itself is tested in Task 2).

- [ ] **Step 1: Add config fields**

In `src/config.ts`, add to the `Config` interface (next to `anchorMorning`/`anchorEvening`):

```ts
  /** Local time "HH:MM" for the nightly dream cycle. */
  anchorDream: string;
  /** Max initiatives the dream cycle surfaces in the morning brief. */
  dreamTopN: number;
  /** Model for the dream-cycle ranker one-shot (defaults to specialistModel). */
  dreamModel?: string;
```

In `loadConfig()` (next to `anchorMorning`/`anchorEvening` and `curatorModel`):

```ts
    anchorDream: process.env.AIOS_ANCHOR_DREAM ?? "02:00",
    dreamTopN: Number(process.env.AIOS_DREAM_TOP_N ?? 3),
    dreamModel: process.env.AIOS_DREAM_MODEL ?? process.env.AIOS_SPECIALIST_MODEL,
```

- [ ] **Step 2: Widen the anchor-name union in `clock.ts`**

In `src/heartbeat/clock.ts`, change `AnchorConfig.name` (line ~5):

```ts
  name: "morning" | "evening" | "dream";
```

and `ClockDeps.onAnchor` (line ~14):

```ts
  onAnchor: (name: "morning" | "evening" | "dream") => Promise<void>;
```

(The `tick()` anchor loop is name-agnostic — no other clock change.)

- [ ] **Step 3: Wire the dream anchor + branch in `src/index.ts`**

Add the import (near the `distill`/`curateLLM` import):

```ts
import { runDreamCycle, dreamRankLLM } from "./heartbeat/dream.js";
```

Add the dream anchor to the Clock's `anchors` array — **first**, so a late-boot catch-up runs it before the morning brief:

```ts
    anchors: [
      { name: "dream", hhmm: config.anchorDream },
      { name: "morning", hhmm: config.anchorMorning },
      { name: "evening", hhmm: config.anchorEvening },
    ],
```

In the `onAnchor` handler, add a `dream` branch at the TOP that early-returns (so the unconditional `runBrief` below does NOT run for the dream tick):

```ts
    onAnchor: async (name) => {
      if (name === "dream") {
        // fire-and-forget: the ranker's LLM call must not block the clock tick / reminders.
        void runDreamCycle({ store, rank: dreamRankLLM(config.dreamModel), topN: config.dreamTopN, log })
          .catch((err) => log(`dream cycle failed: ${(err as Error).message}`));
        return;
      }
      await runBrief(
        { store, bus, vault, narrate, send: sendVia, primary: config.primaryChat, degraded: () => [...google.degraded(), ...bunq.degraded()], log },
        name,
      );
      if (name === "evening") {
        reindexVault(store, vault);
        void distill({ store, vault, gate, curate: curateLLM(config.curatorModel, log), log })
          .catch((err) => log(`distill failed: ${(err as Error).message}`));
      }
    },
```

> Note: `runBrief`/`narrate` are typed `(anchor: "morning" | "evening", ...)`. Because the `dream` branch returns before those are called, `name` is still `"dream" | "morning" | "evening"` at the `runBrief(... , name)` call — TypeScript narrows `name` to `"morning" | "evening"` after the `if (name === "dream") { ...; return; }` guard, so `runBrief(..., name)` and `narrate` type-check without widening their unions. Confirm the build is clean; if tsc does not narrow (older TS), change the guard to `if (name === "dream") { ...; return; } else { /* name: "morning"|"evening" */ }` or assert `name as "morning" | "evening"` at the `runBrief` call.

- [ ] **Step 4: Build + verify**

Run: `npm run build` → clean (the union widening + the narrowing in `onAnchor`).
Run: `npx vitest run` → green (no behavior change to existing tests; the dream anchor only fires at 02:00).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/heartbeat/clock.ts src/index.ts
git commit -m "feat(dream): 02:00 dream anchor + config (anchorDream/dreamTopN/dreamModel) + wiring"
```

---

## Stage 3 — Morning-brief integration

### Task 4: Render the "Dream" section in the morning brief

**Files:**
- Modify: `src/heartbeat/briefs.ts` (`BriefData` + `assembleBrief` + `renderBriefNote` + `isEmptyBrief`)
- Test: `test/dream-brief.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/dream-brief.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { assembleBrief, renderBriefNote, isEmptyBrief } from "../src/heartbeat/briefs.js";

const NOW = "2026-06-17T07:30:00.000Z"; // morning, same local date as the dream stamp
function seedDream(s: Store, date: string) {
  s.kvSet("dream:latest", JSON.stringify({ date, initiatives: [{ title: "Book dentist", why: "10 days overdue", suggestion: "call today" }] }));
}

describe("dream section in the morning brief", () => {
  it("morning brief includes dreamInitiatives when dream:latest is from the current local date", () => {
    const s = new Store(":memory:");
    seedDream(s, "2026-06-17");
    const data = assembleBrief(s, "morning", NOW, null);
    expect(data.dreamInitiatives).toHaveLength(1);
    expect(data.dreamInitiatives![0].title).toBe("Book dentist");
    const note = renderBriefNote(data, "narration");
    expect(note).toMatch(/## Dream/);
    expect(note).toMatch(/Book dentist — call today/);
  });

  it("evening brief never includes the dream section", () => {
    const s = new Store(":memory:");
    seedDream(s, "2026-06-17");
    const data = assembleBrief(s, "evening", NOW, null);
    expect(data.dreamInitiatives).toBeUndefined();
    expect(renderBriefNote(data, "n")).not.toMatch(/## Dream/);
  });

  it("a stale-dated dream:latest is omitted", () => {
    const s = new Store(":memory:");
    seedDream(s, "2026-06-16"); // yesterday
    const data = assembleBrief(s, "morning", NOW, null);
    expect(data.dreamInitiatives).toBeUndefined();
  });

  it("a morning with only dream initiatives is not 'empty' (so it narrates)", () => {
    const s = new Store(":memory:");
    seedDream(s, "2026-06-17");
    const data = assembleBrief(s, "morning", NOW, null);
    expect(isEmptyBrief(data)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/dream-brief.test.ts`
Expected: FAIL — `dreamInitiatives` is undefined / no `## Dream` section / `isEmptyBrief` true.

- [ ] **Step 3: Add the `dreamInitiatives` field to `BriefData`**

In `src/heartbeat/briefs.ts`, add to the `BriefData` interface (after `sinceLastBrief` or near `meetings`):

```ts
  /** Ranked initiatives from the nightly dream cycle — morning brief only. */
  dreamInitiatives?: Array<{ title: string; why: string; suggestion: string }>;
```

- [ ] **Step 4: Read `dream:latest` in `assembleBrief` (morning only)**

In `assembleBrief`, just before the `return { ... }`, add:

```ts
  let dreamInitiatives: BriefData["dreamInitiatives"];
  if (anchor === "morning") {
    try {
      const raw = store.kvGet("dream:latest");
      if (raw) {
        const parsed = JSON.parse(raw) as { date?: string; initiatives?: BriefData["dreamInitiatives"] };
        if (parsed.date === localDateOf(nowIso) && parsed.initiatives?.length) dreamInitiatives = parsed.initiatives;
      }
    } catch { /* stale/bad value → omit the section */ }
  }
```

and add `dreamInitiatives,` to the returned object literal (alongside `meetings,`).

- [ ] **Step 5: Render the section + count it in `isEmptyBrief`**

In `renderBriefNote`, add (after the `Pending approvals` section, so the most actionable items lead — placement is a judgment call; just before the `Meetings` section is fine):

```ts
  section("Dream — worth considering", (d.dreamInitiatives ?? []).map((i) => `${i.title} — ${i.suggestion}`));
```

In `isEmptyBrief`, add a clause so a morning carrying only dream initiatives still narrates (it's worth waking to):

```ts
    (d.dreamInitiatives?.length ?? 0) === 0 &&
```

(add it inside the `&&` chain, e.g. right after the `d.meetings.length === 0 &&` line).

- [ ] **Step 6: Run + build + commit**

Run: `npx vitest run test/dream-brief.test.ts` → 4 pass.
Run: `npx vitest run` → green (existing brief tests unaffected — `dreamInitiatives` is optional and only set for morning when a fresh `dream:latest` exists).
Run: `npm run build` → clean.

```bash
git add src/heartbeat/briefs.ts test/dream-brief.test.ts
git commit -m "feat(dream): render the Dream section in the morning brief"
```

---

## Self-Review

**Spec coverage:**
- 02:00 dream anchor (fire-once, catch-up) → Task 3 (anchor + clock union). ✅
- `collectObservations` over reminders/calendar/decisions/jobs; money + email excluded → Task 1 (store-only, no `personal_*`/email reads). ✅
- One-shot LLM rank (distiller pattern, JSON-schema, fail-silent) → Task 2. ✅
- Store ranked top-N in kv `dream:latest` (date-stamped); LLM-guided dedup (anti-repeat) → Task 2. ✅
- Morning brief renders a "Dream" section; evening doesn't; stale omitted → Task 4. ✅
- Read-only (no gate.propose, no action queue, no direct vault write — only kv + the brief's existing note) → Tasks 2, 4. ✅
- Fail-safe (empty digest / ranker error → no write → no section; anchor handler try/caught + fire-and-forget) → Tasks 2, 3. ✅
- Build stages (compiler → cycle+anchor → brief) → Stages 1/2/3. ✅

**Deviation (flagged, sound):** the spec's "jobs + second-brain (open recall threads)" source is implemented as **failed jobs only** for v1; the recall/memo "open threads" sub-source is deferred — `recall()` is query-based (no natural "list what's open"), so it needs its own query strategy. Noted in the spec's out-of-scope spirit; the four concrete sources (reminders, calendar, decisions, jobs) fully cover the digest. The "stale reminders" sub-bucket is likewise simplified to overdue + upcoming (a "stale" heuristic was vague). If you want the recall threads in v1, add a Task that picks a query strategy.

**Placeholder scan:** No TBD/"add error handling"/"similar to Task N". Two "confirm the Store method shapes" notes are verification steps with the expected shapes given. Every code step has real code.

**Type consistency:** `Initiative {title,why,suggestion}` is defined in Task 1 and used identically in Tasks 2 + 4 (`BriefData.dreamInitiatives` inlines the same shape); `collectObservations(store, now)`, `runDreamCycle(DreamDeps)`, `dreamRankLLM(model)`, the kv key `dream:latest` with `{date, initiatives}`, and `localParts(now).date` / `localDateOf(nowIso)` date-folding are consistent across tasks; `config.dreamModel`/`dreamTopN`/`anchorDream` names match between Task 3's config and Task 3's wiring. ✅
