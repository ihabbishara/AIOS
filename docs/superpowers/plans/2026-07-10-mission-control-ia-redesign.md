# Mission Control IA Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the 11 flat tabs into a 4-zone IA (Inbox / Work / Staff / System) with a hash router, a unified attention Inbox, a merged Governance view, chat as a drawer, a shared SSE-invalidation data layer, and a single shared DTO module.

**Architecture:** Pure-frontend restructure plus one type-only backend module. A ~40-line hash router (`useSyncExternalStore` on `hashchange`) replaces `useState<Tab>`; selection state (open goal/agent/thread) moves into the URL. The copy-pasted `lastEvt` memo idiom collapses into `useLiveQuery(fn, events, topics)` over a central `EVENT_TOPICS` module. Approvals is absorbed by Inbox; Trust + Permissions merge into Staff→Governance; RoutingTrail is absorbed by a System→Events log. All views stay mounted (hidden-class trick preserved). No server route changes; `src/web/dto.ts` is types-only.

**Tech Stack:** React 19, Vite 6, Tailwind v4, TypeScript. No new dependencies. Backend untouched except the type-only `src/web/dto.ts` move (Task 7).

**Spec:** conversation analysis 2026-07-10 (capability map + UI redesign, Part 3). No separate spec doc.

## Global Constraints

- No new npm dependencies. `git diff origin/main -- package.json package-lock.json ui/package.json ui/package-lock.json` stays empty.
- Suite baseline **934 pass + 1 skip** stays green (`npx vitest run`). Backend `npx tsc --noEmit` clean; `cd ui && npx tsc --noEmit && npm run build` clean after every task.
- No HTTP API changes: every `/api/*` route, method, and JSON shape stays exactly as-is. The React SPA remains the sole frontend.
- Keep the CRT/HUD aesthetic: existing `@theme` tokens, `.hud`, `.label`, glow/boot/sweep animations unchanged. No new fonts.
- All leaf views stay mounted across navigation (hidden-class toggle, never unmount) — preserves chat log, drafts, scroll.
- URLs are the source of truth for selection: `#/inbox`, `#/work`, `#/work/goals/:slug?node=k`, `#/work/mail/:threadId`, `#/staff`, `#/staff/agents/:name`, `#/staff/governance`, `#/system/departments|config|costs|events`. Unknown hash → `#/inbox`.
- No `window.confirm` / `window.prompt` / `window.alert` may survive in files this plan touches — replaced by `<ConfirmButton>` or inline note state.
- Build cycle (session-locked): worktree off `origin/main`; per-task commits; whole-branch review before FF-merge; deploy `npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`; READ-ONLY smoke.
- UI components have no test harness (house rule) — UI tasks are verified by `cd ui && npx tsc --noEmit && npm run build`; anything load-bearing on the backend is pinned by vitest.
- Out of scope (explicitly): global type-scale bump, senses-health panel (needs new endpoint), event-log cursor pagination beyond the existing 500-cap, Slack parity, network-egress sandbox.

---

### Task 1: Shared UI lib — topics, formatters, useLiveQuery, ConfirmButton

**Files:**
- Create: `ui/src/lib/topics.ts`
- Create: `ui/src/lib/format.ts`
- Create: `ui/src/components/ConfirmButton.tsx`
- Modify: `ui/src/hooks.ts`
- Modify: `ui/src/App.tsx`, `ui/src/views/Org.tsx`, `ui/src/views/Mail.tsx`, `ui/src/views/Goals.tsx`, `ui/src/views/Packs.tsx`, `ui/src/views/Approvals.tsx`, `ui/src/views/Trust.tsx`, `ui/src/views/Permissions.tsx`, `ui/src/views/Costs.tsx`

**Interfaces:**
- Consumes: existing `usePoll`, `StoredEvent` from `ui/src/api.ts`.
- Produces: `T` topic constants + `matches(type, topics)` + `lastMatching(events, topics)` from `lib/topics.ts`; `ts(iso)`, `tsTime(iso)`, `usd(cents)`, `usdFloat(v, dp?)` from `lib/format.ts`; `useFetch<T>(fn, deps)` (renamed `usePoll`) and `useLiveQuery<T>(fn, events, topics, extraDeps?)` from `hooks.ts`; `<ConfirmButton label confirmLabel? alert? disabled? onConfirm className?>` component. Tasks 2–6 rely on all of these names exactly.

- [ ] **Step 1: Create `ui/src/lib/topics.ts`**

```ts
// ui/src/lib/topics.ts — single source of which event types invalidate which queries.
// A topic ending in "." is a prefix match; anything else is exact.
import type { StoredEvent } from "../api.js";

export const T = {
  /** Agent-mailbox events only — a bare "mail." prefix would also match Gmail's mail.received. */
  agentMail: ["mail.sent", "mail.spawned", "mail.read", "mail.asked_user"],
  goals: ["goal.", "node."],
  agentsActions: ["agent.", "action."],
  actions: ["action."],
  trust: ["trust.changed", "action."],
  permissions: ["permission.changed", "tool.denied"],
  costs: ["agent.end"],
  budget: ["agent.end", "goal."],
} as const;

export function matches(type: string, topics: readonly string[]): boolean {
  return topics.some((t) => (t.endsWith(".") ? type.startsWith(t) : type === t));
}

/** Id of the newest event matching topics — the stable invalidation key for useLiveQuery. */
export function lastMatching(events: StoredEvent[], topics: readonly string[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (matches(events[i].event.type, topics)) return events[i].id;
  }
  return undefined;
}
```

- [ ] **Step 2: Create `ui/src/lib/format.ts`**

```ts
// ui/src/lib/format.ts — shared display formatters (previously re-implemented per view).
export const ts = (iso: string | null | undefined): string =>
  iso ? iso.slice(5, 16).replace("T", " ") : "…";
export const tsTime = (iso: string): string => iso.slice(11, 19);
export const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
export const usdFloat = (v: number, dp = 2): string => `$${v.toFixed(dp)}`;
```

- [ ] **Step 3: Create `ui/src/components/ConfirmButton.tsx`** (extracted arm-confirm pattern from Goals abandon)

```tsx
// ui/src/components/ConfirmButton.tsx — two-step arm/confirm; disarms after 4s of inaction.
import { useEffect, useState } from "react";

export function ConfirmButton({ label, confirmLabel, alert, disabled, onConfirm, className }: {
  label: string; confirmLabel?: string; alert?: boolean; disabled?: boolean;
  onConfirm: () => void; className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const color = alert
    ? "border-alert text-alert hover:bg-alert"
    : "border-phosphor text-phosphor hover:bg-phosphor";
  return (
    <button
      disabled={disabled}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}
      className={`border px-3 py-1 font-display uppercase tracking-[0.2em] text-[10px] hover:text-void transition-colors disabled:opacity-40 ${color} ${className ?? ""}`}
    >
      {armed ? (confirmLabel ?? `confirm ${label}?`) : label}
    </button>
  );
}
```

- [ ] **Step 4: Rework `ui/src/hooks.ts`** — rename `usePoll` → `useFetch` (it never polled), add `useLiveQuery`

Replace the whole `usePoll` block (hooks.ts:36-50) with:

```ts
/** Fetch once + manual reload; re-fetches when deps change. (Renamed from the misnamed usePoll.) */
export function useFetch<T>(fn: () => Promise<T>, deps: unknown[] = []): {
  data: T | undefined;
  error: string | undefined;
  reload: () => void;
} {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    fn().then((d) => { setData(d); setError(undefined); }).catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, reload };
}

/** useFetch keyed on the newest event matching `topics` — SSE events invalidate REST reads. */
export function useLiveQuery<T>(
  fn: () => Promise<T>,
  events: StoredEvent[],
  topics: readonly string[],
  extraDeps: unknown[] = [],
): ReturnType<typeof useFetch<T>> {
  const lastEvt = useMemo(() => lastMatching(events, topics), [events, topics]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useFetch(fn, [lastEvt, ...extraDeps]);
}
```

Add to the imports at the top of hooks.ts: `useMemo` from react, `StoredEvent` (already imported), and `import { lastMatching } from "./lib/topics.js";`

- [ ] **Step 5: Migrate every consumer** — mechanical, one file at a time. Exact replacements:

`ui/src/App.tsx`:
- Delete line 21 (`const AGENT_MAIL_EVENTS = new Set(...)` and its comment line 20). Add `import { T } from "./lib/topics.js";` and change the hooks import to `import { useEvents, useFetch, useLiveQuery } from "./hooks.js";`
- Replace lines 27, 36-43:
```tsx
  const { data: state, error, reload } = useFetch(() => api.state(), []);
  ...
  const { data: budget } = useLiveQuery(() => api.budget(), events, T.budget);
  const { data: unread } = useLiveQuery(() => api.mailUnread(), events, T.agentMail);
```
(the two `lastCostEvt` / `lastMailEvt` `useMemo`s are deleted.)

`ui/src/views/Org.tsx`:
- Delete lines 8-9 (`AGENT_MAIL_EVENTS`) and lines 21-26 (`lastEvt` memo + `usePoll`); replace with `const { data: org } = useLiveQuery(() => api.org(), events, T.agentsActions);`
- `AgentProfile`: `usePoll(() => api.agent(name), [name])` → `useFetch(() => api.agent(name), [name])`.
- `MailSection`: delete its `lastMailEvt` memo; `const { data: mail } = useLiveQuery(() => api.mail(name), events, T.agentMail, [name]);`
- Imports: `import { useFetch, useLiveQuery } from "../hooks.js"; import { T } from "../lib/topics.js";`

`ui/src/views/Mail.tsx`:
- Delete line 6 (`AGENT_MAIL_EVENTS`) and the lines 9-12 memo. `const { data: mine, reload } = useLiveQuery(() => api.mailMine(), events, T.agentMail);` and `const { data: org } = useFetch(() => api.org(), []);`
- `ThreadDetail` keeps its `lastMailEvt` prop → change the prop to `events: StoredEvent[]` and use `useLiveQuery(() => api.mailThreadView(threadId), events, T.agentMail, [threadId])`. Update the call site: `<ThreadDetail key={open} threadId={open} events={events} onChanged={reload} />`.

`ui/src/views/Goals.tsx`:
- Delete local `const usd = ...` and `const ts = ...` (lines 38-39); `import { ts, usd } from "../lib/format.js";`
- Both `lastEvt` memos (Goals + GoalDetailView) die; use `useLiveQuery(() => api.goals(), events, T.goals)` and `useLiveQuery(() => api.goal(idOrSlug), events, T.goals, [idOrSlug])`.
- Replace the arm-abandon pair (lines 179-181) with `<ConfirmButton label="abandon" alert onConfirm={() => act("abandon")} />` and delete the `armAbandon` state + `setArmAbandon` calls. `CtlButton` stays for pause/resume.

`ui/src/views/Packs.tsx`: `lastEvt` memo dies → `useLiveQuery(() => api.packs(), events, T.goals)`.

`ui/src/views/Approvals.tsx`: memo dies → `useLiveQuery(() => api.actions("proposed"), events, T.actions)`.

`ui/src/views/Trust.tsx`: memo dies → `useLiveQuery(() => api.trust(), events, T.trust)`.

`ui/src/views/Permissions.tsx`: memo dies → `useLiveQuery(() => api.permissions(), events, T.permissions)`.

`ui/src/views/Costs.tsx`: memo dies → `useLiveQuery(() => api.costs(), events, T.costs)`. (The old memo also filtered on `costUsd` presence; refetching on every `agent.end` is a harmless simplification.)

`ui/src/views/Config.tsx`: `usePoll` → `useFetch` (two call sites), import updated.

- [ ] **Step 6: Verify**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean, build green. `grep -rn "usePoll\|AGENT_MAIL_EVENTS" ui/src/` returns nothing.

- [ ] **Step 7: Commit**

```bash
git add ui/src
git commit -m "refactor(ui): shared topics/format/useLiveQuery lib + ConfirmButton — kill 8 copy-pasted lastEvt memos"
```

---

### Task 2: Hash router + 4-zone shell

**Files:**
- Create: `ui/src/lib/router.ts`
- Modify: `ui/src/App.tsx` (full rewrite below)
- Modify: `ui/src/views/Goals.tsx`, `ui/src/views/Org.tsx`, `ui/src/views/Mail.tsx` (route-driven selection)

**Interfaces:**
- Consumes: Task 1 lib.
- Produces: `useRoute(): { zone: string; parts: string[]; query: URLSearchParams }`, `navigate(path: string)`, `href(path: string)` from `lib/router.ts`. View prop contracts after this task: `Goals({ events, route })`, `Org({ events, route, onOpenChat, unreadByAgent })`, `Mail({ events, route })`. Tasks 3–6 rely on these.

- [ ] **Step 1: Create `ui/src/lib/router.ts`**

```ts
// ui/src/lib/router.ts — minimal hash router. #/zone/seg1/seg2?query — no dependency.
import { useMemo, useSyncExternalStore } from "react";

export interface Route { zone: string; parts: string[]; query: URLSearchParams }

export const ZONES = ["inbox", "work", "staff", "system"] as const;

export function parseHash(hash: string): Route {
  const [path, q] = hash.replace(/^#\/?/, "").split("?");
  const segs = path.split("/").filter(Boolean).map(decodeURIComponent);
  const zone = (ZONES as readonly string[]).includes(segs[0]) ? segs[0] : "inbox";
  return { zone, parts: segs.slice(1), query: new URLSearchParams(q ?? "") };
}

export function href(path: string): string {
  return path.startsWith("#") ? path : `#/${path.replace(/^\//, "")}`;
}

export function navigate(path: string): void {
  window.location.hash = href(path);
}

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export function useRoute(): Route {
  const raw = useSyncExternalStore(subscribe, () => window.location.hash);
  return useMemo(() => parseHash(raw), [raw]);
}
```

- [ ] **Step 2: Rewrite `ui/src/App.tsx`**

Full replacement content:

```tsx
import { useState } from "react";
import { api, setToken, getToken, type BudgetInfo } from "./api.js";
import { useEvents, useFetch, useLiveQuery } from "./hooks.js";
import { T } from "./lib/topics.js";
import { useRoute, navigate, type Route } from "./lib/router.js";
import { Goals } from "./views/Goals.js";
import { Mail } from "./views/Mail.js";
import { Org } from "./views/Org.js";
import { RoutingTrail } from "./views/RoutingTrail.js";
import { Chat } from "./views/Chat.js";
import { Config } from "./views/Config.js";
import { Costs } from "./views/Costs.js";
import { EventFeed } from "./views/EventFeed.js";
import { Approvals } from "./views/Approvals.js";
import { Trust } from "./views/Trust.js";
import { Permissions } from "./views/Permissions.js";
import { Packs } from "./views/Packs.js";

// zone → ordered sub-views. First entry is the zone default.
const SUBNAV: Record<string, string[]> = {
  inbox: [],
  work: ["goals", "mail", "chat"],
  staff: ["org", "trust", "permissions"],
  system: ["departments", "config", "costs", "routing"],
};

/** Which leaf view a route shows. Every leaf stays mounted; this only picks visibility. */
function leafOf(route: Route): string {
  const sub = route.parts[0];
  if (route.zone === "inbox") return "inbox";
  if (route.zone === "work") return sub === "mail" ? "mail" : sub === "chat" ? "chat" : "goals";
  if (route.zone === "staff") {
    if (sub === "agents") return "org"; // profile drill-in renders inside Org
    return sub === "trust" ? "trust" : sub === "permissions" ? "permissions" : "org";
  }
  return sub === "config" ? "config" : sub === "costs" ? "costs" : sub === "routing" ? "routing" : "departments";
}

export function App() {
  const route = useRoute();
  const leaf = leafOf(route);
  const [chatTarget, setChatTarget] = useState("hermes");
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem("aios_rail") !== "0");
  const { events, connected } = useEvents();
  const { data: state, error, reload } = useFetch(() => api.state(), []);
  const { data: budget } = useLiveQuery(() => api.budget(), events, T.budget);
  const { data: unread } = useLiveQuery(() => api.mailUnread(), events, T.agentMail);
  const { data: pending } = useLiveQuery(() => api.actions("proposed"), events, T.actions);

  const openChat = (name: string) => { setChatTarget(name); navigate("work/chat"); };
  const toggleRail = () => setRailOpen((v) => { localStorage.setItem("aios_rail", v ? "0" : "1"); return !v; });

  if (error === "unauthorized") return <TokenGate onSet={reload} />;

  const activeAgents = new Map<string, string>();
  for (const e of events) {
    if (e.event.type === "agent.start") activeAgents.set(String(e.event.agent), String(e.event.context));
    if (e.event.type === "agent.end") activeAgents.delete(String(e.event.agent));
  }

  const inboxCount = (pending?.length ?? 0) + (unread?.userInbox ?? 0) + (unread?.pendingUser ?? 0);

  return (
    <div className="h-full flex flex-col">
      {/* Top status bar */}
      <header className="flex items-center gap-6 px-5 h-12 border-b border-line bg-panel shrink-0">
        <div className="font-display font-bold tracking-[0.3em] text-bright text-sm">
          AI<span className="text-phosphor glow-green">⏣</span>OS
        </div>
        <div className="label">Mission Control</div>
        <div className="flex items-center gap-2 ml-auto">
          {[...activeAgents.entries()].map(([agent, ctx]) => (
            <span key={agent} className="px-2 py-0.5 text-[11px] border border-line bg-panel-2 text-amber glow-amber">
              ▸ {agent} <span className="text-dim">{ctx.replace(/^(job|chat|goal):/, "")}</span>
            </span>
          ))}
          {activeAgents.size === 0 && <span className="text-dim text-[11px]">all agents idle</span>}
        </div>
        <BudgetBar budget={budget} />
        <button onClick={toggleRail} title="toggle telemetry" className={`label hover:text-fg ${railOpen ? "text-phosphor" : ""}`}>
          ◫
        </button>
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-phosphor live-dot" : "bg-alert"}`} />
          <span className="label">{connected ? "LINK" : "NO LINK"}</span>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Zone rail */}
        <nav className="w-40 shrink-0 border-r border-line bg-panel flex flex-col py-4 gap-1">
          {(["inbox", "work", "staff", "system"] as const).map((z, i) => (
            <div key={z}>
              <button
                onClick={() => navigate(z)}
                className={`boot w-full text-left px-5 py-2.5 font-display uppercase tracking-[0.18em] text-[11px] transition-colors border-l-2 ${
                  route.zone === z
                    ? "border-phosphor text-phosphor glow-green bg-panel-2"
                    : "border-transparent text-dim hover:text-fg hover:border-line"
                }`}
                style={{ animationDelay: `${i * 60}ms` }}
              >
                {z}
                {z === "inbox" && inboxCount > 0 && (
                  <span className="ml-2 text-[9px] text-void bg-amber px-1.5 rounded-full tracking-normal align-middle">{inboxCount}</span>
                )}
                {z === "staff" && unread && unread.total > 0 && (
                  <span className="ml-2 text-[9px] text-void bg-amber px-1.5 rounded-full tracking-normal align-middle">{unread.total}</span>
                )}
              </button>
              {route.zone === z && SUBNAV[z].map((s) => (
                <button
                  key={s}
                  onClick={() => navigate(`${z}/${s}`)}
                  className={`w-full text-left pl-8 pr-2 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors ${
                    leaf === leafOf({ zone: z, parts: [s], query: new URLSearchParams() })
                      ? "text-bright"
                      : "text-dim hover:text-fg"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          ))}
          <div className="mt-auto px-5">
            <div className="label mb-1">Uptime</div>
            <div className="text-[11px] text-fg">{state ? fmtUptime(state.uptimeMs) : "—"}</div>
          </div>
        </nav>

        {/* Main view — every leaf stays mounted; route picks visibility. */}
        <main className="flex-1 min-w-0 overflow-auto p-5">
          <div className={leaf === "inbox" ? "h-full" : "hidden"}><Approvals events={events} /></div>
          <div className={leaf === "goals" ? "h-full" : "hidden"}><Goals events={events} route={route} /></div>
          <div className={leaf === "mail" ? "h-full" : "hidden"}><Mail events={events} route={route} /></div>
          <div className={leaf === "chat" ? "h-full" : "hidden"}><Chat state={state} events={events} target={chatTarget} setTarget={setChatTarget} /></div>
          <div className={leaf === "org" ? "h-full" : "hidden"}><Org events={events} route={route} onOpenChat={openChat} unreadByAgent={unread?.byAgent ?? {}} /></div>
          <div className={leaf === "trust" ? "" : "hidden"}><Trust events={events} /></div>
          <div className={leaf === "permissions" ? "" : "hidden"}><Permissions events={events} /></div>
          <div className={leaf === "departments" ? "h-full" : "hidden"}><Packs events={events} /></div>
          <div className={leaf === "config" ? "h-full" : "hidden"}><Config /></div>
          <div className={leaf === "costs" ? "" : "hidden"}><Costs events={events} /></div>
          <div className={leaf === "routing" ? "" : "hidden"}><RoutingTrail events={events} /></div>
        </main>

        {/* Telemetry rail — toggleable at every width now. */}
        {railOpen && (
          <aside className="w-72 shrink-0 border-l border-line bg-panel hidden lg:flex flex-col">
            <div className="label px-4 pt-4 pb-2">Telemetry</div>
            <EventFeed events={events} />
          </aside>
        )}
      </div>
    </div>
  );
}

function BudgetBar({ budget }: { budget: BudgetInfo | undefined }) {
  // Spec §9: hidden entirely when no cap is configured.
  if (!budget || budget.capCents == null) return null;
  const pct = budget.capCents > 0 ? Math.min(100, (budget.spentCents / budget.capCents) * 100) : 100;
  const hot = pct >= 80;
  return (
    <div className="flex items-center gap-2" title={`daily budget · ${budget.date}`}>
      <div className="w-24 h-1.5 bg-panel-2 border border-line">
        <div className={`h-full ${hot ? "bg-alert" : "bg-phosphor"}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-[10px] ${hot ? "text-alert" : "text-dim"}`}>
        ${(budget.spentCents / 100).toFixed(2)} / ${(budget.capCents / 100).toFixed(2)}
      </span>
    </div>
  );
}

function TokenGate({ onSet }: { onSet: () => void }) {
  const [value, setValue] = useState(getToken());
  return (
    <div className="h-full flex items-center justify-center">
      <div className="hud p-8 w-96 boot">
        <div className="font-display text-bright tracking-[0.3em] mb-1">AI⏣OS</div>
        <div className="label mb-6">Access token required</div>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (setToken(value), onSet())}
          placeholder="AIOS_UI_TOKEN"
          className="w-full bg-void border border-line px-3 py-2 text-fg outline-none focus:border-phosphor"
        />
        <button
          onClick={() => { setToken(value); onSet(); }}
          className="mt-4 w-full border border-phosphor text-phosphor py-2 font-display uppercase tracking-[0.2em] text-[11px] hover:bg-phosphor hover:text-void transition-colors"
        >
          Authenticate
        </button>
      </div>
    </div>
  );
}

function fmtUptime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h ? `${h}h ${m}m` : `${m}m`;
}
```

Notes: `Approvals` temporarily fills the inbox leaf (Task 3 replaces it with the real Inbox). The `goalTarget`/`agentTarget` consume-callback plumbing is deleted — routes carry that now.

- [ ] **Step 3: Route-drive `ui/src/views/Goals.tsx`**

- Change signature to `export function Goals({ events, route }: { events: StoredEvent[]; route: Route })` (`import type { Route } from "../lib/router.js"; import { navigate } from "../lib/router.js";`). Delete the `GoalTarget` interface/export, the `target/onConsumeTarget/onOpenAgent` props, and the target-consuming `useEffect`.
- `const selected = route.parts[0] === "goals" ? route.parts[1] ?? null : null;` — delete the `useState` for `selected`/`initialNode`.
- `GoalCard onClick` → `navigate(`work/goals/${g.slug}`)`.
- `GoalDetailView`: receives `route`; `const selectedNode = route.query.get("node");` node select → `navigate(`work/goals/${goal.slug}?node=${encodeURIComponent(key)}`)`; NodePanel close → `navigate(`work/goals/${goal.slug}`)`; `onBack` → `navigate("work")`.
- `spawnedBy` click (was `onOpenAgent`) → `navigate(`staff/agents/${goal.spawnedBy.from}`)`.

- [ ] **Step 4: Route-drive `ui/src/views/Org.tsx`**

- Signature: `export function Org({ events, route, onOpenChat, unreadByAgent }: { events: StoredEvent[]; route: Route; onOpenChat: (name: string) => void; unreadByAgent: Record<string, number> })`. Delete `agentTarget/onConsumeAgentTarget/onOpenGoal` props + effect.
- `const selected = route.parts[0] === "agents" ? route.parts[1] ?? null : null;` — delete `useState`.
- Card click → `navigate(`staff/agents/${a.name}`)`; profile back → `navigate("staff")`.
- Goal deep-links (currentTask + MailSection) → `navigate(`work/goals/${slug}${nodeKey ? `?node=${nodeKey}` : ""}`)` — drop the `onOpenGoal` prop threading.

- [ ] **Step 5: Route-drive `ui/src/views/Mail.tsx`**

- Signature: `export function Mail({ events, route }: { events: StoredEvent[]; route: Route })`.
- `const open = route.parts[0] === "mail" ? route.parts[1] ?? null : null;` — delete `useState`; `onOpen` → `navigate(`work/mail/${t.threadId}`)`; compose `onSent(id)` → `if (id) navigate(`work/mail/${id}`)`.

- [ ] **Step 6: Verify**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean. Manual spot-check in dev (`cd ui && npm run dev`): `#/work/goals/<slug>` deep-link opens the DAG; browser refresh stays on it; back button walks history.

- [ ] **Step 7: Commit**

```bash
git add ui/src
git commit -m "feat(ui): hash router + 4-zone nav (inbox/work/staff/system) — selection state moves into the URL"
```

---

### Task 3: Inbox — the unified attention queue

**Files:**
- Create: `ui/src/views/Inbox.tsx`
- Delete: `ui/src/views/Approvals.tsx`
- Modify: `ui/src/App.tsx` (swap inbox leaf, drop Approvals import)

**Interfaces:**
- Consumes: `api.actions("proposed")`, `api.resolveAction`, `api.mailMine()`, `api.goals()`, `useLiveQuery`, `T`, `ConfirmButton`, `navigate`, `ts` — all from earlier tasks.
- Produces: `Inbox({ events })`. Nothing downstream depends on its internals.

- [ ] **Step 1: Create `ui/src/views/Inbox.tsx`**

```tsx
// ui/src/views/Inbox.tsx — the answer to "what needs me?": approvals, asks, unread mail, failures.
import { useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate } from "../lib/router.js";
import { ts } from "../lib/format.js";
import { ConfirmButton } from "../components/ConfirmButton.js";

export function Inbox({ events }: { events: StoredEvent[] }) {
  const { data: actions, reload: reloadActions } = useLiveQuery(() => api.actions("proposed"), events, T.actions);
  const { data: mine, reload: reloadMail } = useLiveQuery(() => api.mailMine(), events, T.agentMail);
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);

  const asks = (mine?.threads ?? []).filter((t) => t.pendingAsk > 0);
  const unreadThreads = (mine?.threads ?? []).filter((t) => t.unread > 0 && t.pendingAsk === 0);
  const failed = (goals ?? []).filter((g) => g.status === "failed");
  const empty = !actions?.length && !asks.length && !unreadThreads.length && !failed.length;

  return (
    <div className="flex flex-col gap-5 max-w-3xl">
      {empty && (
        <div className="border border-dashed border-line text-dim text-[12px] p-8 text-center boot">
          Inbox zero — nothing needs you. <span className="text-phosphor">System nominal.</span>
        </div>
      )}

      {!!actions?.length && (
        <section>
          <div className="label mb-2">Approvals — {actions.length} pending</div>
          <div className="flex flex-col gap-2">
            {actions.map((a) => <ApprovalRow key={a.id} a={a} onDone={reloadActions} />)}
          </div>
        </section>
      )}

      {asks.length > 0 && (
        <section>
          <div className="label mb-2">🙋 Agents waiting on your answer</div>
          {asks.map((t) => (
            <button key={t.threadId} onClick={() => navigate(`work/mail/${t.threadId}`)}
              className="hud hud-cyan p-3 mb-2 w-full text-left hover:bg-panel-2 transition-colors">
              <div className="text-[11px]"><span className="text-cyan">{t.lastFrom}</span>
                <span className="text-dim ml-2">{ts(t.lastTs)}</span></div>
              <div className="text-[12px] text-bright truncate">{t.lastBody}</div>
            </button>
          ))}
        </section>
      )}

      {unreadThreads.length > 0 && (
        <section>
          <div className="label mb-2">Unread mail</div>
          {unreadThreads.map((t) => (
            <button key={t.threadId} onClick={() => { navigate(`work/mail/${t.threadId}`); reloadMail(); }}
              className="hud p-3 mb-2 w-full text-left hover:bg-panel-2 transition-colors">
              <div className="text-[11px]"><span className="text-fg">{t.lastFrom}</span>
                <span className="text-void bg-amber px-1 rounded-full text-[9px] ml-2">{t.unread}</span>
                <span className="text-dim ml-2">{ts(t.lastTs)}</span></div>
              <div className="text-[12px] text-dim truncate">{t.lastBody}</div>
            </button>
          ))}
        </section>
      )}

      {failed.length > 0 && (
        <section>
          <div className="label mb-2">Failed goals</div>
          {failed.map((g) => (
            <button key={g.id} onClick={() => navigate(`work/goals/${g.slug}`)}
              className="hud hud-alert p-3 mb-2 w-full text-left hover:bg-panel-2 transition-colors">
              <div className="text-[12px] text-bright">{g.title}</div>
              {g.error && <div className="text-[11px] text-alert truncate">{g.error}</div>}
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

function ApprovalRow({ a, onDone }: { a: import("../api.js").ActionInfo; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const decide = async (verdict: "approve" | "reject") => {
    setBusy(true);
    try {
      await api.resolveAction(a.id, verdict, verdict === "reject" ? reason || undefined : undefined);
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="hud p-4 boot">
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-amber">{a.type} · {a.id} · via {a.origin_channel}</div>
          <div className="text-fg">{a.preview}</div>
          <div className="text-[10px] text-dim">expires {ts(a.expires_at)}</div>
        </div>
        <ConfirmButton label="approve" disabled={busy} onConfirm={() => decide("approve")} />
        <button disabled={busy} onClick={() => setRejecting((v) => !v)}
          className="border border-alert text-alert px-3 py-1 font-display uppercase tracking-[0.2em] text-[10px] hover:bg-alert hover:text-void transition-colors disabled:opacity-40">
          reject
        </button>
      </div>
      {rejecting && (
        <div className="flex gap-2 mt-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="reason (optional — trains the ledger)"
            className="flex-1 bg-void border border-alert/40 px-2 py-1 text-[11px] text-fg outline-none focus:border-alert" />
          <ConfirmButton label="confirm reject" alert disabled={busy} onConfirm={() => decide("reject")} />
        </div>
      )}
      {msg && <div className="text-[11px] text-alert mt-1">{msg}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Wire into App, delete Approvals**

In `ui/src/App.tsx`: replace `import { Approvals } from "./views/Approvals.js";` with `import { Inbox } from "./views/Inbox.js";` and the inbox leaf div with `<div className={leaf === "inbox" ? "h-full" : "hidden"}><Inbox events={events} /></div>`. Then `git rm ui/src/views/Approvals.tsx`.

- [ ] **Step 3: Verify**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean. `grep -rn "window.prompt\|prompt(" ui/src/views/Inbox.tsx` → nothing.

- [ ] **Step 4: Commit**

```bash
git add -A ui/src
git commit -m "feat(ui): Inbox zone — unified attention queue absorbs Approvals tab"
```

---

### Task 4: Governance — merge Trust + Permissions under Staff

**Files:**
- Create: `ui/src/views/Governance.tsx`
- Delete: `ui/src/views/Trust.tsx`, `ui/src/views/Permissions.tsx`
- Modify: `ui/src/App.tsx` (SUBNAV staff → `["org", "governance"]`, leafOf + leaf divs)

**Interfaces:**
- Consumes: `api.trust/demoteTrust/permissions/proposePermission`, `useLiveQuery`, `T`, `ConfirmButton`.
- Produces: `Governance({ events })`.

- [ ] **Step 1: Create `ui/src/views/Governance.tsx`** — Trust table + Permissions cards, no native dialogs

```tsx
// ui/src/views/Governance.tsx — the earned-autonomy pipeline in one place:
// trust ledger (top) + per-role permissions (bottom). Grants queue in Inbox→Approvals.
import { useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { ConfirmButton } from "../components/ConfirmButton.js";

const STATE_COLOR: Record<string, string> = {
  autonomous: "text-cyan", graduating: "text-amber", supervised: "text-dim",
};

const MODE_HELP: Record<string, string> = {
  dontAsk: "denies anything not in the allowlist",
  bypassPermissions: "sandboxed write role — runs tools without prompting",
  default: "undecided tools route through the role's guard",
};

export function Governance({ events }: { events: StoredEvent[] }) {
  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <TrustSection events={events} />
      <PermissionsSection events={events} />
    </div>
  );
}

function TrustSection({ events }: { events: StoredEvent[] }) {
  const { data, reload } = useLiveQuery(() => api.trust(), events, T.trust);
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <div className="text-dim">loading…</div>;

  const demote = async (type: string) => {
    try { await api.demoteTrust(type); } catch (e) { setMsg((e as Error).message); }
    reload();
  };

  return (
    <section>
      <div className="label mb-3">Trust ledger — autonomy is earned, never assumed</div>
      {msg && <div className="text-[11px] text-alert mb-2">{msg}</div>}
      <table className="w-full text-[12px]">
        <thead>
          <tr className="label text-left">
            <th className="pb-2">Action type</th><th>State</th><th>✓</th><th>✗</th>
            <th>Streak</th><th>Last rejection</th><th />
          </tr>
        </thead>
        <tbody>
          {data.map((t) => (
            <tr key={t.actionType} className="border-t border-line">
              <td className="py-2 text-fg">{t.actionType}</td>
              <td className={STATE_COLOR[t.state] ?? ""}>{t.state}</td>
              <td>{t.approvals}</td><td>{t.rejections}</td><td>{t.streak}</td>
              <td className="text-dim">{t.lastRejection?.slice(0, 10) ?? "—"}</td>
              <td className="text-right">
                {t.state !== "supervised" && (
                  <ConfirmButton label="demote" alert onConfirm={() => demote(t.actionType)} />
                )}
              </td>
            </tr>
          ))}
          {data.length === 0 && (
            <tr><td colSpan={7} className="py-4 text-dim">no actions proposed yet</td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function PermissionsSection({ events }: { events: StoredEvent[] }) {
  const { data, reload } = useLiveQuery(() => api.permissions(), events, T.permissions);
  const [note, setNote] = useState<string | null>(null);
  if (!data) return <div className="text-dim">loading…</div>;

  const propose = async (role: string, tool: string, action: "grant" | "revoke", knownTools?: string[]) => {
    const t = tool.trim();
    if (!t) return;
    if (/\s/.test(t)) {
      setNote("Tool name can't contain spaces. Built-ins are exact-case (e.g. Bash); MCP tools look like mcp__server__tool.");
      return;
    }
    if (action === "grant" && knownTools !== undefined && !knownTools.includes(t) && !t.startsWith("mcp__")) {
      setNote(`"${t}" isn't a known tool for ${role} — the grant is recorded but does nothing until a tool with that exact name exists.`);
    }
    try {
      await api.proposePermission(role, t, action);
      setNote(`Queued ${action} of "${t}" for ${role} in Inbox → Approvals — approve there to apply.`);
    } catch (e) {
      setNote((e as Error).message);
    }
    reload();
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="label">Permissions — what each agent may use. Grants queue in Inbox → Approvals.</div>
      {note && <div className="text-[11px] text-cyan">{note}</div>}
      {data.map((r) => (
        <div key={r.role} className="hud p-4 boot">
          <div className="flex items-baseline gap-2">
            <div className="text-fg font-display uppercase tracking-widest text-[12px]">{r.role}</div>
            <div className="text-[10px] text-dim" title={MODE_HELP[r.permissionMode] ?? ""}>{r.permissionMode}</div>
          </div>
          <div className="text-[11px] text-dim mb-2">{r.description}</div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {r.tools.map((t) => (
              <span key={t.name}
                className={`text-[10px] px-1.5 py-0.5 border ${t.source === "granted" ? "border-cyan text-cyan" : "border-line text-dim"}`}>
                {t.name}{t.source === "granted" && " +"}
                <button onClick={() => propose(r.role, t.name, "revoke")} className="ml-1 text-alert hover:text-bright">×</button>
              </span>
            ))}
            {r.revoked.map((t) => (
              <span key={t.name} className="text-[10px] px-1.5 py-0.5 border border-line text-dim line-through">
                {t.name}
                <button onClick={() => propose(r.role, t.name, "grant")} className="ml-1 text-phosphor hover:text-bright no-underline">+</button>
              </span>
            ))}
          </div>
          {r.denials.length > 0 && (
            <div className="text-[10px] text-amber mb-2">
              {r.denials.map((d) => (
                <span key={d.tool} className="mr-3">
                  {d.tool} denied {d.count}× (last {d.lastTs.slice(11, 16)}){" "}
                  <button onClick={() => propose(r.role, d.tool, "grant")} className="text-phosphor hover:text-bright">grant</button>
                </span>
              ))}
            </div>
          )}
          <form className="flex gap-1.5 items-center"
            onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem("tool") as HTMLInputElement;
              propose(r.role, input.value, "grant", r.knownTools);
              input.value = "";
            }}>
            <input name="tool" list={`tools-${r.role}`} autoComplete="off"
              placeholder="tool name — pick or type (e.g. Bash)"
              className="bg-panel-2 border border-line text-fg text-[11px] px-2 py-1 flex-1" />
            <datalist id={`tools-${r.role}`}>
              {r.knownTools.map((name) => <option key={name} value={name} />)}
            </datalist>
            <button type="submit"
              className="border border-phosphor text-phosphor px-3 py-1 text-[10px] uppercase tracking-widest hover:bg-phosphor hover:text-void transition-colors">
              propose grant
            </button>
          </form>
        </div>
      ))}
    </section>
  );
}
```

- [ ] **Step 2: Wire into App**

In `ui/src/App.tsx`: `SUBNAV.staff = ["org", "governance"]`; in `leafOf`, staff branch becomes `return sub === "governance" ? "governance" : "org";`; replace the trust + permissions leaf divs with `<div className={leaf === "governance" ? "" : "hidden"}><Governance events={events} /></div>`; swap imports. `git rm ui/src/views/Trust.tsx ui/src/views/Permissions.tsx`.

- [ ] **Step 3: Verify**

Run: `cd ui && npx tsc --noEmit && npm run build && ! grep -rn "confirm(\|alert(\|prompt(" ui/src/views/Governance.tsx`
Expected: clean, grep empty.

- [ ] **Step 4: Commit**

```bash
git add -A ui/src
git commit -m "feat(ui): Governance view under Staff — merges Trust + Permissions tabs, kills native dialogs"
```

---

### Task 5: Chat drawer

**Files:**
- Create: `ui/src/components/ChatDrawer.tsx`
- Modify: `ui/src/App.tsx` (drawer state, remove `chat` from work SUBNAV/leafOf/leaf divs)

**Interfaces:**
- Consumes: existing `Chat` view component unchanged.
- Produces: `ChatDrawer({ open, onClose, state, events, target, setTarget })`. `openChat(name)` in App now opens the drawer instead of navigating.

- [ ] **Step 1: Create `ui/src/components/ChatDrawer.tsx`**

```tsx
// ui/src/components/ChatDrawer.tsx — chat slides over the bottom so org/goal context stays visible.
import type { StateInfo, StoredEvent } from "../api.js";
import { Chat } from "../views/Chat.js";

export function ChatDrawer({ open, onClose, state, events, target, setTarget }: {
  open: boolean; onClose: () => void;
  state: StateInfo | undefined; events: StoredEvent[];
  target: string; setTarget: (t: string) => void;
}) {
  // Stays mounted (log/draft survive) — only visibility toggles.
  return (
    <div className={`fixed inset-x-0 bottom-0 z-40 border-t border-phosphor/40 bg-panel shadow-2xl transition-transform duration-200 ${open ? "translate-y-0" : "translate-y-full"}`}
      style={{ height: "min(480px, 70vh)" }}>
      <div className="flex items-center px-4 h-8 border-b border-line">
        <span className="label">Comms — {target}</span>
        <button onClick={onClose} className="ml-auto text-dim hover:text-fg text-[12px]">✕ close</button>
      </div>
      <div className="h-[calc(100%-2rem)] p-4">
        <Chat state={state} events={events} target={target} setTarget={setTarget} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire into App**

In `ui/src/App.tsx`:
- `SUBNAV.work = ["goals", "mail"]`; remove the `chat` branch from `leafOf` and delete the chat leaf div.
- Add state `const [chatOpen, setChatOpen] = useState(false);`; `openChat` becomes `(name: string) => { setChatTarget(name); setChatOpen(true); }`.
- Topbar: add before the rail toggle:
```tsx
        <button onClick={() => setChatOpen((v) => !v)}
          className={`label hover:text-fg ${chatOpen ? "text-phosphor" : ""}`}>comms</button>
```
- At the end of the root div (after the flex row): `<ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} state={state} events={events} target={chatTarget} setTarget={setChatTarget} />` and import it. Remove the now-unused `Chat` import from App (it lives inside the drawer).

- [ ] **Step 3: Verify**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean. Dev spot-check: open an agent profile → Chat button opens drawer over the profile; close; log persists.

- [ ] **Step 4: Commit**

```bash
git add -A ui/src
git commit -m "feat(ui): chat becomes a bottom drawer — talk to any agent without leaving context"
```

---

### Task 6: System zone — EventLog absorbs RoutingTrail; Packs → Departments

**Files:**
- Create: `ui/src/views/EventLog.tsx`
- Delete: `ui/src/views/RoutingTrail.tsx`
- Rename: `ui/src/views/Packs.tsx` → `ui/src/views/Departments.tsx` (component `Packs` → `Departments`)
- Modify: `ui/src/views/EventFeed.tsx` (export `describe` + `COLOR`), `ui/src/App.tsx`

**Interfaces:**
- Consumes: `api.events()` (existing 500-cap history), live `events` buffer, `describe`/`COLOR` from EventFeed.
- Produces: `EventLog({ events })`, `Departments({ events })`. SUBNAV system → `["departments", "config", "costs", "events"]`.

- [ ] **Step 1: Export the event renderer from `ui/src/views/EventFeed.tsx`**

Change `const COLOR` → `export const COLOR` and `function describe` → `export function describe`.

- [ ] **Step 2: Create `ui/src/views/EventLog.tsx`**

```tsx
// ui/src/views/EventLog.tsx — full event history (server 500-cap + live SSE merge) with
// filter presets. Absorbs the old RoutingTrail (preset "routing").
// ponytail: no cursor pagination — bus.history caps at 500; add ?before= paging if that ever hurts.
import { useMemo, useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { useFetch } from "../hooks.js";
import { matches } from "../lib/topics.js";
import { describe, COLOR } from "./EventFeed.js";

const PRESETS: Record<string, readonly string[]> = {
  all: [],
  routing: ["route.decision"],
  goals: ["goal.", "node."],
  agents: ["agent."],
  actions: ["action.", "trust.changed", "permission.changed"],
  chat: ["chat."],
  mail: ["mail."],
};

const VIA_COLOR: Record<string, string> = {
  mention: "text-cyan", binding: "text-violet", handoff: "text-amber",
  default: "text-dim", verdict: "text-phosphor", reset: "text-alert",
};

export function EventLog({ events }: { events: StoredEvent[] }) {
  const { data: history } = useFetch(() => api.events(), []);
  const [preset, setPreset] = useState<keyof typeof PRESETS>("all");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const byId = new Map<number, StoredEvent>();
    for (const e of history ?? []) byId.set(e.id, e);
    for (const e of events) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => b.id - a.id);
  }, [history, events]);

  const filtered = rows.filter((e) => {
    const topics = PRESETS[preset];
    if (topics.length && !matches(e.event.type, topics)) return false;
    if (!q.trim()) return true;
    return JSON.stringify(e.event).toLowerCase().includes(q.toLowerCase());
  });

  return (
    <div className="max-w-4xl flex flex-col gap-3">
      <div className="flex gap-2 items-center flex-wrap">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…"
          className="bg-panel border border-line px-3 py-1.5 text-[12px] text-fg outline-none focus:border-phosphor w-64" />
        {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).map((p) => (
          <button key={p} onClick={() => setPreset(p)}
            className={`px-2 py-1 text-[10px] font-display uppercase tracking-wider border transition-colors ${
              preset === p ? "border-phosphor text-phosphor" : "border-line text-dim hover:text-fg"}`}>
            {p}
          </button>
        ))}
      </div>
      <div className="hud p-4 flex flex-col gap-1.5">
        {filtered.slice(0, 300).map((e) => (
          <div key={e.id} className="text-[11px] leading-relaxed">
            <span className="text-dim">{e.ts.slice(5, 19).replace("T", " ")} </span>
            {e.event.type === "route.decision" ? (
              <RouteRow e={e} />
            ) : (
              <span className={COLOR[e.event.type] ?? "text-fg"}>{describe(e)}</span>
            )}
          </div>
        ))}
        {filtered.length === 0 && <div className="text-dim text-[11px]">nothing matching</div>}
      </div>
    </div>
  );
}

function RouteRow({ e }: { e: StoredEvent }) {
  const v = e.event as unknown as { to: string; via: string; reason: string; channel: string; chatId: string };
  return (
    <>
      <span className={VIA_COLOR[v.via] ?? "text-fg"}>[{v.via}]</span>{" "}
      <span className="text-bright">→ {v.to}</span>{" "}
      <span className="text-fg">{v.reason}</span>{" "}
      <span className="text-dim">({v.channel}:{v.chatId})</span>
    </>
  );
}
```

- [ ] **Step 3: Rename Packs → Departments**

```bash
git mv ui/src/views/Packs.tsx ui/src/views/Departments.tsx
```
In the renamed file: header comment path, `export function Packs` → `export function Departments`. Replace the `window.confirm` in `handleToggle` (Packs.tsx:31) with a `ConfirmButton` next to the enable/disable toggle: change the toggle `<button>` to a `<ConfirmButton label={pack.enabled ? "● enabled" : "○ disabled"} confirmLabel={`${pack.enabled ? "disable" : "enable"} + restart?`} alert={pack.enabled} onConfirm={handleToggle} className="ml-auto" />` and drop the `window.confirm` line inside `handleToggle`.

- [ ] **Step 4: Wire into App**

`SUBNAV.system = ["departments", "config", "costs", "events"]`; `leafOf` system branch: `return sub === "config" ? "config" : sub === "costs" ? "costs" : sub === "events" ? "events" : "departments";`; leaf divs: replace routing div with `<div className={leaf === "events" ? "" : "hidden"}><EventLog events={events} /></div>`; `Packs` import/usage → `Departments`. Delete `RoutingTrail` import; `git rm ui/src/views/RoutingTrail.tsx`.

- [ ] **Step 5: Verify + commit**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean.

```bash
git add -A ui/src
git commit -m "feat(ui): System→Events log absorbs RoutingTrail; Packs renamed Departments; confirm-free toggles"
```

---

### Task 7: Shared DTO module — one source of truth for wire types

**Files:**
- Create: `src/web/dto.ts`
- Modify: `src/web/org-view.ts`, `src/web/goals-view.ts`, `src/web/packs-view.ts`, `src/web/permissions-view.ts` (import shapes instead of declaring)
- Modify: `ui/src/api.ts` (re-export from dto)

**Interfaces:**
- Consumes: nothing new.
- Produces: `src/web/dto.ts` exporting exactly the interfaces currently in `ui/src/api.ts:1-149` (AgentInfo, StateInfo, StoredEvent, ActionInfo, TrustInfo, OrgAgentCard, OrgDepartmentView, AgentProfileInfo, PermissionInfo, PackRoleView, PackPlaybookView, PackJobView, PackWorkspaceView, PackView, GoalNodeView, GoalView, GoalDetail, MailView, UserThreadView, BudgetInfo). These names are canonical from here on.

- [ ] **Step 1: Create `src/web/dto.ts`**

Move the interface block from `ui/src/api.ts` lines 1-149 verbatim into `src/web/dto.ts` with the header:

```ts
// src/web/dto.ts — the wire contract between the daemon's /api/* JSON and the React UI.
// Types only. Zero imports. Server view-builders implement these; ui/src/api.ts re-exports them.
```

(then the twenty interfaces exactly as they appear in `ui/src/api.ts` today).

- [ ] **Step 2: Point the server view files at dto**

For each of the four `src/web/*-view.ts` files: delete the locally declared interface that duplicates a dto shape and import it instead, e.g. in `goals-view.ts`:

```ts
import type { GoalNodeView, GoalView, GoalDetail, MailView, UserThreadView, BudgetInfo } from "./dto.js";
```

Server-local names that differ adopt the dto name: `org-view.ts` `AgentProfileView` → `AgentProfileInfo` (update its `buildAgentProfile` return type and any import in `server.ts`); `permissions-view.ts` `PermissionRoleView` → `PermissionInfo`. Internal-only types (`RunValidation`, `FileValidation`, `PackFileRoute`, `PermissionTool`, `PermissionDenial`, `AgentLiveStatus`) stay where they are.
If `npx tsc --noEmit` reveals a field mismatch between a server builder and the dto shape, **the server builder's actual output wins** (it defines the runtime JSON): fix the dto field to match, then re-run both tscs — that mismatch is precisely the silent drift this task exists to catch.

- [ ] **Step 3: Point `ui/src/api.ts` at dto**

Replace lines 1-149 with:

```ts
export type {
  AgentInfo, StateInfo, StoredEvent, ActionInfo, TrustInfo,
  OrgAgentCard, OrgDepartmentView, AgentProfileInfo, PermissionInfo,
  PackRoleView, PackPlaybookView, PackJobView, PackWorkspaceView, PackView,
  GoalNodeView, GoalView, GoalDetail, MailView, UserThreadView, BudgetInfo,
} from "../../src/web/dto.js";
import type { StateInfo, StoredEvent, ActionInfo, TrustInfo, OrgDepartmentView, AgentProfileInfo, PermissionInfo, PackView, GoalView, GoalDetail, MailView, UserThreadView, BudgetInfo } from "../../src/web/dto.js";
```

(the `api` object below needs the `import type` line for its own annotations).

- [ ] **Step 4: Verify both sides + suite**

Run: `npx tsc --noEmit && npx vitest run && cd ui && npx tsc --noEmit && npm run build`
Expected: backend tsc clean, **934 pass + 1 skip**, ui clean.

- [ ] **Step 5: Commit**

```bash
git add src/web ui/src/api.ts
git commit -m "refactor(web): single dto.ts wire contract — server builders and UI import the same types"
```

---

### Task 8: ⌘K command palette

**Files:**
- Create: `ui/src/components/CommandPalette.tsx`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Consumes: `navigate`, `api.goals()`, `state.agents`, `openChat` callback.
- Produces: `CommandPalette({ state, onOpenChat })` — self-contained, binds its own ⌘K/Ctrl-K listener.

- [ ] **Step 1: Create `ui/src/components/CommandPalette.tsx`**

```tsx
// ui/src/components/CommandPalette.tsx — ⌘K jump: zones, agents (chat/profile), goals.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type StateInfo, type GoalView } from "../api.js";
import { navigate } from "../lib/router.js";

interface Item { label: string; hint: string; run: () => void }

export function CommandPalette({ state, onOpenChat }: {
  state: StateInfo | undefined; onOpenChat: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [goals, setGoals] = useState<GoalView[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQ("");
        setSel(0);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      api.goals().then(setGoals).catch(() => {});
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const close = (fn: () => void) => () => { fn(); setOpen(false); };
    const base: Item[] = [
      { label: "inbox", hint: "zone", run: close(() => navigate("inbox")) },
      { label: "work", hint: "zone", run: close(() => navigate("work")) },
      { label: "staff", hint: "zone", run: close(() => navigate("staff")) },
      { label: "system", hint: "zone", run: close(() => navigate("system")) },
      { label: "governance", hint: "staff", run: close(() => navigate("staff/governance")) },
      { label: "events", hint: "system", run: close(() => navigate("system/events")) },
    ];
    for (const a of state?.agents ?? []) {
      base.push({ label: `chat ${a.name}`, hint: a.description.slice(0, 40), run: close(() => onOpenChat(a.name)) });
      base.push({ label: `profile ${a.name}`, hint: "staff", run: close(() => navigate(`staff/agents/${a.name}`)) });
    }
    for (const g of goals) {
      base.push({ label: `goal ${g.title}`, hint: g.status, run: close(() => navigate(`work/goals/${g.slug}`)) });
    }
    return base;
  }, [state, goals, onOpenChat]);

  const filtered = items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())).slice(0, 12);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-void/70 flex items-start justify-center pt-32" onClick={() => setOpen(false)}>
      <div className="hud w-[520px] p-3" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, filtered.length - 1));
            if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
            if (e.key === "Enter") filtered[sel]?.run();
          }}
          placeholder="jump to… (zones, agents, goals)"
          className="w-full bg-void border border-phosphor/40 px-3 py-2 text-[13px] text-bright outline-none focus:border-phosphor"
        />
        <div className="mt-2 flex flex-col">
          {filtered.map((i, idx) => (
            <button key={i.label} onClick={i.run}
              className={`text-left px-3 py-1.5 text-[12px] flex gap-3 ${idx === sel ? "bg-panel-2 text-bright" : "text-fg hover:bg-panel-2"}`}>
              <span>{i.label}</span>
              <span className="text-dim ml-auto text-[10px]">{i.hint}</span>
            </button>
          ))}
          {filtered.length === 0 && <div className="text-dim text-[11px] px-3 py-2">no match</div>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount in App**

In `ui/src/App.tsx`, alongside the ChatDrawer at the root: `<CommandPalette state={state} onOpenChat={openChat} />` + import.

- [ ] **Step 3: Verify + commit**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean.

```bash
git add ui/src
git commit -m "feat(ui): cmd-K palette — jump to zones, agents, goals"
```

---

## Final integration checklist

- [ ] `npx vitest run && npx tsc --noEmit && npm run build && (cd ui && npx tsc --noEmit && npm run build) && git diff origin/main -- package.json package-lock.json ui/package.json ui/package-lock.json`
  Expected: **934 pass + 1 skip**, both tscs clean, both builds green, empty drift output.
- [ ] `grep -rn "window.confirm\|window.alert\|window.prompt\|confirm(\|alert(\|prompt(" ui/src/ | grep -v node_modules` — only hits allowed: none.
- [ ] Whole-branch review, FF-merge, deploy `npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`, READ-ONLY smoke: load `#/inbox`, approve nothing, walk all four zones, deep-link a goal, refresh, open chat drawer, ⌘K to an agent profile.
