# Goals "Memory" Implementation Plan

> ## ⛔ DO NOT EXECUTE AUTOMATICALLY — NOT STARTED
>
> Written 2026-08-03. **Execution is driven from the session that wrote it**, task by task with a review gate between each. Do not pick this up as an unattended work item.
>
> Task 4 and Task 5 delete six files between them. Task 1 rewrites `tokens.css`. None of that should land without a human seeing the RED state first.
>
> Once execution starts, treat the snippets below as intent, not truth — read the code.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Goals section as the org's memory — a recency-banded list and a vertical node thread — and fix the light-theme clock tokens that this exposes.

**Architecture:** Pure functions in `ui2/src/lib/` hold every decision (ordering, banding, status→colour); the views are assembly only. This mirrors how `lib/tide.ts` and `lib/field.ts` were built last cycle and is what makes the logic testable without jsdom. `MiniDag`'s SVG and its layout engine are replaced by DOM rows, so branch structure becomes text rather than geometry.

**Tech Stack:** React 19, TypeScript, Tailwind v4 (tokens via `@theme inline`), Vitest 3 + @testing-library/react + jsdom.

## Global Constraints

- **No raw hex outside `ui2/src/tokens.css`.** `test/design-doctrine.test.ts` §2 enforces it across `src/**/*.{ts,tsx,css}`.
- **No new `@keyframes`.** Any new animation must be added to the allowlist in `design-doctrine.test.ts` §6 *and* be bound to a real fact. This plan adds none — it reuses the existing `.breath` class.
- **No new dependencies, no new endpoints, no server changes.**
- **Every section view except Home must render inside `.page`** — `design-doctrine.test.ts` §4 checks `Goals.tsx` by name.
- **`toneOfStatus` must not be re-implemented locally** — `design-doctrine.test.ts` §5 greps for `function toneOfStatus` outside `ui.tsx`. The new `statusClock` is a *different* mapping (time relationship, not severity) and is fine.
- **Two test suites:** `npx vitest run` at the repo root does **not** include ui2's. Run `cd ui2 && npm test` as well.
- **Two typechecks:** `npx tsc --noEmit` at root **and** `cd ui2 && npm run typecheck`.
- **Read the "Tests" line, never exit codes**, and check for a separate `Errors` line — green Tests plus an Errors line is a failure.
- **Never pipe to `tail` before `&&`** — the pipeline exit code becomes `tail`'s and masks a failing `tsc`. Use `cmd > /tmp/x.log 2>&1; echo "EXIT=$?"`.

## Canonical status vocabularies

Copied verbatim from the source of truth; every mapping in this plan is closed over these.

- **Goal statuses** (`src/store/db.ts:7`): `planning | running | paused-budget | paused-user | paused-api | paused-session | replanning | done | failed | abandoned | awaiting-mail`
- **Node statuses** (`src/engine/reduce.ts:20` stored, `:84` derived): `pending | ready | running | done | failed | skipped | needs-review`

No string appears in both lists with a different meaning, so one `statusClock` function serves both.

## File structure

| File | Responsibility |
|---|---|
| `ui2/src/lib/thread.ts` | `threadOrder` (topological, stable) and `elapsed` (duration formatting) |
| `ui2/src/lib/goal-clock.ts` | `statusClock`, `CLOCK_TOKEN`, `CLOCK_TEXT`, `MUTED` — the one status→time-relationship mapping |
| `ui2/src/lib/goal-recency.ts` | `bandOf`, `BANDS`, `groupByBand` — recency banding for the list |
| `ui2/src/views/Thread.tsx` | Renders an ordered node list as DOM rows (replaces `MiniDag.tsx`) |
| `ui2/src/views/Goals.tsx` | Assembly only: `GoalList` + `GoalDetailView` |
| `ui2/src/tokens.css` | Light-theme clock values |
| `ui2/test/design-doctrine.test.ts` | Adds the contrast-ordering pin |

---

### Task 1: Light-theme clock tokens

Do this first. Every later task renders colour, and today the light theme silently inverts the clock axis.

**Files:**
- Modify: `ui2/test/design-doctrine.test.ts` (append one `it` block inside the existing `describe`)
- Modify: `ui2/src/tokens.css:59-68`

**Interfaces:**
- Consumes: nothing.
- Produces: `--t-now` / `--t-past` / `--t-next` / `--t-rest` are theme-correct, so `bg-now`, `text-now`, `bg-past`, `text-past`, `bg-next`, `text-next`, `bg-rest`, `text-rest` are legible in both themes. Tasks 3-6 rely on this.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("design doctrine (DESIGN.md)")` block in `ui2/test/design-doctrine.test.ts`:

```ts
  it("§2 the clock axis keeps its loudness order in BOTH themes", () => {
    // The light block used to repeat the dark values verbatim, which inverted the
    // axis: --now fell to 1.57:1 and --past rose to 6.30:1, so the live thing
    // vanished and the finished thing shouted. Pin the ORDER, not the hexes.
    const css = readFileSync(join(SRC, "tokens.css"), "utf8");

    const luminance = (hex: string): number => {
      const ch = [1, 3, 5]
        .map((i) => parseInt(hex.substr(i, 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    const contrast = (a: string, b: string): number => {
      const [x, y] = [luminance(a), luminance(b)];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    // Grab a theme block's body by its selector, then read tokens out of it.
    const block = (selector: string): Record<string, string> => {
      const start = css.indexOf(selector);
      expect(start, `${selector} must exist in tokens.css`).toBeGreaterThan(-1);
      const body = css.slice(start, css.indexOf("}", start));
      return Object.fromEntries(
        [...body.matchAll(/(--t-[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]),
      );
    };

    for (const selector of [':root[data-theme="dark"]', ':root[data-theme="light"]']) {
      const t = block(selector);
      const bg = t["--t-bg"];
      const order = ["--t-now", "--t-next", "--t-past", "--t-rest"];
      const ratios = order.map((k) => contrast(t[k], bg));
      for (let i = 1; i < ratios.length; i++) {
        expect(
          ratios[i - 1],
          `${selector}: ${order[i - 1]} (${ratios[i - 1].toFixed(2)}:1) must be louder than ${order[i]} (${ratios[i].toFixed(2)}:1)`,
        ).toBeGreaterThan(ratios[i]);
      }
      // --now and --next carry text, so they must clear 4.5:1 outright.
      expect(ratios[0], `${selector}: --t-now must be text-legible`).toBeGreaterThanOrEqual(4.5);
      expect(ratios[1], `${selector}: --t-next must be text-legible`).toBeGreaterThanOrEqual(4.5);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ui2 && npx vitest run test/design-doctrine.test.ts 2>&1 | tee /tmp/t1.log
```

Expected: FAIL on the light block, with a message like
`:root[data-theme="light"]: --t-now (1.57:1) must be louder than --t-next (1.88:1)`.

The dark block must already pass (`now` 11.25:1 > `next` 9.38:1 > `past` 2.80:1 > `rest` 1.51:1 against `--t-bg: #0b0d12`).

- [ ] **Step 3: Write the fix**

In `ui2/src/tokens.css`, replace lines 59-68 (the comment plus the seven token lines inside `:root[data-theme="light"]`) with:

```css
  /* Identical to dark on purpose: Home's field does not follow the theme
     (spec 2026-08-02 §9, option A). Only these three — the clock tokens below
     DO get light values, because Goals follows the toggle (spec 2026-08-03 §3). */
  --t-field-base: #07090f;
  --t-field-bloom: #16233f;
  --t-field-mid: #0a0e18;
  /* Tuned so now > next > past > rest holds against --t-bg in BOTH themes.
     The dark hexes here would invert it: --now reads 1.57:1 on #f4f4f2. */
  --t-now: #07663c;
  --t-past: #7e9488;
  --t-next: #3a5fd6;
  --t-rest: #c7ccd6;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ui2 && npx vitest run test/design-doctrine.test.ts 2>&1 | tee /tmp/t1.log
```

Expected: PASS. Light ratios are `now` 6.41:1 > `next` 5.03:1 > `past` 2.94:1 > `rest` 1.46:1.

Then the whole ui2 suite, to catch anything asserting on the old values:

```bash
cd ui2 && npm test > /tmp/t1-all.log 2>&1; echo "EXIT=$?"; grep -E "Tests|Errors" /tmp/t1-all.log
```

Expected: a `Tests` line with 0 failed, and **no** `Errors` line.

- [ ] **Step 5: Commit**

```bash
git add ui2/src/tokens.css ui2/test/design-doctrine.test.ts
git commit -m "fix(ui2): give the light theme its own clock tokens

The light block repeated the dark values verbatim, which was correct while
Home -- pinned .night -- was their only consumer. Goals follows the toggle,
and on #f4f4f2 those values invert the axis: --now falls to 1.57:1 and
--past rises to 6.30:1, so the live thing disappears and the finished thing
shouts.

Pins the ORDER rather than the hexes, in both blocks, so the values stay
tunable but the axis cannot silently reverse again."
```

---

### Task 2: `lib/thread.ts` — ordering and duration

**Files:**
- Create: `ui2/src/lib/thread.ts`
- Create: `ui2/test/thread.test.ts`

**Interfaces:**
- Consumes: `GoalNodeView` from `../api.js` (fields used: `key`, `deps`, `startedAt`, `finishedAt`).
- Produces:
  - `threadOrder(nodes: GoalNodeView[]): GoalNodeView[]`
  - `elapsed(startedAt: string | null, finishedAt: string | null, now?: number): string`
  - `showsDeps(node: GoalNodeView, previous: GoalNodeView | undefined): boolean`

  Task 4 (`Thread.tsx`) consumes all three.

- [ ] **Step 1: Write the failing test**

Create `ui2/test/thread.test.ts`:

```ts
// ui2/test/thread.test.ts — ordering, duration, and when a row must name its deps.
import { describe, it, expect } from "vitest";
import { threadOrder, elapsed, showsDeps } from "../src/lib/thread.js";
import type { GoalNodeView } from "../src/api.js";

const node = (key: string, deps: string[] = [], over: Partial<GoalNodeView> = {}): GoalNodeView => ({
  key, type: "task", agent: "clio", critic: null, brief: "", deps,
  status: "done", costCents: 0, rounds: 1, artifact: null, error: null,
  startedAt: null, finishedAt: null, ...over,
});

const keys = (ns: GoalNodeView[]) => ns.map((n) => n.key);

describe("threadOrder", () => {
  it("keeps a single node as-is", () => {
    expect(keys(threadOrder([node("a")]))).toEqual(["a"]);
  });

  it("orders a linear chain by dependency, not array order", () => {
    const out = threadOrder([node("c", ["b"]), node("a"), node("b", ["a"])]);
    expect(keys(out)).toEqual(["a", "b", "c"]);
  });

  it("breaks ties by original array index, so order is deterministic", () => {
    const out = threadOrder([node("x"), node("y"), node("z")]);
    expect(keys(out)).toEqual(["x", "y", "z"]);
    const reordered = threadOrder([node("z"), node("y"), node("x")]);
    expect(keys(reordered)).toEqual(["z", "y", "x"]);
  });

  it("places a fan-in node after both parents", () => {
    const out = threadOrder([node("join", ["a", "b"]), node("a"), node("b")]);
    expect(keys(out).indexOf("join")).toBeGreaterThan(keys(out).indexOf("a"));
    expect(keys(out).indexOf("join")).toBeGreaterThan(keys(out).indexOf("b"));
  });

  it("does not strand a node whose dep is absent from the set", () => {
    // canvas/Ask.tsx renders a goal's nodes directly; a dep naming something
    // outside the array must not swallow its dependent.
    const out = threadOrder([node("orphan", ["nope"]), node("a")]);
    expect(keys(out).sort()).toEqual(["a", "orphan"]);
  });

  it("terminates on a cycle instead of hanging", () => {
    const out = threadOrder([node("a", ["b"]), node("b", ["a"])]);
    expect(keys(out).sort()).toEqual(["a", "b"]);
  });
});

describe("elapsed", () => {
  const T0 = "2026-08-03T10:00:00.000Z";

  it("returns an em dash when there is no start", () => {
    // 3 of 107 stored nodes have a finished_at and no started_at.
    expect(elapsed(null, "2026-08-03T10:05:00.000Z")).toBe("—");
  });

  it("formats whole minutes", () => {
    expect(elapsed(T0, "2026-08-03T10:14:00.000Z")).toBe("14m");
  });

  it("formats sub-minute as <1m rather than 0m", () => {
    expect(elapsed(T0, "2026-08-03T10:00:20.000Z")).toBe("<1m");
  });

  it("formats hours and minutes", () => {
    expect(elapsed(T0, "2026-08-03T12:18:00.000Z")).toBe("2h 18m");
  });

  it("measures an unfinished node against now", () => {
    expect(elapsed(T0, null, Date.parse("2026-08-03T10:22:00.000Z"))).toBe("22m");
  });

  it("returns an em dash rather than a negative duration", () => {
    expect(elapsed("2026-08-03T10:05:00.000Z", T0)).toBe("—");
  });

  it("returns an em dash on an unparseable stamp", () => {
    expect(elapsed("not-a-date", T0)).toBe("—");
  });
});

describe("showsDeps", () => {
  it("is false for a node with no deps", () => {
    expect(showsDeps(node("a"), undefined)).toBe(false);
  });

  it("is false when the single dep is the row directly above", () => {
    expect(showsDeps(node("b", ["a"]), node("a"))).toBe(false);
  });

  it("is true when the single dep is NOT the row above", () => {
    expect(showsDeps(node("c", ["a"]), node("b"))).toBe(true);
  });

  it("is true whenever there is more than one dep", () => {
    expect(showsDeps(node("join", ["a", "b"]), node("b"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ui2 && npx vitest run test/thread.test.ts 2>&1 | tee /tmp/t2.log
```

Expected: FAIL — `Failed to resolve import "../src/lib/thread.js"`.

- [ ] **Step 3: Write the implementation**

Create `ui2/src/lib/thread.ts`:

```ts
// ui2/src/lib/thread.ts — how a goal's nodes are ordered and timed for the
// thread (spec 2026-08-03 §2). Pure: the view is assembly only.
import type { GoalNodeView } from "../api.js";

/** Topological order, ties broken by the node's original array index so the
 *  same payload always renders the same way. A dep naming a node outside the
 *  set is treated as already satisfied — canvas views render node arrays
 *  directly and must not lose rows to a dangling reference. */
export function threadOrder(nodes: GoalNodeView[]): GoalNodeView[] {
  const index = new Map(nodes.map((n, i) => [n.key, i]));
  const byIndex = (a: string, b: string) => index.get(a)! - index.get(b)!;
  const remaining = new Set(nodes.map((n) => n.key));
  const out: GoalNodeView[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining].filter((k) =>
      nodes[index.get(k)!].deps.every((d) => !remaining.has(d)),
    );
    // A cycle leaves nothing ready. The engine plans DAGs, but a bad payload
    // must not spin the UI — emit the lowest-index survivor and carry on.
    const batch = (ready.length > 0 ? ready : [[...remaining].sort(byIndex)[0]]).sort(byIndex);
    for (const k of batch) {
      out.push(nodes[index.get(k)!]);
      remaining.delete(k);
    }
  }
  return out;
}

/** Wall-clock duration, or an em dash when it cannot be known. */
export function elapsed(
  startedAt: string | null,
  finishedAt: string | null,
  now: number = Date.now(),
): string {
  if (!startedAt) return "—";
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Whether a row must spell out its dependencies. Only when reading the thread
 *  top-to-bottom would otherwise mislead: more than one parent, or a single
 *  parent that is not the row directly above. This is what lets the thread
 *  carry arbitrary DAGs without drawing any geometry. */
export function showsDeps(node: GoalNodeView, previous: GoalNodeView | undefined): boolean {
  if (node.deps.length === 0) return false;
  if (node.deps.length > 1) return true;
  return node.deps[0] !== previous?.key;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ui2 && npx vitest run test/thread.test.ts 2>&1 | tee /tmp/t2.log
```

Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add ui2/src/lib/thread.ts ui2/test/thread.test.ts
git commit -m "feat(ui2): thread ordering and duration for the Goals rework

threadOrder is Kahn's with a stable tie-break on the original array index,
so the same payload always renders identically. Deps naming nodes outside
the set are treated as satisfied -- the canvas views pass node arrays
directly and must not lose rows to a dangling reference -- and a cycle
terminates rather than spinning.

elapsed returns an em dash for the 3-of-107 stored nodes that carry a
finished_at with no started_at."
```

---

### Task 3: `lib/goal-clock.ts` and `lib/goal-recency.ts`

**Files:**
- Create: `ui2/src/lib/goal-clock.ts`
- Create: `ui2/src/lib/goal-recency.ts`
- Create: `ui2/test/goal-clock.test.ts`
- Create: `ui2/test/goal-recency.test.ts`

**Interfaces:**
- Consumes: `GoalView` from `../api.js` (fields used: `createdAt`, `status`).
- Produces:
  - `type Clock = "now" | "past" | "next" | "blocked"`
  - `statusClock(status: string): Clock`
  - `CLOCK_TOKEN: Record<Clock, string>` and `CLOCK_TEXT: Record<Clock, string>` — Tailwind class names
  - `isMuted(status: string): boolean`
  - `type Band = "live" | "today" | "week" | "earlier"`
  - `BANDS: Array<{ key: Band; label: string }>`
  - `bandOf(goal: GoalView, now: Date): Band`
  - `groupByBand(goals: GoalView[], now: Date): Array<{ key: Band; label: string; items: GoalView[] }>`

  Tasks 4, 5 and 6 consume these.

- [ ] **Step 1: Write the failing tests**

Create `ui2/test/goal-clock.test.ts`:

```ts
// ui2/test/goal-clock.test.ts — status → time relationship (spec 2026-08-03 §1).
import { describe, it, expect } from "vitest";
import { statusClock, isMuted, CLOCK_TOKEN, CLOCK_TEXT } from "../src/lib/goal-clock.js";

describe("statusClock", () => {
  it("maps in-flight goal statuses to now", () => {
    for (const s of ["planning", "running", "replanning", "awaiting-mail"]) {
      expect(statusClock(s), s).toBe("now");
    }
  });

  it("maps in-flight node statuses to now", () => {
    expect(statusClock("running")).toBe("now");
  });

  it("maps finished work to past", () => {
    for (const s of ["done", "abandoned", "skipped"]) expect(statusClock(s), s).toBe("past");
  });

  it("maps not-yet-started nodes to next", () => {
    for (const s of ["pending", "ready"]) expect(statusClock(s), s).toBe("next");
  });

  it("maps everything a human must unblock to blocked", () => {
    for (const s of [
      "failed", "needs-review",
      "paused-user", "paused-budget", "paused-api", "paused-session",
    ]) expect(statusClock(s), s).toBe("blocked");
  });

  it("routes an UNKNOWN status to blocked, never to healthy", () => {
    // Carried over from laneOf (goal-buckets.ts:44-47): a new backend status
    // must surface as needing attention, not hide as if fine.
    expect(statusClock("some-new-backend-status")).toBe("blocked");
    expect(statusClock("")).toBe("blocked");
  });
});

describe("isMuted", () => {
  it("mutes work that ended without succeeding", () => {
    expect(isMuted("abandoned")).toBe(true);
    expect(isMuted("skipped")).toBe(true);
  });

  it("does not mute work that finished fine", () => {
    expect(isMuted("done")).toBe(false);
    expect(isMuted("running")).toBe(false);
  });
});

describe("token maps", () => {
  it("cover every Clock value", () => {
    for (const c of ["now", "past", "next", "blocked"] as const) {
      expect(CLOCK_TOKEN[c], c).toBeTruthy();
      expect(CLOCK_TEXT[c], c).toBeTruthy();
    }
  });

  it("use token utilities, never raw colour", () => {
    for (const v of [...Object.values(CLOCK_TOKEN), ...Object.values(CLOCK_TEXT)]) {
      expect(v).toMatch(/^(bg|text)-[a-z]+$/);
    }
  });
});
```

Create `ui2/test/goal-recency.test.ts`:

```ts
// ui2/test/goal-recency.test.ts — recency banding (spec 2026-08-03 §1).
import { describe, it, expect } from "vitest";
import { bandOf, groupByBand, BANDS } from "../src/lib/goal-recency.js";
import type { GoalView } from "../src/api.js";

const NOW = new Date("2026-08-03T14:00:00.000Z");

const goal = (over: Partial<GoalView> = {}): GoalView => ({
  id: "g", slug: "g", title: "t", department: "ops", lead: "neo", originChannel: "web",
  status: "done", planSummary: "", replansUsed: 0, error: null,
  createdAt: "2026-08-03T09:00:00.000Z", updatedAt: "2026-08-03T09:00:00.000Z",
  projectDir: null, goalDir: null, nodes: [], ...over,
});

describe("bandOf", () => {
  it("puts anything still in flight in live, regardless of age", () => {
    for (const status of ["planning", "running", "replanning", "awaiting-mail"]) {
      expect(bandOf(goal({ status, createdAt: "2026-01-01T00:00:00.000Z" }), NOW), status).toBe("live");
    }
  });

  it("puts a goal needing the user in live too", () => {
    // A failed goal is not settled; burying it under EARLIER hides the one row
    // that most wants attention.
    expect(bandOf(goal({ status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }), NOW)).toBe("live");
  });

  it("bands a finished goal from today as today", () => {
    expect(bandOf(goal({ createdAt: "2026-08-03T02:00:00.000Z" }), NOW)).toBe("today");
  });

  it("uses local midnight as the today boundary", () => {
    const justBefore = new Date(NOW); justBefore.setHours(0, 0, 0, 0);
    const before = new Date(justBefore.getTime() - 1000).toISOString();
    const after = new Date(justBefore.getTime() + 1000).toISOString();
    expect(bandOf(goal({ createdAt: after }), NOW)).toBe("today");
    expect(bandOf(goal({ createdAt: before }), NOW)).toBe("week");
  });

  it("bands the last seven days as week", () => {
    expect(bandOf(goal({ createdAt: "2026-07-30T09:00:00.000Z" }), NOW)).toBe("week");
  });

  it("bands anything older as earlier", () => {
    expect(bandOf(goal({ createdAt: "2026-07-20T09:00:00.000Z" }), NOW)).toBe("earlier");
  });

  it("bands a future-dated goal as today rather than losing it", () => {
    // Clock skew between the daemon host and the browser must not make a row
    // vanish off the top of the list.
    expect(bandOf(goal({ createdAt: "2026-08-04T09:00:00.000Z" }), NOW)).toBe("today");
  });

  it("bands an unparseable date as earlier rather than throwing", () => {
    expect(bandOf(goal({ createdAt: "not-a-date" }), NOW)).toBe("earlier");
  });
});

describe("groupByBand", () => {
  it("returns bands in BANDS order and drops empty ones", () => {
    const out = groupByBand([
      goal({ id: "a", createdAt: "2026-07-20T09:00:00.000Z" }),
      goal({ id: "b", createdAt: "2026-08-03T09:00:00.000Z" }),
    ], NOW);
    expect(out.map((b) => b.key)).toEqual(["today", "earlier"]);
  });

  it("omits live entirely when nothing is live", () => {
    // Spec §1: absent, not empty-with-placeholder.
    const out = groupByBand([goal()], NOW);
    expect(out.some((b) => b.key === "live")).toBe(false);
  });

  it("sorts newest first inside a band", () => {
    const out = groupByBand([
      goal({ id: "older", createdAt: "2026-08-03T02:00:00.000Z" }),
      goal({ id: "newer", createdAt: "2026-08-03T11:00:00.000Z" }),
    ], NOW);
    expect(out[0].items.map((g) => g.id)).toEqual(["newer", "older"]);
  });

  it("labels every band it can emit", () => {
    expect(BANDS.map((b) => b.key)).toEqual(["live", "today", "week", "earlier"]);
    for (const b of BANDS) expect(b.label).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ui2 && npx vitest run test/goal-clock.test.ts test/goal-recency.test.ts 2>&1 | tee /tmp/t3.log
```

Expected: FAIL — both modules unresolved.

- [ ] **Step 3: Write the implementations**

Create `ui2/src/lib/goal-clock.ts`:

```ts
// ui2/src/lib/goal-clock.ts — the single status → TIME RELATIONSHIP mapping
// (spec 2026-08-03 §1; the axis is defined in 2026-08-02 §2).
//
// Distinct from toneOfStatus, which encodes SEVERITY for Command Deck views.
// Both exist on purpose; this one is the Organism axis.
//
// Goal statuses come from src/store/db.ts:7, node statuses from
// src/engine/reduce.ts:20 and :84. No string means different things in the two
// vocabularies, so one function serves both.

export type Clock = "now" | "past" | "next" | "blocked";

export const CLOCK_TOKEN: Record<Clock, string> = {
  now: "bg-now", past: "bg-past", next: "bg-next", blocked: "bg-accent",
};

export const CLOCK_TEXT: Record<Clock, string> = {
  now: "text-now", past: "text-past", next: "text-next", blocked: "text-accent",
};

/** awaiting-mail waits on the WORLD, not the user, so it is in flight — the
 *  same call laneOf made (goal-buckets.ts:40). */
const NOW = new Set(["planning", "running", "replanning", "awaiting-mail", "working", "executing"]);
const PAST = new Set(["done", "abandoned", "skipped"]);
const NEXT = new Set(["pending", "ready"]);
const BLOCKED = new Set([
  "failed", "needs-review",
  "paused-user", "paused-budget", "paused-api", "paused-session",
]);

export function statusClock(status: string): Clock {
  if (NOW.has(status)) return "now";
  if (PAST.has(status)) return "past";
  if (NEXT.has(status)) return "next";
  if (BLOCKED.has(status)) return "blocked";
  // An unrecognised status must surface as needing attention rather than hide
  // as if healthy. laneOf documented this at goal-buckets.ts:44-47 and the
  // property survives the rewrite.
  return "blocked";
}

/** Ended, but not well. Same colour as past, rendered quieter. */
const MUTED = new Set(["abandoned", "skipped"]);

export function isMuted(status: string): boolean {
  return MUTED.has(status);
}
```

Create `ui2/src/lib/goal-recency.ts`:

```ts
// ui2/src/lib/goal-recency.ts — which band a goal falls in (spec 2026-08-03 §1).
// Recency is the organising axis because status is near-constant across the
// corpus: 51 of 57 goals are done, so status carries almost no information.
import type { GoalView } from "../api.js";
import { statusClock } from "./goal-clock.js";

export type Band = "live" | "today" | "week" | "earlier";

export const BANDS: Array<{ key: Band; label: string }> = [
  { key: "live", label: "Live" },
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "earlier", label: "Earlier" },
];

const DAY_MS = 86_400_000;

export function bandOf(goal: GoalView, now: Date): Band {
  // Anything unsettled rides at the top no matter how old. A failed goal from
  // March still wants the user; burying it under EARLIER hides the row that
  // most needs them.
  const clock = statusClock(goal.status);
  if (clock === "now" || clock === "blocked") return "live";

  const created = Date.parse(goal.createdAt);
  if (Number.isNaN(created)) return "earlier";

  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  // A future stamp means clock skew between the daemon host and the browser.
  // Show it at the top rather than letting it fall off the axis.
  if (created >= midnight.getTime()) return "today";
  if (created >= midnight.getTime() - 7 * DAY_MS) return "week";
  return "earlier";
}

/** Bands in display order, newest first inside each, empty bands omitted —
 *  an empty band is a standing claim about the org that is not true. */
export function groupByBand(
  goals: GoalView[],
  now: Date,
): Array<{ key: Band; label: string; items: GoalView[] }> {
  return BANDS.map(({ key, label }) => ({
    key,
    label,
    items: goals
      .filter((g) => bandOf(g, now) === key)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  })).filter((b) => b.items.length > 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ui2 && npx vitest run test/goal-clock.test.ts test/goal-recency.test.ts 2>&1 | tee /tmp/t3.log
```

Expected: PASS, 21 tests.

- [ ] **Step 5: Commit**

```bash
git add ui2/src/lib/goal-clock.ts ui2/src/lib/goal-recency.ts ui2/test/goal-clock.test.ts ui2/test/goal-recency.test.ts
git commit -m "feat(ui2): status->clock and recency banding for Goals

statusClock is the Organism time-relationship axis (now/past/next/blocked),
distinct from toneOfStatus, which stays the Command Deck severity axis. It
covers both vocabularies -- goals from src/store/db.ts:7, nodes from
src/engine/reduce.ts:20 -- since no string means different things in each,
and preserves laneOf's safety property: an unknown backend status surfaces
as blocked, never as healthy.

bandOf keeps anything unsettled in LIVE regardless of age, so an old failed
goal cannot hide under EARLIER, and groupByBand omits empty bands outright."
```

---

### Task 4: `Thread.tsx` replaces `MiniDag`

**Files:**
- Create: `ui2/src/views/Thread.tsx`
- Delete: `ui2/src/views/MiniDag.tsx`, `ui2/src/views/dag-layout.ts`, `ui2/test/dag-layout.test.ts`
- Modify: `ui2/src/views/Goals.tsx:11,208`, `ui2/src/views/canvas/Goal.tsx:10,43`, `ui2/src/views/canvas/Ask.tsx:7,46`, `ui2/src/views/Setup.tsx:8,694`
- Create: `ui2/test/thread-render.test.tsx`

**Interfaces:**
- Consumes: `threadOrder`, `elapsed`, `showsDeps` (Task 2); `statusClock`, `CLOCK_TOKEN`, `CLOCK_TEXT`, `isMuted` (Task 3).
- Produces: `<Thread nodes={GoalNodeView[]} failedKey?={string} onSelect?={(key: string) => void} />`. Note `scale` is **gone**; `Goals.tsx:208` is the only caller that passed it.

- [ ] **Step 1: Write the failing test**

Create `ui2/test/thread-render.test.tsx`:

```tsx
// ui2/test/thread-render.test.tsx — the thread renders rows, not geometry.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Thread } from "../src/views/Thread.js";
import type { GoalNodeView } from "../src/api.js";

afterEach(cleanup);

const node = (key: string, over: Partial<GoalNodeView> = {}): GoalNodeView => ({
  key, type: "task", agent: "clio", critic: null, brief: "", deps: [],
  status: "done", costCents: 0, rounds: 1, artifact: null, error: null,
  startedAt: "2026-08-03T10:00:00.000Z", finishedAt: "2026-08-03T10:14:00.000Z", ...over,
});

describe("Thread", () => {
  it("renders one row per node, in dependency order", () => {
    render(<Thread nodes={[node("second", { deps: ["first"] }), node("first")]} />);
    const rows = screen.getAllByTestId("thread-row");
    expect(rows.map((r) => r.dataset.key)).toEqual(["first", "second"]);
  });

  it("shows agent, elapsed and cost", () => {
    render(<Thread nodes={[node("a", { agent: "vulcan", costCents: 44 })]} />);
    expect(screen.getByText("vulcan")).toBeTruthy();
    expect(screen.getByText("14m")).toBeTruthy();
    expect(screen.getByText("$0.44")).toBeTruthy();
  });

  it("names an artifact when the node produced one", () => {
    render(<Thread nodes={[node("a", { artifact: "deck.html" })]} />);
    expect(screen.getByText("deck.html")).toBeTruthy();
  });

  it("breathes only the running row", () => {
    render(<Thread nodes={[node("a"), node("b", { status: "running", finishedAt: null })]} />);
    const dots = screen.getAllByTestId("thread-dot");
    expect(dots[0].className).not.toContain("breath");
    expect(dots[1].className).toContain("breath");
  });

  it("prints 'after:' only where the linear reading would mislead", () => {
    render(<Thread nodes={[node("a"), node("b", { deps: ["a"] }), node("join", { deps: ["a", "b"] })]} />);
    // b's only dep is the row above it — silent. join has two — named.
    expect(screen.queryByText(/after: a$/)).toBeNull();
    expect(screen.getByText("after: a, b")).toBeTruthy();
  });

  it("renders a single-node goal with no spine and no deps line", () => {
    render(<Thread nodes={[node("only")]} />);
    expect(screen.getAllByTestId("thread-row")).toHaveLength(1);
    expect(screen.queryByText(/after:/)).toBeNull();
  });

  it("calls onSelect with the node key when a row is clicked", () => {
    const picked: string[] = [];
    render(<Thread nodes={[node("a"), node("b")]} onSelect={(k) => picked.push(k)} />);
    fireEvent.click(screen.getAllByTestId("thread-row")[1]);
    expect(picked).toEqual(["b"]);
  });

  it("renders nothing at all for an empty node list", () => {
    const { container } = render(<Thread nodes={[]} />);
    expect(container.textContent).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ui2 && npx vitest run test/thread-render.test.tsx 2>&1 | tee /tmp/t4.log
```

Expected: FAIL — `Failed to resolve import "../src/views/Thread.js"`.

- [ ] **Step 3: Write the implementation**

Create `ui2/src/views/Thread.tsx`:

```tsx
// ui2/src/views/Thread.tsx — a goal's nodes as a vertical thread (spec
// 2026-08-03 §2). Replaces MiniDag: 88% of goals are a single node or a
// linear chain, so branch structure is cheaper as text than as geometry.
import { threadOrder, elapsed, showsDeps } from "../lib/thread.js";
import { statusClock, CLOCK_TOKEN, CLOCK_TEXT, isMuted } from "../lib/goal-clock.js";
import { usd } from "../lib/format.js";
import type { GoalNodeView } from "../api.js";

export function Thread({ nodes, failedKey, onSelect }: {
  nodes: GoalNodeView[];
  failedKey?: string;
  onSelect?: (key: string) => void;
}) {
  if (nodes.length === 0) return null;
  const ordered = threadOrder(nodes);
  // A lone node has nothing to thread — drop the spine rather than draw a rule
  // down the side of one row.
  const spine = ordered.length > 1;

  return (
    <div className="flex flex-col">
      {ordered.map((n, i) => {
        const clock = statusClock(n.status);
        const blocked = n.key === failedKey || clock === "blocked";
        const tone = blocked ? "blocked" : clock;
        return (
          <div
            key={n.key}
            data-testid="thread-row"
            data-key={n.key}
            onClick={onSelect ? () => onSelect(n.key) : undefined}
            className={`flex gap-3 py-2 ${spine ? "border-l border-line pl-3" : ""} ${
              onSelect ? "cursor-pointer hover:bg-raised" : ""
            } ${isMuted(n.status) ? "opacity-55" : ""}`}
          >
            <span
              data-testid="thread-dot"
              className={`size-1.5 rounded-full shrink-0 mt-[7px] ${CLOCK_TOKEN[tone]} ${
                clock === "now" ? "breath" : ""
              }`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-[13px] text-strong truncate">{n.key}</span>
                <span className={`font-mono text-[10px] uppercase ${CLOCK_TEXT[tone]}`}>{n.status}</span>
                <span className="text-[11px] text-dim">{n.agent}</span>
                <span className="font-mono text-[10.5px] text-dim ml-auto shrink-0">
                  {elapsed(n.startedAt, n.finishedAt)}
                </span>
                <span className="font-mono text-[10.5px] text-dim shrink-0">{usd(n.costCents)}</span>
              </div>
              {showsDeps(n, ordered[i - 1]) && (
                <div className="text-[10.5px] text-dim mt-0.5">after: {n.deps.join(", ")}</div>
              )}
              {n.artifact && <div className="text-[10.5px] text-info mt-0.5 truncate">{n.artifact}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ui2 && npx vitest run test/thread-render.test.tsx 2>&1 | tee /tmp/t4.log
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Convert the four call sites**

In `ui2/src/views/Goals.tsx`, replace line 11:

```tsx
import { MiniDag } from "./MiniDag.js";
```

with:

```tsx
import { Thread } from "./Thread.js";
```

and line 208:

```tsx
          <MiniDag nodes={goal.nodes} failedKey={failedKey} scale={1} onSelect={setNodeKey} />
```

with:

```tsx
          <Thread nodes={goal.nodes} failedKey={failedKey} onSelect={setNodeKey} />
```

In `ui2/src/views/canvas/Goal.tsx`, replace line 10 `import { MiniDag } from "../MiniDag.js";` with `import { Thread } from "../Thread.js";`, and line 43:

```tsx
      <MiniDag nodes={goal.nodes} failedKey={failedNode?.key} />
```

with:

```tsx
      <Thread nodes={goal.nodes} failedKey={failedNode?.key} />
```

Also update the file's header comment on line 1, which says "failed node in the mini DAG":

```tsx
// ui2/src/views/canvas/Goal.tsx — failed/paused goal: error, failed node in the thread, cost, actions.
```

In `ui2/src/views/canvas/Ask.tsx`, replace line 7 `import { MiniDag } from "../MiniDag.js";` with `import { Thread } from "../Thread.js";`, and line 46 `<MiniDag nodes={goal.nodes} />` with `<Thread nodes={goal.nodes} />`.

In `ui2/src/views/Setup.tsx`, replace line 8 `import { MiniDag } from "./MiniDag.js";` with `import { Thread } from "./Thread.js";`, and line 694 `{g.nodes.length > 0 && <MiniDag nodes={g.nodes} />}` with `{g.nodes.length > 0 && <Thread nodes={g.nodes} />}`. Update the comment on line 543 so it no longer names the old component:

```tsx
 * watched — one Thread per goal it spawns, so this step and the cockpit draw the same pipeline.
```

- [ ] **Step 6: Delete the replaced code**

```bash
git rm ui2/src/views/MiniDag.tsx ui2/src/views/dag-layout.ts ui2/test/dag-layout.test.ts
```

- [ ] **Step 7: Verify nothing still references the old names**

```bash
cd ui2 && grep -rn "MiniDag\|dag-layout" src/ test/; echo "EXIT=$? (1 == clean)"
```

Expected: no output, `EXIT=1`.

- [ ] **Step 8: Run the full ui2 suite and typecheck**

```bash
cd ui2 && npm test > /tmp/t4-all.log 2>&1; echo "TEST_EXIT=$?"; grep -E "Tests|Errors" /tmp/t4-all.log
cd ui2 && npm run typecheck > /tmp/t4-tsc.log 2>&1; echo "TSC_EXIT=$?"; cat /tmp/t4-tsc.log
```

Expected: `Tests` line with 0 failed, **no** `Errors` line, `TSC_EXIT=0`.

**`test/setup-first-job.test.tsx:91` is the one at risk** — it asserts `screen.getByText("research")` with the comment *"MiniDag drew the spawned goal"*. Thread renders `n.agent` as its own text node, so it should still pass. If it fails, the fix is to assert on what Thread actually renders, and to update the stale comment to say Thread. Do not delete the assertion.

- [ ] **Step 9: Commit**

```bash
git add -A ui2/src/views ui2/test
git commit -m "refactor(ui2): replace the goal DAG with a vertical thread

88% of stored goals are a single node or a linear chain and only 7 of 57
branch at all, so dag-layout.ts solved a layout problem the data does not
have. Branches become text -- a row prints 'after: a, b' only when reading
top-to-bottom would mislead -- which handles arbitrary DAGs with no geometry.

All four call sites convert together. Two of them, canvas/Goal and
canvas/Ask, render inside Home's queue sheet and had been leaking Command
Deck tokens into the Organism surface; Setup.tsx:543 already stated the
intent that the wizard and cockpit draw the same pipeline.

Also removes the SMIL <animate> that MiniDag used for running nodes. It was
real data-bound motion, but it lived in SVG where the keyframe allowlist in
design-doctrine.test.ts cannot see it. The thread reuses .breath instead, so
the motion is now covered by doctrine."
```

---

### Task 5: `GoalList` becomes recency bands

**Files:**
- Modify: `ui2/src/views/Goals.tsx:26-116` (`DONE_CAP`, `GoalList`, `GoalCard`)
- Modify: `ui2/src/lib/goal-buckets.ts`
- Delete: `ui2/test/goal-lanes.test.ts`, `ui2/test/goal-buckets.test.ts`, `ui2/test/goal-kanban.test.tsx`
- Create: `ui2/test/goal-bands.test.tsx`

**Interfaces:**
- Consumes: `groupByBand`, `BANDS` (Task 3); `statusClock`, `CLOCK_TOKEN`, `CLOCK_TEXT`, `isMuted` (Task 3).
- Produces: `GoalList` keeps its existing export and `{ events }` props, so `test/goal-bands.test.tsx` and any future caller need no change.

- [ ] **Step 1: Write the failing test**

Create `ui2/test/goal-bands.test.tsx`:

```tsx
// ui2/test/goal-bands.test.tsx — recency bands replace the kanban lanes.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { GoalList } from "../src/views/Goals.js";
import { stubApi } from "./stubs.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const goal = (over: Record<string, unknown>) => ({
  id: "g", slug: "g", title: "t", department: "ops", lead: "neo", originChannel: "web",
  status: "done", planSummary: "", replansUsed: 0, error: null,
  createdAt: "2026-08-03T09:00:00.000Z", updatedAt: "2026-08-03T09:00:00.000Z",
  projectDir: null, goalDir: null,
  nodes: [{
    key: "a", type: "task", agent: "neo", critic: null, brief: "", deps: [],
    status: "done", costCents: 10, rounds: 1, artifact: null, error: null,
    startedAt: "2026-08-03T09:00:00.000Z", finishedAt: "2026-08-03T09:03:00.000Z",
  }],
  ...over,
});

/** Pin the clock so band boundaries are deterministic. */
const at = (iso: string) => { vi.useFakeTimers(); vi.setSystemTime(new Date(iso)); };

describe("Goals bands", () => {
  it("omits the LIVE band entirely when nothing is live", async () => {
    at("2026-08-03T14:00:00.000Z");
    stubApi({ "/api/goals": [goal({ id: "d1", slug: "d1", title: "Finished thing" })] });
    render(<GoalList events={[]} />);
    expect(await screen.findByText("Finished thing")).toBeTruthy();
    expect(screen.queryByText("Live")).toBeNull();
  });

  it("shows a running goal under LIVE", async () => {
    at("2026-08-03T14:00:00.000Z");
    stubApi({ "/api/goals": [goal({ id: "r1", slug: "r1", title: "Running thing", status: "running" })] });
    render(<GoalList events={[]} />);
    expect(await screen.findByText("Running thing")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("keeps an OLD failed goal in LIVE rather than burying it", async () => {
    at("2026-08-03T14:00:00.000Z");
    stubApi({ "/api/goals": [
      goal({ id: "f1", slug: "f1", title: "Old failure", status: "failed", createdAt: "2026-01-02T09:00:00.000Z" }),
    ] });
    render(<GoalList events={[]} />);
    expect(await screen.findByText("Old failure")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("splits finished goals across TODAY / THIS WEEK / EARLIER", async () => {
    at("2026-08-03T14:00:00.000Z");
    stubApi({ "/api/goals": [
      goal({ id: "a", slug: "a", title: "From today", createdAt: "2026-08-03T09:00:00.000Z" }),
      goal({ id: "b", slug: "b", title: "From this week", createdAt: "2026-07-30T09:00:00.000Z" }),
      goal({ id: "c", slug: "c", title: "From long ago", createdAt: "2026-06-01T09:00:00.000Z" }),
    ] });
    render(<GoalList events={[]} />);
    expect(await screen.findByText("Today")).toBeTruthy();
    expect(screen.getByText("This week")).toBeTruthy();
    expect(screen.getByText("Earlier")).toBeTruthy();
  });

  it("shows every goal — there is no Done cap any more", async () => {
    at("2026-08-03T14:00:00.000Z");
    stubApi({ "/api/goals": Array.from({ length: 12 }, (_, i) =>
      goal({ id: `d${i}`, slug: `d${i}`, title: `Done goal ${i}` })) });
    render(<GoalList events={[]} />);
    expect(await screen.findByText("Done goal 11")).toBeTruthy();
    expect(screen.queryByText(/Show all/)).toBeNull();
  });

  it("names the artifacts a goal produced", async () => {
    at("2026-08-03T14:00:00.000Z");
    stubApi({ "/api/goals": [goal({
      id: "a", slug: "a", title: "Made a deck",
      nodes: [{
        key: "a", type: "task", agent: "vulcan", critic: null, brief: "", deps: [],
        status: "done", costCents: 10, rounds: 1, artifact: "deck.html", error: null,
        startedAt: "2026-08-03T09:00:00.000Z", finishedAt: "2026-08-03T09:03:00.000Z",
      }],
    })] });
    render(<GoalList events={[]} />);
    expect(await screen.findByText("deck.html")).toBeTruthy();
  });

  it("filters by title substring", async () => {
    at("2026-08-03T14:00:00.000Z");
    stubApi({ "/api/goals": [
      goal({ id: "a", slug: "a", title: "Investor deck" }),
      goal({ id: "b", slug: "b", title: "Market analysis" }),
    ] });
    render(<GoalList events={[]} />);
    const box = await screen.findByPlaceholderText("filter…");
    fireEvent.change(box, { target: { value: "deck" } });
    expect(screen.getByText("Investor deck")).toBeTruthy();
    expect(screen.queryByText("Market analysis")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ui2 && npx vitest run test/goal-bands.test.tsx 2>&1 | tee /tmp/t5.log
```

Expected: FAIL — the current `GoalList` renders lanes, so `screen.queryByText("Live")` is null where the test wants it present, and `findByPlaceholderText("filter…")` finds nothing.

- [ ] **Step 3: Rewrite `GoalList` and `GoalCard`**

In `ui2/src/views/Goals.tsx`, replace lines 26-116 (`const DONE_CAP` through the end of `GoalCard`) with:

```tsx
export function GoalList({ events }: { events: StoredEvent[] }) {
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  const [dept, setDept] = useState<string>("");
  const [q, setQ] = useState("");
  if (!goals) return <Empty>Loading…</Empty>;

  const depts = [...new Set(goals.map((g) => g.department))].sort();
  const needle = q.trim().toLowerCase();
  const filtered = goals.filter((g) =>
    (!dept || g.department === dept) && (!needle || g.title.toLowerCase().includes(needle)));

  const weekAgo = Date.now() - 7 * 86_400_000;
  const weekCost = filtered
    .filter((g) => Date.parse(g.createdAt) >= weekAgo)
    .reduce((s, g) => s + g.nodes.reduce((n, x) => n + x.costCents, 0), 0);

  const bands = groupByBand(filtered, new Date());

  return (
    <div>
      <PageHeader title="Goals" meta={`${filtered.length} total · ${usd(weekCost)} this week`}>
        <select value={dept} onChange={(e) => setDept(e.target.value)}
          className="bg-surface border border-line rounded-md px-2 py-1 text-[12px] text-fg outline-none">
          <option value="">all departments</option>
          {depts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…"
          className="bg-surface border border-line rounded-md px-2 py-1 text-[12px] text-fg outline-none focus:border-dim w-40" />
      </PageHeader>

      {bands.length === 0 && <Empty>No goals yet</Empty>}

      {bands.map(({ key, label, items }) => (
        <div key={key} className="mb-7">
          <div className="label mb-2 flex items-center gap-2">
            {label}
            <span className="h-px flex-1 bg-line" />
            <span className="font-mono text-[10px] text-dim">{items.length}</span>
          </div>
          {items.map((g) => <GoalRow key={g.id} g={g} />)}
        </div>
      ))}
    </div>
  );
}

const VIA: Record<string, string> = { chat: "via chat", mail: "via mail", speculate: "speculated" };

function GoalRow({ g }: { g: GoalView }) {
  const clock = statusClock(g.status);
  const done = g.nodes.filter((n) => n.status === "done").length;
  const cost = g.nodes.reduce((s, n) => s + n.costCents, 0);
  const current = g.nodes.find((n) => statusClock(n.status) === "now");
  const artifacts = g.nodes.map((n) => n.artifact).filter((a): a is string => Boolean(a));

  return (
    <button onClick={() => navigate(`goals/${g.slug}`)}
      className={`w-full text-left flex gap-3 py-2.5 px-1 rounded-md hover:bg-raised ${
        isMuted(g.status) ? "opacity-55" : ""}`}>
      <span className={`size-1.5 rounded-full shrink-0 mt-[7px] ${CLOCK_TOKEN[clock]} ${
        clock === "now" ? "breath" : ""}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] text-bright truncate">{g.title}</span>
          <span className="text-[11px] text-dim shrink-0 ml-auto">{g.department} · {g.lead}</span>
        </div>
        <div className="flex items-baseline gap-2 mt-0.5 flex-wrap">
          <span className={`font-mono text-[10px] uppercase ${CLOCK_TEXT[clock]}`}>{g.status}</span>
          <span className="text-[10.5px] text-dim">
            {g.nodes.length === 1 ? "1 node" : `node ${done} of ${g.nodes.length}`}
          </span>
          {current && <span className="text-[10.5px] text-agent truncate">→ {current.key} · {current.agent}</span>}
          <span className="text-[10.5px] text-dim">{VIA[provenance(g.originChannel)]}</span>
          {artifacts.length > 0 && (
            <span className="text-[10.5px] text-info truncate">{artifacts.join(" · ")}</span>
          )}
          {cost > 0 && <span className="font-mono text-[10.5px] text-dim ml-auto shrink-0">{usd(cost)}</span>}
        </div>
      </div>
    </button>
  );
}
```

Then fix the imports at the top of `Goals.tsx`. Replace lines 7-11 with:

```tsx
import { provenance } from "../lib/goal-buckets.js";
import { groupByBand } from "../lib/goal-recency.js";
import { statusClock, CLOCK_TOKEN, CLOCK_TEXT, isMuted } from "../lib/goal-clock.js";
import { Button, Empty, PageHeader, SectionLabel, Tag, toneOfStatus } from "../components/ui.js";
import { TwoStepButton } from "../components/TwoStepButton.js";
import { ts, usd } from "../lib/format.js";
import { Thread } from "./Thread.js";
```

`Dot` and `Segments` are no longer imported here — `Segments` stays in `ui.tsx` for `canvas/OrgPulse.tsx:55`. `ts` is still used by `GoalDetailView`.

- [ ] **Step 4: Prune `goal-buckets.ts`**

Replace the entire contents of `ui2/src/lib/goal-buckets.ts` with:

```ts
// ui2/src/lib/goal-buckets.ts — provenance chip for the Goals list.
//
// LANES/laneOf and BUCKETS/bucketOf lived here for the Command Deck kanban.
// Recency bands replaced the lanes (spec 2026-08-03 §1), and BUCKETS was
// exported and unit-tested but rendered by no view. The one surviving
// property of laneOf -- an unknown status must surface, never hide as
// healthy -- moved to statusClock in goal-clock.ts.
export function provenance(originChannel: string): "mail" | "speculate" | "chat" {
  if (originChannel === "mail") return "mail";
  if (originChannel === "speculate" || originChannel === "dream") return "speculate";
  return "chat";
}
```

- [ ] **Step 5: Delete the tests for the deleted code**

```bash
git rm ui2/test/goal-lanes.test.ts ui2/test/goal-buckets.test.ts ui2/test/goal-kanban.test.tsx
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd ui2 && npx vitest run test/goal-bands.test.tsx 2>&1 | tee /tmp/t5.log
cd ui2 && npm test > /tmp/t5-all.log 2>&1; echo "TEST_EXIT=$?"; grep -E "Tests|Errors" /tmp/t5-all.log
cd ui2 && npm run typecheck > /tmp/t5-tsc.log 2>&1; echo "TSC_EXIT=$?"; cat /tmp/t5-tsc.log
```

Expected: 7 tests pass in `goal-bands`, whole suite green with no `Errors` line, `TSC_EXIT=0`.

- [ ] **Step 7: Commit**

```bash
git add -A ui2/src ui2/test
git commit -m "feat(ui2): Goals list becomes recency bands

Status is near-constant across the corpus -- 51 of 57 goals are done -- so
three status lanes gave equal thirds to buckets whose real sizes were 1/0/51,
and hid the 51 behind a DONE_CAP of 10. Recency is the axis the data actually
varies on.

The LIVE band is absent when nothing is live rather than empty-with-a-
placeholder, the same discipline that made Home's stillness mean something.
Anything unsettled stays in LIVE regardless of age, so an old failed goal
cannot bury itself under EARLIER.

Artifact filenames come free -- GoalView.nodes[].artifact already ships in
the list payload, so naming produced files needs no server change.

Drops LANES/laneOf and BUCKETS/bucketOf; the latter was exported and tested
but rendered by no view."
```

---

### Task 6: `GoalDetailView` restyle and final verification

**Files:**
- Modify: `ui2/src/views/Goals.tsx` (`GoalDetailView`, `ArtifactPreview`)
- Create: `ui2/test/goal-detail.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 2-5.
- Produces: nothing new. This task closes the section.

- [ ] **Step 1: Write the failing test**

Create `ui2/test/goal-detail.test.tsx`:

```tsx
// ui2/test/goal-detail.test.tsx — detail view: thread, inspector, ask box.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Goals } from "../src/views/Goals.js";
import { stubApi } from "./stubs.js";

afterEach(cleanup);

const NODE = {
  key: "build-deck", type: "task", agent: "vulcan", critic: null, brief: "Build it", deps: [],
  status: "done", costCents: 44, rounds: 1, artifact: "deck.html", error: null,
  startedAt: "2026-08-03T10:00:00.000Z", finishedAt: "2026-08-03T10:22:00.000Z",
};

const DETAIL = {
  id: "g1", slug: "deck", title: "Render the deck", department: "engineering", lead: "atlas",
  originChannel: "web", status: "done", planSummary: "Two steps", replansUsed: 0, error: null,
  createdAt: "2026-08-03T09:00:00.000Z", updatedAt: "2026-08-03T10:22:00.000Z",
  projectDir: null, goalDir: "/g", nodes: [NODE],
  artifacts: [{ file: "deck.html", content: "<h1>hi</h1>" }],
  spawnedBy: null, awaitingUserAsk: null,
};

const route = { section: "goals" as const, parts: ["deck"] };

describe("Goal detail", () => {
  it("renders the thread and the inspector for the node", async () => {
    stubApi({ "/api/goal/deck": DETAIL });
    render(<Goals events={[]} route={route} onOpenChat={() => {}} />);
    expect(await screen.findByText("Render the deck")).toBeTruthy();
    expect(screen.getAllByTestId("thread-row")).toHaveLength(1);
    expect(screen.getByText("Build it")).toBeTruthy();   // inspector brief
    expect(screen.getByText("22m")).toBeTruthy();        // thread elapsed
  });

  it("surfaces the question when a goal is awaiting the user", async () => {
    stubApi({ "/api/goal/deck": {
      ...DETAIL, status: "awaiting-mail",
      awaitingUserAsk: { mailId: "m1", question: "Which repo?", from: "clio" },
    } });
    render(<Goals events={[]} route={route} onOpenChat={() => {}} />);
    expect(await screen.findByText("Which repo?")).toBeTruthy();
    expect(screen.getByPlaceholderText(/Your answer resumes the goal/)).toBeTruthy();
  });

  it("shows the node error when one failed", async () => {
    stubApi({ "/api/goal/deck": {
      ...DETAIL, status: "failed",
      nodes: [{ ...NODE, status: "failed", error: "ENOENT vault/notes" }],
    } });
    render(<Goals events={[]} route={route} onOpenChat={() => {}} />);
    expect(await screen.findByText("ENOENT vault/notes")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ui2 && npx vitest run test/goal-detail.test.tsx 2>&1 | tee /tmp/t6.log
```

Expected: FAIL on the first test — `getAllByTestId("thread-row")` finds nothing until `GoalDetailView` renders `Thread`, which Task 4 Step 5 already wired. If Task 4 was completed, this test may pass on the first two cases and fail only where the restyle is missing. Record which assertions fail before changing anything.

- [ ] **Step 3: Restyle the detail header and inspector**

In `ui2/src/views/Goals.tsx`, in `GoalDetailView`, replace the inspector block (the `{node && ( … )}` JSX, currently lines 210-222) with:

```tsx
        {node && (
          <div className="panel lg:w-96 shrink-0 p-4 h-fit">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-strong">{node.key}</span>
              <span className={`font-mono text-[10px] uppercase ${CLOCK_TEXT[statusClock(node.status)]}`}>
                {node.status}
              </span>
              <span className="text-[11px] text-dim ml-auto">
                {node.agent} · rounds {node.rounds} · {usd(node.costCents)}
              </span>
            </div>
            <div className="text-[12px] text-dim whitespace-pre-wrap mb-3">{node.brief}</div>
            {node.error && <pre className="text-[11px] text-err whitespace-pre-wrap mb-3">{node.error}</pre>}
            {node.artifact && <ArtifactPreview goalArtifacts={goal.artifacts} file={node.artifact} />}
            <Button onClick={() => onOpenChat(node.agent, `About node "${node.key}" of goal "${goal.title}": `)}>Discuss ⌘J</Button>
          </div>
        )}
```

Then replace the `<Tag tone={toneOfStatus(goal.status)}>{goal.status}</Tag>` on the header line (currently line 164) with the clock-axis equivalent:

```tsx
        <span className={`font-mono text-[11px] uppercase ${CLOCK_TEXT[statusClock(goal.status)]}`}>{goal.status}</span>
```

`Tag` and `toneOfStatus` may now be unused in this file. Remove them from the import on line 7 **only if** `npm run typecheck` reports them unused — `noUnusedLocals` will say so.

Also update the file header comment on line 1:

```tsx
// ui2/src/views/Goals.tsx — the org's memory: recency bands + node thread (spec 2026-08-03).
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ui2 && npx vitest run test/goal-detail.test.tsx 2>&1 | tee /tmp/t6.log
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Full verification, both suites and both typechecks**

```bash
cd /Users/ihabbishara/projects/AIOS
npx vitest run > /tmp/root-tests.log 2>&1; echo "ROOT_TESTS_EXIT=$?"; grep -E "Tests|Errors" /tmp/root-tests.log
npx tsc --noEmit > /tmp/root-tsc.log 2>&1; echo "ROOT_TSC_EXIT=$?"; cat /tmp/root-tsc.log
cd ui2 && npm test > /tmp/ui2-tests.log 2>&1; echo "UI2_TESTS_EXIT=$?"; grep -E "Tests|Errors" /tmp/ui2-tests.log
cd /Users/ihabbishara/projects/AIOS/ui2 && npm run typecheck > /tmp/ui2-tsc.log 2>&1; echo "UI2_TSC_EXIT=$?"; cat /tmp/ui2-tsc.log
cd /Users/ihabbishara/projects/AIOS/ui2 && npm run build > /tmp/ui2-build.log 2>&1; echo "BUILD_EXIT=$?"; tail -3 /tmp/ui2-build.log
```

Expected: both `Tests` lines with 0 failed and **no** `Errors` line on either; all four `*_EXIT=0`; build clean.

- [ ] **Step 6: Live walk against the stub harness**

The harness from the 2026-08-02 tide verification serves the real built bundle with a faked API and needs no daemon and no tokens. Extend its `/api/goals` and `/api/goal/:slug` routes to cover, one scenario at a time:

1. **Empty corpus** — `[]`. Expect `No goals yet`, no band headers.
2. **Only finished goals** — expect no `Live` header anywhere.
3. **One running goal plus finished ones** — expect `Live` present with exactly one row, breathing.
4. **An old failed goal** — expect it in `Live`, amber, not under `Earlier`.
5. **A branching goal** (`deps: ["a","b"]` on a third node) — expect exactly one `after: a, b` line.
6. **Light theme** — toggle and confirm the running row's status text stays legible and louder than a finished row's.

Screenshot each. Scenario 6 is the one that unit tests cannot prove.

- [ ] **Step 7: Commit**

```bash
git add -A ui2/src ui2/test
git commit -m "feat(ui2): Goals detail on the clock axis

Header and inspector state now read on the time-relationship axis rather
than the Command Deck severity tones, so the detail view matches the list
and the thread above it.

Closes the Goals section rework: list, detail, thread and inspector are all
Organism, and the section follows the light/dark toggle rather than
inheriting Home's pinned .night."
```

---

## Self-review

**Spec coverage.** Every section of `2026-08-03-goals-memory-design.md` maps to a task: §1 list → Tasks 3, 5; §1 colour axis → Task 3; §1 removals → Task 5; §2 thread → Tasks 2, 4; §2 call sites → Task 4 Step 5; §3 ground and light tokens → Task 1; §4 data flow → unchanged, asserted by the render tests continuing to pass; §5 error handling → Task 2 (`elapsed`) and Task 6 (node error test); §6 files → covered across tasks; §7 testing → each task's own test file plus Task 6 Step 5.

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries the actual code.

**Type consistency.** `threadOrder`, `elapsed`, `showsDeps` are defined in Task 2 and consumed under those exact names in Task 4. `statusClock`, `CLOCK_TOKEN`, `CLOCK_TEXT`, `isMuted`, `groupByBand`, `BANDS` are defined in Task 3 and consumed under those exact names in Tasks 5 and 6. `Thread`'s props (`nodes`, `failedKey`, `onSelect`) match every call site written in Task 4 Step 5.

**Known risk, called out rather than hidden.** `test/setup-first-job.test.tsx:91` asserts on text that `MiniDag` rendered. Task 4 Step 8 says to verify it rather than assume, and to fix the assertion rather than delete it if it breaks.
