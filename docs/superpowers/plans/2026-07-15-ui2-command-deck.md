# ui2 Command Deck Visual Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the warm-Ember visual language of ui2 with the approved "Command Deck" design — cool-dark layered surfaces + a first-class light theme behind a top-bar toggle, Goals as kanban lanes, Home org pulse rebuilt as live department cards with an activity strip.

**Architecture:** Pure client restyle. Two complete CSS-variable token sets on `:root[data-theme]`, bridged to Tailwind v4 utilities via `@theme inline` so the toggle is pure CSS. Structural recomposition only in Goals (kanban), OrgPulse (dept cards + activity), Queue (cards), TopBar (toggle). Everything else inherits the new look through tokens + restyled primitives. Zero server changes, zero new dependencies.

**Tech Stack:** React 19, Tailwind v4 (`@theme inline`), Vite, vitest + jsdom (ui2 suite), browser-harness for visual smoke.

**Spec:** `docs/superpowers/specs/2026-07-15-ui2-command-deck-redesign-design.md` (token table lives there — values below are copied from it verbatim).

## Global Constraints

- No new npm dependencies. No server or `src/web/dto.ts` changes.
- Amber/accent = needs-you + primary actions ONLY, never decorative.
- All numerals/timestamps/costs render mono `tabular-nums`.
- Existing utility token names (`bg surface raised line dim fg strong accent ok err agent`) keep working; new names added: `bright info line-soft accent-bg err-bg err-line`.
- Existing 24 ui2 tests must stay green; root suite untouched (1175 pass + 2 skip); `npx tsc --noEmit` clean in BOTH roots.
- Worktree execution (locked process): `git worktree add .worktrees/command-deck -b command-deck && ln -s $PWD/node_modules .worktrees/command-deck/node_modules && cd .worktrees/command-deck/ui2 && npm install`.
- All test commands below run from the worktree's `ui2/` unless stated otherwise.

---

### Task 1: Theme foundation — tokens, boot script, `theme.ts`, top-bar toggle

**Files:**
- Modify: `ui2/src/tokens.css` (full rewrite)
- Modify: `ui2/src/index.css` (add `.panel`/`.card`, retune motion)
- Modify: `ui2/index.html` (pre-bundle theme script)
- Create: `ui2/src/lib/theme.ts`
- Modify: `ui2/src/components/TopBar.tsx` (toggle button)
- Test: `ui2/test/theme.test.ts`

**Interfaces:**
- Produces: `currentTheme(): "dark" | "light"`, `setTheme(t)`, `toggleTheme(): Theme`, `applyTheme(t)` from `ui2/src/lib/theme.ts`; CSS classes `.panel` (surface-level container) and `.card` (raised card) used by every later task.

- [ ] **Step 1: Write the failing test**

```ts
// ui2/test/theme.test.ts — system default, persistence, toggle side-effects.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { currentTheme, setTheme, toggleTheme, applyTheme } from "../src/lib/theme.js";

function stubScheme(prefersLight: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("light") ? prefersLight : !prefersLight,
    addEventListener: () => {}, removeEventListener: () => {},
  }));
}

describe("theme", () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-theme"); });

  it("defaults to the system scheme when nothing is stored", () => {
    stubScheme(false);
    expect(currentTheme()).toBe("dark");
    stubScheme(true);
    expect(currentTheme()).toBe("light");
  });

  it("stored value wins over the system scheme", () => {
    stubScheme(true);
    localStorage.setItem("aios_theme", "dark");
    expect(currentTheme()).toBe("dark");
  });

  it("setTheme persists and stamps <html data-theme>", () => {
    setTheme("light");
    expect(localStorage.getItem("aios_theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("toggleTheme flips dark↔light", () => {
    stubScheme(false);
    expect(toggleTheme()).toBe("light");
    expect(toggleTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("applyTheme stamps without persisting", () => {
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("aios_theme")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/theme.test.ts`
Expected: FAIL — cannot resolve `../src/lib/theme.js`

- [ ] **Step 3: Implement `theme.ts`**

```ts
// ui2/src/lib/theme.ts — theme state: localStorage override, system default, <html data-theme> stamp.
export type Theme = "dark" | "light";
const KEY = "aios_theme";

export function currentTheme(): Theme {
  const stored = localStorage.getItem(KEY);
  if (stored === "dark" || stored === "light") return stored;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

export function setTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
  applyTheme(t);
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/theme.test.ts`
Expected: 5 passed

- [ ] **Step 5: Rewrite `tokens.css` (full replacement)**

```css
/* ui2/src/tokens.css — Command Deck tokens (spec 2026-07-15). Two runtime themes
   on :root[data-theme]; Tailwind v4 reads through @theme inline so utilities like
   bg-raised/text-strong resolve at runtime and the toggle is pure CSS. */
:root[data-theme="dark"] {
  --t-bg: #0b0d12;
  --t-surface: #0e1117;
  --t-raised: #12151d;
  --t-line: #1e2330;
  --t-line-soft: #1a1f2b;
  --t-dim: #6b7386;
  --t-fg: #8b96ad;
  --t-strong: #e6e9f0;
  --t-bright: #f0f2f7;
  --t-accent: #ffb454;
  --t-accent-bg: #241a10;
  --t-ok: #4ade80;
  --t-err: #f87171;
  --t-err-bg: #141019;
  --t-err-line: #3d2430;
  --t-info: #7ea6f4;
  --t-agent: #9c8cc9;
  --t-card-shadow: none;
}
:root[data-theme="light"] {
  --t-bg: #f4f4f2;
  --t-surface: #ffffff;
  --t-raised: #fafaf9;
  --t-line: #e6e7e4;
  --t-line-soft: #f0f0ee;
  --t-dim: #82838c;
  --t-fg: #5a5b64;
  --t-strong: #191a1e;
  --t-bright: #000000;
  --t-accent: #c2410c;
  --t-accent-bg: #fef0e8;
  --t-ok: #16a34a;
  --t-err: #dc2626;
  --t-err-bg: #fffbf9;
  --t-err-line: #f3d9d3;
  --t-info: #2f5af5;
  --t-agent: #6d5bc7;
  --t-card-shadow: 0 1px 3px rgba(20, 20, 30, 0.05);
}
@theme inline {
  --color-*: initial;
  --color-black: #000;
  --color-bg: var(--t-bg);
  --color-surface: var(--t-surface);
  --color-raised: var(--t-raised);
  --color-line: var(--t-line);
  --color-line-soft: var(--t-line-soft);
  --color-dim: var(--t-dim);
  --color-fg: var(--t-fg);
  --color-strong: var(--t-strong);
  --color-bright: var(--t-bright);
  --color-accent: var(--t-accent);
  --color-accent-bg: var(--t-accent-bg);
  --color-ok: var(--t-ok);
  --color-err: var(--t-err);
  --color-err-bg: var(--t-err-bg);
  --color-err-line: var(--t-err-line);
  --color-info: var(--t-info);
  --color-agent: var(--t-agent);
  --font-sans: "Inter Variable", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}
```

- [ ] **Step 6: Add depth classes + keep motion in `index.css`**

After the `.label` rule in `ui2/src/index.css`, add:

```css
/* Command Deck depth: bg page → .panel (surface) → .card (raised). Light theme
   swaps glow-less borders for a soft shadow via --t-card-shadow. */
.panel { @apply bg-surface border border-line rounded-xl; box-shadow: var(--t-card-shadow); }
.card { @apply bg-raised border border-line rounded-lg; box-shadow: var(--t-card-shadow); }
.card-hover { @apply transition-all hover:-translate-y-px hover:border-dim; }
```

Leave `breathe`/`arrive`/`shimmer`/`tick` and the reduced-motion block unchanged.

- [ ] **Step 7: index.html boot script (no theme flash)**

In `ui2/index.html`, add just BEFORE the `/src/main.tsx` script tag:

```html
    <script>
      (function () {
        var t = localStorage.getItem("aios_theme");
        if (t !== "dark" && t !== "light")
          t = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
        document.documentElement.dataset.theme = t;
      })();
    </script>
```

- [ ] **Step 8: TopBar toggle**

In `ui2/src/components/TopBar.tsx`: add imports and a toggle button between the budget span and the connection dot.

```tsx
import { useState } from "react";
import { currentTheme, toggleTheme } from "../lib/theme.js";
```

Inside the component body:

```tsx
  const [theme, setThemeState] = useState(currentTheme());
```

In the right-side `div` (`ml-auto`), before the connection dot:

```tsx
        <button
          aria-label="Toggle theme"
          onClick={() => setThemeState(toggleTheme())}
          className="text-[13px] text-dim hover:text-strong transition-colors"
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
```

- [ ] **Step 9: Full ui2 suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 24 + 5 tests pass (jsdom has no `data-theme`, tokens are CSS-only — no test depends on colors), tsc clean.

- [ ] **Step 10: Commit**

```bash
git add ui2/src/tokens.css ui2/src/index.css ui2/index.html ui2/src/lib/theme.ts ui2/src/components/TopBar.tsx ui2/test/theme.test.ts
git commit -m "feat(ui2): Command Deck token sets + dark/light theme toggle"
```

---

### Task 2: Primitives — restyle `ui.tsx`

**Files:**
- Modify: `ui2/src/components/ui.tsx` (full replacement below)

**Interfaces:**
- Consumes: nothing new.
- Produces: same exported API as today — `Button({variant: "primary"|"ghost"|"danger"})`, `Tag({tone})` with tone union gaining `"info"`, `Dot`, `SectionLabel`, `Empty`, `toneOfStatus` — every existing call site keeps compiling. `Avatar({name, tone})` is NEW (used by Task 5).

- [ ] **Step 1: Replace `ui2/src/components/ui.tsx`**

```tsx
// ui2/src/components/ui.tsx — Command Deck primitives. Amber = needs-you only; depth via .card/.panel.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({ variant = "ghost", className = "", ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-accent text-bg border-accent hover:opacity-90 font-semibold",
    ghost: "border-line text-fg hover:border-dim hover:text-strong bg-transparent",
    danger: "bg-err text-bg border-err hover:opacity-90 font-semibold",
  }[variant];
  return (
    <button
      className={`border rounded-md px-3 py-1.5 text-[12px] transition-all disabled:opacity-40 ${styles} ${className}`}
      {...rest}
    />
  );
}

export function Tag({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "ok" | "err" | "accent" | "agent" | "info" }) {
  const color = {
    dim: "text-dim border-line bg-transparent",
    ok: "text-ok border-ok/30 bg-ok/5",
    err: "text-err border-err/30 bg-err/5",
    accent: "text-accent border-accent/30 bg-accent-bg",
    agent: "text-agent border-agent/30 bg-agent/5",
    info: "text-info border-info/30 bg-info/5",
  }[tone];
  return <span className={`inline-block border rounded-full px-2 py-px text-[10px] leading-4 font-mono whitespace-nowrap ${color}`}>{children}</span>;
}

export function Dot({ tone, breathing }: { tone: "ok" | "err" | "accent" | "agent" | "dim" | "info"; breathing?: boolean }) {
  const bg = { ok: "bg-ok", err: "bg-err", accent: "bg-accent", agent: "bg-agent", dim: "bg-dim", info: "bg-info" }[tone];
  return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${bg} ${breathing ? "breathe" : ""}`} />;
}

/** Initials avatar — violet ring while working, amber only when the agent owns a needs-you item. */
export function Avatar({ name, tone = "dim" }: { name: string; tone?: "dim" | "agent" | "accent" | "ok" | "err" }) {
  const color = {
    dim: "text-dim bg-raised border-line", agent: "text-agent bg-agent/10 border-agent/30",
    accent: "text-accent bg-accent-bg border-accent/30", ok: "text-ok bg-ok/10 border-ok/30",
    err: "text-err bg-err/10 border-err/30",
  }[tone];
  return (
    <span className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded-full border text-[9px] font-bold uppercase shrink-0 ${color}`}>
      {name.slice(0, 2)}
    </span>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="label mb-2">{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-dim py-6">{children}</div>;
}

/** One shared status→tone map so goal/node/mail/action states color identically everywhere. */
export function toneOfStatus(status: string): "ok" | "err" | "accent" | "agent" | "dim" {
  if (status === "running" || status === "done" || status === "ok" || status === "executed") return "ok";
  if (status === "failed" || status === "error" || status === "refused" || status === "rejected") return "err";
  if (["awaiting-human", "awaiting-mail", "paused-user", "paused-budget", "proposed", "unread"].includes(status)) return "accent";
  if (status === "planning" || status === "replanning" || status === "working" || status === "executing") return "agent";
  return "dim";
}
```

- [ ] **Step 2: Suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass (behavioral tests, no color assertions), tsc clean.

- [ ] **Step 3: Commit**

```bash
git add ui2/src/components/ui.tsx
git commit -m "feat(ui2): Command Deck primitives — filled danger, info tone, Avatar"
```

---

### Task 3: `laneOf` — statuses → 3 kanban lanes

**Files:**
- Modify: `ui2/src/lib/goal-buckets.ts` (append)
- Test: `ui2/test/goal-lanes.test.ts`

**Interfaces:**
- Consumes: `bucketOf(status)` (existing, unchanged).
- Produces: `type Lane = "needs" | "running" | "done"`, `LANES: Array<{key: Lane; label: string}>` (order: needs, running, done), `laneOf(status: string): Lane`. Task 4 renders lanes from these.

- [ ] **Step 1: Write the failing test**

```ts
// ui2/test/goal-lanes.test.ts — status→lane mapping for the kanban Goals page.
import { describe, it, expect } from "vitest";
import { laneOf, LANES } from "../src/lib/goal-buckets.js";

describe("laneOf", () => {
  it("failed and paused land in needs-you", () => {
    expect(laneOf("failed")).toBe("needs");
    expect(laneOf("paused-budget")).toBe("needs");
    expect(laneOf("paused-user")).toBe("needs");
  });
  it("awaiting-mail renders in running despite the waiting bucket", () => {
    expect(laneOf("awaiting-mail")).toBe("running");
  });
  it("active statuses are running", () => {
    for (const s of ["planning", "running", "replanning"]) expect(laneOf(s)).toBe("running");
  });
  it("done and abandoned share the done lane", () => {
    expect(laneOf("done")).toBe("done");
    expect(laneOf("abandoned")).toBe("done");
  });
  it("lane order is needs, running, done", () => {
    expect(LANES.map((l) => l.key)).toEqual(["needs", "running", "done"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/goal-lanes.test.ts`
Expected: FAIL — `laneOf` not exported

- [ ] **Step 3: Implement (append to `goal-buckets.ts`)**

```ts
/** Kanban lanes (Command Deck spec §3): 5 buckets fold into 3 columns.
 *  awaiting-mail is the one status-level exception — it waits on the WORLD,
 *  not the user, so it renders in Running with a chip. */
export type Lane = "needs" | "running" | "done";

export const LANES: Array<{ key: Lane; label: string }> = [
  { key: "needs", label: "Needs you" },
  { key: "running", label: "Running" },
  { key: "done", label: "Done" },
];

export function laneOf(status: string): Lane {
  if (status === "awaiting-mail") return "running";
  const bucket = bucketOf(status);
  if (bucket === "needs" || bucket === "waiting") return "needs";
  if (bucket === "running") return "running";
  return "done";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/goal-lanes.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add ui2/src/lib/goal-buckets.ts ui2/test/goal-lanes.test.ts
git commit -m "feat(ui2): laneOf — fold goal buckets into 3 kanban lanes"
```

---

### Task 4: Goals page — kanban lanes

**Files:**
- Modify: `ui2/src/views/Goals.tsx` (replace `GoalList`; keep `Goals`, `GoalDetailView`, `ArtifactPreview` as-is except detail polish below)
- Test: `ui2/test/goal-kanban.test.tsx`

**Interfaces:**
- Consumes: `LANES`, `laneOf` (Task 3), `Tag/Button/Empty/toneOfStatus` (Task 2), `.card`/`.panel` classes (Task 1), existing `api.goals()`, `useLiveQuery`, `provenance`, `ts`, `usd`, `navigate`.
- Produces: nothing consumed later; page-level.

- [ ] **Step 1: Write the failing test**

```tsx
// ui2/test/goal-kanban.test.tsx — lanes render, done lane caps at 10 with Show all.
import { describe, it, expect, vi } from "vitest";
// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { GoalList } from "../src/views/Goals.js";

vi.mock("../src/api.js", async (orig) => {
  const goals = [
    { id: "g1", slug: "g1", title: "Failed goal", status: "failed", department: "eng", lead: "athena",
      originChannel: "web", createdAt: "2026-07-15T08:00:00.000Z", nodes: [{ key: "a", status: "failed", costCents: 0 }] },
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `d${i}`, slug: `d${i}`, title: `Done goal ${i}`, status: "done", department: "ops", lead: "hermes",
      originChannel: "web", createdAt: "2026-07-14T08:00:00.000Z", nodes: [{ key: "a", status: "done", costCents: 10 }] })),
  ];
  return { ...(await orig()), api: { goals: async () => goals } };
});

describe("Goals kanban", () => {
  it("renders three lanes, caps Done at 10, Show all expands", async () => {
    render(<GoalList events={[]} />);
    expect((await screen.findAllByText(/Needs you/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Running/)).length).toBeGreaterThan(0);
    expect(await screen.findByText("Failed goal")).toBeTruthy();
    expect(screen.queryByText("Done goal 11")).toBeNull(); // capped
    fireEvent.click(await screen.findByText(/Show all 12/));
    expect(await screen.findByText("Done goal 11")).toBeTruthy();
  });
});
```

Export `GoalList` from `Goals.tsx` (add `export` keyword) so the test can mount it directly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/goal-kanban.test.tsx`
Expected: FAIL — `GoalList` not exported / lanes not rendered

- [ ] **Step 3: Replace `GoalList` with the kanban implementation**

```tsx
const DONE_CAP = 10;

export function GoalList({ events }: { events: StoredEvent[] }) {
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  const [dept, setDept] = useState<string>("");
  const [showAllDone, setShowAllDone] = useState(false);
  if (!goals) return <Empty>Loading…</Empty>;
  const depts = [...new Set(goals.map((g) => g.department))].sort();
  const filtered = dept ? goals.filter((g) => g.department === dept) : goals;
  const weekAgo = Date.now() - 7 * 86_400_000;
  const weekCost = filtered
    .filter((g) => Date.parse(g.createdAt) >= weekAgo)
    .reduce((s, g) => s + g.nodes.reduce((n, x) => n + x.costCents, 0), 0);

  const lanes = LANES.map(({ key, label }) => ({
    key, label, items: filtered.filter((g) => laneOf(g.status) === key),
  }));

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h1 className="text-[17px] font-bold text-bright">Goals</h1>
        <span className="text-[12px] text-dim font-mono">{filtered.length} total · {usd(weekCost)} this week</span>
        <select value={dept} onChange={(e) => setDept(e.target.value)}
          className="ml-auto bg-surface border border-line rounded-md px-2 py-1 text-[12px] text-fg outline-none">
          <option value="">all departments</option>
          {depts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 items-start">
        {lanes.map(({ key, label, items }) => {
          const capped = key === "done" && !showAllDone ? items.slice(0, DONE_CAP) : items;
          return (
            <div key={key} className={`panel p-3.5 ${key === "needs" && items.length > 0 ? "border-err-line" : ""}`}>
              <div className={`label mb-2.5 flex items-center justify-between ${key === "needs" ? "text-accent" : ""}`}>
                {label}
                <span className={`font-mono rounded-full px-2 py-px text-[10px] ${
                  key === "needs" && items.length > 0 ? "bg-accent-bg text-accent" : "bg-raised text-dim"}`}>
                  {items.length}
                </span>
              </div>
              {capped.map((g) => <GoalCard key={g.id} g={g} />)}
              {items.length === 0 && (
                <div className="border border-dashed border-line rounded-lg px-3.5 py-5 text-center">
                  <div className="text-[11.5px] text-dim">
                    {key === "needs" ? "Nothing needs you" : key === "running" ? "All quiet — agents idle" : "No finished goals yet"}
                  </div>
                  {key === "running" && <div className="text-[10.5px] text-dim opacity-60 mt-1">new goals appear here live</div>}
                </div>
              )}
              {key === "done" && items.length > DONE_CAP && !showAllDone && (
                <button onClick={() => setShowAllDone(true)}
                  className="w-full text-center text-[11px] text-info hover:opacity-80 py-1.5">
                  Show all {items.length} →
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GoalCard({ g }: { g: GoalView }) {
  const done = g.nodes.filter((n) => n.status === "done").length;
  const cost = g.nodes.reduce((s, n) => s + n.costCents, 0);
  const failed = g.status === "failed";
  const live = ["planning", "running", "replanning"].includes(g.status);
  return (
    <button onClick={() => navigate(`goals/${g.slug}`)}
      className={`card card-hover w-full text-left p-3 mb-2.5 ${failed ? "!bg-err-bg !border-err-line" : ""} ${g.status === "abandoned" ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Dot tone={toneOfStatus(g.status)} breathing={live} />
        <span className={`font-mono text-[10px] uppercase ${failed ? "text-err" : "text-dim"}`}>
          {g.status} · {done}/{g.nodes.length}
        </span>
        <Tag tone="dim">{provenance(g.originChannel)}</Tag>
      </div>
      <div className={`text-[13px] font-semibold leading-snug ${g.status === "abandoned" ? "text-fg" : "text-bright"}`}>{g.title}</div>
      <div className="flex justify-between items-baseline mt-1.5">
        <span className="text-[10.5px] text-dim truncate">{g.department} · {g.lead} · {ts(g.createdAt)}</span>
        {cost > 0 && <span className="font-mono text-[10.5px] text-dim shrink-0 ml-2">{usd(cost)}</span>}
      </div>
      {live && <div className="shimmer mt-2" />}
    </button>
  );
}
```

Import updates at the top of `Goals.tsx`: add `LANES, laneOf` to the goal-buckets import, `Dot` to the ui import, `GoalView` to the api type import; drop `BUCKETS` and `SectionLabel` if now unused. `GoalList`'s old body (BUCKETS loop) is deleted; remove the `max-w-4xl` wrapper (kanban wants full width).

- [ ] **Step 4: Detail-view polish (same file, small edits)**

- Ask card: `border border-accent/40 rounded-lg bg-surface p-4` → `panel !border-accent/40 p-4`.
- Node inspector: `border border-line rounded-lg bg-surface p-4 h-fit` → `panel p-4 h-fit`.
- `<h1 className="text-[20px] text-strong">` → `text-[18px] font-bold text-bright`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: goal-kanban test passes; all previous pass; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add ui2/src/views/Goals.tsx ui2/test/goal-kanban.test.tsx
git commit -m "feat(ui2): Goals page as Command Deck kanban lanes"
```

---

### Task 5: Home — queue cards, org pulse rebuild, activity strip

**Files:**
- Modify: `ui2/src/views/Queue.tsx` (rows → cards with typed kickers)
- Modify: `ui2/src/views/canvas/OrgPulse.tsx` (full replacement below)
- Modify: `ui2/src/views/TodayStrip.tsx` (mono numerals only)

**Interfaces:**
- Consumes: `Avatar` (Task 2), `.card`/`.panel` (Task 1), existing `api.org()` (`OrgAgentCard: {name, status: "idle"|"working"|"waiting", currentTask, costTodayUsd}`), `StoredEvent` (`{id, ts, event: {type, …}}`), `flatQueue/groupQueue` untouched.
- Produces: nothing consumed later.

- [ ] **Step 1: Queue rows → cards**

In `Queue.tsx`, add a kicker map above the component:

```tsx
const KICKER: Record<string, { label: string; cls: string }> = {
  approval: { label: "approval", cls: "text-accent" },
  ask: { label: "question", cls: "text-accent" },
  review: { label: "review", cls: "text-accent" },
  goal: { label: "goal", cls: "text-err" },
  mail: { label: "mail", cls: "text-info" },
  sense: { label: "sense", cls: "text-err" },
};
```

Replace the row `div` (the one with `border-l-2`) className and header with:

```tsx
            <div
              key={i.id}
              onClick={() => onSelect(i)}
              className={`card card-hover mx-3 mb-2 px-3 py-2.5 cursor-pointer ${
                selected?.id === i.id ? "!border-accent" : ""
              } ${isNew(i.id) ? "arrive" : ""}`}
            >
              <div className="flex items-baseline gap-2">
                <span className={`font-mono text-[9.5px] uppercase tracking-wide ${KICKER[i.kind]?.cls ?? "text-dim"}`}>
                  {KICKER[i.kind]?.label ?? i.kind}
                </span>
                <span className="text-[10px] text-dim ml-auto shrink-0 font-mono">{ts(i.ts)}</span>
              </div>
              <div className="text-[13px] text-bright font-semibold truncate mt-0.5">{i.title}</div>
```

The meta line, error line, and action buttons below stay exactly as they are (labels unchanged — `queue-render.test.tsx` asserts them).

- [ ] **Step 2: Replace `OrgPulse.tsx`**

```tsx
// ui2/src/views/canvas/OrgPulse.tsx — the idle canvas: live department cards + activity strip (Command Deck).
import { api, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { navigate } from "../../lib/router.js";
import { Avatar } from "../../components/ui.js";
import { usdFloat, usd, tsTime } from "../../lib/format.js";

const NOTABLE = new Set(["goal.created", "goal.status", "mail.sent", "brief.sent", "action.executed", "action.resolved"]);
const EVENT_TONE: Record<string, string> = {
  "goal.created": "text-agent", "goal.status": "text-ok", "mail.sent": "text-info",
  "brief.sent": "text-dim", "action.executed": "text-ok", "action.resolved": "text-ok",
};

function eventLine(e: StoredEvent): string {
  const ev = e.event as Record<string, unknown>;
  const parts = [String(ev.type)];
  for (const k of ["from", "agent", "status", "title", "slug", "to", "kind"]) {
    if (typeof ev[k] === "string" && (ev[k] as string).length < 60) parts.push(`${ev[k]}`);
  }
  return parts.join(" · ");
}

export function OrgPulse({ events }: { events: StoredEvent[] }) {
  const { data: org } = useLiveQuery(() => api.org(), events, T.agentsActions);
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  const { data: budget } = useLiveQuery(() => api.budget(), events, T.budget);
  const failedBy = new Map<string, number>();
  for (const g of goals ?? []) if (g.status === "failed") failedBy.set(g.lead, (failedBy.get(g.lead) ?? 0) + 1);
  const activity = events.filter((e) => NOTABLE.has(e.event.type)).slice(-6).reverse();

  return (
    <div className="panel p-4 flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <span className="label">Organization · live</span>
        <span className="font-mono text-[11px] text-dim">
          {budget ? `${usd(budget.spentCents)} today` : ""}{budget?.capCents != null ? ` of ${usd(budget.capCents)}` : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5">
        {(org ?? []).map((d) => (
          <div key={d.department} className="card p-3">
            <div className="flex justify-between items-baseline mb-2">
              <span className="label !mb-0">{d.department}</span>
              <span className="font-mono text-[10px] text-dim">{d.agents.length}</span>
            </div>
            {d.agents.map((a) => {
              const failed = failedBy.get(a.name) ?? 0;
              const tone = failed > 0 ? "err" : a.status === "working" ? "agent" : a.status === "waiting" ? "accent" : "dim";
              return (
                <button key={a.name} onClick={() => navigate(`staff/agents/${a.name}`)}
                  className="flex items-center gap-2 py-1 w-full text-left group">
                  <Avatar name={a.name} tone={tone} />
                  <span className={`text-[11.5px] group-hover:text-bright ${a.status === "working" ? "text-strong" : "text-fg"}`}>{a.name}</span>
                  <span className={`text-[9.5px] truncate ml-auto text-right ${failed > 0 ? "text-err" : a.status === "working" ? "text-agent" : "text-dim"}`}>
                    {failed > 0 ? `${failed} failed goal${failed > 1 ? "s" : ""}`
                      : a.status === "working" ? (a.currentTask ?? "working")
                      : a.costTodayUsd > 0 ? `done · ${usdFloat(a.costTodayUsd)}` : "idle"}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {activity.length > 0 && (
        <div className="border-t border-line-soft pt-3">
          <div className="label mb-1.5">Activity</div>
          {activity.map((e) => (
            <div key={e.id} className="font-mono text-[10.5px] text-fg leading-relaxed truncate arrive">
              <span className={EVENT_TONE[e.event.type] ?? "text-dim"}>{e.ts ? tsTime(e.ts) : "—"}</span> {eventLine(e)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

Note: `d.agents`/`a.*` field names come from `OrgAgentCard` in `src/web/dto.ts` (verified: `status: "idle"|"working"|"waiting"`, `currentTask: string | null`, `costTodayUsd: number`). If `StoredEvent.ts` is not a field on the stored event wrapper, use `(e as unknown as {ts?: string}).ts` — check `ui2/src/api.ts`'s `StoredEvent` import at implementation time and adjust the timestamp render only.

- [ ] **Step 3: TodayStrip mono polish**

In `TodayStrip.tsx`, add `font-mono` to the budget span: `className="ml-auto font-mono"`.

- [ ] **Step 4: Full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass — `queue-render.test.tsx` and `shell.test.tsx` still find their texts (titles/actions/"Nothing needs you." unchanged).

- [ ] **Step 5: Commit**

```bash
git add ui2/src/views/Queue.tsx ui2/src/views/canvas/OrgPulse.tsx ui2/src/views/TodayStrip.tsx
git commit -m "feat(ui2): Home queue cards + live org pulse with activity strip"
```

---

### Task 6: Shell + remaining views — apply the kit

**Files:**
- Modify: `ui2/src/components/TopBar.tsx`, `BottomTabs.tsx`, `ChatDrawer.tsx`, `CommandPalette.tsx`, `Sheet.tsx`, `TokenGate.tsx`
- Modify: `ui2/src/views/Staff.tsx`, `Mail.tsx`, `System.tsx`, `MiniDag.tsx`
- Modify: `ui2/src/views/canvas/Approval.tsx`, `Ask.tsx`, `Goal.tsx`, `MailThread.tsx`, `Review.tsx`

**Interfaces:** consumes `.panel`/`.card`/`card-hover`, `text-bright`, `border-line-soft`, `font-mono` conventions. No API changes.

This task is mechanical: the new tokens already recolor everything; here we add DEPTH and DENSITY. Apply these exact rules in every listed file (grep-driven, not judgment-driven):

- [ ] **Step 1: Panel/card sweep**

- Every container currently styled `border border-line rounded-lg bg-surface` (or `rounded-md bg-surface`) → `panel`.
- Every hoverable row/list item currently `hover:bg-raised` on a bare div/button inside Staff/Mail/System lists → `card card-hover px-3 py-2.5 mb-2` (keep existing inner layout classes).
- Page `<h1 className="text-[20px] text-strong">` → `text-[17px] font-bold text-bright` (Staff, Mail, System headers — matches Goals).
- Every cost/count/timestamp span showing digits gains `font-mono` if it lacks it.
- Row separators `border-b border-line` inside tables/lists → `border-b border-line-soft`.

- [ ] **Step 2: MiniDag recolor check**

`MiniDag.tsx` (46 lines) — confirm node fills/strokes reference token utilities or `var(--color-*)` only; replace any hex literal with the matching token (`--color-ok/err/accent/agent/line/raised`). Failed node keeps the err glow: `filter: drop-shadow(0 0 6px color-mix(in srgb, var(--color-err) 40%, transparent))`.

- [ ] **Step 3: ChatDrawer / CommandPalette / Sheet / TokenGate**

- Drawer + palette containers → `panel` (palette overlay keeps its backdrop).
- Palette add entry: `{ label: "Toggle theme", run: () => toggleTheme() }` — import `toggleTheme` from `../lib/theme.js`; follow the existing command-entry shape in `CommandPalette.tsx` (inspect at implementation time; entries live in a static array).
- TokenGate: center card → `panel p-6`, input keeps `bg-bg border-line`.

- [ ] **Step 4: BottomTabs**

Active tab: `text-strong` → `text-bright`; needs-you badge stays `bg-accent text-bg`.

- [ ] **Step 5: Suite + typecheck + visual spot-check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass, tsc clean.
Then `npm run build` (ui2) must succeed.

- [ ] **Step 6: Commit**

```bash
git add ui2/src
git commit -m "feat(ui2): apply Command Deck kit to shell, Staff, Mail, System, canvases"
```

---

### Task 7: Verify + ship (root checks, merge, deploy, live smoke, push)

**Files:** none new. Worktree → main.

- [ ] **Step 1: Full checks in worktree**

```bash
cd <worktree-root> && npx vitest run && npx tsc --noEmit
cd ui2 && npx vitest run && npx tsc --noEmit && npm run build
```

Expected: root 1175 pass + 2 skip; ui2 = 24 old + new theme/lane/kanban tests, tsc clean both, build clean.

- [ ] **Step 2: FF-merge + cleanup**

```bash
cd /Users/ihabbishara/projects/AIOS
git merge --ff-only command-deck
git worktree remove .worktrees/command-deck && git branch -d command-deck
```

- [ ] **Step 3: Deploy**

```bash
npm run build && (cd ui2 && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios
```

Web up ~30–60s.

- [ ] **Step 4: Live visual smoke (browser-harness)**

Screenshot and EYEBALL each against the approved mockups (`.superpowers/brainstorm/*/content/final-composite.html`):
1. `#/goals` dark — kanban lanes, failure card red-tinted, done capped.
2. Toggle → light — light tokens everywhere, no dark remnants, accent is the dark orange.
3. `#/home` dark — queue cards, org pulse dept cards + activity strip.
4. 390px viewport — lanes stack, bottom tabs fine.
Also: hard-reload with `localStorage.aios_theme` cleared in a fresh tab → theme follows system, no flash.

- [ ] **Step 5: Push + memory**

```bash
git push
```

Update auto-memory `aios-project.md` with the shipped state.

---

## Self-Review (done at write time)

- **Spec coverage:** tokens/table→T1, toggle+boot→T1, primitives→T2, laneOf→T3, kanban+empty lanes+Show all→T4, Home queue/org-pulse/activity→T5, other views+palette entry+MiniDag→T6, motion (kept keyframes + card-hover)→T1/T6, testing+a11y (aria-label on toggle, text+dot status)→T1/T4, deploy/verify→T7. Gap: none found.
- **Placeholder scan:** two intentional inspect-at-implementation notes (CommandPalette entry shape, StoredEvent.ts field) — both bounded with exact fallback instructions, not open TODOs.
- **Type consistency:** `laneOf(status: string): Lane` used in T4 as defined in T3; `Avatar({name, tone})` T2→T5; `Theme`/`toggleTheme` T1→T6 palette entry. Consistent.
