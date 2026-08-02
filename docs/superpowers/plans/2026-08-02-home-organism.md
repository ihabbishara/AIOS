# Home "Organism" Implementation Plan

> ## ⛔ DO NOT EXECUTE — COMPLETE
>
> All ten tasks were executed on 2026-08-02 (branch `home-organism`, 11 commits from `9a71def`). Merged to `main`. **This file is a record, not a work item.**
>
> **Several code snippets below are wrong, deliberately left un-back-edited.** Executing this plan would re-introduce three defects the execution found and fixed. Read the "Execution outcome" section at the bottom for what actually shipped and why it differs.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ui2's Home with a living field of agent dots over a day clock, whose proportions tide with how much work is running.

**Architecture:** Five pure modules in `ui2/src/lib/` hold all the logic (tide level, dot state, field layout, dock ordering, clock marks). Four presentational components in `ui2/src/views/home/` render them. `Home.tsx` becomes assembly only. The field reads `/api/org` — server-computed live-run state — never the client SSE buffer. No server code changes, no new endpoints, no new dependencies.

**Tech Stack:** React 19, TypeScript, Tailwind v4 (`@theme inline` over CSS custom properties), Vitest + @testing-library/react in jsdom.

## Global Constraints

- **No raw hex outside `ui2/src/tokens.css`.** `test/design-doctrine.test.ts` §2 fails the build otherwise. Every colour is a semantic token.
- **No new dependencies.** No new `package.json` entries.
- **No server changes.** No files under `src/` (repo root) are modified. All endpoints already exist.
- **`Queue.tsx`, `Canvas`, `src/lib/queue.ts` are reused unmodified.** Triage is relocated, not redesigned.
- **Motion is real or it doesn't exist.** Every animation binds to a fact. The keyframe allowlist in Task 1 enforces this mechanically.
- Test command: `cd ui2 && npx vitest run <file>`. Read the **"Tests" line**, never exit codes, and check for a separate `Errors` line — green Tests plus an Errors line is a failure.
- Typecheck: `cd ui2 && npm run typecheck`. `npm run build` is `vite build` and does **not** typecheck — never use it as verification.
- Import paths inside `ui2/src` use the `.js` extension (e.g. `from "../api.js"`), matching the existing codebase.

---

### Task 1: Tokens, motion keyframes, and the doctrine pin

**Files:**
- Modify: `ui2/src/tokens.css`
- Modify: `ui2/src/index.css`
- Modify: `ui2/DESIGN.md:96-98`
- Modify: `ui2/test/design-doctrine.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: CSS custom properties `--t-field-base`, `--t-field-bloom`, `--t-now`, `--t-past`, `--t-next`, `--t-rest`; Tailwind colour utilities `bg-field-base`, `text-now`, `bg-rest` etc. via `@theme inline`; CSS classes `.field-ground`, `.breath`, `.travel`; the keyframe allowlist test.

- [ ] **Step 1: Write the failing doctrine test**

Append this case inside the existing `describe("design doctrine (DESIGN.md)")` block in `ui2/test/design-doctrine.test.ts`:

```ts
  it("§6 motion is real — every @keyframes is on the allowlist", () => {
    // Adding an animation must be a deliberate amendment here, not a drive-by.
    // Each name below is bound to a fact in 2026-08-02-home-organism-design.md §5.
    const allowed = new Set([
      "breathe",    // an agent is mid-turn
      "travel",     // one mail.sent crossed between two agents
      "arrive",     // a row/chip newly entered the queue
      "edge-flash", // paired with arrive
      "shimmer",    // a node is executing
      "tick",       // a count changed
      "orb-pulse",  // the mic is recording
    ]);
    const css = readFileSync(join(SRC, "index.css"), "utf8");
    const found = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((n) => !allowed.has(n))).toEqual([]);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ui2 && npx vitest run test/design-doctrine.test.ts`
Expected: FAIL — `index.css` has no `travel` keyframe yet, so the assertion passes vacuously on the allowlist but `found` still contains only the six existing names. Confirm the test **runs** and reports `Tests 4 passed`. Then temporarily add `@keyframes bogus { from {opacity:0} to {opacity:1} }` to `index.css`, re-run, and confirm it now FAILS with `bogus` in the array. **Remove the bogus keyframe before continuing.** This proves the check is not vacuous.

- [ ] **Step 3: Add the Organism tokens**

In `ui2/src/tokens.css`, inside the `:root[data-theme="dark"]` block, after `--t-card-shadow`:

```css
  /* Organism (spec 2026-08-02). The field is night in BOTH themes — see §9 — so these
     five live in the dark block and are re-declared identically in light. */
  --t-field-base: #07090f;
  --t-field-bloom: #16233f;
  --t-now: #7fd7a4;
  --t-past: #38624e;
  --t-next: #8fb4ff;
  --t-rest: #28314a;
```

Add the identical six lines inside `:root[data-theme="light"]` too, with this comment instead:

```css
  /* Identical to dark on purpose: Home's field does not follow the theme (spec §9).
     Chrome around it still does, via the tokens above. */
```

Then inside `@theme inline`, after `--color-agent`:

```css
  --color-field-base: var(--t-field-base);
  --color-field-bloom: var(--t-field-bloom);
  --color-now: var(--t-now);
  --color-past: var(--t-past);
  --color-next: var(--t-next);
  --color-rest: var(--t-rest);
```

- [ ] **Step 4: Add the ground and motion classes**

Append to `ui2/src/index.css`, before the `prefers-reduced-motion` block:

```css
/* Organism ground (spec 2026-08-02 §1) — a field with a light source, not a box.
   The grain is not decoration: a bloom this large bands on 8-bit displays and the
   noise dithers it away. Inline data URI, so no network request. */
.field-ground {
  background: radial-gradient(120% 100% at 50% 8%, var(--color-field-bloom) 0%, #0a0e18 58%, var(--color-field-base) 100%);
  position: relative;
}
.field-ground::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.035;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
}

/* Breath — a dot pulses ONLY while that agent is mid-turn. Reuses the existing
   `breathe` keyframe at the Organism tempo. */
.breath { animation: breathe 2.4s ease-in-out infinite; }
.approach { animation: breathe 2.6s ease-in-out infinite; }

/* Travel — fires once per mail.sent between two agents. `forwards` and no
   iteration count are the point: a loop would be a lie about traffic. */
@keyframes travel {
  from { background-position: -60px 0; }
  to { background-position: calc(100% + 60px) 0; }
}
.travel {
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--color-now), transparent);
  background-size: 60px 100%;
  background-repeat: no-repeat;
  animation: travel 2.8s ease-in-out 1 forwards;
}

/* Tide — the field/clock re-proportion. A transition, not a keyframe, so it
   cannot run on its own. */
.tide { transition: height 1400ms cubic-bezier(0.4, 0, 0.2, 1); }
```

There is one raw hex above (`#0a0e18`, the gradient's midpoint). It is in `index.css`, which the doctrine test **does** scan. Add it as a token instead: put `--t-field-mid: #0a0e18;` in both theme blocks and `--color-field-mid: var(--t-field-mid);` in `@theme inline`, then use `var(--color-field-mid)` in the gradient.

Extend the `prefers-reduced-motion` selector list to include the new classes:

```css
  .breathe, .breath, .approach, .arrive, .shimmer, .tick, .orb-ring, .travel { animation: none !important; }
```

- [ ] **Step 5: Rewrite the DESIGN.md motion rule**

Replace `ui2/DESIGN.md:97-98` (currently "Motion means liveness only… No decorative animation.") with:

```markdown
- Motion is real or it doesn't exist. Every animation on screen is bound to a fact:
  `breath` (an agent is mid-turn), `travel` (one mail.sent crossed, fires once — never
  loops), `approach` (the single nearest upcoming anchor), `arrive` (a row newly
  entered), `shimmer` (a node is executing), `tick` (a count changed), `orb-ring`
  (the mic is recording). Nothing animates for mood. At rest with an empty schedule,
  nothing on screen moves. `prefers-reduced-motion` kills all of it, so every state
  must also be legible in hue alone. New keyframes require amending the allowlist in
  `test/design-doctrine.test.ts`.
```

- [ ] **Step 6: Run the doctrine and theme tests**

Run: `cd ui2 && npx vitest run test/design-doctrine.test.ts test/theme.test.ts`
Expected: PASS. Confirm the `Tests` line and that no `Errors` line is present.

- [ ] **Step 7: Typecheck and commit**

```bash
cd ui2 && npm run typecheck
cd .. && git add ui2/src/tokens.css ui2/src/index.css ui2/DESIGN.md ui2/test/design-doctrine.test.ts
git commit -m "feat(ui2): Organism tokens, ground, and a motion allowlist

Colour stops encoding severity and starts encoding time relationship:
now / past / next, with amber reserved for a human being the blocker.
The doctrine test now pins every @keyframes to an allowlist so adding
an animation is a deliberate amendment rather than a drive-by."
```

---

### Task 2: Tide level and hysteresis

**Files:**
- Create: `ui2/src/lib/tide.ts`
- Create: `ui2/test/tide.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TideLevel = "high" | "mid" | "low"`
  - `TIDE_DWELL_MS: number` (8000)
  - `tideLevel(working: number): TideLevel`
  - `interface TideState { level: TideLevel; pending: TideLevel | null; since: number }`
  - `tideInit(working: number): TideState`
  - `tideStep(s: TideState, working: number, now: number): TideState`
  - `useTide(working: number): TideLevel`

- [ ] **Step 1: Write the failing test**

Create `ui2/test/tide.test.ts`:

```ts
// ui2/test/tide.test.ts — the anti-twitch gate. A level must not change on a
// blip; agents finish turns constantly and the page must not jump.
import { describe, it, expect } from "vitest";
import { tideLevel, tideInit, tideStep, TIDE_DWELL_MS } from "../src/lib/tide.js";

describe("tideLevel", () => {
  it("maps working count to three discrete levels", () => {
    expect(tideLevel(0)).toBe("low");
    expect(tideLevel(1)).toBe("mid");
    expect(tideLevel(2)).toBe("mid");
    expect(tideLevel(3)).toBe("high");
    expect(tideLevel(11)).toBe("high");
  });
});

describe("tideStep hysteresis", () => {
  it("holds the level until the new one has persisted for the dwell", () => {
    let s = tideInit(0);
    expect(s.level).toBe("low");
    s = tideStep(s, 3, 1000);           // high appears
    expect(s.level).toBe("low");        // not yet
    s = tideStep(s, 3, 1000 + TIDE_DWELL_MS - 1);
    expect(s.level).toBe("low");        // still not
    s = tideStep(s, 3, 1000 + TIDE_DWELL_MS);
    expect(s.level).toBe("high");       // committed
  });

  it("six count changes inside 4s produce zero level changes", () => {
    let s = tideInit(0);
    const counts = [3, 0, 4, 1, 5, 0];
    counts.forEach((c, i) => { s = tideStep(s, c, 500 * (i + 1)); });
    expect(s.level).toBe("low");
  });

  it("a return to the committed level cancels a pending change", () => {
    let s = tideInit(0);
    s = tideStep(s, 3, 1000);
    expect(s.pending).toBe("high");
    s = tideStep(s, 0, 2000);
    expect(s.pending).toBe(null);
    s = tideStep(s, 0, 2000 + TIDE_DWELL_MS * 2);
    expect(s.level).toBe("low");
  });

  it("restarts the dwell when the pending level itself changes", () => {
    let s = tideInit(0);
    s = tideStep(s, 3, 1000);                    // pending high
    s = tideStep(s, 1, 1000 + TIDE_DWELL_MS - 1); // pending flips to mid, clock restarts
    expect(s.pending).toBe("mid");
    s = tideStep(s, 1, 1000 + TIDE_DWELL_MS + 1); // dwell measured from the flip, not the first
    expect(s.level).toBe("low");
    s = tideStep(s, 1, 1000 + TIDE_DWELL_MS * 2);
    expect(s.level).toBe("mid");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui2 && npx vitest run test/tide.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/tide.js"`.

- [ ] **Step 3: Write the implementation**

Create `ui2/src/lib/tide.ts`:

```ts
// ui2/src/lib/tide.ts — how much of Home the field gets (spec 2026-08-02 §6).
// Three discrete levels, never a continuum: a continuum is unpredictable to use
// and impossible to assert on.
import { useEffect, useRef, useState } from "react";

export type TideLevel = "high" | "mid" | "low";

/** How long a new level must hold before it commits. Agents finish turns
 *  constantly; without this the page twitches on every agent.end. */
export const TIDE_DWELL_MS = 8000;

export function tideLevel(working: number): TideLevel {
  if (working >= 3) return "high";
  if (working >= 1) return "mid";
  return "low";
}

export interface TideState {
  level: TideLevel;
  /** The level trying to take over, or null when the input agrees with `level`. */
  pending: TideLevel | null;
  /** When `pending` was first observed. Meaningless while pending is null. */
  since: number;
}

export function tideInit(working: number): TideState {
  return { level: tideLevel(working), pending: null, since: 0 };
}

export function tideStep(s: TideState, working: number, now: number): TideState {
  const want = tideLevel(working);
  if (want === s.level) return s.pending === null ? s : { ...s, pending: null, since: 0 };
  // A different pending level restarts the clock — otherwise a flapping input
  // could ride an old timestamp across the threshold.
  if (want !== s.pending) return { ...s, pending: want, since: now };
  if (now - s.since >= TIDE_DWELL_MS) return { level: want, pending: null, since: 0 };
  return s;
}

/** Drives tideStep from the working count plus a ticker, because the dwell can
 *  elapse with no new event arriving. */
export function useTide(working: number): TideLevel {
  const [state, setState] = useState<TideState>(() => tideInit(working));
  const latest = useRef(working);
  latest.current = working;
  useEffect(() => {
    setState((s) => tideStep(s, working, Date.now()));
  }, [working]);
  useEffect(() => {
    const id = setInterval(() => setState((s) => tideStep(s, latest.current, Date.now())), 1000);
    return () => clearInterval(id);
  }, []);
  return state.level;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ui2 && npx vitest run test/tide.test.ts`
Expected: PASS, `Tests 5 passed`, no `Errors` line.

- [ ] **Step 5: Commit**

```bash
git add ui2/src/lib/tide.ts ui2/test/tide.test.ts
git commit -m "feat(ui2): tide level with an 8s hysteresis gate"
```

---

### Task 3: Dot state and field layout

**Files:**
- Create: `ui2/src/lib/field.ts`
- Create: `ui2/test/field.test.ts`

**Interfaces:**
- Consumes: `OrgDepartmentView`, `OrgAgentCard` from `../api.js`.
- Produces:
  - `type DotState = "now" | "waiting" | "rest"`
  - `stateOf(card: OrgAgentCard): DotState`
  - `DOT_TOKEN: Record<DotState, string>` — maps to Tailwind classes `bg-now` / `bg-needs` / `bg-rest`
  - `interface Cluster { department: string; dots: Array<{ name: string; title: string; state: DotState; currentTask: string | null; col: number; row: number }> }`
  - `fieldLayout(depts: OrgDepartmentView[]): Cluster[]`
  - `workingCount(depts: OrgDepartmentView[]): number`

- [ ] **Step 1: Write the failing test**

Create `ui2/test/field.test.ts`:

```ts
// ui2/test/field.test.ts — the field is a body, not a chart. Its one law is that
// a dot never moves: an agent lighting up must appear where it already was.
import { describe, it, expect } from "vitest";
import { stateOf, fieldLayout, workingCount } from "../src/lib/field.js";
import type { OrgDepartmentView, OrgAgentCard } from "../src/api.js";

const card = (name: string, status: OrgAgentCard["status"]): OrgAgentCard => ({
  name, title: "T", charter: "c", visibility: "shared", guarded: false,
  status, currentTask: status === "working" ? "node 3/5" : null, costTodayUsd: 0,
});

const org = (statuses: Array<OrgAgentCard["status"]>): OrgDepartmentView[] => [
  { department: "engineering", mission: "m", lead: "atlas",
    agents: [card("atlas", statuses[0]), card("vulcan", statuses[1]), card("odin", statuses[2])] },
  { department: "research", mission: "m", lead: "clio",
    agents: [card("clio", statuses[3]), card("janus", statuses[4])] },
];

describe("stateOf", () => {
  it("maps the three server statuses onto three dot states", () => {
    expect(stateOf(card("a", "working"))).toBe("now");
    expect(stateOf(card("a", "waiting"))).toBe("waiting");
    expect(stateOf(card("a", "idle"))).toBe("rest");
  });
});

describe("fieldLayout", () => {
  it("keeps every dot at the same coordinates when agents start working", () => {
    const quiet = fieldLayout(org(["idle", "idle", "idle", "idle", "idle"]));
    const busy = fieldLayout(org(["idle", "working", "idle", "working", "waiting"]));
    const coords = (cs: ReturnType<typeof fieldLayout>) =>
      cs.flatMap((c) => c.dots.map((d) => `${c.department}/${d.name}@${d.col},${d.row}`));
    expect(coords(busy)).toEqual(coords(quiet));
  });

  it("orders departments and agents deterministically regardless of input order", () => {
    const a = fieldLayout(org(["idle", "idle", "idle", "idle", "idle"]));
    const b = fieldLayout([...org(["idle", "idle", "idle", "idle", "idle"])].reverse());
    expect(a.map((c) => c.department)).toEqual(b.map((c) => c.department));
    expect(a[0].dots.map((d) => d.name)).toEqual(b[0].dots.map((d) => d.name));
  });

  it("wraps a cluster onto a second row past four agents", () => {
    const wide: OrgDepartmentView[] = [{
      department: "engineering", mission: "m", lead: "atlas",
      agents: ["a", "b", "c", "d", "e", "f"].map((n) => card(n, "idle")),
    }];
    const dots = fieldLayout(wide)[0].dots;
    expect(dots.map((d) => d.row)).toEqual([0, 0, 0, 0, 1, 1]);
    expect(dots.map((d) => d.col)).toEqual([0, 1, 2, 3, 0, 1]);
  });

  it("carries currentTask through so the field can caption itself", () => {
    const busy = fieldLayout(org(["working", "idle", "idle", "idle", "idle"]));
    expect(busy[0].dots[0].currentTask).toBe("node 3/5");
  });
});

describe("workingCount", () => {
  it("counts only working — waiting is blocked on a human, not running", () => {
    expect(workingCount(org(["working", "waiting", "idle", "working", "idle"]))).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui2 && npx vitest run test/field.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/field.js"`.

- [ ] **Step 3: Write the implementation**

Create `ui2/src/lib/field.ts`:

```ts
// ui2/src/lib/field.ts — the org as a body (spec 2026-08-02 §6).
// Note what is NOT a parameter here: the tide level. Position cannot depend on
// how busy the org is, so the layout function is structurally unable to move a
// dot when work starts. That is the "a dot never moves" rule, enforced by types.
import type { OrgAgentCard, OrgDepartmentView } from "../api.js";

export type DotState = "now" | "waiting" | "rest";

/** Tailwind classes, not hex — raw colour outside tokens.css fails the doctrine test. */
export const DOT_TOKEN: Record<DotState, string> = {
  now: "bg-now",
  waiting: "bg-needs",
  rest: "bg-rest",
};

export function stateOf(card: OrgAgentCard): DotState {
  if (card.status === "working") return "now";
  if (card.status === "waiting") return "waiting";
  return "rest";
}

export interface Cluster {
  department: string;
  dots: Array<{
    name: string;
    title: string;
    state: DotState;
    currentTask: string | null;
    col: number;
    row: number;
  }>;
}

/** Agents per cluster row before wrapping. */
const PER_ROW = 4;

export function fieldLayout(depts: OrgDepartmentView[]): Cluster[] {
  // Sorted, not input-ordered: /api/org iterates a Map and a registry reload
  // could otherwise silently reshuffle the whole field.
  return [...depts]
    .sort((a, b) => a.department.localeCompare(b.department))
    .map((d) => ({
      department: d.department,
      dots: [...d.agents]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((a, i) => ({
          name: a.name,
          title: a.title,
          state: stateOf(a),
          currentTask: a.currentTask,
          col: i % PER_ROW,
          row: Math.floor(i / PER_ROW),
        })),
    }));
}

export function workingCount(depts: OrgDepartmentView[]): number {
  return depts.reduce((n, d) => n + d.agents.filter((a) => a.status === "working").length, 0);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ui2 && npx vitest run test/field.test.ts`
Expected: PASS, `Tests 6 passed`.

- [ ] **Step 5: Commit**

```bash
git add ui2/src/lib/field.ts ui2/test/field.test.ts
git commit -m "feat(ui2): field layout where a dot never moves"
```

---

### Task 4: Dock ordering

**Files:**
- Create: `ui2/src/lib/dock.ts`
- Create: `ui2/test/dock.test.ts`

**Interfaces:**
- Consumes: `AttentionItem` from `../api.js`.
- Produces:
  - `interface DockChip { id: string; title: string; severity: number; fill: boolean }`
  - `DOCK_MAX: number` (3)
  - `dockChips(items: AttentionItem[]): { chips: DockChip[]; overflow: number }`

- [ ] **Step 1: Write the failing test**

Create `ui2/test/dock.test.ts`:

```ts
// ui2/test/dock.test.ts — severity lost its hue in the Organism palette (every
// attention row is amber), so it has to survive as order and as fill.
import { describe, it, expect } from "vitest";
import { dockChips, DOCK_MAX } from "../src/lib/dock.js";
import type { AttentionItem } from "../src/api.js";

const item = (id: string, severity: AttentionItem["severity"], ts: string): AttentionItem => ({
  kind: "approval", id, title: `T-${id}`, meta: "", severity, ts, actions: [], ref: {},
});

describe("dockChips", () => {
  it("orders by severity then newest first", () => {
    const { chips } = dockChips([
      item("c", 4, "2026-08-02T10:00:00.000Z"),
      item("a", 1, "2026-08-02T09:00:00.000Z"),
      item("b", 1, "2026-08-02T11:00:00.000Z"),
    ]);
    expect(chips.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("fills only severity 1 so the dock shows the shape of what is waiting", () => {
    const { chips } = dockChips([item("a", 1, "2026-08-02T09:00:00.000Z"), item("b", 2, "2026-08-02T09:00:00.000Z")]);
    expect(chips.map((c) => c.fill)).toEqual([true, false]);
  });

  it("caps at DOCK_MAX and reports the remainder", () => {
    const many = ["a", "b", "c", "d", "e"].map((id) => item(id, 2, "2026-08-02T09:00:00.000Z"));
    const { chips, overflow } = dockChips(many);
    expect(chips).toHaveLength(DOCK_MAX);
    expect(overflow).toBe(2);
  });

  it("reports no overflow for an empty queue", () => {
    expect(dockChips([])).toEqual({ chips: [], overflow: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui2 && npx vitest run test/dock.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/dock.js"`.

- [ ] **Step 3: Write the implementation**

Create `ui2/src/lib/dock.ts`:

```ts
// ui2/src/lib/dock.ts — the three chips that stand in for the queue (spec §7).
// Colour can no longer carry severity (everything needing a human is amber), so
// order carries it and fill marks the top rank.
import type { AttentionItem } from "../api.js";

export interface DockChip {
  id: string;
  title: string;
  severity: number;
  /** Solid amber for severity 1 (approvals); outline for everything else. */
  fill: boolean;
}

export const DOCK_MAX = 3;

export function dockChips(items: AttentionItem[]): { chips: DockChip[]; overflow: number } {
  const sorted = [...items].sort(
    (a, b) => a.severity - b.severity || b.ts.localeCompare(a.ts),
  );
  return {
    chips: sorted.slice(0, DOCK_MAX).map((i) => ({
      id: i.id, title: i.title, severity: i.severity, fill: i.severity === 1,
    })),
    overflow: Math.max(0, sorted.length - DOCK_MAX),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ui2 && npx vitest run test/dock.test.ts`
Expected: PASS, `Tests 4 passed`.

- [ ] **Step 5: Commit**

```bash
git add ui2/src/lib/dock.ts ui2/test/dock.test.ts
git commit -m "feat(ui2): dock chip ordering, severity as order and fill"
```

---

### Task 5: Clock marks and the schedule topic

**Files:**
- Create: `ui2/src/lib/clock.ts`
- Create: `ui2/test/clock.test.ts`
- Modify: `ui2/src/lib/topics.ts`
- Modify: `ui2/test/topics.test.ts`

**Interfaces:**
- Consumes: `ScheduleView` from `../api.js`.
- Produces:
  - `type MarkKind = "past" | "next" | "future"`
  - `interface ClockMark { key: string; label: string; hhmm: string; minutes: number; kind: MarkKind }`
  - `clockMarks(s: ScheduleView, now: Date): ClockMark[]`
  - `T.schedule` in `topics.ts`

- [ ] **Step 1: Write the failing test**

Create `ui2/test/clock.test.ts`:

```ts
// ui2/test/clock.test.ts — exactly one mark may pulse. "Approach" means the next
// thing that will happen, singular; two pulsing pins would be decoration.
import { describe, it, expect } from "vitest";
import { clockMarks } from "../src/lib/clock.js";
import type { ScheduleView } from "../src/api.js";

const schedule: ScheduleView = {
  anchors: [
    { name: "morning", hhmm: "08:00", overridden: false, firedToday: true },
    { name: "evening", hhmm: "21:30", overridden: false, firedToday: false },
  ],
  routines: [
    { id: 1, name: "inbox sweep", prompt: "p", recurrence: { kind: "daily", hhmm: "09:30" } as never,
      enabled: true, lastFiredAt: null, nextFire: "2026-08-02 09:30" },
  ],
  reminders: [{ id: 7, text: "renew domain", dueAt: "2026-08-02T12:00:00.000Z", origin: "user" }],
};

const at = (hhmm: string) => new Date(`2026-08-02T${hhmm}:00.000Z`);

describe("clockMarks", () => {
  it("marks a fired anchor as past", () => {
    const m = clockMarks(schedule, at("10:00")).find((x) => x.key === "anchor:morning");
    expect(m?.kind).toBe("past");
  });

  it("marks exactly one upcoming entry as next — the earliest", () => {
    const marks = clockMarks(schedule, at("10:00"));
    const next = marks.filter((m) => m.kind === "next");
    expect(next).toHaveLength(1);
    expect(next[0].key).toBe("reminder:7");
  });

  it("demotes everything after the next to future", () => {
    const marks = clockMarks(schedule, at("10:00"));
    expect(marks.find((m) => m.key === "anchor:evening")?.kind).toBe("future");
  });

  it("returns marks sorted by minutes from midnight", () => {
    const mins = clockMarks(schedule, at("10:00")).map((m) => m.minutes);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
  });

  it("has no next when everything has already fired", () => {
    const done: ScheduleView = { anchors: [{ name: "morning", hhmm: "08:00", overridden: false, firedToday: true }], routines: [], reminders: [] };
    expect(clockMarks(done, at("23:00")).some((m) => m.kind === "next")).toBe(false);
  });

  it("returns an empty list for an empty schedule", () => {
    expect(clockMarks({ anchors: [], routines: [], reminders: [] }, at("10:00"))).toEqual([]);
  });
});
```

Append this case to `ui2/test/topics.test.ts` (inside its existing top-level `describe`):

```ts
  it("schedule invalidates on the events that change firedToday", () => {
    expect(matches("brief.sent", T.schedule)).toBe(true);
    expect(matches("routine.due", T.schedule)).toBe(true);
    expect(matches("reminder.due", T.schedule)).toBe(true);
    expect(matches("agent.start", T.schedule)).toBe(false);
  });
```

Check the existing imports at the top of `topics.test.ts` — add `T` and/or `matches` to the import if either is missing.

- [ ] **Step 2: Run both to verify they fail**

Run: `cd ui2 && npx vitest run test/clock.test.ts test/topics.test.ts`
Expected: FAIL — unresolved `../src/lib/clock.js`, and `T.schedule` is `undefined` so `matches` throws.

- [ ] **Step 3: Add the topic**

In `ui2/src/lib/topics.ts`, inside the `T` object, after `budget`:

```ts
  /** What can change a schedule's firedToday / nextFire. Edits go through POST,
   *  so the mutating caller invalidates locally instead. */
  schedule: ["brief.sent", "routine.due", "reminder.due"],
```

- [ ] **Step 4: Write the clock module**

Create `ui2/src/lib/clock.ts`:

```ts
// ui2/src/lib/clock.ts — the day as an axis (spec 2026-08-02 §6).
import type { ScheduleView } from "../api.js";

export type MarkKind = "past" | "next" | "future";

export interface ClockMark {
  key: string;
  label: string;
  hhmm: string;
  /** Minutes from local midnight — the x position on the axis. */
  minutes: number;
  kind: MarkKind;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function hhmmOf(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function clockMarks(s: ScheduleView, now: Date): ClockMark[] {
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const raw: Array<Omit<ClockMark, "kind"> & { fired: boolean }> = [];

  for (const a of s.anchors) {
    raw.push({ key: `anchor:${a.name}`, label: a.name, hhmm: a.hhmm, minutes: toMinutes(a.hhmm), fired: a.firedToday });
  }
  for (const r of s.routines) {
    if (!r.enabled || !r.nextFire) continue;
    // nextFire is display-local "YYYY-MM-DD HH:MM" — take the clock part only.
    const hhmm = r.nextFire.slice(11, 16);
    raw.push({ key: `routine:${r.id}`, label: r.name, hhmm, minutes: toMinutes(hhmm), fired: false });
  }
  for (const rem of s.reminders) {
    const d = new Date(rem.dueAt);
    const hhmm = hhmmOf(d);
    raw.push({ key: `reminder:${rem.id}`, label: rem.text, hhmm, minutes: toMinutes(hhmm), fired: false });
  }

  raw.sort((a, b) => a.minutes - b.minutes);

  // Exactly one "next": the earliest thing still ahead. Everything else ahead is
  // future, so only one pin ever pulses.
  const nextKey = raw.find((m) => !m.fired && m.minutes > nowMin)?.key;
  return raw.map(({ fired, ...m }) => ({
    ...m,
    kind: fired || m.minutes <= nowMin ? "past" : m.key === nextKey ? "next" : "future",
  }));
}
```

- [ ] **Step 5: Run the tests**

Run: `cd ui2 && npx vitest run test/clock.test.ts test/topics.test.ts`
Expected: PASS. Confirm the `Tests` line covers both files and there is no `Errors` line.

- [ ] **Step 6: Commit**

```bash
git add ui2/src/lib/clock.ts ui2/test/clock.test.ts ui2/src/lib/topics.ts ui2/test/topics.test.ts
git commit -m "feat(ui2): clock marks with exactly one approaching pin"
```

---

### Task 6: The Field component

**Files:**
- Create: `ui2/src/views/home/Field.tsx`
- Create: `ui2/test/field-render.test.tsx`

**Interfaces:**
- Consumes: `Cluster`, `DOT_TOKEN` from `../../lib/field.js`; `TideLevel` from `../../lib/tide.js`.
- Produces: `Field({ clusters, level, live }: { clusters: Cluster[]; level: TideLevel; live: boolean })`.

- [ ] **Step 1: Write the failing test**

Create `ui2/test/field-render.test.tsx`:

```tsx
// ui2/test/field-render.test.tsx — the two claims the field makes: motion stops
// when the stream dies, and state is legible without motion at all.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Field } from "../src/views/home/Field.js";
import { fieldLayout } from "../src/lib/field.js";
import type { OrgDepartmentView, OrgAgentCard } from "../src/api.js";

afterEach(cleanup);

const card = (name: string, status: OrgAgentCard["status"]): OrgAgentCard => ({
  name, title: "T", charter: "c", visibility: "shared", guarded: false,
  status, currentTask: null, costTodayUsd: 0,
});

const clusters = fieldLayout([
  { department: "engineering", mission: "m", lead: "atlas", agents: [card("atlas", "working"), card("vulcan", "idle")] },
]);

describe("Field", () => {
  it("breathes a working dot while the stream is live", () => {
    const { container } = render(<Field clusters={clusters} level="high" live={true} />);
    expect(container.querySelectorAll(".breath")).toHaveLength(1);
  });

  it("stops all motion when the stream is down — a breathing dot on dead data is a lie", () => {
    const { container } = render(<Field clusters={clusters} level="high" live={false} />);
    expect(container.querySelectorAll(".breath")).toHaveLength(0);
  });

  it("distinguishes working from idle by hue, so reduced-motion still reads", () => {
    const { container } = render(<Field clusters={clusters} level="high" live={false} />);
    expect(container.querySelectorAll(".bg-now")).toHaveLength(1);
    expect(container.querySelectorAll(".bg-rest")).toHaveLength(1);
  });

  it("hides labels at the low tide but keeps every dot mounted", () => {
    const { container } = render(<Field clusters={clusters} level="low" live={true} />);
    expect(container.querySelectorAll("[data-dot]")).toHaveLength(2);
    expect(container.querySelector("[data-labels]")?.className).toContain("opacity-0");
  });

  it("shows a private agent — the owner's own body is not partial", () => {
    const withPrivate = fieldLayout([{
      department: "life", mission: "m", lead: null,
      agents: [{ ...card("hestia", "idle"), visibility: "private" }],
    }]);
    const { container } = render(<Field clusters={withPrivate} level="mid" live={true} />);
    expect(container.querySelectorAll("[data-dot]")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui2 && npx vitest run test/field-render.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/views/home/Field.js"`.

- [ ] **Step 3: Write the component**

Create `ui2/src/views/home/Field.tsx`:

```tsx
// ui2/src/views/home/Field.tsx — the org as a body (spec 2026-08-02 §6).
// The tide changes scale and label opacity, never structure: every dot stays
// mounted at every level so it cannot move when work starts.
import { DOT_TOKEN, type Cluster } from "../../lib/field.js";
import type { TideLevel } from "../../lib/tide.js";

const DOT_SIZE: Record<TideLevel, string> = { high: "size-2", mid: "size-2", low: "size-[5px]" };
const GAP: Record<TideLevel, string> = { high: "gap-8", mid: "gap-8", low: "gap-3" };

export function Field({ clusters, level, live }: {
  clusters: Cluster[];
  level: TideLevel;
  /** SSE connected. False freezes every animation — motion on stale data is a lie. */
  live: boolean;
}) {
  const compact = level === "low";
  return (
    <div className={`flex flex-wrap content-start ${GAP[level]} px-5 py-4 transition-all duration-[1400ms]`}>
      {clusters.map((c) => (
        <div key={c.department} className="flex flex-col">
          <div
            data-labels
            className={`label mb-2 transition-opacity duration-[1400ms] ${compact ? "opacity-0 h-0 mb-0" : "opacity-100"}`}
          >
            {c.department}
          </div>
          <div className={`grid ${compact ? "gap-1.5" : "gap-x-5 gap-y-4"}`} style={{ gridTemplateColumns: "repeat(4, min-content)" }}>
            {c.dots.map((d) => (
              <div key={d.name} style={{ gridColumn: d.col + 1, gridRow: d.row + 1 }} className="text-center">
                <div
                  data-dot={d.name}
                  title={d.currentTask ?? d.title}
                  className={`${DOT_SIZE[level]} rounded-full mx-auto transition-all duration-[1400ms] ${DOT_TOKEN[d.state]} ${
                    live && d.state === "now" ? "breath" : ""
                  }`}
                />
                <div className={`text-[9px] mt-1.5 transition-opacity duration-[1400ms] ${
                  compact ? "opacity-0" : d.state === "rest" ? "opacity-100 text-dim" : "opacity-100 text-fg"
                }`}>
                  {d.name}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ui2 && npx vitest run test/field-render.test.tsx`
Expected: PASS, `Tests 5 passed`.

- [ ] **Step 5: Commit**

```bash
git add ui2/src/views/home/Field.tsx ui2/test/field-render.test.tsx
git commit -m "feat(ui2): Field component — dots breathe only on live data"
```

---

### Task 7: The Clock component

**Files:**
- Create: `ui2/src/views/home/Clock.tsx`
- Create: `ui2/test/clock-render.test.tsx`

**Interfaces:**
- Consumes: `ClockMark` from `../../lib/clock.js`.
- Produces: `Clock({ marks, nowMinutes, live }: { marks: ClockMark[]; nowMinutes: number; live: boolean })`.

- [ ] **Step 1: Write the failing test**

Create `ui2/test/clock-render.test.tsx`:

```tsx
// ui2/test/clock-render.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Clock } from "../src/views/home/Clock.js";
import type { ClockMark } from "../src/lib/clock.js";

afterEach(cleanup);

const marks: ClockMark[] = [
  { key: "anchor:morning", label: "morning brief", hhmm: "08:00", minutes: 480, kind: "past" },
  { key: "reminder:7", label: "renew domain", hhmm: "12:00", minutes: 720, kind: "next" },
  { key: "anchor:evening", label: "evening wrap", hhmm: "21:30", minutes: 1290, kind: "future" },
];

describe("Clock", () => {
  it("pulses exactly one pin — the approaching one", () => {
    const { container } = render(<Clock marks={marks} nowMinutes={600} live={true} />);
    expect(container.querySelectorAll(".approach")).toHaveLength(1);
  });

  it("stops the pulse when the stream is down", () => {
    const { container } = render(<Clock marks={marks} nowMinutes={600} live={false} />);
    expect(container.querySelectorAll(".approach")).toHaveLength(0);
  });

  it("hues past, next and future differently so reduced-motion still reads", () => {
    const { container } = render(<Clock marks={marks} nowMinutes={600} live={false} />);
    expect(container.querySelectorAll(".bg-past")).toHaveLength(1);
    expect(container.querySelectorAll(".bg-next")).toHaveLength(1);
    expect(container.querySelectorAll(".bg-rest")).toHaveLength(1);
  });

  it("positions each mark by its minute of the day", () => {
    const { container } = render(<Clock marks={marks} nowMinutes={600} live={true} />);
    const first = container.querySelector('[data-mark="anchor:morning"]') as HTMLElement;
    expect(first.style.left).toBe(`${(480 / 1440) * 100}%`);
  });

  it("says so plainly when nothing is scheduled, rather than drawing an empty axis", () => {
    render(<Clock marks={[]} nowMinutes={600} live={true} />);
    expect(screen.getByText("Nothing scheduled today")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui2 && npx vitest run test/clock-render.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/views/home/Clock.js"`.

- [ ] **Step 3: Write the component**

Create `ui2/src/views/home/Clock.tsx`:

```tsx
// ui2/src/views/home/Clock.tsx — the day as an axis (spec 2026-08-02 §6).
// Only the single nearest upcoming mark pulses; anything else would be mood.
import type { ClockMark } from "../../lib/clock.js";

const PIN: Record<ClockMark["kind"], string> = {
  past: "bg-past",
  next: "bg-next",
  future: "bg-rest",
};

const pct = (minutes: number) => `${(minutes / 1440) * 100}%`;

export function Clock({ marks, nowMinutes, live }: {
  marks: ClockMark[];
  /** Minutes from local midnight. Re-rendered on a 30s tick by Home, not per second. */
  nowMinutes: number;
  live: boolean;
}) {
  if (marks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full px-5">
        <span className="label">Nothing scheduled today</span>
      </div>
    );
  }
  return (
    <div className="relative h-full px-5">
      <div className="absolute left-5 right-5 top-8 h-px bg-line" />
      <div className="absolute top-4 w-px h-6 bg-next" style={{ left: pct(nowMinutes) }} />
      {marks.map((m) => (
        <div
          key={m.key}
          data-mark={m.key}
          className="absolute top-5 -translate-x-1/2 text-center"
          style={{ left: pct(m.minutes) }}
        >
          <span
            className={`block size-1.5 rounded-full mx-auto mb-1.5 ${PIN[m.kind]} ${
              live && m.kind === "next" ? "approach" : ""
            }`}
          />
          <div className="font-mono text-[8.5px] text-dim">{m.hhmm}</div>
          <div className={`text-[9px] mt-0.5 whitespace-nowrap ${m.kind === "next" ? "text-strong" : "text-dim"}`}>
            {m.label}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ui2 && npx vitest run test/clock-render.test.tsx`
Expected: PASS, `Tests 5 passed`.

- [ ] **Step 5: Commit**

```bash
git add ui2/src/views/home/Clock.tsx ui2/test/clock-render.test.tsx
git commit -m "feat(ui2): Clock component — one approaching pin, never two"
```

---

### Task 8: Dock and the queue sheet

**Files:**
- Create: `ui2/src/views/home/Dock.tsx`
- Create: `ui2/src/views/home/QueueSheet.tsx`
- Create: `ui2/test/dock-render.test.tsx`

**Interfaces:**
- Consumes: `dockChips` from `../../lib/dock.js`; `Queue` from `../Queue.js`; `Canvas` from `../canvas/index.js`; `groupQueue` from `../../lib/queue.js`.
- Produces:
  - `Dock({ items, onOpenQueue }: { items: AttentionItem[]; onOpenQueue: () => void })`
  - `QueueSheet({ open, onClose, groups, selected, onSelect, onAct, rowErrors, busy, events, onOpenChat })`

- [ ] **Step 1: Write the failing test**

Create `ui2/test/dock-render.test.tsx`:

```tsx
// ui2/test/dock-render.test.tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Dock } from "../src/views/home/Dock.js";
import type { AttentionItem } from "../src/api.js";

afterEach(cleanup);

const item = (id: string, severity: AttentionItem["severity"]): AttentionItem => ({
  kind: "approval", id, title: `Task ${id}`, meta: "", severity,
  ts: "2026-08-02T09:00:00.000Z", actions: [], ref: {},
});

describe("Dock", () => {
  it("shows three chips and the remainder", () => {
    render(<Dock items={["a", "b", "c", "d", "e"].map((i) => item(i, 2))} onOpenQueue={() => {}} />);
    expect(screen.getAllByRole("button", { name: /^Task/ })).toHaveLength(3);
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("says the inbox is clear rather than rendering an empty strip", () => {
    render(<Dock items={[]} onOpenQueue={() => {}} />);
    expect(screen.getByText("Nothing. Inbox clear.")).toBeTruthy();
  });

  it("opens the queue when a chip is clicked", () => {
    const onOpenQueue = vi.fn();
    render(<Dock items={[item("a", 1)]} onOpenQueue={onOpenQueue} />);
    fireEvent.click(screen.getByRole("button", { name: "Task a" }));
    expect(onOpenQueue).toHaveBeenCalledOnce();
  });

  it("fills the severity-1 chip and outlines the rest", () => {
    const { container } = render(<Dock items={[item("a", 1), item("b", 3)]} onOpenQueue={() => {}} />);
    expect(container.querySelectorAll(".bg-accent")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui2 && npx vitest run test/dock-render.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/views/home/Dock.js"`.

- [ ] **Step 3: Write the Dock**

Create `ui2/src/views/home/Dock.tsx`:

```tsx
// ui2/src/views/home/Dock.tsx — the queue's standing representative (spec §7).
// Fill (not hue) marks severity 1, because every attention row is amber now.
import { dockChips } from "../../lib/dock.js";
import type { AttentionItem } from "../../api.js";

export function Dock({ items, onOpenQueue }: {
  items: AttentionItem[];
  onOpenQueue: () => void;
}) {
  const { chips, overflow } = dockChips(items);
  return (
    <div className="flex items-center gap-2.5 px-5 py-2.5 border-t border-line bg-surface overflow-x-auto">
      <span className="label shrink-0">Needs you</span>
      {chips.length === 0 && <span className="text-[11px] text-dim">Nothing. Inbox clear.</span>}
      {chips.map((c) => (
        <button
          key={c.id}
          onClick={onOpenQueue}
          className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] border transition-colors ${
            c.fill ? "bg-accent border-accent text-black font-medium" : "border-line text-fg hover:border-dim"
          }`}
        >
          {c.title}
        </button>
      ))}
      {overflow > 0 && (
        <button onClick={onOpenQueue} className="shrink-0 text-[11px] text-dim hover:text-fg">
          +{overflow}
        </button>
      )}
      <span className="ml-auto shrink-0 text-[10px] text-dim">
        <kbd>q</kbd> queue
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Write the QueueSheet**

Create `ui2/src/views/home/QueueSheet.tsx`:

```tsx
// ui2/src/views/home/QueueSheet.tsx — the existing Queue, relocated (spec §7).
// Nothing about triage is redesigned: same component, same grouping, same
// keyboard model. This file is a container and an Escape handler.
import { useEffect } from "react";
import { Queue } from "../Queue.js";
import { Canvas } from "../canvas/index.js";
import type { QueueGroup } from "../../lib/queue.js";
import type { AttentionItem, StoredEvent } from "../../api.js";

export function QueueSheet({ open, onClose, groups, selected, onSelect, onAct, rowErrors, busy, events, onOpenChat }: {
  open: boolean;
  onClose: () => void;
  groups: QueueGroup[];
  selected: AttentionItem | null;
  onSelect: (i: AttentionItem) => void;
  onAct: (i: AttentionItem, verb: string) => void;
  rowErrors: Record<string, string>;
  busy: Set<string>;
  events: StoredEvent[];
  onOpenChat: (target: string, seed?: string) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-surface/95 backdrop-blur-sm">
      <div className="flex items-center gap-3 px-5 h-11 border-b border-line shrink-0">
        <span className="label">Needs you</span>
        <button onClick={onClose} className="ml-auto text-[11px] text-dim hover:text-fg">
          close <kbd>esc</kbd>
        </button>
      </div>
      <div className="flex-1 min-h-0 flex">
        <div className="w-[360px] shrink-0 border-r border-line py-2 hidden md:flex flex-col">
          <Queue groups={groups} selected={selected} onSelect={onSelect} onAct={onAct} rowErrors={rowErrors} busy={busy} />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 hidden md:block">
          <Canvas item={selected} events={events} onAct={onAct} onOpenChat={onOpenChat} onDone={() => onSelect(null as never)} />
        </div>
        {/* Phone: queue-first, a selection pushes full-screen detail — same as the old Home. */}
        <div className="flex-1 min-h-0 md:hidden flex flex-col py-2">
          {selected ? (
            <div className="flex-1 min-h-0 overflow-y-auto px-3">
              <button onClick={() => onSelect(null as never)} className="label hover:text-fg mb-3">← queue</button>
              <Canvas item={selected} events={events} onAct={onAct} onOpenChat={onOpenChat} onDone={() => onSelect(null as never)} />
            </div>
          ) : (
            <Queue groups={groups} selected={selected} onSelect={onSelect} onAct={onAct} rowErrors={rowErrors} busy={busy} />
          )}
        </div>
      </div>
    </div>
  );
}
```

The `null as never` casts above are a smell caused by `onSelect` taking a non-nullable `AttentionItem`. Fix it properly instead: change the prop type to `onSelect: (i: AttentionItem | null) => void` and drop all three casts. `Queue`'s own `onSelect` prop is `(i: AttentionItem) => void`, which is assignable to that wider type, so `Queue` needs no change.

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd ui2 && npx vitest run test/dock-render.test.tsx && npm run typecheck`
Expected: PASS, `Tests 4 passed`, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add ui2/src/views/home/Dock.tsx ui2/src/views/home/QueueSheet.tsx ui2/test/dock-render.test.tsx
git commit -m "feat(ui2): dock chips and the relocated queue sheet"
```

---

### Task 9: Assemble Home

**Files:**
- Modify: `ui2/src/views/Home.tsx` (full rewrite of the render tree; the `act` handler and its optimistic-rollback logic are kept verbatim)
- Delete: `ui2/src/views/TodayStrip.tsx`
- Modify: `ui2/test/queue-render.test.tsx`
- Create: `ui2/test/home-organism.test.tsx`
- Modify: `ui2/src/App.tsx` (pass `connected` into `Home`)

**Interfaces:**
- Consumes: everything from Tasks 2–8.
- Produces: `Home({ events, attention, connected, onOpenChat })` — one new required prop, `connected: boolean`.

- [ ] **Step 1: Write the failing test**

Create `ui2/test/home-organism.test.tsx`:

```tsx
// ui2/test/home-organism.test.tsx — Home's own claims: it states what is true,
// it opens the queue on `q`, and it goes still when the stream dies.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Home } from "../src/views/Home.js";
import { stubApi } from "./stubs.js";
import type { AttentionItem } from "../src/api.js";

afterEach(cleanup);

const ORG = [{
  department: "engineering", mission: "m", lead: "atlas",
  agents: [
    { name: "atlas", title: "T", charter: "c", visibility: "shared", guarded: false, status: "working", currentTask: "node 3/5", costTodayUsd: 0 },
    { name: "vulcan", title: "T", charter: "c", visibility: "shared", guarded: false, status: "idle", currentTask: null, costTodayUsd: 0 },
  ],
}];

const SCHEDULE = { anchors: [{ name: "morning", hhmm: "08:00", overridden: false, firedToday: false }], routines: [], reminders: [] };

const approval: AttentionItem = {
  kind: "approval", id: "a1", title: "Send weekly report", meta: "email.draft",
  severity: 1, ts: "2026-08-02T09:00:00.000Z", actions: ["approve", "reject", "open"], ref: { actionId: "a1" },
};

function stubAll() {
  stubApi({
    "/api/org": ORG,
    "/api/schedule": SCHEDULE,
    "/api/budget": { date: "2026-08-02", spentCents: 214, capCents: null },
    "/api/health": { uptimeMs: 22320000, voice: false, senses: [], sseClients: 1, dbBytes: 0, policyMode: "audit", policyViolations: 0 },
  });
}

describe("Home — Organism", () => {
  it("states how many are working and how many need you", async () => {
    stubAll();
    render(<Home events={[]} attention={[approval]} connected={true} onOpenChat={() => {}} />);
    expect(await screen.findByText(/One is working/)).toBeTruthy();
    expect(screen.getByText(/One thing needs you/)).toBeTruthy();
  });

  it("opens the queue sheet on q and closes it on escape", async () => {
    stubAll();
    render(<Home events={[]} attention={[approval]} connected={true} onOpenChat={() => {}} />);
    await screen.findByText(/One is working/);
    fireEvent.keyDown(window, { key: "q" });
    expect(screen.getAllByText("Send weekly report").length).toBeGreaterThan(0);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Send weekly report")).toBeNull();
  });

  it("goes completely still when the stream is down", async () => {
    stubAll();
    const { container } = render(<Home events={[]} attention={[]} connected={false} onOpenChat={() => {}} />);
    await screen.findByText(/One is working/);
    expect(container.querySelectorAll(".breath, .approach, .travel")).toHaveLength(0);
  });

  it("starts at the mid tide with one agent working and does not jump on mount", async () => {
    stubAll();
    const { container } = render(<Home events={[]} attention={[]} connected={true} onOpenChat={() => {}} />);
    await screen.findByText(/One is working/);
    expect(container.querySelector("[data-tide]")?.getAttribute("data-tide")).toBe("mid");
  });
});
```

Then update `ui2/test/queue-render.test.tsx`: both `render(<Home ... />)` calls need the new `connected={true}` prop, and both `stubApi({...})` maps need `"/api/org": []`, `"/api/schedule": { anchors: [], routines: [], reminders: [] }`, and `"/api/health": { uptimeMs: 0, voice: false, senses: [], sseClients: 1, dbBytes: 0, policyMode: "audit", policyViolations: 0 }` added. Its two assertions also move behind the sheet, so add `fireEvent.keyDown(window, { key: "q" });` after the initial render in each test, before looking for the row.

- [ ] **Step 2: Run both to verify they fail**

Run: `cd ui2 && npx vitest run test/home-organism.test.tsx test/queue-render.test.tsx`
Expected: FAIL — `Home` does not accept `connected`, and none of the new text exists.

- [ ] **Step 3: Rewrite Home**

Replace the render tree in `ui2/src/views/Home.tsx`. Keep `act`, `mark`, the `handled` tombstone effect, and `openBrief` **exactly as they are today** — only the props, the derived state, the keyboard handler and the JSX change:

```tsx
// ui2/src/views/Home.tsx — the Organism (spec 2026-08-02).
// Home shows the org working. The needs-you queue lives one keystroke away in a
// sheet; nothing about triage itself changed.
import { useEffect, useMemo, useState } from "react";
import { api, type AttentionItem, type StoredEvent } from "../api.js";
import { groupQueue, flatQueue } from "../lib/queue.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { usd } from "../lib/format.js";
import { fieldLayout, workingCount } from "../lib/field.js";
import { clockMarks } from "../lib/clock.js";
import { useTide } from "../lib/tide.js";
import { Field } from "./home/Field.js";
import { Clock } from "./home/Clock.js";
import { Dock } from "./home/Dock.js";
import { QueueSheet } from "./home/QueueSheet.js";

/** Field / clock split per tide level (spec §6). The two always sum to 80. */
const SPLIT = { high: [68, 12], mid: [50, 30], low: [14, 66] } as const;

const COUNT = ["Nothing", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const spell = (n: number) => COUNT[n] ?? String(n);

export function Home({ events, attention, connected, onOpenChat }: {
  events: StoredEvent[];
  attention: AttentionItem[] | undefined;
  /** SSE health. False freezes all motion — see spec §9. */
  connected: boolean;
  onOpenChat: (target: string, seed?: string) => void;
}) {
  const [selected, setSelected] = useState<AttentionItem | null>(null);
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState(false);
  // The NOW marker has to advance with no event to prompt it. 30s, not 1s: the
  // axis is 1440 minutes wide, so a second of drift is invisible.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const { data: org } = useLiveQuery(() => api.org(), events, T.agentsActions);
  const { data: schedule } = useLiveQuery(() => api.schedule(), events, T.schedule);
  const { data: budget } = useLiveQuery(() => api.budget(), events, T.budget);
  const { data: health } = useLiveQuery(() => api.health(), events, T.budget);

  const visible = useMemo(
    () => (attention ?? []).filter((i) => !handled.has(i.id)),
    [attention, handled],
  );
  const groups = useMemo(() => groupQueue(visible), [visible]);
  const clusters = useMemo(() => fieldLayout(org ?? []), [org]);
  const working = useMemo(() => workingCount(org ?? []), [org]);
  const marks = useMemo(() => (schedule ? clockMarks(schedule, now) : []), [schedule, now]);
  const level = useTide(working);
  const [fieldPct, clockPct] = SPLIT[level];

  // ---- keep `act`, `mark`, the tombstone effect and `openBrief` from the previous
  // ---- version of this file, unchanged. They are omitted here only for brevity.

  // j/k walk · a approve · r reject · d discuss — unchanged. `q` is new.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "q") { setSheet((s) => !s); return; }
      if (!sheet) return; // the walk/act keys only mean something over the queue
      const flat = flatQueue(groupQueue(visible));
      const idx = selected ? flat.findIndex((i) => i.id === selected.id) : -1;
      if (e.key === "j") setSelected(flat[Math.min(idx + 1, flat.length - 1)] ?? null);
      if (e.key === "k") setSelected(flat[Math.max(idx - 1, 0)] ?? null);
      if (!selected) return;
      if (e.key === "a" && selected.actions.includes("approve")) void act(selected, "approve");
      if (e.key === "r" && selected.actions.includes("reject")) void act(selected, "reject");
      if (e.key === "d") onOpenChat("neo", `About "${selected.title}" (${selected.kind} ${selected.id}): `);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, selected, sheet]);

  const needs = visible.length;
  const uptime = health ? `up ${Math.floor(health.uptimeMs / 3_600_000)}h ${Math.floor((health.uptimeMs % 3_600_000) / 60_000)}m` : "";
  const date = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="flex-1 min-h-0 flex flex-col relative field-ground" data-tide={level}>
      <div className="px-5 pt-6 pb-2 shrink-0">
        <div className="text-[42px] font-extralight tracking-[-0.03em] leading-[1.1] text-bright">
          {working === 0 ? "Resting." : `${spell(working)} ${working === 1 ? "is" : "are"} working.`}
          <br />
          <span className={needs > 0 ? "text-accent" : "text-dim"}>
            {needs === 0 ? "Nothing needs you." : `${spell(needs)} thing${needs === 1 ? "" : "s"} need${needs === 1 ? "s" : ""} you.`}
          </span>
        </div>
        <div className="font-mono text-[11px] text-dim mt-2">
          {date}{uptime ? ` · ${uptime}` : ""}{budget ? ` · ${usd(budget.spentCents)} today` : ""}
        </div>
      </div>

      <div className="tide overflow-hidden min-h-[92px]" style={{ height: `${fieldPct}%` }}>
        <Field clusters={clusters} level={level} live={connected} />
      </div>
      <div className="tide overflow-hidden" style={{ height: `${clockPct}%` }}>
        <Clock marks={marks} nowMinutes={now.getHours() * 60 + now.getMinutes()} live={connected} />
      </div>

      <div className="mt-auto shrink-0">
        <Dock items={visible} onOpenQueue={() => setSheet(true)} />
      </div>

      <QueueSheet
        open={sheet}
        onClose={() => { setSheet(false); setSelected(null); }}
        groups={groups}
        selected={selected}
        onSelect={setSelected}
        onAct={act}
        rowErrors={rowErrors}
        busy={busy}
        events={events}
        onOpenChat={onOpenChat}
      />
    </div>
  );
}
```

Note `min-h-[92px]` on the field wrapper: that is the Low-level floor from spec §9, which stops a 14% band clipping the compressed grid on a short viewport.

`clockMarks` takes a `Date` and reads UTC parts; `nowMinutes` above uses local parts. Pick one and use it in both — use **local** (`getHours`/`getMinutes`) and change `clock.ts`'s `nowMin` and `hhmmOf` to the local getters, then update `test/clock.test.ts` to construct its dates without the trailing `Z`. Do this now rather than leaving a timezone bug for the live walk to find.

- [ ] **Step 4: Delete TodayStrip and pass `connected`**

```bash
rm ui2/src/views/TodayStrip.tsx
```

In `ui2/src/App.tsx`, find where `useEvents()` is destructured and where `<Home ... />` is rendered; pass the existing `connected` value through as `connected={connected}`. If `connected` is not currently destructured from `useEvents()`, add it.

Then confirm nothing else imported the deleted file:

```bash
grep -rn "TodayStrip" ui2/src ui2/test
```

Expected: no output. If `App.tsx` or a test still references it, remove those references.

- [ ] **Step 5: Run the whole ui2 suite**

Run: `cd ui2 && npx vitest run`
Expected: all files pass. Read the **Tests** line, and confirm there is no separate `Errors` line. If `shell.test.tsx` fails on the new `Home` prop, add `connected={true}` there too.

- [ ] **Step 6: Typecheck both projects**

```bash
cd ui2 && npm run typecheck
cd .. && npx tsc --noEmit
```

Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add -A ui2/src ui2/test
git commit -m "feat(ui2): Home becomes the Organism

Home shows the org working — a field of agent dots over a day clock,
proportioned by how much is running. The needs-you queue moves into a
sheet behind q; Queue and Canvas are reused unmodified.

The field reads /api/org rather than the SSE buffer: useEvents caps at
400 events and replays 100 on reconnect, so a long-running agent's
agent.start can scroll out of the window and its dot would show idle
while the agent is still working.

TodayStrip is deleted — its date, brief and spend now live in the
status line and sub-line."
```

---

### Task 10: Live walk

**Files:** none — verification only.

- [ ] **Step 1: Build the bundle**

```bash
cd ui2 && npm run build
```

(`vite build` does not typecheck; Task 9 Step 6 already covered that.)

- [ ] **Step 2: Start a scratch daemon**

Never `:4280` — that is the user's live daemon. Check first, and blank the channel tokens or it steals the user's Telegram updates.

```bash
lsof -ti:4294 || echo "free"
rm -rf /tmp/aios-organism && mkdir -p /tmp/aios-organism/{agents,playbooks,data}
cp -r agents/* /tmp/aios-organism/agents/ 2>/dev/null
TELEGRAM_BOT_TOKEN= SLACK_BOT_TOKEN= SLACK_APP_TOKEN= AIOS_VOICE_ENABLED=false \
  AIOS_AGENTS_DIR=/tmp/aios-organism/agents AIOS_PLAYBOOKS_DIR=/tmp/aios-organism/playbooks \
  AIOS_DATA_DIR=/tmp/aios-organism/data AIOS_UI_PORT=4294 npx tsx src/index.ts
```

- [ ] **Step 3: Walk the four states**

Confirm by eye, because none of these are test-provable:

1. **Idle** — nothing running. The clock owns the screen, the field is a compressed strip, and **nothing on screen moves** except the single approaching pin. If a second pin pulses, Task 5 regressed.
2. **Busy** — dispatch a job. Within 8 seconds of a third agent starting, the field swells and the clock shrinks. It should read as one movement, not a jump.
3. **Twitch** — let agents finish. Confirm the layout does *not* re-proportion on every `agent.end`; only sustained change moves it.
4. **Disconnected** — kill the daemon with the tab open. Every animation must stop within one reconnect interval. A dot still breathing here is the bug this whole principle exists to prevent.

- [ ] **Step 4: Check reduced motion and the light theme**

In the browser, enable "reduce motion" at the OS level and reload: nothing animates, and working versus idle is still distinguishable by colour alone. Then toggle the theme: the field stays night, while the nav, dock and sheet follow the theme.

- [ ] **Step 5: Clean up**

```bash
# stop the scratch daemon (Ctrl-C), then
rm -rf /tmp/aios-organism
```

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Ground | 1 |
| §2 Colour is a clock | 1 (tokens), 3 (`stateOf`), 5 (`MarkKind`) |
| §3 Type | 9 (status line ramp) |
| §4 Space and depth | 1 (`.field-ground`), 6 (gap steps) |
| §5 Motion inventory | 1 (keyframes + allowlist), 6, 7 |
| §6 Home structure / tide | 2, 9 (`SPLIT`) |
| §6 "a dot never moves" | 3 (level is not a parameter), 6 |
| §7 Queue debt | 4, 8 |
| §8 Data and wiring | 5 (`T.schedule`), 9 (`/api/org`) |
| §9 Degradation | 6, 7 (`live`), 9 (min-height, `connected`), 10 (theme, reduced motion) |
| §10 Testing | 2–9 |

**Gap found and closed:** §5's *travel* animation (one `mail.sent` crossing between two agents) has CSS in Task 1 but no component renders it — the field draws no inter-cluster wires. Rather than add a task, this is **explicitly deferred**: the wire needs an agent-to-agent geometry the cluster grid does not currently express, and the design stands without it. Note it in the plan's open items and remove `travel` from the Task 1 allowlist if it is still unused when Task 9 lands, so the allowlist never blesses an animation nothing fires.

**Type consistency:** `TideLevel` is the same union in Tasks 2, 6, 7, 9. `Cluster` and `DotState` from Task 3 are consumed unchanged in Task 6. `ClockMark`/`MarkKind` from Task 5 are consumed unchanged in Task 7. `DockChip` from Task 4 is internal to Task 8. `Home`'s new `connected` prop is threaded in Task 9 Step 4 and asserted in Task 9 Step 1.

**Known follow-ups:** the `travel` wire (above); a display typeface (spec §3, deferred with brand identity); direction iii "Day spine" for the Goals view (spec open items).

---

## Execution outcome (2026-08-02)

Branch `home-organism`, 11 commits from `9a71def`. ui2 **26 files / 125 tests**; root **215 files / 1831 pass + 2 skipped**; both typechecks exit 0; `vite build` clean.

### What the plan got wrong

**1. `DOT_TOKEN.waiting` was `bg-needs`.** There is no `--color-needs` token — the amber is `--color-accent`. Shipped as `bg-accent`.

**2. The plan's test fixtures were incomplete.** `OrgDepartmentView` also requires `memoDomain`, `sandbox` and `actions`. Missing fields passed vitest and only failed under `tsc`, which is why the verification order matters.

**3. `clockMarks` was specified reading UTC.** The plan flagged this inline and it was fixed during Task 5: the axis is the user's local day, and Home derives `nowMinutes` from local getters. Test fixtures build their dates locally so they pass outside UTC.

### Three defects only the live walk could find

**Light theme broke Home entirely.** Option A pins the field to night, but the plan only pinned *background* tokens — every descendant still resolved theme-following ink, so light mode rendered near-black text on a near-black ground. Fixed by exposing the dark set under a `.night` class (`tokens.css`) that `Home.tsx` stamps on its root, switching the whole subtree. This is a **deviation from spec §9**, which said the dock and sheet follow the theme: implemented strictly, a white dock welds to a night field. The nav — the thing §9 was actually protecting against flashing — sits outside Home and still follows the toggle.

**Both tiding bands top-aligned their content**, leaving hundreds of pixels of void in a band sized for a much larger org. `Field` and `Clock` now centre within their bands.

**`currentTask` was only a tooltip.** Now a caption under the field, which is what the approved direction showed.

### Two defects the tests forced out

**`useTide` took `number`.** Initialising from a placeholder zero parked every page load at `low` for the full 8s dwell before swelling. It now takes `number | undefined` and **seeds during render** — seeding in an effect left one frame where the status line claimed work while the field was still compressed, which showed up as a genuine test flake.

**The status line said "Resting." before `/api/org` landed.** Claiming the org is idle before knowing is the same lie as a dot breathing on dead data. It now renders blank until the first payload.

### Deliberately not shipped

**The `travel` animation.** The cluster grid has no agent-to-agent geometry to draw a mail wire along, so nothing rendered it. CSS and allowlist entry were both removed rather than left blessing an animation with no fact behind it. Re-add both together.

### Not verified

**The tide transition was never watched live.** The worktree has no `.env`, so the daemon came up in setup mode; rather than copy an OAuth token or spend tokens on heartbeat work, the walk served the real built bundle against a stub API. That covered layout, colour, type, all three tide levels, the queue sheet and the disconnected state (12 dots rendered, **zero animating elements**). The 8s hysteresis and the 1400ms re-proportion are unit-tested only.

### Noticed, not fixed

`Staff.tsx:72` reads `unread?.byAgent[a.name]` — the optional chain stops at `unread`, so any `/api/mail/unread` payload without `byAgent` crashes the whole app rather than just Staff. Dormant today because the server always sends it. Out of scope.
