# Speculate (Research) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new 03:00 "speculate" heartbeat anchor reads the propose step's `dream:latest` initiatives, runs a one-shot LLM planner that picks ≤K worth overnight research, enqueues read-only `research-report` jobs via the existing JobManager, and surfaces the finished notes in the 07:30 morning brief.

**Architecture:** Pure composition over existing primitives — no new infra. Mirrors the live dream-cycle (`src/heartbeat/dream.ts` + its 02:00 anchor in `index.ts` + its morning-brief section in `briefs.ts`). New module `src/heartbeat/speculate.ts` holds the planner + `runSpeculate(deps)`; the anchor and brief changes are small edits to existing files. Read-only: enqueues jobs whose roles (`researcher`/`reviewer`) have no Bash/Write/Edit/outward effect, never calls the gate, never writes the vault directly. Fail-silent throughout.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 23 `node:sqlite` via `Store`, `@anthropic-ai/claude-agent-sdk` `query` (one-shot `json_schema` output, subscription auth — NO apiKey), Vitest, in-memory `Store(":memory:")` for tests.

---

## Spec

`docs/superpowers/specs/2026-06-17-speculate-research-design.md` (committed `1e30297`). Read it before starting.

## Key facts verified against live code (do not re-derive)

- `JobManager.createJob({ playbook, title, request, projectDir?, channel, chatId }): JobRow` — `src/engine/jobs.ts:45`. Synchronous, returns immediately (work pumps async). `JobRow` has `id` (PK, `randomUUID()`) and `slug` (`slugify(title)`) — `src/store/db.ts:10-23`. The JobManager local in `src/index.ts` main() is named `jobs` (`src/index.ts:157`).
- `playbooks/research-report.yaml` — `needsProjectDir: false`, single `loop` stage **id `report`** (`producer: researcher`, `critic: reviewer`, `maxRounds: 2`). Artifact written to `jobs/<jobDirName>/report.md` where `jobDirName = ${today()}-${slug}` (`src/vault/writer.ts:37`, `src/engine/executor.ts:73` → `${stage.id}.md`).
- `Store` job lookups: `getJob(id): JobRow | undefined` (`db.ts:313`), `insertJob(Omit<JobRow,"created_at"|"updated_at">)` (`db.ts:293`), `listJobs(limit)` (`db.ts:317`). **No `getJobBySlug`** — the brief resolves by `id` (stored in `speculate:latest`), not slug. `JobStatus = "queued" | "running" | "done" | "failed"` (`db.ts:7`).
- `localParts(now: Date): { date, hhmm }` from `src/heartbeat/clock.ts:21` — `date` is local `YYYY-MM-DD`. The dream cycle stamps `dream:latest.date = localParts(now).date`; speculate uses the same and date-gates to the current night.
- The dream one-shot LLM pattern to copy: `dreamRankLLM` (`src/heartbeat/dream.ts:141-189`) — `query` with `allowedTools:[]`, `permissionMode:"dontAsk"`, `settingSources:[]`, `persistSession:false`, `maxTurns:1`, spread `...(model ? { model } : {})`, `outputFormat: { type: "json_schema", schema }`, read `structured_output` from the `result`/`success` message, return a safe default (`[]`) on any failure.
- The dream anchor branch to mirror: `src/index.ts:367-373` (`onAnchor`, `if (name === "dream") { void runDreamCycle(...).catch(log); return; }`). The clock union to widen: `src/heartbeat/clock.ts:5` (`AnchorConfig.name`) and `:14` (`ClockDeps.onAnchor`), currently `"morning" | "evening" | "dream"`.
- The dream brief section to mirror: `src/heartbeat/briefs.ts` — `BriefData.dreamInitiatives` (`:21-22`), the morning-only date-gated read (`:116-125`), `isEmptyBrief` clause (`:162`), and `renderBriefNote` `section()` call (`:190`).

## File Structure

- **Create `src/heartbeat/speculate.ts`** — `ResearchTask`/`SpeculateTask` types, `SpeculateJobs` injection interface, `runSpeculate(deps)`, `speculatePlanLLM(model, maxJobs)`. One responsibility: turn tonight's initiatives into ≤K enqueued research jobs + a `speculate:latest` stamp.
- **Create `test/speculate.test.ts`** — `runSpeculate` behavior (cap, system origin, fail-silent, anti-repeat, per-task isolation) with a stub `plan` + stub `jobs`.
- **Create `test/speculate-brief.test.ts`** — the morning-brief Speculate section (mirrors `test/dream-brief.test.ts`).
- **Modify `src/config.ts`** — `anchorSpeculate` / `speculateMaxJobs` / `speculateModel` fields + env loads.
- **Modify `src/heartbeat/clock.ts`** — widen the two `"morning" | "evening" | "dream"` unions to add `"speculate"`.
- **Modify `src/index.ts`** — import `runSpeculate` + `speculatePlanLLM`, push the `speculate` anchor after `dream`, add the `onAnchor` branch.
- **Modify `src/heartbeat/briefs.ts`** — `BriefData.speculateResults` + morning-only read in `assembleBrief` + `isEmptyBrief` clause + `renderBriefNote` section.
- **Modify `test/clock.test.ts`** — add a `"speculate"` anchor-fires test.

---

## Stage 1 — Planner + `runSpeculate` (headless: enqueues jobs, nothing surfaces yet)

### Task 1: `runSpeculate` happy path — cap, system origin, kv stamp

**Files:**
- Create: `src/heartbeat/speculate.ts`
- Test: `test/speculate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/speculate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { runSpeculate, type ResearchTask, type SpeculateJobs } from "../src/heartbeat/speculate.js";
import { localParts } from "../src/heartbeat/clock.js";

const NOW = new Date("2026-06-17T03:00:00.000Z");
const TODAY = localParts(NOW).date;

function seedDream(s: Store, date: string, n = 3) {
  const initiatives = Array.from({ length: n }, (_, i) => ({ title: `init ${i}`, why: "w", suggestion: "s" }));
  s.kvSet("dream:latest", JSON.stringify({ date, initiatives }));
}

/** Records every createJob call; returns deterministic id/slug per call. */
function stubJobs(): SpeculateJobs & { calls: Array<{ playbook: string; title: string; request: string; channel: string; chatId: string }> } {
  const calls: Array<{ playbook: string; title: string; request: string; channel: string; chatId: string }> = [];
  return {
    calls,
    createJob(params) {
      calls.push(params);
      return { id: `id-${calls.length}`, slug: `slug-${calls.length}` };
    },
  };
}

const THREE_TASKS: ResearchTask[] = [
  { title: "T0", question: "Q0?" },
  { title: "T1", question: "Q1?" },
  { title: "T2", question: "Q2?" },
];

describe("runSpeculate", () => {
  it("enqueues at most maxJobs research-report jobs with system origin and stamps speculate:latest", async () => {
    const s = new Store(":memory:");
    seedDream(s, TODAY);
    const jobs = stubJobs();
    await runSpeculate({ store: s, jobs, plan: async () => THREE_TASKS, maxJobs: 2, nowFn: () => NOW });

    expect(jobs.calls).toHaveLength(2); // cap enforced
    expect(jobs.calls[0]).toEqual({ playbook: "research-report", title: "T0", request: "Q0?", channel: "system", chatId: "speculate" });
    expect(jobs.calls[1].title).toBe("T1");

    const saved = JSON.parse(s.kvGet("speculate:latest")!);
    expect(saved.date).toBe(TODAY);
    expect(saved.tasks).toEqual([
      { title: "T0", slug: "slug-1", id: "id-1" },
      { title: "T1", slug: "slug-2", id: "id-2" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/speculate.test.ts`
Expected: FAIL — `Cannot find module '../src/heartbeat/speculate.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/heartbeat/speculate.ts`:

```typescript
import type { Store } from "../store/db.js";
import type { Initiative } from "./dream.js";
import { localParts } from "./clock.js";

/** One research task the planner emits: a title + the research question (becomes the job's `request`). */
export interface ResearchTask {
  title: string;
  question: string;
}

/** What we persist per task in `speculate:latest` so the morning brief can resolve status by job id. */
export interface SpeculateTask {
  title: string;
  slug: string;
  id: string;
}

/** Minimal slice of JobManager that runSpeculate needs — lets tests inject a stub. */
export interface SpeculateJobs {
  createJob(params: {
    playbook: string;
    title: string;
    request: string;
    channel: string;
    chatId: string;
  }): { id: string; slug: string };
}

export interface SpeculateDeps {
  store: Store;
  jobs: SpeculateJobs;
  /** Injected one-shot planner. The real one is `speculatePlanLLM`; tests pass a stub. */
  plan: (initiatives: Initiative[], recentTitles: string[]) => Promise<ResearchTask[]>;
  /** Hard cap on jobs enqueued per night (config.speculateMaxJobs). */
  maxJobs: number;
  nowFn?: () => Date;
  log?: (line: string) => void;
}

/**
 * The nightly speculate pass: read tonight's propose initiatives → plan ≤K research questions →
 * enqueue read-only research-report jobs → stamp `speculate:latest`.
 * Read-only: only ever calls jobs.createJob + store kv. Never gate.propose, never vault.write.
 */
export async function runSpeculate(deps: SpeculateDeps): Promise<void> {
  const now = (deps.nowFn ?? (() => new Date()))();
  const today = localParts(now).date;

  const raw = deps.store.kvGet("dream:latest");
  if (!raw) { deps.log?.("speculate: no dream:latest"); return; }
  const parsed = JSON.parse(raw) as { date?: string; initiatives?: Initiative[] };
  if (parsed.date !== today || !parsed.initiatives?.length) {
    deps.log?.("speculate: no fresh initiatives");
    return;
  }

  const recentTitles = readRecentTitles(deps.store);
  const planned = await deps.plan(parsed.initiatives, recentTitles);
  const tasks = (Array.isArray(planned) ? planned : []).slice(0, deps.maxJobs);
  if (!tasks.length) { deps.log?.("speculate: planner returned nothing"); return; }

  const stored: SpeculateTask[] = [];
  for (const t of tasks) {
    const job = deps.jobs.createJob({
      playbook: "research-report",
      title: t.title,
      request: t.question,
      channel: "system",
      chatId: "speculate",
    });
    stored.push({ title: t.title, slug: job.slug, id: job.id });
  }
  if (!stored.length) return;
  deps.store.kvSet("speculate:latest", JSON.stringify({ date: today, tasks: stored }));
}

/** Prior night's task titles, for anti-repeat. Bad/absent value → none. */
function readRecentTitles(store: Store): string[] {
  try {
    const prev = store.kvGet("speculate:latest");
    if (!prev) return [];
    const tasks = (JSON.parse(prev).tasks ?? []) as SpeculateTask[];
    return tasks.map((t) => t.title);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/speculate.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/speculate.ts test/speculate.test.ts
git commit -m "feat(speculate): runSpeculate enqueues capped research-report jobs + stamps speculate:latest"
```

### Task 2: `runSpeculate` robustness — fail-silent, anti-repeat, per-task isolation

**Files:**
- Modify: `src/heartbeat/speculate.ts`
- Test: `test/speculate.test.ts` (add cases)

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("runSpeculate", ...)` block in `test/speculate.test.ts`:

```typescript
  it("does nothing when there is no dream:latest (no jobs, no kv)", async () => {
    const s = new Store(":memory:");
    const jobs = stubJobs();
    await runSpeculate({ store: s, jobs, plan: async () => THREE_TASKS, maxJobs: 2, nowFn: () => NOW });
    expect(jobs.calls).toHaveLength(0);
    expect(s.kvGet("speculate:latest")).toBeUndefined();
  });

  it("ignores a stale-dated dream:latest", async () => {
    const s = new Store(":memory:");
    seedDream(s, "2020-01-01");
    const jobs = stubJobs();
    await runSpeculate({ store: s, jobs, plan: async () => THREE_TASKS, maxJobs: 2, nowFn: () => NOW });
    expect(jobs.calls).toHaveLength(0);
    expect(s.kvGet("speculate:latest")).toBeUndefined();
  });

  it("does nothing when initiatives are empty", async () => {
    const s = new Store(":memory:");
    s.kvSet("dream:latest", JSON.stringify({ date: TODAY, initiatives: [] }));
    const jobs = stubJobs();
    await runSpeculate({ store: s, jobs, plan: async () => THREE_TASKS, maxJobs: 2, nowFn: () => NOW });
    expect(jobs.calls).toHaveLength(0);
    expect(s.kvGet("speculate:latest")).toBeUndefined();
  });

  it("writes nothing when the planner returns an empty list", async () => {
    const s = new Store(":memory:");
    seedDream(s, TODAY);
    const jobs = stubJobs();
    await runSpeculate({ store: s, jobs, plan: async () => [], maxJobs: 2, nowFn: () => NOW });
    expect(jobs.calls).toHaveLength(0);
    expect(s.kvGet("speculate:latest")).toBeUndefined();
  });

  it("is fail-silent: a throwing planner enqueues nothing and writes nothing", async () => {
    const s = new Store(":memory:");
    seedDream(s, TODAY);
    const jobs = stubJobs();
    await runSpeculate({ store: s, jobs, plan: async () => { throw new Error("llm down"); }, maxJobs: 2, nowFn: () => NOW });
    expect(jobs.calls).toHaveLength(0);
    expect(s.kvGet("speculate:latest")).toBeUndefined();
  });

  it("ignores a malformed dream:latest (no throw, no work)", async () => {
    const s = new Store(":memory:");
    s.kvSet("dream:latest", "not json {");
    const jobs = stubJobs();
    await expect(
      runSpeculate({ store: s, jobs, plan: async () => THREE_TASKS, maxJobs: 2, nowFn: () => NOW }),
    ).resolves.toBeUndefined();
    expect(jobs.calls).toHaveLength(0);
    expect(s.kvGet("speculate:latest")).toBeUndefined();
  });

  it("passes the prior night's task titles to the planner as anti-repeat context", async () => {
    const s = new Store(":memory:");
    seedDream(s, TODAY);
    s.kvSet("speculate:latest", JSON.stringify({ date: "2026-06-16", tasks: [{ title: "yesterday", slug: "y", id: "yid" }] }));
    let seen: string[] = [];
    await runSpeculate({
      store: s, jobs: stubJobs(), maxJobs: 2, nowFn: () => NOW,
      plan: async (_inits, recent) => { seen = recent; return THREE_TASKS; },
    });
    expect(seen).toEqual(["yesterday"]);
  });

  it("isolates a failing createJob: remaining tasks still enqueue and only successes are stamped", async () => {
    const s = new Store(":memory:");
    seedDream(s, TODAY);
    let n = 0;
    const jobs: SpeculateJobs = {
      createJob() { // params intentionally unused here — fewer params still satisfies the interface
        n++;
        if (n === 1) throw new Error("boom"); // first task fails
        return { id: `id-${n}`, slug: `slug-${n}` };
      },
    };
    await runSpeculate({ store: s, jobs, plan: async () => THREE_TASKS, maxJobs: 2, nowFn: () => NOW });
    const saved = JSON.parse(s.kvGet("speculate:latest")!);
    expect(saved.tasks).toEqual([{ title: "T1", slug: "slug-2", id: "id-2" }]); // T0 dropped, T1 kept
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/speculate.test.ts`
Expected: the "throwing planner", "malformed dream:latest", and "failing createJob" cases FAIL (the Task-1 impl lets those throws propagate / aborts the loop); the rest already pass.

- [ ] **Step 3: Write minimal implementation**

In `src/heartbeat/speculate.ts`, wrap the three throw sites. Replace the `JSON.parse(raw)` line and everything after it through the kv stamp with:

```typescript
  let parsed: { date?: string; initiatives?: Initiative[] };
  try {
    parsed = JSON.parse(raw) as { date?: string; initiatives?: Initiative[] };
  } catch {
    deps.log?.("speculate: malformed dream:latest");
    return;
  }
  if (parsed.date !== today || !parsed.initiatives?.length) {
    deps.log?.("speculate: no fresh initiatives");
    return;
  }

  const recentTitles = readRecentTitles(deps.store);
  let planned: ResearchTask[];
  try {
    planned = await deps.plan(parsed.initiatives, recentTitles);
  } catch (err) {
    deps.log?.(`speculate: planner failed: ${(err as Error).message}`);
    return; // fail-silent
  }
  const tasks = (Array.isArray(planned) ? planned : []).slice(0, deps.maxJobs);
  if (!tasks.length) { deps.log?.("speculate: planner returned nothing"); return; }

  const stored: SpeculateTask[] = [];
  for (const t of tasks) {
    try {
      const job = deps.jobs.createJob({
        playbook: "research-report",
        title: t.title,
        request: t.question,
        channel: "system",
        chatId: "speculate",
      });
      stored.push({ title: t.title, slug: job.slug, id: job.id });
    } catch (err) {
      deps.log?.(`speculate: createJob failed for "${t.title}": ${(err as Error).message}`);
    }
  }
  if (!stored.length) return;
  deps.store.kvSet("speculate:latest", JSON.stringify({ date: today, tasks: stored }));
```

(The earlier `if (!raw) { ... return; }` guard stays as written in Task 1.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/speculate.test.ts`
Expected: PASS (all 8 cases).

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/speculate.ts test/speculate.test.ts
git commit -m "feat(speculate): fail-silent guards + per-task createJob isolation + anti-repeat"
```

### Task 3: `speculatePlanLLM` — the one-shot planner

**Files:**
- Modify: `src/heartbeat/speculate.ts`
- Test: `test/speculate.test.ts` (add a factory smoke test)

Note: like `dreamRankLLM`, the real LLM call is **not** unit-tested (no live model in CI). The test only asserts the factory returns a callable; `runSpeculate`'s behavior is fully covered with a stub `plan` above.

- [ ] **Step 1: Write the failing test**

Append to `test/speculate.test.ts` (new top-level `describe`, and add `speculatePlanLLM` to the import on line 3):

```typescript
import { runSpeculate, speculatePlanLLM, type ResearchTask, type SpeculateJobs } from "../src/heartbeat/speculate.js";

describe("speculatePlanLLM", () => {
  it("returns a callable planner for the given model + cap", () => {
    expect(typeof speculatePlanLLM(undefined, 2)).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/speculate.test.ts`
Expected: FAIL — `speculatePlanLLM is not a function` (not exported yet).

- [ ] **Step 3: Write minimal implementation**

Add to `src/heartbeat/speculate.ts`. Add `query` to the imports at the top:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
```

Then append:

```typescript
/**
 * Real one-shot LLM planner (chief-of-staff researcher, JSON-schema output). Mirrors dreamRankLLM.
 * Picks ONLY initiatives that genuinely benefit from web/literature research, writes one focused
 * research question each, returns at most `maxJobs`, avoids anything in `recentTitles`.
 * Returns [] on any failure (fail-silent).
 */
export function speculatePlanLLM(
  model: string | undefined,
  maxJobs: number,
): (initiatives: Initiative[], recentTitles: string[]) => Promise<ResearchTask[]> {
  return async (initiatives, recentTitles) => {
    const inits = initiatives.map((i) => `- ${i.title}: ${i.why} (suggested: ${i.suggestion})`).join("\n");
    const antiRepeat = recentTitles.map((t) => `- ${t}`).join("\n") || "(none)";
    const q = query({
      prompt:
        `Tonight's initiatives:\n${inits}\n\n` +
        `You already researched these recently — do NOT repeat:\n${antiRepeat}\n\n` +
        `Select the initiatives that genuinely benefit from overnight web/literature research and write a focused research question for each.`,
      options: {
        systemPrompt:
          "You are the operator's chief-of-staff researcher. From tonight's initiatives, pick ONLY the ones that " +
          "would genuinely benefit from web or literature research — skip pure reminders, scheduling, and anything " +
          `actionable without research. Write one focused, self-contained research question for each. Return AT MOST ${maxJobs}. ` +
          "Do not repeat anything already researched recently. If nothing warrants research, return an empty list.",
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
              tasks: {
                type: "array",
                items: {
                  type: "object",
                  properties: { title: { type: "string" }, question: { type: "string" } },
                  required: ["title", "question"],
                  additionalProperties: false,
                },
              },
            },
            required: ["tasks"],
            additionalProperties: false,
          },
        },
      },
    });
    for await (const msg of q) {
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          const out = (msg.structured_output as { tasks?: ResearchTask[] } | undefined)?.tasks;
          if (Array.isArray(out)) return out;
        }
        break;
      }
    }
    return [];
  };
}
```

- [ ] **Step 4: Run test to verify it passes + full suite green**

Run: `npx vitest run test/speculate.test.ts`
Expected: PASS (9 cases).
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/speculate.ts test/speculate.test.ts
git commit -m "feat(speculate): speculatePlanLLM one-shot json_schema planner (mirrors dreamRankLLM)"
```

---

## Stage 2 — The 03:00 "speculate" anchor + config (the nightly pass runs and enqueues research)

### Task 4: Config fields

**Files:**
- Modify: `src/config.ts` (interface near line 44-48; loader near line 182-184)

- [ ] **Step 1: Add the interface fields**

In `src/config.ts`, after the `dreamModel?: string;` field (line 48), add:

```typescript
  /** Local time "HH:MM" for the nightly speculate (overnight research) pass. */
  anchorSpeculate: string;
  /** Hard cap on research-report jobs the speculate pass enqueues per night. */
  speculateMaxJobs: number;
  /** Model for the speculate planner one-shot (defaults to specialistModel). */
  speculateModel?: string;
```

- [ ] **Step 2: Add the loader lines**

In the returned config object, after the `dreamModel:` line (line 184), add:

```typescript
    anchorSpeculate: process.env.AIOS_ANCHOR_SPECULATE ?? "03:00",
    speculateMaxJobs: Number(process.env.AIOS_SPECULATE_MAX_JOBS ?? 2),
    speculateModel: process.env.AIOS_SPECULATE_MODEL ?? process.env.AIOS_SPECIALIST_MODEL,
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors (these are additive optional/required-with-default fields; nothing else references them yet).

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "feat(speculate): config — anchorSpeculate/speculateMaxJobs/speculateModel"
```

### Task 5: Widen the clock anchor union + an anchor-fires test

**Files:**
- Modify: `src/heartbeat/clock.ts:5` and `:14`
- Test: `test/clock.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/clock.test.ts`, add inside `describe("Clock.tick", ...)`:

```typescript
  it("fires a 'speculate' anchor once at its time", async () => {
    const store = new Store(":memory:");
    const fired: string[] = [];
    const clock = new Clock({
      store,
      anchors: [{ name: "speculate", hhmm: "03:00" }],
      onAnchor: async (name) => { fired.push(name); },
      onReminderDue: () => {},
      nowFn: () => new Date(2026, 5, 17, 3, 30), // 03:30 local, past 03:00
    });
    await clock.tick();
    expect(fired).toEqual(["speculate"]);
    await clock.tick();
    expect(fired).toEqual(["speculate"]); // fire-once
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/clock.test.ts`
Expected: FAIL — TypeScript error: `Type '"speculate"' is not assignable to type '"morning" | "evening" | "dream"'`.

- [ ] **Step 3: Widen both unions**

In `src/heartbeat/clock.ts`, change line 5:

```typescript
  name: "morning" | "evening" | "dream" | "speculate";
```

and line 14:

```typescript
  onAnchor: (name: "morning" | "evening" | "dream" | "speculate") => Promise<void>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/clock.test.ts`
Expected: PASS (all clock tests).

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/clock.ts test/clock.test.ts
git commit -m "feat(speculate): widen clock anchor union with 'speculate'"
```

### Task 6: Wire the anchor in `index.ts`

**Files:**
- Modify: `src/index.ts` (import line ~36; anchors array ~362; onAnchor ~367)

This is integration wiring (the `main()` graph isn't unit-tested — the dream anchor is verified the same way: `runDreamCycle` unit tests + a boot/log check at deploy). Verification here is `tsc` + the full suite staying green; the live nightly behavior is confirmed at deploy.

- [ ] **Step 1: Add the import**

In `src/index.ts`, near the dream import (line 36, `import { runDreamCycle, dreamRankLLM } from "./heartbeat/dream.js";`), add:

```typescript
import { runSpeculate, speculatePlanLLM } from "./heartbeat/speculate.js";
```

- [ ] **Step 2: Push the anchor after `dream`**

In the `anchors` array (lines 362-366), add a line **after** the `dream` entry:

```typescript
    anchors: [
      { name: "dream", hhmm: config.anchorDream },
      { name: "speculate", hhmm: config.anchorSpeculate },
      { name: "morning", hhmm: config.anchorMorning },
      { name: "evening", hhmm: config.anchorEvening },
    ],
```

- [ ] **Step 3: Add the `onAnchor` branch**

In the `onAnchor` handler, after the `if (name === "dream") { ... return; }` block (line 373), add:

```typescript
      if (name === "speculate") {
        // fire-and-forget: the planner's LLM call + enqueue must not block the clock tick / reminders.
        void runSpeculate({
          store,
          jobs,
          plan: speculatePlanLLM(config.speculateModel, config.speculateMaxJobs),
          maxJobs: config.speculateMaxJobs,
          log,
        }).catch((err) => log(`speculate failed: ${(err as Error).message}`));
        return;
      }
```

- [ ] **Step 4: Verify compile + full suite green**

Run: `npx tsc --noEmit`
Expected: no errors (the `jobs` local — `src/index.ts:157` — structurally satisfies `SpeculateJobs`).
Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(speculate): wire the 03:00 speculate anchor (fire-and-forget after dream)"
```

---

## Stage 3 — Morning-brief "Speculate" section (the overnight research surfaces)

### Task 7: `BriefData.speculateResults` + assemble + render + isEmptyBrief

**Files:**
- Modify: `src/heartbeat/briefs.ts` (`BriefData` ~21-22; `assembleBrief` ~116-125 and the return ~146; `isEmptyBrief` ~162; `renderBriefNote` ~190)
- Test: `test/speculate-brief.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/speculate-brief.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import type { JobRow } from "../src/store/db.js";
import { assembleBrief, renderBriefNote, isEmptyBrief } from "../src/heartbeat/briefs.js";
import { localParts } from "../src/heartbeat/clock.js";

const NOW = "2026-06-17T07:30:00.000Z"; // morning; same local date as the speculate stamp
const TODAY = localParts(new Date(NOW)).date;

/** Insert a job row directly so the brief's getJob(id) can resolve status. */
function insertJob(s: Store, id: string, slug: string, status: JobRow["status"]) {
  s.insertJob({
    id, slug, title: slug, playbook: "research-report", request: "q",
    project_dir: null, channel: "system", chat_id: "speculate", status, error: null,
  });
}

function seedSpeculate(s: Store, date: string, tasks: Array<{ title: string; slug: string; id: string }>) {
  s.kvSet("speculate:latest", JSON.stringify({ date, tasks }));
}

describe("speculate section in the morning brief", () => {
  it("resolves done/failed/running status + a report ref and renders the section", () => {
    const s = new Store(":memory:");
    insertJob(s, "id-done", "alpha", "done");
    insertJob(s, "id-fail", "beta", "failed");
    insertJob(s, "id-run", "gamma", "running");
    seedSpeculate(s, TODAY, [
      { title: "Alpha", slug: "alpha", id: "id-done" },
      { title: "Beta", slug: "beta", id: "id-fail" },
      { title: "Gamma", slug: "gamma", id: "id-run" },
    ]);
    const data = assembleBrief(s, "morning", NOW, null);
    expect(data.speculateResults).toEqual([
      { title: "Alpha", status: "done", ref: `jobs/${TODAY}-alpha/report.md` },
      { title: "Beta", status: "failed", ref: null },
      { title: "Gamma", status: "running", ref: null },
    ]);
    const note = renderBriefNote(data, "narration");
    expect(note).toMatch(/## Speculate — researched overnight/);
    expect(note).toMatch(new RegExp(`Alpha — jobs/${TODAY}-alpha/report.md`));
    expect(note).toMatch(/Beta — failed/);
    expect(note).toMatch(/Gamma — still running/);
  });

  it("evening brief never includes the speculate section", () => {
    const s = new Store(":memory:");
    insertJob(s, "id-done", "alpha", "done");
    seedSpeculate(s, TODAY, [{ title: "Alpha", slug: "alpha", id: "id-done" }]);
    const data = assembleBrief(s, "evening", NOW, null);
    expect(data.speculateResults).toBeUndefined();
    expect(renderBriefNote(data, "n")).not.toMatch(/## Speculate/);
  });

  it("omits a stale-dated speculate:latest", () => {
    const s = new Store(":memory:");
    insertJob(s, "id-done", "alpha", "done");
    seedSpeculate(s, "2020-01-01", [{ title: "Alpha", slug: "alpha", id: "id-done" }]);
    const data = assembleBrief(s, "morning", NOW, null);
    expect(data.speculateResults).toBeUndefined();
  });

  it("a morning with only speculate results is not 'empty' (so it narrates)", () => {
    const s = new Store(":memory:");
    insertJob(s, "id-done", "alpha", "done");
    seedSpeculate(s, TODAY, [{ title: "Alpha", slug: "alpha", id: "id-done" }]);
    const data = assembleBrief(s, "morning", NOW, null);
    expect(isEmptyBrief(data)).toBe(false);
  });

  it("malformed speculate:latest is omitted (no throw)", () => {
    const s = new Store(":memory:");
    s.kvSet("speculate:latest", "not json {");
    const data = assembleBrief(s, "morning", NOW, null);
    expect(data.speculateResults).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/speculate-brief.test.ts`
Expected: FAIL — `data.speculateResults` is undefined / no `## Speculate` section (field + logic not implemented).

- [ ] **Step 3: Implement the field, read, render, and empty-check**

In `src/heartbeat/briefs.ts`:

(a) Add to the `BriefData` interface, after `dreamInitiatives?` (line 22):

```typescript
  /** Overnight research tasks from the speculate pass — morning brief only. */
  speculateResults?: Array<{ title: string; status: "done" | "failed" | "running"; ref: string | null }>;
```

(b) In `assembleBrief`, after the `dreamInitiatives` block (the `}` closing line 125), add:

```typescript
  let speculateResults: BriefData["speculateResults"];
  if (anchor === "morning") {
    try {
      const raw = store.kvGet("speculate:latest");
      if (raw) {
        const parsed = JSON.parse(raw) as { date?: string; tasks?: Array<{ title: string; slug: string; id: string }> };
        if (parsed.date === localDateOf(nowIso) && parsed.tasks?.length) {
          speculateResults = parsed.tasks.map((t) => {
            const job = store.getJob(t.id);
            const status: "done" | "failed" | "running" =
              job?.status === "done" ? "done" : job?.status === "failed" ? "failed" : "running";
            const ref = status === "done" ? `jobs/${parsed.date}-${t.slug}/report.md` : null;
            return { title: t.title, status, ref };
          });
        }
      }
    } catch { /* stale/bad value → omit the section */ }
  }
```

(c) Add `speculateResults` to the returned object (after `dreamInitiatives,` on line 146):

```typescript
    dreamInitiatives,
    speculateResults,
```

(d) In `isEmptyBrief`, add a clause (after the `dreamInitiatives` clause, line 162):

```typescript
    (d.dreamInitiatives?.length ?? 0) === 0 &&
    (d.speculateResults?.length ?? 0) === 0
```

(e) In `renderBriefNote`, after the Dream section (line 190), add:

```typescript
  section("Speculate — researched overnight", (d.speculateResults ?? []).map((r) =>
    r.status === "done" ? `${r.title} — ${r.ref}` : r.status === "failed" ? `${r.title} — failed` : `${r.title} — still running`,
  ));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/speculate-brief.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/briefs.ts test/speculate-brief.test.ts
git commit -m "feat(speculate): morning-brief 'Speculate — researched overnight' section"
```

---

## Final verification (after all tasks)

- [ ] Run the full suite: `npx vitest run` — expect all green (no regressions; ~14 new tests added over the baseline).
- [ ] Typecheck: `npx tsc --noEmit` — no errors.
- [ ] Build: `npm run build` — clean (confirms `dist/heartbeat/speculate.js` emits and the index wiring compiles).
- [ ] Grep the safety invariant: `grep -nE "gate\.propose|vault\.(write|writeNote)|email\.|bus\.emit" src/heartbeat/speculate.ts` → **zero matches** (runSpeculate only ever calls `jobs.createJob` + `store.kv*`). This is the read-only guarantee, checked mechanically.

## Notes for the implementer

- **Caveman house style** does not apply to code/commits — write normal prose in comments and commit messages (as the templates do).
- **Never `git add -A` / `git add -am`.** Stage only the explicit paths each commit lists. An unrelated pdf-attachments WIP (~12 modified + 3 untracked files) lives uncommitted in the working tree — leave it untouched; do not sweep it into any commit.
- **Subscription auth only** — `query()` takes NO `apiKey`; auth is `CLAUDE_CODE_OAUTH_TOKEN` from the environment. Copy `dreamRankLLM`'s options verbatim; do not add an `apiKey`.
- **ESM import specifiers end in `.js`** even for `.ts` sources (e.g. `from "./dream.js"`). Match the existing files.
- **Run tests with `npx vitest run`** (not watch mode). Single file: `npx vitest run test/<file>.test.ts`.
