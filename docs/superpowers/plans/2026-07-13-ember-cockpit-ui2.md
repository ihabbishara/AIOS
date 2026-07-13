# Ember Cockpit (ui2/) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full parallel rebuild of the web UI in `ui2/` per `docs/superpowers/specs/2026-07-11-mission-control-redesign-design.md` ("Ember Cockpit"): triage-cockpit Home (needs-you queue + context canvas), 5-section nav (Home · Goals · Staff · Mail · System), calm-premium Ember dark theme, responsive queue-first phone layout, chat drawer (⌘J) — plus two additive server changes (`GET /api/attention`, `AIOS_UI_DIST` env switch). Old `ui/` keeps working untouched until cutover.

**Architecture:** `ui2/` is a fresh Vite + React 19 + TS + Tailwind v4 app. The data layer is PORTED, not rewritten: `dto.ts` stays the single wire contract (imported via `../../src/web/dto.js`), `useEvents` (SSE) + `useLiveQuery` (topic-keyed invalidation) + `topics.ts` copied in pattern. Server work is one pure view-builder (`src/web/attention-view.ts`) behind `GET /api/attention` that assembles the unified needs-you queue server-side, plus a one-line `AIOS_UI_DIST` switch in config.ts. Cutover = set `AIOS_UI_DIST=ui2/dist` in `.env`; revert = remove the line.

**Tech Stack:** React 19, Vite 6, TypeScript 5.8, Tailwind v4 (`@theme` tokens), self-hosted fonts via `@fontsource-variable/inter` + `@fontsource/jetbrains-mono`, vitest + jsdom + @testing-library/react (ui2), vitest + node:sqlite `:memory:` (root, for server work).

## Global Constraints

- Server changes ADDITIVE only — no breaking changes to existing endpoints; `ui/` must keep working unchanged until cutover.
- `node:sqlite` only; subscription auth only (never `ANTHROPIC_API_KEY`).
- Amber `--color-accent #e0a458` is used ONLY for needs-you items and primary action buttons. Never decorative.
- No CDN anything: fonts self-hosted (`@fontsource` packages bundled by Vite); no component library (hand-rolled primitives; Radix only if a primitive proves painful — default is no).
- Motion communicates state change or liveness only; `prefers-reduced-motion` honored (one media query kills all animation classes).
- Voice: sentence case; empty states are one calm line ("Nothing needs you."), never illustrations.
- Root suite: `npx vitest run` (baseline 1046 pass + 1 skip; grows with Task 1/2 tests) AND `npx tsc --noEmit` (vitest doesn't typecheck). ui2 suite: `cd ui2 && npx vitest run && npx tsc --noEmit`. Both must be green at the END of every task.
- Commit after every task.
- Worktree: `git worktree add .worktrees/ember-cockpit -b ember-cockpit && ln -s $PWD/node_modules .worktrees/ember-cockpit/node_modules`. `ui2/node_modules` is created by `npm install` inside the worktree (Task 2). Remove the worktree before trusting root-suite counts.
- zsh mangles UUIDs in `$(…)` — wrap sqlite/UUID one-liners in `bash -c '…'`.

## Accepted deltas vs spec (decisions — do not "fix")

1. **`GET /api/health` already exists** (`src/web/server.ts:187`, shipped with ops floor, tested in `test/health-endpoint.test.ts`). Spec §9.2 is a no-op; ui2 just consumes it.
2. **Graduation offers produce no queue items yet** — the shadow-mode graduation surface ships with the verification-hardening spec. `AttentionItem.kind` already covers ambient via `"sense"`; offers join `buildAttentionView` later. The queue UI renders whatever the server sends, so no client change will be needed.
3. **Today strip has no meetings count** — there is no calendar REST surface (calendar sense emits bus events only). Strip shows date · brief link · budget today. Meetings count added when a calendar store surface exists.
4. **Provenance chip needs a new additive DTO field** — `GoalView.originChannel` (mapped from `goals.origin_channel`). Chip mapping: `mail` → "mail", `speculate`/`dream` → "speculate", everything else → "chat".
5. **Sense degradation has no bus topic** — `/api/attention` includes degraded senses, but nothing invalidates that slice specifically; it refreshes whenever any attention topic fires or on reload. Acceptable for a single user.
6. **`TwoStepButton`** = Ember-styled port of `ui/src/components/ConfirmButton.tsx` (same 4s auto-disarm arm/confirm), renamed per spec.
7. **Root `vitest.config.ts` is new** — root has none today; without one, root `npx vitest run` default globs would collect `ui2/test/**` and fail (no jsdom at root). The new config pins include to `test/**/*.test.ts`, which is exactly today's collected set (baseline unchanged).

## File structure

**Server (root):**
- `src/web/dto.ts` — add `AttentionItem`, `HealthInfo`; add `originChannel` to `GoalView`.
- `src/web/attention-view.ts` — NEW pure builder `buildAttentionView(store, senses?, now?)`.
- `src/web/server.ts` — one new route `GET /api/attention`.
- `src/web/goals-view.ts` — map `originChannel` in `goalView()`.
- `src/config.ts` — `AIOS_UI_DIST` switch for `uiDist`.
- `vitest.config.ts` — NEW, pins root test glob.
- `test/attention-view.test.ts`, `test/config-ui-dist.test.ts` — NEW.

**ui2/ (all new):**
```
ui2/package.json  vite.config.ts  tsconfig.json  index.html
ui2/src/main.tsx  App.tsx  index.css  tokens.css
ui2/src/api.ts  hooks.ts                     # ported (api.ts + 2 methods)
ui2/src/lib/{topics,router,format,queue,preview,goal-buckets}.ts
ui2/src/components/{ui.tsx,TwoStepButton.tsx,Sheet.tsx,TokenGate.tsx,TopBar.tsx,BottomTabs.tsx,CommandPalette.tsx,ChatDrawer.tsx,Chat.tsx}
ui2/src/views/{Home.tsx,TodayStrip.tsx,Queue.tsx,MiniDag.tsx,dag-layout.ts,Goals.tsx,Staff.tsx,Mail.tsx,System.tsx}
ui2/src/views/canvas/{index.tsx,Approval.tsx,Ask.tsx,Goal.tsx,MailThread.tsx,OrgPulse.tsx}
ui2/test/{stubs.ts,router.test.ts,topics.test.ts,dag-layout.test.ts,queue.test.ts,preview.test.ts,goal-buckets.test.ts,shell.test.tsx,queue-render.test.tsx}
```

---

### Task 1: Server — `AttentionItem` DTO, `buildAttentionView`, `GET /api/attention`, `GoalView.originChannel`

**Files:**
- Modify: `src/web/dto.ts`
- Create: `src/web/attention-view.ts`
- Modify: `src/web/server.ts` (one route after `/api/health`, ~line 197)
- Modify: `src/web/goals-view.ts:21-28` (`goalView()`)
- Test: `test/attention-view.test.ts` (create)

**Interfaces:**
- Consumes: `Store.listActions(status?, limit)` (db.ts:1109), `Store.pendingUserAsks()` (db.ts:898), `Store.goalsUpdatedSince(sinceIso)` (db.ts:590), `Store.pausedBudgetGoals()` (db.ts:601), `Store.listGoals(limit)` (db.ts:583), `Store.userThreads(limit)` (db.ts:861), `WebDeps.senses?: () => Array<{name, ok, reason?}>` (server.ts:80).
- Produces (later tasks depend on these exact names):
  - dto.ts: `interface AttentionItem { kind: "approval"|"ask"|"goal"|"mail"|"sense"; id: string; title: string; meta: string; severity: 1|2|3|4|5; ts: string; actions: string[]; ref: Record<string, string> }`, `interface HealthInfo { uptimeMs: number; voice: boolean; senses: Array<{name: string; ok: boolean; reason?: string}>; sseClients: number; dbBytes: number }`, `GoalView.originChannel: string`.
  - attention-view.ts: `buildAttentionView(store: Store, senses?: SensesFn, now?: () => Date): AttentionItem[]`, `type SensesFn`.
  - HTTP: `GET /api/attention` → `AttentionItem[]`, severity-sorted (1 first), ts-desc within severity.

- [ ] **Step 1: Write the failing test**

```ts
// test/attention-view.test.ts
import { describe, it, expect } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Store, type GoalRow } from "../src/store/db.js";
import type { ActionRow } from "../src/kernel/actions.js";
import { buildAttentionView } from "../src/web/attention-view.js";
import { buildGoalsView } from "../src/web/goals-view.js";
import { startWebServer, type WebDeps } from "../src/web/server.js";

const NOW = () => new Date("2026-07-13T10:00:00.000Z");

function action(id: string, over: Partial<ActionRow> = {}): ActionRow {
  return {
    id, type: "test.echo", payload: "{}", preview: `preview ${id}`,
    status: "proposed", origin_channel: "cli", origin_chat_id: "local",
    trust_state: "supervised", verdict_by: null, reject_reason: null, result: null,
    created_at: "2026-07-13T09:00:00.000Z", resolved_at: null,
    expires_at: "2026-07-14T09:00:00.000Z", ...over,
  };
}

function goal(id: string, over: Partial<GoalRow> = {}): Omit<GoalRow, "created_at" | "updated_at" | "spawned_by_mail"> {
  return {
    id, slug: id, title: `goal ${id}`, request: "r", department: "research", lead: "iris",
    origin_channel: "web", origin_chat_id: "ui", status: "running",
    project_dir: null, goal_dir: null, plan_summary: "", replans_used: 0,
    chain_depth: 0, error: null, ...over,
  };
}

function ask(store: Store, id: string, from: string, body: string, goalId: string | null = null) {
  store.insertMail({
    id, from_agent: from, to_agent: "user", kind: "request", body,
    goal_id: goalId, origin_channel: "engine", origin_chat_id: "x",
    chain_depth: 0, status: "awaiting-human", error: null,
  });
}

describe("buildAttentionView", () => {
  it("ranks approvals > asks > goals > mail > senses, ts-desc within a rank", () => {
    const store = new Store(":memory:");
    store.insertAction(action("a1"));
    ask(store, "m1", "iris", "Which account?", "g-ask");
    store.insertGoal(goal("g1"));
    store.updateGoalStatus("g1", "failed", "boom");
    store.insertMail({
      id: "n1", from_agent: "hermes", to_agent: "user", kind: "note", body: "FYI note",
      goal_id: null, origin_channel: "engine", origin_chat_id: "x",
      chain_depth: 0, status: "unread", error: null,
    });
    const senses = () => [{ name: "google:personal", ok: false, reason: "invalid_grant" }];
    const items = buildAttentionView(store, senses, NOW);
    expect(items.map((i) => i.kind)).toEqual(["approval", "ask", "goal", "mail", "sense"]);
    expect(items.map((i) => i.severity)).toEqual([1, 2, 3, 4, 5]);
    expect(items[0].actions).toEqual(["approve", "reject", "open"]);
    expect(items[1].actions).toEqual(["answer", "open"]);
    expect(items[1].ref.goalId).toBe("g-ask");
    expect(items[2].actions).toContain("abandon");
    expect(items[4].meta).toBe("invalid_grant");
  });

  it("excludes expired approvals, answered asks, old failures, read mail, healthy senses", () => {
    const store = new Store(":memory:");
    store.insertAction(action("dead", { expires_at: "2026-07-13T09:59:00.000Z" }));
    ask(store, "m2", "iris", "answered ask");
    store.insertMail({
      id: "r2", from_agent: "user", to_agent: "iris", kind: "report", body: "answer",
      goal_id: null, origin_channel: "web", origin_chat_id: "ui",
      chain_depth: 0, status: "read", error: null, in_reply_to: "m2",
    });
    store.insertGoal(goal("gOld"));
    store.updateGoalStatus("gOld", "failed", "old");
    const future = () => new Date(Date.now() + 72 * 3_600_000); // 48h window has passed
    const senses = () => [{ name: "gmail", ok: true }];
    expect(buildAttentionView(store, senses, future)).toEqual([]);
  });

  it("surfaces paused-budget and paused-user goals regardless of age", () => {
    const store = new Store(":memory:");
    store.insertGoal(goal("gb"));
    store.updateGoalStatus("gb", "paused-budget");
    store.insertGoal(goal("gu"));
    store.updateGoalStatus("gu", "paused-user");
    const future = () => new Date(Date.now() + 72 * 3_600_000);
    const items = buildAttentionView(store, undefined, future);
    expect(items.map((i) => i.ref.status).sort()).toEqual(["paused-budget", "paused-user"]);
    expect(items.every((i) => i.actions.includes("resume"))).toBe(true);
  });

  it("skips legacy goals and threads whose only flag is a pending ask (ranked higher already)", () => {
    const store = new Store(":memory:");
    store.insertGoal(goal("gl"));
    store.updateGoalStatus("gl", "failed", "x");
    store.freezeLegacyGoals();
    ask(store, "m3", "iris", "only an ask in this thread");
    const items = buildAttentionView(store, undefined, NOW);
    expect(items.filter((i) => i.kind === "goal")).toEqual([]);
    expect(items.filter((i) => i.kind === "mail")).toEqual([]); // ask thread not double-listed
    expect(items.filter((i) => i.kind === "ask")).toHaveLength(1);
  });
});

describe("GoalView.originChannel", () => {
  it("maps goals.origin_channel", () => {
    const store = new Store(":memory:");
    store.insertGoal(goal("g2", { origin_channel: "mail" }));
    expect(buildGoalsView(store)[0].originChannel).toBe("mail");
  });
});

describe("GET /api/attention", () => {
  it("serves the queue, token-gated", async () => {
    const prev = process.env.AIOS_UI_TOKEN;
    process.env.AIOS_UI_TOKEN = "att-token";
    const store = new Store(":memory:");
    store.insertAction(action("a9"));
    const deps = {
      store, goals: {}, vault: {}, registry: { agents: new Map(), departments: new Map(), agentOf: new Map() },
      reloadPacks: () => {}, envPath: "", uiDist: "", log: () => {},
      bus: {}, config: { dbPath: ":memory:" }, router: {}, gate: {},
      voice: { available: () => false }, mailbox: {},
    } as unknown as WebDeps;
    const server = startWebServer(deps, 0);
    if (!server.listening) await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      expect((await fetch(`http://127.0.0.1:${port}/api/attention`)).status).toBe(401);
      const res = await fetch(`http://127.0.0.1:${port}/api/attention`, {
        headers: { Authorization: "Bearer att-token" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ kind: string; id: string }>;
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ kind: "approval", id: "a9", severity: 1 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      if (prev === undefined) delete process.env.AIOS_UI_TOKEN; else process.env.AIOS_UI_TOKEN = prev;
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/attention-view.test.ts`
Expected: FAIL — `Cannot find module '../src/web/attention-view.js'`

- [ ] **Step 3: Add the DTO types**

In `src/web/dto.ts`, add `originChannel` to `GoalView` (after `lead`):

```ts
export interface GoalView {
  id: string; slug: string; title: string; department: string; lead: string;
  originChannel: string;
  status: string; planSummary: string; replansUsed: number; error: string | null;
  createdAt: string; updatedAt: string; projectDir: string | null; goalDir: string | null;
  nodes: GoalNodeView[];
}
```

Append at the end of the file:

```ts
/** One row of the unified needs-you queue (Ember Cockpit spec §5, §9.1). */
export interface AttentionItem {
  kind: "approval" | "ask" | "goal" | "mail" | "sense";
  id: string;
  title: string;
  meta: string;
  /** 1 approvals · 2 asks · 3 failed/paused goals · 4 unread mail · 5 ambient. */
  severity: 1 | 2 | 3 | 4 | 5;
  ts: string;
  /** Inline verbs the row offers: approve, reject, answer, open, read, resume, abandon. */
  actions: string[];
  /** Kind-specific pointers the canvas needs (actionId, mailId, threadId, goalId, slug, status, sense). */
  ref: Record<string, string>;
}

/** GET /api/health (already served; typed here so ui2 can consume it). */
export interface HealthInfo {
  uptimeMs: number;
  voice: boolean;
  senses: Array<{ name: string; ok: boolean; reason?: string }>;
  sseClients: number;
  dbBytes: number;
}
```

- [ ] **Step 4: Map originChannel in goals-view**

In `src/web/goals-view.ts` `goalView()` (line 21), add after `lead`:

```ts
    originChannel: g.origin_channel,
```

- [ ] **Step 5: Write the builder**

```ts
// src/web/attention-view.ts — pure builder behind /api/attention (Ember Cockpit spec §5, §9.1).
// Assembles the unified needs-you queue server-side: proposed actions + user asks +
// failed/paused goals + unread user mail + degraded senses. Graduation offers join
// here when the verification-hardening spec ships.
import type { Store } from "../store/db.js";
import type { AttentionItem } from "./dto.js";

export type { AttentionItem } from "./dto.js";
export type SensesFn = () => Array<{ name: string; ok: boolean; reason?: string }>;

const FAILED_WINDOW_MS = 48 * 3_600_000;

function firstLine(s: string, max = 140): string {
  const l = s.split("\n")[0].trim();
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}

export function buildAttentionView(
  store: Store,
  senses?: SensesFn,
  now: () => Date = () => new Date(),
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const nowIso = now().toISOString();

  // 1 — approvals (proposed, not yet expired; the sweep is lazy so filter here too)
  for (const a of store.listActions("proposed", 100)) {
    if (a.expires_at <= nowIso) continue;
    items.push({
      kind: "approval", id: a.id, title: firstLine(a.preview),
      meta: `${a.type} · expires ${a.expires_at.slice(5, 16).replace("T", " ")}`,
      severity: 1, ts: a.created_at, actions: ["approve", "reject", "open"],
      ref: { actionId: a.id },
    });
  }

  // 2 — agent asks blocking parked goals
  for (const m of store.pendingUserAsks()) {
    items.push({
      kind: "ask", id: m.id, title: firstLine(m.body),
      meta: `${m.from_agent} is blocked on your answer`,
      severity: 2, ts: m.created_at, actions: ["answer", "open"],
      ref: { mailId: m.id, threadId: m.thread_id ?? m.id, ...(m.goal_id ? { goalId: m.goal_id } : {}) },
    });
  }

  // 3 — failed (48h window on updated_at) + paused goals (any age)
  const cutoff = new Date(now().getTime() - FAILED_WINDOW_MS).toISOString();
  const failed = store.goalsUpdatedSince(cutoff).filter((g) => g.status === "failed" && g.legacy !== 1);
  const pausedUser = store.listGoals(200).filter((g) => g.status === "paused-user" && g.legacy !== 1);
  for (const g of [...failed, ...store.pausedBudgetGoals(), ...pausedUser]) {
    items.push({
      kind: "goal", id: g.id, title: g.title,
      meta: `${g.department} · ${g.status === "failed" ? firstLine(g.error ?? "failed", 80) : g.status}`,
      severity: 3, ts: g.updated_at,
      actions: g.status === "failed" ? ["open", "abandon"] : ["open", "resume", "abandon"],
      ref: { goalId: g.id, slug: g.slug, status: g.status },
    });
  }

  // 4 — unread user mail (a thread whose only flag is a pending ask is already ranked 2)
  for (const t of store.userThreads()) {
    if (t.unread === 0 || t.pending_ask > 0) continue;
    items.push({
      kind: "mail", id: t.thread_id, title: firstLine(t.last_body), meta: `from ${t.last_from}`,
      severity: 4, ts: t.last_ts, actions: ["open", "read"], ref: { threadId: t.thread_id },
    });
  }

  // 5 — ambient: degraded senses
  for (const s of senses?.() ?? []) {
    if (s.ok) continue;
    items.push({
      kind: "sense", id: s.name, title: `${s.name} needs attention`, meta: s.reason ?? "degraded",
      severity: 5, ts: nowIso, actions: ["open"], ref: { sense: s.name },
    });
  }

  return items.sort((a, b) => a.severity - b.severity || (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}
```

- [ ] **Step 6: Wire the route**

In `src/web/server.ts`, import at top (beside the other view imports):

```ts
import { buildAttentionView } from "./attention-view.js";
```

After the `/api/health` block (line ~197), add:

```ts
        if (path === "/api/attention" && req.method === "GET") {
          return json(res, 200, buildAttentionView(store, deps.senses));
        }
```

- [ ] **Step 7: Run tests, fix any exact-shape assertions**

Run: `npx vitest run test/attention-view.test.ts` → expect PASS.
Run: `npx vitest run && npx tsc --noEmit` → the new `GoalView.originChannel` field is additive, but if any existing goal-view test asserts an exact object (`toEqual` on a full GoalView), add `originChannel` to its expected object.
Expected: full suite green (1046+ pass, 1 skip).

- [ ] **Step 8: Commit**

```bash
git add src/web/dto.ts src/web/attention-view.ts src/web/server.ts src/web/goals-view.ts test/attention-view.test.ts
git commit -m "feat(web): GET /api/attention — unified needs-you queue + GoalView.originChannel"
```

---

### Task 2: ui2 scaffold — Vite + Ember tokens + self-hosted fonts + vitest; `AIOS_UI_DIST` switch

**Files:**
- Create: `ui2/package.json`, `ui2/vite.config.ts`, `ui2/tsconfig.json`, `ui2/index.html`, `ui2/src/main.tsx`, `ui2/src/App.tsx`, `ui2/src/index.css`, `ui2/src/tokens.css`
- Create: `vitest.config.ts` (root — pins glob, see delta 7)
- Modify: `src/config.ts:213` (`uiDist`)
- Test: `test/config-ui-dist.test.ts` (create), `ui2/test/smoke.test.tsx` (create)

**Interfaces:**
- Consumes: `loadConfig(root = process.cwd()): Config` (src/config.ts:273).
- Produces: `ui2/` builds to `ui2/dist/` via `cd ui2 && npm run build`; `AIOS_UI_DIST` env (relative to repo root, or absolute) overrides `config.uiDist`; Ember token names every later task styles with: colors `bg surface raised line dim fg strong accent ok err agent`, fonts `font-sans font-mono`, classes `.label .breathe .arrive .shimmer .tick`.

- [ ] **Step 1: Root vitest config + failing config test**

```ts
// vitest.config.ts — pin the root suite to test/ so ui2's jsdom tests stay in ui2's own runner.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

```ts
// test/config-ui-dist.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

const prev = process.env.AIOS_UI_DIST;
afterEach(() => {
  if (prev === undefined) delete process.env.AIOS_UI_DIST;
  else process.env.AIOS_UI_DIST = prev;
});

describe("AIOS_UI_DIST", () => {
  it("defaults to <root>/ui/dist", () => {
    delete process.env.AIOS_UI_DIST;
    expect(loadConfig("/tmp/x").uiDist).toBe("/tmp/x/ui/dist");
  });
  it("resolves a relative override against root", () => {
    process.env.AIOS_UI_DIST = "ui2/dist";
    expect(loadConfig("/tmp/x").uiDist).toBe("/tmp/x/ui2/dist");
  });
  it("keeps an absolute override as-is", () => {
    process.env.AIOS_UI_DIST = "/opt/dist";
    expect(loadConfig("/tmp/x").uiDist).toBe("/opt/dist");
  });
});
```

Run: `npx vitest run test/config-ui-dist.test.ts` → FAIL (override ignored).
Also verify the pin did not change collection: `npx vitest run` still collects only `test/**` files.

- [ ] **Step 2: Implement the switch**

In `src/config.ts` line 213, replace `uiDist: join(root, "ui", "dist"),` with:

```ts
    uiDist: process.env.AIOS_UI_DIST ? resolve(root, process.env.AIOS_UI_DIST) : join(root, "ui", "dist"),
```

Add `resolve` to the existing `node:path` import. Run the test → PASS. Run `npx tsc --noEmit`.

- [ ] **Step 3: Scaffold ui2 package**

```json
// ui2/package.json
{
  "name": "aios-ui2",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fontsource-variable/inter": "^5.2.0",
    "@fontsource/jetbrains-mono": "^5.2.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.0",
    "@testing-library/react": "^16.3.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.5.0",
    "jsdom": "^26.0.0",
    "tailwindcss": "^4.1.0",
    "typescript": "^5.8.0",
    "vite": "^6.3.0",
    "vitest": "^3.1.0"
  }
}
```

```ts
// ui2/vite.config.ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": "http://localhost:4280" } },
  test: { environment: "jsdom" },
});
```

```json
// ui2/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

```html
<!-- ui2/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>AIOS</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Ember tokens + base css**

```css
/* ui2/src/tokens.css — Ember design tokens (spec §3). Single dark theme; swappable by construction. */
@theme {
  --color-*: initial;
  --color-black: #000;
  --color-bg: #0f0e0c;
  --color-surface: #141210;
  --color-raised: #181510;
  --color-line: #24211c;
  --color-dim: #847e72;
  --color-fg: #cfccc4;
  --color-strong: #efe9dc;
  /* Amber — ONLY needs-you items and primary actions. Never decorative. */
  --color-accent: #e0a458;
  --color-ok: #7da87b;    /* desaturated green — running/ok */
  --color-err: #c96f5f;   /* desaturated red — failed */
  --color-agent: #9c8cc9; /* violet — agent activity */
  --font-sans: "Inter Variable", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}
```

```css
/* ui2/src/index.css */
@import "tailwindcss";
@import "./tokens.css";

html, body, #root { height: 100%; }
body {
  @apply bg-bg text-fg font-sans text-[13px] antialiased;
  font-variant-numeric: tabular-nums;
}
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--color-line); border-radius: 4px; }

/* 10px uppercase section labels (spec §3 typography ramp). */
.label { @apply text-[10px] uppercase tracking-[0.14em] text-dim; }

/* Motion (spec §3) — state change / liveness only. */
@keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.breathe { animation: breathe 2s ease-in-out infinite; }

@keyframes arrive { from { transform: translateY(-4px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes edge-flash { from { box-shadow: inset 2px 0 0 var(--color-accent); } to { box-shadow: inset 2px 0 0 transparent; } }
.arrive { animation: arrive 200ms ease-out, edge-flash 1.2s ease-out; }

@keyframes shimmer { from { background-position: -200px 0; } to { background-position: 200px 0; } }
.shimmer {
  height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--color-ok) 45%, transparent), transparent);
  background-size: 200px 100%;
  background-repeat: no-repeat;
  animation: shimmer 1.6s linear infinite;
}

@keyframes tick { 50% { transform: scale(1.25); } }
.tick { animation: tick 150ms ease-out; }

@media (prefers-reduced-motion: reduce) {
  .breathe, .arrive, .shimmer, .tick { animation: none !important; }
  * { transition-duration: 0s !important; }
}
```

- [ ] **Step 5: Entry + placeholder App + smoke test**

```tsx
// ui2/src/main.tsx
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

```tsx
// ui2/src/App.tsx — placeholder; the real shell lands in Task 4.
export function App() {
  return <div className="p-6 text-dim">Nothing needs you.</div>;
}
```

```tsx
// ui2/test/smoke.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { App } from "../src/App.js";

describe("scaffold", () => {
  it("renders the calm empty line", () => {
    const { getByText } = render(<App />);
    expect(getByText("Nothing needs you.")).toBeTruthy();
  });
});
```

- [ ] **Step 6: Install, test, build**

Run: `cd ui2 && npm install && npx vitest run && npx tsc --noEmit && npm run build`
Expected: 1 test passes; `ui2/dist/index.html` exists; woff2 files in `ui2/dist/assets/` (self-hosted fonts bundled).
Run root: `npx vitest run && npx tsc --noEmit` — green, `ui2/` not collected.

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts src/config.ts test/config-ui-dist.test.ts ui2/package.json ui2/package-lock.json ui2/vite.config.ts ui2/tsconfig.json ui2/index.html ui2/src ui2/test
git commit -m "feat(ui2): Ember scaffold — Vite+Tailwind v4 tokens, self-hosted fonts, vitest; AIOS_UI_DIST switch"
```

(Confirm `.gitignore` already covers `ui2/dist` and `ui2/node_modules` — it ignores `ui/dist` and `node_modules/` patterns; add `ui2/dist` if the existing entry is path-specific.)

---

### Task 3: Data layer port — api, hooks, topics, router, format, dag-layout

**Files:**
- Create: `ui2/src/api.ts`, `ui2/src/hooks.ts`, `ui2/src/lib/topics.ts`, `ui2/src/lib/router.ts`, `ui2/src/lib/format.ts`, `ui2/src/views/dag-layout.ts`
- Test: `ui2/test/router.test.ts`, `ui2/test/topics.test.ts`, `ui2/test/dag-layout.test.ts` (create)

**Interfaces:**
- Consumes: `src/web/dto.ts` types (Task 1), `/api/attention` + `/api/health` (Task 1).
- Produces (every later ui2 task imports these):
  - api.ts: everything `ui/src/api.ts` exports today PLUS `api.attention(): Promise<AttentionItem[]>`, `api.health(): Promise<HealthInfo>`, and re-exported types `AttentionItem`, `HealthInfo`.
  - hooks.ts: `useEvents(cap?)`, `useFetch<T>(fn, deps?)`, `useLiveQuery<T>(fn, events, topics, extraDeps?)` — identical to ui/.
  - topics.ts: `T` gains `attention: ["action.", "mail.sent", "mail.read", "goal.status", "trust.changed"]`; `matches`, `lastMatching` unchanged.
  - router.ts: `SECTIONS = ["home","goals","staff","mail","system"]`, `interface Route { section: string; parts: string[]; query: URLSearchParams }`, `parseHash`, `href`, `navigate`, `useRoute` — default section `"home"`.
  - format.ts: `ts`, `tsTime`, `usd`, `usdFloat` (verbatim port).
  - dag-layout.ts: verbatim port of `ui/src/views/dag-layout.ts` (same exports: `layoutDag`, `BOX_W/BOX_H/GAP_X/GAP_Y/PAD`, `DagNodeIn/DagBox/DagEdge/DagLayout`).

- [ ] **Step 1: Verbatim copies**

```bash
cp ui/src/hooks.ts ui2/src/hooks.ts
cp ui/src/lib/format.ts ui2/src/lib/format.ts
cp ui/src/views/dag-layout.ts ui2/src/views/dag-layout.ts
cp test/dag-layout.test.ts ui2/test/dag-layout.test.ts
```

In `ui2/test/dag-layout.test.ts`, repoint the import to `../src/views/dag-layout.js` (the root test imports `../ui/src/views/dag-layout.js`). Everything else stays byte-identical.

- [ ] **Step 2: api.ts — port + two additions**

`cp ui/src/api.ts ui2/src/api.ts`, then:
1. Add `AttentionItem, HealthInfo` to BOTH the `export type { ... }` list and the `import type { ... }` list at the top (still from `"../../src/web/dto.js"` — ui2 sits at the same depth as ui).
2. Inside the `api` object, after `state:`, add:

```ts
  attention: () => request<AttentionItem[]>("/api/attention"),
  health: () => request<HealthInfo>("/api/health"),
```

- [ ] **Step 3: topics.ts — port + attention topic**

`cp ui/src/lib/topics.ts ui2/src/lib/topics.ts`, then add to `T` (after `agentMail`):

```ts
  /** Everything that can add/remove a needs-you row: actions, user mail, goal transitions, trust. */
  attention: ["action.", "mail.sent", "mail.read", "goal.status", "trust.changed"],
```

- [ ] **Step 4: router.ts — rebuilt for the 5-section map**

```ts
// ui2/src/lib/router.ts — minimal hash router. #/section/seg1/seg2?query — no dependency.
import { useMemo, useSyncExternalStore } from "react";

export interface Route { section: string; parts: string[]; query: URLSearchParams }

export const SECTIONS = ["home", "goals", "staff", "mail", "system"] as const;

export function parseHash(hash: string): Route {
  const [path, q] = hash.replace(/^#\/?/, "").split("?");
  const segs = path.split("/").filter(Boolean).map(decodeURIComponent);
  const section = (SECTIONS as readonly string[]).includes(segs[0]) ? segs[0] : "home";
  return { section, parts: segs.slice(1), query: new URLSearchParams(q ?? "") };
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

- [ ] **Step 5: Tests**

```ts
// ui2/test/router.test.ts
import { describe, it, expect } from "vitest";
import { parseHash, href } from "../src/lib/router.js";

describe("router", () => {
  it("defaults to home", () => {
    expect(parseHash("").section).toBe("home");
    expect(parseHash("#/inbox").section).toBe("home"); // old-UI paths fall back calmly
  });
  it("parses section, parts, query", () => {
    const r = parseHash("#/goals/my-slug?tab=nodes");
    expect(r.section).toBe("goals");
    expect(r.parts).toEqual(["my-slug"]);
    expect(r.query.get("tab")).toBe("nodes");
  });
  it("decodes segments and builds hrefs", () => {
    expect(parseHash("#/staff/agents/a%20b").parts).toEqual(["agents", "a b"]);
    expect(href("goals/x")).toBe("#/goals/x");
    expect(href("#/goals/x")).toBe("#/goals/x");
  });
});
```

```ts
// ui2/test/topics.test.ts
import { describe, it, expect } from "vitest";
import { T, matches, lastMatching } from "../src/lib/topics.js";
import type { StoredEvent } from "../src/api.js";

const ev = (id: number, type: string): StoredEvent => ({ id, ts: "t", event: { type } });

describe("topics", () => {
  it("prefix vs exact matching", () => {
    expect(matches("action.proposed", T.attention)).toBe(true);
    expect(matches("goal.status", T.attention)).toBe(true);
    expect(matches("goal.created", T.attention)).toBe(false); // exact, not prefix
    expect(matches("mail.received", T.attention)).toBe(false); // Gmail sense stays out
  });
  it("lastMatching returns newest matching id", () => {
    const events = [ev(1, "action.proposed"), ev(2, "chat.out"), ev(3, "mail.read")];
    expect(lastMatching(events, T.attention)).toBe(3);
    expect(lastMatching(events, ["chat."])).toBe(2);
    expect(lastMatching(events, ["nope"])).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run + commit**

Run: `cd ui2 && npx vitest run && npx tsc --noEmit`
Expected: router (3) + topics (2) + dag-layout (ported count) + smoke pass.

```bash
git add ui2/src ui2/test
git commit -m "feat(ui2): data layer port — api/hooks/topics/format/dag-layout + 5-section router"
```

---

### Task 4: Primitives + app shell — top bar, keyboard, token gate, chat drawer (⌘J), palette (⌘K)

**Files:**
- Create: `ui2/src/components/ui.tsx`, `ui2/src/components/TwoStepButton.tsx`, `ui2/src/components/Sheet.tsx`, `ui2/src/components/TokenGate.tsx`, `ui2/src/components/TopBar.tsx`, `ui2/src/components/Chat.tsx`, `ui2/src/components/ChatDrawer.tsx`, `ui2/src/components/CommandPalette.tsx`
- Create: `ui2/test/stubs.ts`, `ui2/test/shell.test.tsx`
- Modify: `ui2/src/App.tsx` (replace placeholder with the real shell)

**Interfaces:**
- Consumes: Task 3 data layer (`api`, `useEvents`, `useFetch`, `useLiveQuery`, `T`, `useRoute`, `navigate`, `SECTIONS`, `usd`).
- Produces (later tasks import these exact names):
  - ui.tsx: `Button({variant?: "primary"|"ghost"|"danger", ...buttonProps})`, `Tag({children, tone?: "dim"|"ok"|"err"|"accent"|"agent"})`, `Dot({tone: "ok"|"err"|"accent"|"agent"|"dim", breathing?})`, `SectionLabel({children})`, `Empty({children})`.
  - TwoStepButton.tsx: `TwoStepButton({label, confirmLabel?, disabled?, onConfirm, className?})`.
  - Sheet.tsx: `Sheet({open, onClose, children, tall?})`.
  - App.tsx: `openChat(target: string, seed?: string)` passed down as prop `onOpenChat` wherever a view needs pre-targeted chat (Home canvas "Discuss", Staff profile, Goals node inspector).
  - Section components receive `{ events, route, onOpenChat }` (each later task states its exact props).
  - Status→tone mapping helper in ui.tsx: `toneOfStatus(status: string): "ok"|"err"|"accent"|"agent"|"dim"` — `running/done/ok → ok`, `failed/error → err`, `awaiting-human/paused-user/paused-budget/awaiting-mail/proposed → accent`, `planning/replanning/working → agent`, else `dim`.

- [ ] **Step 1: Test stubs (SSE + fetch fakes every component test reuses)**

```ts
// ui2/test/stubs.ts — FakeEventSource + fetch stub for jsdom component tests.
import { vi } from "vitest";

let nextId = 1;

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {}
  emit(event: Record<string, unknown> & { type: string }): void {
    this.onmessage?.({ data: JSON.stringify({ id: nextId++, ts: new Date().toISOString(), event }) });
  }
}

/** Stub fetch with a path→body map (query strings stripped; first match wins). */
export function stubApi(routes: Record<string, unknown>): void {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0];
    if (path in routes) return new Response(JSON.stringify(routes[path]), { status: 200 });
    return new Response(JSON.stringify({ error: `no stub for ${path}` }), { status: 404 });
  }));
}

export const STATE_STUB = {
  uptimeMs: 1000, voice: false,
  agents: [
    { name: "hermes", kind: "moderator", description: "Chief of Staff", tools: [], guarded: false },
    { name: "iris", kind: "specialist", description: "researcher", tools: [], guarded: false },
  ],
  playbooks: [], bindings: [],
};
```

- [ ] **Step 2: Primitives**

```tsx
// ui2/src/components/ui.tsx — Ember primitives (spec §3). Borders over shadows; amber = needs-you only.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({ variant = "ghost", className = "", ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-accent text-bg border-accent hover:opacity-90 font-medium",
    ghost: "border-line text-fg hover:border-dim hover:text-strong",
    danger: "border-line text-err hover:border-err",
  }[variant];
  return (
    <button
      className={`border rounded-md px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40 ${styles} ${className}`}
      {...rest}
    />
  );
}

export function Tag({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "ok" | "err" | "accent" | "agent" }) {
  const color = {
    dim: "text-dim border-line", ok: "text-ok border-ok/40", err: "text-err border-err/40",
    accent: "text-accent border-accent/40", agent: "text-agent border-agent/40",
  }[tone];
  return <span className={`inline-block border rounded px-1.5 py-px text-[10px] leading-4 whitespace-nowrap ${color}`}>{children}</span>;
}

export function Dot({ tone, breathing }: { tone: "ok" | "err" | "accent" | "agent" | "dim"; breathing?: boolean }) {
  const bg = { ok: "bg-ok", err: "bg-err", accent: "bg-accent", agent: "bg-agent", dim: "bg-dim" }[tone];
  return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${bg} ${breathing ? "breathe" : ""}`} />;
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

```tsx
// ui2/src/components/TwoStepButton.tsx — two-step arm/confirm (successor of ui/ ConfirmButton); disarms after 4s.
import { useEffect, useState } from "react";

export function TwoStepButton({ label, confirmLabel, disabled, onConfirm, className = "" }: {
  label: string; confirmLabel?: string; disabled?: boolean; onConfirm: () => void; className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      disabled={disabled}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}
      className={`border rounded-md px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40 ${
        armed ? "border-err text-err" : "border-line text-dim hover:text-err hover:border-err"
      } ${className}`}
    >
      {armed ? (confirmLabel ?? `confirm ${label}?`) : label}
    </button>
  );
}
```

```tsx
// ui2/src/components/Sheet.tsx — bottom sheet: chat drawer + mobile inspectors. Stays mounted (content survives).
import type { ReactNode } from "react";

export function Sheet({ open, onClose, children, tall }: {
  open: boolean; onClose: () => void; children: ReactNode; tall?: boolean;
}) {
  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />}
      <div
        className={`fixed left-0 right-0 bottom-0 z-50 bg-surface border-t border-line rounded-t-lg
          transition-transform duration-200 flex flex-col ${tall ? "h-[85vh]" : "h-[min(480px,70vh)]"}
          ${open ? "translate-y-0" : "translate-y-full pointer-events-none"}`}
      >
        {children}
      </div>
    </>
  );
}
```

```tsx
// ui2/src/components/TokenGate.tsx — 401 gate (existing behavior kept; Ember styling).
import { useState } from "react";
import { getToken, setToken } from "../api.js";
import { Button } from "./ui.js";

export function TokenGate({ onSet }: { onSet: () => void }) {
  const [value, setValue] = useState(getToken());
  const submit = () => { setToken(value); onSet(); };
  return (
    <div className="h-full flex items-center justify-center">
      <div className="w-80 border border-line rounded-lg bg-surface p-6">
        <div className="text-strong text-[15px] mb-1">AIOS</div>
        <div className="label mb-5">Access token required</div>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="AIOS_UI_TOKEN"
          className="w-full bg-bg border border-line rounded-md px-3 py-2 text-fg outline-none focus:border-dim"
        />
        <Button variant="primary" className="mt-4 w-full" onClick={submit}>Unlock</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Chat + drawer (port of `ui/src/views/Chat.tsx` + `ui/src/components/ChatDrawer.tsx`)**

`ui2/src/components/Chat.tsx` — copy `ui/src/views/Chat.tsx` and apply exactly these changes (logic, voice recording, localStorage persistence, pending-placeholder resolution, routing trail all stay identical):
1. Import path fix: `from "../api.js"` stays correct (file moved to components/, api is one level up in both).
2. Props gain `seed?: string`: `export function Chat({ state, events, target, setTarget, seed }: { ...; seed?: string })`, and below the existing `useState` lines add:

```tsx
  // Context-aware pre-targeting: an opener can seed the draft ("About approval a1: …").
  useEffect(() => { if (seed) setInput(seed); }, [seed]);
```

3. Restyle map (mechanical class swaps — no structural change):
   - `hud` → `border border-line rounded-lg bg-surface`
   - `border-phosphor text-phosphor glow-green` (active target chip) → `border-accent text-accent`  *(chat send is a primary action — amber is allowed here)*
   - `text-phosphor` → `text-ok`; `text-cyan` / `border-cyan/40` → `text-agent` / `border-agent/40`
   - `border-alert text-alert` (rec button) → `border-err text-err`; `bg-panel-2` → `bg-raised`; `bg-panel` → `bg-surface`; `border-line` stays
   - `font-display uppercase tracking-[0.2em] text-[11px]` (send button) → drop; use `<Button variant="primary">` for Send and `<Button>` for mic/targets
   - `cursor-blink` → drop (decorative); `live-dot` on pending bubble → `breathe`

```tsx
// ui2/src/components/ChatDrawer.tsx — ⌘J bottom sheet; stays mounted so the log/draft survive.
import type { StateInfo, StoredEvent } from "../api.js";
import { Sheet } from "./Sheet.js";
import { Chat } from "./Chat.js";

export function ChatDrawer({ open, onClose, state, events, target, setTarget, seed }: {
  open: boolean; onClose: () => void; state: StateInfo | undefined; events: StoredEvent[];
  target: string; setTarget: (t: string) => void; seed?: string;
}) {
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="flex items-center px-4 h-10 border-b border-line shrink-0">
        <span className="label">Chat · {target}</span>
        <span className="label ml-auto">⌘J to close</span>
      </div>
      <div className="flex-1 min-h-0 p-4">
        <Chat state={state} events={events} target={target} setTarget={setTarget} seed={seed} />
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 4: Command palette (port of `ui/src/components/CommandPalette.tsx`)**

Copy the file to `ui2/src/components/CommandPalette.tsx`; keep the ⌘K toggle, Escape close, arrow/enter selection, goal fetch-on-open, and filtering logic identical. Apply:
1. Replace the zone items with the 5 sections:

```tsx
    const base: Item[] = [
      { label: "home", hint: "section", run: close(() => navigate("home")) },
      { label: "goals", hint: "section", run: close(() => navigate("goals")) },
      { label: "staff", hint: "section", run: close(() => navigate("staff")) },
      { label: "mail", hint: "section", run: close(() => navigate("mail")) },
      { label: "system", hint: "section", run: close(() => navigate("system")) },
      { label: "governance", hint: "staff", run: close(() => navigate("staff/governance")) },
      { label: "events", hint: "system", run: close(() => navigate("system/events")) },
      { label: "costs", hint: "system", run: close(() => navigate("system/costs")) },
    ];
```

2. Agent/goal item routes: `staff/agents/${a.name}` stays; goal route becomes `goals/${g.slug}`.
3. Restyle: `hud` → `border border-line rounded-lg bg-surface`, `bg-void/70` → `bg-black/60`, `border-phosphor/40`/`focus:border-phosphor` → `border-line`/`focus:border-dim`, selected row `bg-panel-2 text-bright` → `bg-raised text-strong`, hover `hover:bg-panel-2` → `hover:bg-raised`.
4. `onOpenChat` prop type becomes `(name: string, seed?: string) => void` (palette calls it with just the name).

- [ ] **Step 5: Top bar + App shell**

```tsx
// ui2/src/components/TopBar.tsx — AIOS · Home Goals Staff Mail System ··· budget · connection dot · ⌘K.
import type { BudgetInfo } from "../api.js";
import { SECTIONS, href } from "../lib/router.js";
import { usd } from "../lib/format.js";

export function TopBar({ section, budget, connected, needsYou, onPalette }: {
  section: string; budget: BudgetInfo | undefined; connected: boolean;
  needsYou: number; onPalette: () => void;
}) {
  return (
    <header className="flex items-center gap-1 px-4 h-12 border-b border-line bg-surface shrink-0">
      <a href={href("home")} className="text-strong font-medium text-[14px] mr-4 tracking-wide">AIOS</a>
      <nav className="hidden md:flex items-center gap-1">
        {SECTIONS.map((s) => (
          <a
            key={s}
            href={href(s)}
            className={`px-2.5 py-1.5 rounded-md text-[12px] capitalize transition-colors ${
              section === s ? "text-strong bg-raised" : "text-dim hover:text-fg"
            }`}
          >
            {s}
            {s === "home" && needsYou > 0 && (
              <span className="ml-1.5 text-[10px] text-bg bg-accent rounded-full px-1.5 tick">{needsYou}</span>
            )}
          </a>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-4">
        {budget && budget.capCents != null && (
          <span className="text-[11px] text-dim" title={`daily budget · ${budget.date}`}>
            {usd(budget.spentCents)} / {usd(budget.capCents)}
          </span>
        )}
        <span
          title={connected ? "live" : "reconnecting"}
          className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-ok breathe" : "bg-err"}`}
        />
        <button onClick={onPalette} className="label hover:text-fg">⌘K</button>
      </div>
    </header>
  );
}
```

```tsx
// ui2/src/App.tsx — Ember Cockpit shell: 5 sections stay mounted; route picks visibility (old-UI pattern).
import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { useEvents, useFetch, useLiveQuery } from "./hooks.js";
import { T } from "./lib/topics.js";
import { useRoute, navigate } from "./lib/router.js";
import { TopBar } from "./components/TopBar.js";
import { TokenGate } from "./components/TokenGate.js";
import { ChatDrawer } from "./components/ChatDrawer.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { Home } from "./views/Home.js";
import { Goals } from "./views/Goals.js";
import { Staff } from "./views/Staff.js";
import { Mail } from "./views/Mail.js";
import { System } from "./views/System.js";
import { BottomTabs } from "./components/BottomTabs.js";

const JUMPS: Record<string, string> = { h: "home", g: "goals", s: "staff", m: "mail", y: "system" };

export function App() {
  const route = useRoute();
  const { events, connected } = useEvents();
  const { data: state, error, reload } = useFetch(() => api.state(), []);
  const { data: budget } = useLiveQuery(() => api.budget(), events, T.budget);
  const { data: attention } = useLiveQuery(() => api.attention(), events, T.attention);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatTarget, setChatTarget] = useState("hermes");
  const [chatSeed, setChatSeed] = useState<string | undefined>();
  const [paletteSignal, setPaletteSignal] = useState(0);
  const pendingG = useRef(false);

  const openChat = (target: string, seed?: string) => {
    setChatTarget(target);
    setChatSeed(seed);
    setChatOpen(true);
  };

  // ⌘J chat toggle + `g then h/g/s/m/y` section jumps (never while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setChatOpen((v) => !v);
        return;
      }
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (pendingG.current && JUMPS[e.key]) {
        pendingG.current = false;
        navigate(JUMPS[e.key]);
        return;
      }
      pendingG.current = e.key === "g";
      if (pendingG.current) setTimeout(() => { pendingG.current = false; }, 800);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (error === "unauthorized") return <TokenGate onSet={reload} />;

  const show = (s: string) => (route.section === s ? "flex-1 min-h-0 flex flex-col" : "hidden");

  return (
    <div className="h-full flex flex-col">
      <TopBar
        section={route.section} budget={budget} connected={connected}
        needsYou={attention?.length ?? 0} onPalette={() => setPaletteSignal((n) => n + 1)}
      />
      <div className={show("home")}><Home events={events} attention={attention} onOpenChat={openChat} /></div>
      <div className={show("goals")}><Goals events={events} route={route} onOpenChat={openChat} /></div>
      <div className={show("staff")}><Staff events={events} route={route} onOpenChat={openChat} /></div>
      <div className={show("mail")}><Mail events={events} route={route} /></div>
      <div className={show("system")}><System events={events} route={route} /></div>
      <BottomTabs section={route.section} needsYou={attention?.length ?? 0} />
      <ChatDrawer
        open={chatOpen} onClose={() => setChatOpen(false)} state={state} events={events}
        target={chatTarget} setTarget={setChatTarget} seed={chatSeed}
      />
      <CommandPalette state={state} onOpenChat={openChat} openSignal={paletteSignal} />
    </div>
  );
}
```

Notes:
- `CommandPalette` gains an `openSignal: number` prop — an incrementing counter; a `useEffect` on it (skipping the initial 0) opens the palette so the top-bar ⌘K button works on touch devices too.
- `Home/Goals/Staff/Mail/System` do not exist yet — for THIS task create one-line placeholders so the shell compiles, e.g. `export function Goals(_: {events: StoredEvent[]; route: Route; onOpenChat: (t: string, s?: string) => void}) { return <Empty>Goals — Task 7</Empty>; }` (same pattern for the others with their Task numbers; `BottomTabs` placeholder renders `null` until Task 11).
- `Home` placeholder for this task: renders `<Empty>Nothing needs you.</Empty>` so the smoke test still passes.

- [ ] **Step 6: Shell test**

Replace `ui2/test/smoke.test.tsx` with:

```tsx
// ui2/test/shell.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { App } from "../src/App.js";
import { stubApi, STATE_STUB } from "./stubs.js";

afterEach(cleanup);

describe("app shell", () => {
  it("renders the 5-section nav and connection dot", async () => {
    stubApi({
      "/api/state": STATE_STUB,
      "/api/budget": { date: "2026-07-13", spentCents: 120, capCents: 1000 },
      "/api/attention": [],
    });
    render(<App />);
    for (const s of ["home", "goals", "staff", "mail", "system"]) {
      expect(await screen.findByText(s)).toBeTruthy();
    }
  });

  it("gates on 401", async () => {
    stubApi({}); // /api/state → 404 in the stub; force 401 instead:
    (globalThis.fetch as unknown as { mockImplementation: (fn: () => Promise<Response>) => void })
      .mockImplementation(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    render(<App />);
    expect(await screen.findByPlaceholderText("AIOS_UI_TOKEN")).toBeTruthy();
  });
});
```

- [ ] **Step 7: Run + commit**

Run: `cd ui2 && npx vitest run && npx tsc --noEmit`
Expected: all ui2 tests pass (shell 2 + router 3 + topics 2 + dag-layout).

```bash
git add ui2/src ui2/test
git commit -m "feat(ui2): Ember primitives + app shell — top bar, ⌘K palette, ⌘J chat drawer, token gate"
```

---

### Task 5: Home — queue model, Queue list with inline actions, Today strip

**Files:**
- Create: `ui2/src/lib/queue.ts`, `ui2/src/views/Queue.tsx`, `ui2/src/views/TodayStrip.tsx`, `ui2/src/views/Home.tsx` (replaces placeholder)
- Test: `ui2/test/queue.test.ts`, `ui2/test/queue-render.test.tsx`

**Interfaces:**
- Consumes: `AttentionItem` (Task 1), `api.resolveAction/answerMail/markMailRead/goalAction/mailMine` (Task 3), primitives (Task 4). Canvas components arrive in Task 6 — this task renders a `SelectionPane` placeholder (`<Empty>Canvas — Task 6</Empty>` when an item is selected, org-pulse placeholder when idle).
- Produces:
  - queue.ts: `interface QueueGroup { label: string; severity: number; items: AttentionItem[] }`, `groupQueue(items: AttentionItem[]): QueueGroup[]` (fixed group order Approvals/Asks/Goals/Mail/Ambient, ts-desc inside, empty groups dropped), `flatQueue(groups: QueueGroup[]): AttentionItem[]` (j/k walk order).
  - Home.tsx: `Home({ events, attention, onOpenChat })` — owns `selected: AttentionItem | null`, `handled: Set<string>` (optimistic collapse), `rowError: Record<string, string>`; passes an `act(item, verb)` callback into Queue.
  - Queue.tsx: `Queue({ groups, selected, onSelect, onAct, rowErrors, busy })` — presentation + inline action buttons + one-time `.arrive` animation on newly seen ids.
  - Home keyboard: `j/k` walk, `enter` open (select), `a` approve, `r` reject, `d` discuss (→ `onOpenChat("hermes", seed)`); only when Home is the active section and no input is focused.

- [ ] **Step 1: Failing tests for the pure queue model**

```ts
// ui2/test/queue.test.ts
import { describe, it, expect } from "vitest";
import { groupQueue, flatQueue } from "../src/lib/queue.js";
import type { AttentionItem } from "../src/api.js";

const item = (id: string, severity: 1 | 2 | 3 | 4 | 5, ts: string): AttentionItem =>
  ({ kind: "approval", id, title: id, meta: "", severity, ts, actions: [], ref: {} });

describe("groupQueue", () => {
  it("groups by severity in cockpit order, drops empty groups, ts-desc inside", () => {
    const groups = groupQueue([
      item("m", 4, "2026-01-02"), item("a2", 1, "2026-01-03"),
      item("a1", 1, "2026-01-01"), item("s", 5, "2026-01-01"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Approvals", "Mail", "Ambient"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a2", "a1"]);
  });
  it("flatQueue walks groups in order", () => {
    const groups = groupQueue([item("b", 3, "1"), item("a", 1, "1")]);
    expect(flatQueue(groups).map((i) => i.id)).toEqual(["a", "b"]);
  });
});
```

Run: `cd ui2 && npx vitest run test/queue.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement queue.ts**

```ts
// ui2/src/lib/queue.ts — pure grouping/ordering for the Home cockpit queue (spec §5).
import type { AttentionItem } from "../api.js";

export const GROUPS = [
  { severity: 1, label: "Approvals" },
  { severity: 2, label: "Asks" },
  { severity: 3, label: "Goals" },
  { severity: 4, label: "Mail" },
  { severity: 5, label: "Ambient" },
] as const;

export interface QueueGroup { label: string; severity: number; items: AttentionItem[] }

export function groupQueue(items: AttentionItem[]): QueueGroup[] {
  return GROUPS.map((g) => ({
    label: g.label,
    severity: g.severity,
    items: items.filter((i) => i.severity === g.severity).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)),
  })).filter((g) => g.items.length > 0);
}

/** Flat walk order for j/k navigation. */
export function flatQueue(groups: QueueGroup[]): AttentionItem[] {
  return groups.flatMap((g) => g.items);
}
```

Run the test → PASS.

- [ ] **Step 3: Queue list**

```tsx
// ui2/src/views/Queue.tsx — the needs-you list: grouped rows, inline actions, one-time arrival animation.
import { useRef } from "react";
import type { AttentionItem } from "../api.js";
import type { QueueGroup } from "../lib/queue.js";
import { Button } from "../components/ui.js";
import { TwoStepButton } from "../components/TwoStepButton.js";
import { ts } from "../lib/format.js";

const ACTION_LABEL: Record<string, string> = {
  approve: "Approve", reject: "Reject", answer: "Answer", open: "Open",
  read: "Mark read", resume: "Resume", abandon: "Abandon",
};

export function Queue({ groups, selected, onSelect, onAct, rowErrors, busy }: {
  groups: QueueGroup[];
  selected: AttentionItem | null;
  onSelect: (i: AttentionItem) => void;
  onAct: (i: AttentionItem, verb: string) => void;
  rowErrors: Record<string, string>;
  busy: Set<string>;
}) {
  // Ids seen in a previous render never re-animate (spec §3 arrival rule).
  const seen = useRef(new Set<string>());
  const isNew = (id: string) => {
    if (seen.current.has(id)) return false;
    seen.current.add(id);
    return true;
  };

  return (
    <div className="flex flex-col gap-4 overflow-y-auto min-h-0">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="label px-3 mb-1">{g.label} · {g.items.length}</div>
          {g.items.map((i) => (
            <div
              key={i.id}
              onClick={() => onSelect(i)}
              className={`group px-3 py-2.5 border-l-2 cursor-pointer transition-colors min-h-11 ${
                selected?.id === i.id
                  ? "border-accent bg-raised"
                  : "border-transparent hover:bg-raised"
              } ${isNew(i.id) ? "arrive" : ""}`}
            >
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] text-strong truncate">{i.title}</span>
                <span className="text-[10px] text-dim ml-auto shrink-0">{ts(i.ts)}</span>
              </div>
              <div className="text-[11px] text-dim truncate">{i.meta}</div>
              {rowErrors[i.id] && <div className="text-[11px] text-err mt-1">{rowErrors[i.id]}</div>}
              <div className="flex gap-1.5 mt-1.5" onClick={(e) => e.stopPropagation()}>
                {i.actions.map((verb) =>
                  verb === "abandon" ? (
                    <TwoStepButton key={verb} label="Abandon" disabled={busy.has(i.id)} onConfirm={() => onAct(i, verb)} />
                  ) : (
                    <Button
                      key={verb}
                      variant={verb === "approve" || verb === "answer" ? "primary" : verb === "reject" ? "danger" : "ghost"}
                      disabled={busy.has(i.id)}
                      onClick={() => onAct(i, verb)}
                    >
                      {ACTION_LABEL[verb] ?? verb}
                    </Button>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
      {groups.length === 0 && <div className="text-dim px-3 py-6">Nothing needs you.</div>}
    </div>
  );
}
```

- [ ] **Step 4: Today strip**

```tsx
// ui2/src/views/TodayStrip.tsx — one line above the queue: date · brief link · budget today.
import { api, type StoredEvent } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { usd } from "../lib/format.js";

export function TodayStrip({ events, onOpenBrief }: {
  events: StoredEvent[];
  onOpenBrief: (threadId: string) => void;
}) {
  const { data: budget } = useLiveQuery(() => api.budget(), events, T.budget);
  const { data: mine } = useLiveQuery(() => api.mailMine(), events, T.agentMail);
  const brief = mine?.threads.find((t) => t.lastFrom === "hermes");
  const date = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  return (
    <div className="flex items-center gap-3 px-3 h-9 border-b border-line text-[11px] text-dim shrink-0">
      <span className="text-fg">{date}</span>
      {brief && (
        <button className="hover:text-fg underline underline-offset-2" onClick={() => onOpenBrief(brief.threadId)}>
          latest brief
        </button>
      )}
      {budget && <span className="ml-auto">{usd(budget.spentCents)} today{budget.capCents != null ? ` / ${usd(budget.capCents)}` : ""}</span>}
    </div>
  );
}
```

- [ ] **Step 5: Home — selection, optimistic actions, keyboard**

```tsx
// ui2/src/views/Home.tsx — the Triage Cockpit: queue (left) + canvas (right) (spec §5).
import { useEffect, useMemo, useState } from "react";
import { api, type AttentionItem, type StoredEvent } from "../api.js";
import { groupQueue, flatQueue } from "../lib/queue.js";
import { Queue } from "./Queue.js";
import { TodayStrip } from "./TodayStrip.js";
import { Canvas } from "./canvas/index.js";

export function Home({ events, attention, onOpenChat }: {
  events: StoredEvent[];
  attention: AttentionItem[] | undefined;
  onOpenChat: (target: string, seed?: string) => void;
}) {
  const [selected, setSelected] = useState<AttentionItem | null>(null);
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const visible = useMemo(
    () => (attention ?? []).filter((i) => !handled.has(i.id)),
    [attention, handled],
  );
  const groups = useMemo(() => groupQueue(visible), [visible]);

  // A fresh /api/attention read is the truth — drop optimistic tombstones it no longer lists.
  useEffect(() => {
    if (!attention) return;
    setHandled((h) => new Set([...h].filter((id) => attention.some((i) => i.id === id))));
  }, [attention]);

  const mark = (set: (updater: (s: Set<string>) => Set<string>) => void, id: string, on: boolean) =>
    set((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });

  const act = async (item: AttentionItem, verb: string) => {
    if (verb === "open") { setSelected(item); return; }
    if (verb === "answer") { setSelected(item); return; } // answering happens in the canvas with context
    setRowErrors((e) => ({ ...e, [item.id]: "" }));
    mark(setBusy, item.id, true);
    const optimistic = verb === "approve" || verb === "reject" || verb === "read" || verb === "abandon" || verb === "resume";
    if (optimistic) mark(setHandled, item.id, true);
    try {
      if (verb === "approve" || verb === "reject") await api.resolveAction(item.ref.actionId, verb);
      else if (verb === "read") {
        const thread = await api.mailThreadView(item.ref.threadId);
        await Promise.all(thread.filter((m) => m.to === "user" && m.status === "unread").map((m) => api.markMailRead(m.id)));
      } else if (verb === "abandon") await api.goalAction(item.ref.goalId, "abandon");
      else if (verb === "resume") { await api.goalAction(item.ref.goalId, "resume"); }
      if (selected?.id === item.id) setSelected(null);
    } catch (err) {
      if (optimistic) mark(setHandled, item.id, false); // rollback
      setRowErrors((e) => ({ ...e, [item.id]: (err as Error).message }));
    } finally {
      mark(setBusy, item.id, false);
    }
  };

  // j/k walk · enter open · a approve · r reject · d discuss (spec §4).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const flat = flatQueue(groupQueue(visible));
      const idx = selected ? flat.findIndex((i) => i.id === selected.id) : -1;
      if (e.key === "j") setSelected(flat[Math.min(idx + 1, flat.length - 1)] ?? null);
      if (e.key === "k") setSelected(flat[Math.max(idx - 1, 0)] ?? null);
      if (!selected) return;
      if (e.key === "Enter") setSelected(selected);
      if (e.key === "a" && selected.actions.includes("approve")) void act(selected, "approve");
      if (e.key === "r" && selected.actions.includes("reject")) void act(selected, "reject");
      if (e.key === "d") onOpenChat("hermes", `About "${selected.title}" (${selected.kind} ${selected.id}): `);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, selected]);

  const openBrief = (threadId: string) => {
    setSelected({
      kind: "mail", id: `brief:${threadId}`, title: "Brief", meta: "", severity: 4,
      ts: new Date().toISOString(), actions: [], ref: { threadId, brief: "1" },
    });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <TodayStrip events={events} onOpenBrief={openBrief} />
      <div className="flex-1 min-h-0 flex">
        <div className="w-[360px] shrink-0 border-r border-line py-2 hidden md:flex flex-col">
          <Queue groups={groups} selected={selected} onSelect={setSelected} onAct={act} rowErrors={rowErrors} busy={busy} />
        </div>
        {/* Phone: the queue IS the home screen (Task 11 adds the full-screen detail push). */}
        <div className="flex-1 min-h-0 md:hidden py-2">
          <Queue groups={groups} selected={selected} onSelect={setSelected} onAct={act} rowErrors={rowErrors} busy={busy} />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 hidden md:block">
          <Canvas item={selected} events={events} onAct={act} onOpenChat={onOpenChat} onDone={() => setSelected(null)} />
        </div>
      </div>
    </div>
  );
}
```

For THIS task, `ui2/src/views/canvas/index.tsx` is a placeholder so Home compiles:

```tsx
// ui2/src/views/canvas/index.tsx — placeholder; real renderers land in Task 6.
import type { AttentionItem, StoredEvent } from "../../api.js";
import { Empty } from "../../components/ui.js";

export function Canvas(_: {
  item: AttentionItem | null;
  events: StoredEvent[];
  onAct: (i: AttentionItem, verb: string) => void;
  onOpenChat: (t: string, s?: string) => void;
  onDone: () => void;
}) {
  return <Empty>Canvas — Task 6</Empty>;
}
```

- [ ] **Step 6: Render test — inline approve collapses the row optimistically**

```tsx
// ui2/test/queue-render.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Home } from "../src/views/Home.js";
import { stubApi } from "./stubs.js";
import type { AttentionItem } from "../src/api.js";

afterEach(cleanup);

const approval: AttentionItem = {
  kind: "approval", id: "a1", title: "Send weekly report", meta: "email.draft",
  severity: 1, ts: "2026-07-13T09:00:00.000Z", actions: ["approve", "reject", "open"], ref: { actionId: "a1" },
};

describe("Home queue", () => {
  it("renders groups and collapses a row on approve", async () => {
    stubApi({
      "/api/budget": { date: "2026-07-13", spentCents: 0, capCents: null },
      "/api/mail/mine": { threads: [] },
      "/api/actions/a1/resolve": { id: "a1", status: "executed" },
    });
    render(<Home events={[]} attention={[approval]} onOpenChat={() => {}} />);
    expect((await screen.findAllByText("Send weekly report")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText("Approve")[0]);
    expect((await screen.findAllByText("Nothing needs you.")).length).toBeGreaterThan(0);
  });

  it("rolls back and shows an inline error when the mutation fails", async () => {
    stubApi({
      "/api/budget": { date: "2026-07-13", spentCents: 0, capCents: null },
      "/api/mail/mine": { threads: [] },
      // /api/actions/a1/resolve intentionally unstubbed → 404 "no stub" error
    });
    render(<Home events={[]} attention={[approval]} onOpenChat={() => {}} />);
    fireEvent.click((await screen.findAllByText("Approve"))[0]);
    expect((await screen.findAllByText(/no stub/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Send weekly report").length).toBeGreaterThan(0); // row is back
  });
});
```

- [ ] **Step 7: Run + commit**

Run: `cd ui2 && npx vitest run && npx tsc --noEmit` → all green.

```bash
git add ui2/src ui2/test
git commit -m "feat(ui2): Home triage cockpit — grouped needs-you queue, inline optimistic actions, today strip"
```

---

### Task 6: Canvas renderers — approval preview, ask, goal, mail thread, brief, org pulse

**Files:**
- Create: `ui2/src/lib/preview.ts`, `ui2/src/views/MiniDag.tsx`, `ui2/src/views/canvas/Approval.tsx`, `ui2/src/views/canvas/Ask.tsx`, `ui2/src/views/canvas/Goal.tsx`, `ui2/src/views/canvas/MailThread.tsx`, `ui2/src/views/canvas/OrgPulse.tsx`
- Modify: `ui2/src/views/canvas/index.tsx` (replace placeholder with the real switch)
- Test: `ui2/test/preview.test.ts`

**Interfaces:**
- Consumes: `AttentionItem.ref` pointers (Task 1), `api.actions/goal/mailThreadView/answerMail/composeMail/org/goals/costs` (Task 3), `layoutDag` (Task 3), primitives + `toneOfStatus` (Task 4), `act` callback (Task 5).
- Produces:
  - preview.ts: `type ApprovalPreview = { form: "email"; to; subject; body } | { form: "vault"; path; markdown } | { form: "permission"; role; tool; op: "grant"|"revoke" } | { form: "generic"; preview: string; fields: Array<[string, string]> }`, `parseApproval(a: ActionInfo): ApprovalPreview`.
  - MiniDag.tsx: `MiniDag({ nodes, failedKey? }: { nodes: GoalNodeView[]; failedKey?: string })` — compact read-only SVG (used here AND by Goals detail in Task 7 at full size via a `scale` prop, default 0.6).
  - canvas/index.tsx: `Canvas({ item, events, onAct, onOpenChat, onDone })` — routes by `item.kind` (`null` → OrgPulse; `ref.brief` → MailThread in memo mode).

- [ ] **Step 1: Failing preview test**

```ts
// ui2/test/preview.test.ts
import { describe, it, expect } from "vitest";
import { parseApproval } from "../src/lib/preview.js";
import type { ActionInfo } from "../src/api.js";

const action = (type: string, payload: unknown, preview = "p"): ActionInfo => ({
  id: "x", type, payload: JSON.stringify(payload), preview, status: "proposed",
  origin_channel: "cli", origin_chat_id: "l", trust_state: "supervised",
  verdict_by: null, reject_reason: null, result: null,
  created_at: "t", resolved_at: null, expires_at: "t",
});

describe("parseApproval", () => {
  it("email.draft → email form", () => {
    expect(parseApproval(action("email.draft", { to: "a@b.c", subject: "Hi", body: "text" })))
      .toEqual({ form: "email", to: "a@b.c", subject: "Hi", body: "text" });
  });
  it("vault.write → path + markdown", () => {
    expect(parseApproval(action("vault.write", { path: "notes/x.md", content: "# X" })))
      .toEqual({ form: "vault", path: "notes/x.md", markdown: "# X" });
  });
  it("permission.grant → role/tool delta", () => {
    expect(parseApproval(action("permission.grant", { role: "researcher", tool: "WebSearch" })))
      .toEqual({ form: "permission", role: "researcher", tool: "WebSearch", op: "grant" });
  });
  it("unknown type → generic fields; junk payload survives", () => {
    const g = parseApproval(action("bank.transfer", { amount: 5, note: "x" }, "Transfer €5"));
    expect(g.form).toBe("generic");
    if (g.form === "generic") {
      expect(g.preview).toBe("Transfer €5");
      expect(g.fields).toContainEqual(["amount", "5"]);
    }
    expect(parseApproval({ ...action("t", {}), payload: "not json" }).form).toBe("generic");
  });
});
```

Run: `cd ui2 && npx vitest run test/preview.test.ts` → FAIL.

- [ ] **Step 2: Implement preview.ts**

```ts
// ui2/src/lib/preview.ts — typed approval previews for the canvas (spec §5: gate-authored preview by type).
import type { ActionInfo } from "../api.js";

export type ApprovalPreview =
  | { form: "email"; to: string; subject: string; body: string }
  | { form: "vault"; path: string; markdown: string }
  | { form: "permission"; role: string; tool: string; op: "grant" | "revoke" }
  | { form: "generic"; preview: string; fields: Array<[string, string]> };

export function parseApproval(a: ActionInfo): ApprovalPreview {
  let p: Record<string, unknown> = {};
  try { p = JSON.parse(a.payload) as Record<string, unknown>; } catch { /* keep {} */ }
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  if (a.type === "email.draft" || a.type === "email.send") {
    return { form: "email", to: s("to"), subject: s("subject"), body: s("body") };
  }
  if (a.type === "vault.write") {
    return { form: "vault", path: s("path") || s("file"), markdown: s("content") || s("body") };
  }
  if (a.type === "permission.grant" || a.type === "permission.revoke") {
    return { form: "permission", role: s("role"), tool: s("tool"), op: a.type.endsWith("grant") ? "grant" : "revoke" };
  }
  return {
    form: "generic", preview: a.preview,
    fields: Object.entries(p).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)] as [string, string]),
  };
}
```

Run the test → PASS.

- [ ] **Step 3: MiniDag (shared with Goals)**

```tsx
// ui2/src/views/MiniDag.tsx — read-only DAG snapshot; Goals detail reuses it at scale 1.
import { useMemo } from "react";
import type { GoalNodeView } from "../api.js";
import { layoutDag, BOX_W, BOX_H } from "./dag-layout.js";
import { toneOfStatus } from "../components/ui.js";

const STROKE: Record<string, string> = {
  ok: "var(--color-ok)", err: "var(--color-err)", accent: "var(--color-accent)",
  agent: "var(--color-agent)", dim: "var(--color-line)",
};

export function MiniDag({ nodes, failedKey, scale = 0.6, onSelect }: {
  nodes: GoalNodeView[]; failedKey?: string; scale?: number; onSelect?: (key: string) => void;
}) {
  const layout = useMemo(() => layoutDag(nodes.map((n) => ({ key: n.key, deps: n.deps }))), [nodes]);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  return (
    <div className="overflow-x-auto">
      <svg width={layout.width * scale} height={layout.height * scale} viewBox={`0 0 ${layout.width} ${layout.height}`}>
        {layout.edges.map((e) => (
          <path key={`${e.from}-${e.to}`} d={e.path} fill="none"
            stroke={e.to === failedKey ? "var(--color-err)" : "var(--color-line)"} strokeWidth={1.5} />
        ))}
        {layout.boxes.map((b) => {
          const n = byKey.get(b.key)!;
          const tone = b.key === failedKey ? "err" : toneOfStatus(n.status);
          return (
            <g key={b.key} onClick={() => onSelect?.(b.key)} style={onSelect ? { cursor: "pointer" } : undefined}>
              <rect x={b.x} y={b.y} width={BOX_W} height={BOX_H} rx={8}
                fill="var(--color-raised)" stroke={STROKE[tone]} strokeWidth={b.key === failedKey ? 2 : 1} />
              <text x={b.x + 10} y={b.y + 24} fill="var(--color-strong)" fontSize={13}>{b.key}</text>
              <text x={b.x + 10} y={b.y + 44} fill="var(--color-dim)" fontSize={11}>
                {n.agent} · {n.status}{n.costCents ? ` · $${(n.costCents / 100).toFixed(2)}` : ""}
              </text>
              {n.status === "running" && (
                <rect x={b.x} y={b.y + BOX_H - 2} width={BOX_W} height={2} fill="var(--color-ok)" opacity={0.5}>
                  <animate attributeName="opacity" values="0.2;0.7;0.2" dur="1.6s" repeatCount="indefinite" />
                </rect>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
```

- [ ] **Step 4: Renderers**

```tsx
// ui2/src/views/canvas/Approval.tsx — gate-authored preview by type + Approve/Reject(reason)/Discuss.
import { useState } from "react";
import { api, type AttentionItem, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { parseApproval } from "../../lib/preview.js";
import { Button, Tag, SectionLabel, Empty } from "../../components/ui.js";

export function ApprovalCanvas({ item, events, onAct, onOpenChat }: {
  item: AttentionItem; events: StoredEvent[];
  onAct: (i: AttentionItem, verb: string) => void;
  onOpenChat: (t: string, s?: string) => void;
}) {
  const [reason, setReason] = useState("");
  const { data: actions } = useLiveQuery(() => api.actions("proposed"), events, T.actions);
  const action = actions?.find((a) => a.id === item.ref.actionId);
  if (!action) return <Empty>Already handled.</Empty>;
  const p = parseApproval(action);
  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <SectionLabel>Approval</SectionLabel>
        <Tag tone="accent">{action.type}</Tag>
        <span className="text-[11px] text-dim ml-auto">expires {action.expires_at.slice(5, 16).replace("T", " ")}</span>
      </div>

      {p.form === "email" && (
        <div className="border border-line rounded-lg bg-surface p-4">
          <div className="text-[11px] text-dim">To <span className="text-fg">{p.to}</span></div>
          <div className="text-[15px] text-strong mt-1 mb-3">{p.subject}</div>
          <div className="whitespace-pre-wrap leading-relaxed">{p.body}</div>
        </div>
      )}
      {p.form === "vault" && (
        <div className="border border-line rounded-lg bg-surface p-4">
          <div className="text-[11px] text-dim mb-2 font-mono">{p.path}</div>
          <pre className="font-mono text-[12px] whitespace-pre-wrap text-fg">{p.markdown}</pre>
        </div>
      )}
      {p.form === "permission" && (
        <div className="border border-line rounded-lg bg-surface p-4 flex items-center gap-3">
          <Tag tone={p.op === "grant" ? "ok" : "err"}>{p.op}</Tag>
          <span className="text-strong">{p.tool}</span>
          <span className="text-dim">for role</span>
          <span className="text-strong">{p.role}</span>
        </div>
      )}
      {p.form === "generic" && (
        <div className="border border-line rounded-lg bg-surface p-4">
          <div className="mb-3">{p.preview}</div>
          {p.fields.length > 0 && (
            <table className="text-[12px] w-full">
              <tbody>
                {p.fields.map(([k, v]) => (
                  <tr key={k}><td className="text-dim pr-4 py-0.5 align-top whitespace-nowrap">{k}</td><td className="break-all">{v}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => onAct(item, "approve")}>Approve ↵</Button>
        <Button variant="danger" onClick={() => onAct(item, "reject")}>Reject</Button>
        <input
          value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason (optional)"
          className="bg-bg border border-line rounded-md px-2 py-1.5 text-[12px] outline-none focus:border-dim w-48"
          onKeyDown={(e) => { if (e.key === "Enter" && reason) void api.resolveAction(item.ref.actionId, "reject", reason).then(() => onAct(item, "open")); }}
        />
        <Button onClick={() => onOpenChat("hermes", `About approval "${item.title}" (${action.type}): `)}>Discuss ⌘J</Button>
      </div>
    </div>
  );
}
```

(Reject-with-reason: pressing Enter in the reason field rejects with the reason via the api directly; the plain Reject button goes through `onAct` for the optimistic collapse. After a reasoned reject, calling `onAct(item, "open")` just re-selects — the next `/api/attention` refresh drops the row; acceptable simplicity.)

```tsx
// ui2/src/views/canvas/Ask.tsx — question + parked-goal context + answer box (resumes via /api/mail/:id/answer).
import { useState } from "react";
import { api, type AttentionItem, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { Button, SectionLabel, Tag, Empty } from "../../components/ui.js";
import { MiniDag } from "../MiniDag.js";

export function AskCanvas({ item, events, onDone }: {
  item: AttentionItem; events: StoredEvent[]; onDone: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { data: goal } = useLiveQuery(
    () => (item.ref.goalId ? api.goal(item.ref.goalId) : Promise.resolve(null)),
    events, T.goals, [item.ref.goalId],
  );

  const send = async () => {
    if (!answer.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.answerMail(item.ref.mailId, answer.trim());
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <SectionLabel>Ask</SectionLabel>
        <Tag tone="accent">{item.meta}</Tag>
      </div>
      <div className="border border-line rounded-lg bg-surface p-4 whitespace-pre-wrap leading-relaxed">{itemBody(item)}</div>
      {goal && (
        <div>
          <SectionLabel>Blocked goal · {goal.title}</SectionLabel>
          <MiniDag nodes={goal.nodes} />
        </div>
      )}
      {!goal && item.ref.goalId === undefined && <Empty>No goal attached.</Empty>}
      <div className="flex gap-2">
        <input
          value={answer} onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Your answer resumes the goal…"
          className="flex-1 bg-bg border border-line rounded-md px-3 py-2 outline-none focus:border-dim"
        />
        <Button variant="primary" disabled={busy} onClick={send}>{busy ? "…" : "Answer"}</Button>
      </div>
      {error && <div className="text-[12px] text-err">{error}</div>}
    </div>
  );
}

/** The queue truncates the title; fetch nothing extra — the full body came in the item. */
function itemBody(item: AttentionItem): string {
  return item.title;
}
```

(Note: `AttentionItem.title` is the first line, capped at 140 chars in the builder. For asks that is nearly always the full question; the linked mail thread is one click away via Mail. Keep it simple.)

```tsx
// ui2/src/views/canvas/Goal.tsx — failed/paused goal: error, failed node in the mini DAG, cost, actions.
import { api, type AttentionItem, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { navigate } from "../../lib/router.js";
import { Button, SectionLabel, Tag, Empty, toneOfStatus } from "../../components/ui.js";
import { TwoStepButton } from "../../components/TwoStepButton.js";
import { usd } from "../../lib/format.js";
import { MiniDag } from "../MiniDag.js";

export function GoalCanvas({ item, events, onAct, onOpenChat }: {
  item: AttentionItem; events: StoredEvent[];
  onAct: (i: AttentionItem, verb: string) => void;
  onOpenChat: (t: string, s?: string) => void;
}) {
  const { data: goal } = useLiveQuery(() => api.goal(item.ref.goalId), events, T.goals, [item.ref.goalId]);
  if (!goal) return <Empty>Loading…</Empty>;
  const failedNode = goal.nodes.find((n) => n.status === "failed");
  const cost = goal.nodes.reduce((s, n) => s + n.costCents, 0);
  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <SectionLabel>Goal</SectionLabel>
        <Tag tone={toneOfStatus(goal.status)}>{goal.status}</Tag>
        <span className="text-[11px] text-dim ml-auto">{usd(cost)} so far</span>
      </div>
      <div className="text-[15px] text-strong">{goal.title}</div>
      {goal.error && <div className="border border-err/40 rounded-lg bg-surface p-3 text-err text-[12px] whitespace-pre-wrap">{goal.error}</div>}
      <MiniDag nodes={goal.nodes} failedKey={failedNode?.key} />
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => navigate(`goals/${goal.slug}`)}>Open in Goals</Button>
        {item.actions.includes("resume") && <Button onClick={() => onAct(item, "resume")}>Resume</Button>}
        <TwoStepButton label="Abandon" onConfirm={() => onAct(item, "abandon")} />
        <Button onClick={() => onOpenChat(goal.lead, `About goal "${goal.title}" (${goal.status}): `)}>Discuss ⌘J</Button>
      </div>
    </div>
  );
}
```

```tsx
// ui2/src/views/canvas/MailThread.tsx — thread view + reply box; memo mode for briefs.
import { useState } from "react";
import { api, type AttentionItem, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { Button, SectionLabel, Tag, Empty, toneOfStatus } from "../../components/ui.js";
import { ts } from "../../lib/format.js";

export function MailThreadCanvas({ item, events }: { item: AttentionItem; events: StoredEvent[] }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const memo = item.ref.brief === "1";
  const { data: thread, reload } = useLiveQuery(
    () => api.mailThreadView(item.ref.threadId), events, T.agentMail, [item.ref.threadId],
  );
  if (!thread) return <Empty>Loading…</Empty>;
  const last = thread[thread.length - 1];

  const send = async () => {
    if (!reply.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.composeMail({ to: last.from, body: reply.trim(), threadId: item.ref.threadId, inReplyTo: last.id });
      if ("refusal" in res && !res.ok) setError(res.refusal);
      else { setReply(""); reload(); }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (memo) {
    return (
      <div className="max-w-2xl">
        <SectionLabel>Brief</SectionLabel>
        {thread.filter((m) => m.from !== "user").map((m) => (
          <div key={m.id} className="border border-line rounded-lg bg-surface p-5 mb-3 whitespace-pre-wrap leading-relaxed">{m.body}</div>
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-2xl flex flex-col gap-3">
      <SectionLabel>Thread</SectionLabel>
      {thread.map((m) => (
        <div key={m.id} className={m.from === "user" ? "self-end max-w-[85%]" : "self-start max-w-[85%]"}>
          <div className="label mb-1 flex gap-2">
            {m.from} → {m.to} <Tag tone={toneOfStatus(m.status)}>{m.kind}</Tag>
            <span className="ml-auto">{ts(m.createdAt)}</span>
          </div>
          <div className="border border-line rounded-lg bg-surface px-3 py-2 whitespace-pre-wrap leading-relaxed">{m.body}</div>
        </div>
      ))}
      <div className="flex gap-2 mt-2">
        <input
          value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={`Reply to ${last?.from ?? ""}…`}
          className="flex-1 bg-bg border border-line rounded-md px-3 py-2 outline-none focus:border-dim"
        />
        <Button variant="primary" disabled={busy} onClick={send}>{busy ? "…" : "Reply"}</Button>
      </div>
      {error && <div className="text-[12px] text-err">{error}</div>}
    </div>
  );
}
```

```tsx
// ui2/src/views/canvas/OrgPulse.tsx — the idle canvas: live org, running goals, today totals (spec §5 idle).
import { api, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { navigate } from "../../lib/router.js";
import { Dot, SectionLabel } from "../../components/ui.js";
import { usdFloat, usd } from "../../lib/format.js";

export function OrgPulse({ events }: { events: StoredEvent[] }) {
  const { data: org } = useLiveQuery(() => api.org(), events, T.agentsActions);
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  const { data: budget } = useLiveQuery(() => api.budget(), events, T.budget);
  const running = (goals ?? []).filter((g) => ["planning", "running", "replanning", "awaiting-mail"].includes(g.status));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="text-dim mb-4">Nothing needs you.</div>
        <div className="flex gap-6 overflow-x-auto">
          {(org ?? []).map((d) => (
            <div key={d.department} className="min-w-40">
              <SectionLabel>{d.department}</SectionLabel>
              {d.agents.map((a) => (
                <button
                  key={a.name}
                  onClick={() => navigate(`staff/agents/${a.name}`)}
                  className="flex items-center gap-2 py-1 w-full text-left hover:text-strong"
                >
                  <Dot tone={a.status === "working" ? "agent" : a.status === "waiting" ? "accent" : "dim"} breathing={a.status === "working"} />
                  <span className={a.status === "working" ? "text-fg" : "text-dim"}>{a.name}</span>
                  {a.currentTask && <span className="text-[10px] text-dim truncate max-w-32">{a.currentTask}</span>}
                  {a.costTodayUsd > 0 && <span className="text-[10px] text-dim ml-auto">{usdFloat(a.costTodayUsd)}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      {running.length > 0 && (
        <div>
          <SectionLabel>Running now</SectionLabel>
          {running.map((g) => {
            const done = g.nodes.filter((n) => n.status === "done").length;
            return (
              <button key={g.id} onClick={() => navigate(`goals/${g.slug}`)}
                className="w-full text-left py-1.5 group">
                <div className="flex items-baseline gap-2">
                  <span className="group-hover:text-strong">{g.title}</span>
                  <span className="text-[10px] text-dim">{done}/{g.nodes.length} · {g.department}</span>
                </div>
                <div className="shimmer mt-1" />
              </button>
            );
          })}
        </div>
      )}
      {budget && (
        <div className="text-[11px] text-dim">
          {usd(budget.spentCents)} spent today{budget.capCents != null ? ` of ${usd(budget.capCents)}` : ""}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: The switch**

Replace `ui2/src/views/canvas/index.tsx`:

```tsx
// ui2/src/views/canvas/index.tsx — pick a renderer by AttentionItem.kind; idle = org pulse (spec §5).
import type { AttentionItem, StoredEvent } from "../../api.js";
import { ApprovalCanvas } from "./Approval.js";
import { AskCanvas } from "./Ask.js";
import { GoalCanvas } from "./Goal.js";
import { MailThreadCanvas } from "./MailThread.js";
import { OrgPulse } from "./OrgPulse.js";
import { Empty } from "../../components/ui.js";

export function Canvas({ item, events, onAct, onOpenChat, onDone }: {
  item: AttentionItem | null;
  events: StoredEvent[];
  onAct: (i: AttentionItem, verb: string) => void;
  onOpenChat: (t: string, s?: string) => void;
  onDone: () => void;
}) {
  if (!item) return <OrgPulse events={events} />;
  switch (item.kind) {
    case "approval": return <ApprovalCanvas item={item} events={events} onAct={onAct} onOpenChat={onOpenChat} />;
    case "ask": return <AskCanvas item={item} events={events} onDone={onDone} />;
    case "goal": return <GoalCanvas item={item} events={events} onAct={onAct} onOpenChat={onOpenChat} />;
    case "mail": return <MailThreadCanvas item={item} events={events} />;
    case "sense": return <Empty>{item.title} — {item.meta}. Fix: npx tsx scripts/google-auth.ts (see System · Health).</Empty>;
  }
}
```

- [ ] **Step 6: Run + commit**

Run: `cd ui2 && npx vitest run && npx tsc --noEmit` → all green (preview 4 new).

```bash
git add ui2/src ui2/test
git commit -m "feat(ui2): canvas renderers — typed approval previews, ask/goal/mail canvases, idle org pulse"
```

---

### Task 7: Goals section — grouped list + Ember DAG detail with inspector

**Files:**
- Create: `ui2/src/lib/goal-buckets.ts`, replace placeholder `ui2/src/views/Goals.tsx`
- Test: `ui2/test/goal-buckets.test.ts`

**Interfaces:**
- Consumes: `api.goals/goal/goalAction/answerMail` (Task 3), `GoalView.originChannel` (Task 1), `MiniDag` with `scale=1` + `onSelect` (Task 6), primitives/`toneOfStatus` (Task 4).
- Produces:
  - goal-buckets.ts: `type Bucket = "needs" | "running" | "waiting" | "done" | "abandoned"`, `bucketOf(status: string): Bucket`, `BUCKETS: Array<{key: Bucket; label: string}>` (order: Needs attention / Running / Waiting / Done / Abandoned), `provenance(originChannel: string): "mail" | "speculate" | "chat"`.
  - Goals.tsx: `Goals({ events, route, onOpenChat })` — route `goals` = list, `goals/<slug>` = detail (drill-in inside the same component, old-UI pattern).

- [ ] **Step 1: Failing bucket tests**

```ts
// ui2/test/goal-buckets.test.ts
import { describe, it, expect } from "vitest";
import { bucketOf, provenance, BUCKETS } from "../src/lib/goal-buckets.js";

describe("goal buckets", () => {
  it("maps every engine status", () => {
    expect(bucketOf("failed")).toBe("needs");
    expect(bucketOf("running")).toBe("running");
    expect(bucketOf("planning")).toBe("running");
    expect(bucketOf("replanning")).toBe("running");
    expect(bucketOf("paused-budget")).toBe("waiting");
    expect(bucketOf("paused-user")).toBe("waiting");
    expect(bucketOf("awaiting-mail")).toBe("waiting");
    expect(bucketOf("done")).toBe("done");
    expect(bucketOf("abandoned")).toBe("abandoned");
    expect(bucketOf("anything-else")).toBe("running");
  });
  it("bucket order is the spec order", () => {
    expect(BUCKETS.map((b) => b.key)).toEqual(["needs", "running", "waiting", "done", "abandoned"]);
  });
  it("provenance chips", () => {
    expect(provenance("mail")).toBe("mail");
    expect(provenance("speculate")).toBe("speculate");
    expect(provenance("dream")).toBe("speculate");
    expect(provenance("web")).toBe("chat");
    expect(provenance("telegram")).toBe("chat");
  });
});
```

Run: `cd ui2 && npx vitest run test/goal-buckets.test.ts` → FAIL.

- [ ] **Step 2: Implement goal-buckets.ts**

```ts
// ui2/src/lib/goal-buckets.ts — status → list group + provenance chip (spec §6 Goals).
export type Bucket = "needs" | "running" | "waiting" | "done" | "abandoned";

export const BUCKETS: Array<{ key: Bucket; label: string }> = [
  { key: "needs", label: "Needs attention" },
  { key: "running", label: "Running" },
  { key: "waiting", label: "Waiting" },
  { key: "done", label: "Done" },
  { key: "abandoned", label: "Abandoned" },
];

export function bucketOf(status: string): Bucket {
  if (status === "failed") return "needs";
  if (status === "done") return "done";
  if (status === "abandoned") return "abandoned";
  if (status === "paused-budget" || status === "paused-user" || status === "awaiting-mail") return "waiting";
  return "running"; // planning | running | replanning
}

export function provenance(originChannel: string): "mail" | "speculate" | "chat" {
  if (originChannel === "mail") return "mail";
  if (originChannel === "speculate" || originChannel === "dream") return "speculate";
  return "chat";
}
```

Run the test → PASS.

- [ ] **Step 3: Goals view (list + detail)**

Replace the Task 4 placeholder `ui2/src/views/Goals.tsx`:

```tsx
// ui2/src/views/Goals.tsx — status-grouped list; detail = Ember DAG + inspector (spec §6).
import { useState } from "react";
import { api, type GoalNodeView, type StoredEvent } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate, type Route } from "../lib/router.js";
import { BUCKETS, bucketOf, provenance } from "../lib/goal-buckets.js";
import { Button, Empty, SectionLabel, Tag, toneOfStatus } from "../components/ui.js";
import { TwoStepButton } from "../components/TwoStepButton.js";
import { ts, usd } from "../lib/format.js";
import { MiniDag } from "./MiniDag.js";

export function Goals({ events, route, onOpenChat }: {
  events: StoredEvent[]; route: Route; onOpenChat: (t: string, s?: string) => void;
}) {
  const slug = route.section === "goals" ? route.parts[0] : undefined;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      {slug ? <GoalDetailView slug={slug} events={events} onOpenChat={onOpenChat} /> : <GoalList events={events} />}
    </div>
  );
}

function GoalList({ events }: { events: StoredEvent[] }) {
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  const [dept, setDept] = useState<string>("");
  if (!goals) return <Empty>Loading…</Empty>;
  const depts = [...new Set(goals.map((g) => g.department))].sort();
  const filtered = dept ? goals.filter((g) => g.department === dept) : goals;
  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-2 mb-4">
        <h1 className="text-[20px] text-strong">Goals</h1>
        <select value={dept} onChange={(e) => setDept(e.target.value)}
          className="ml-auto bg-surface border border-line rounded-md px-2 py-1 text-[12px] text-fg outline-none">
          <option value="">all departments</option>
          {depts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      {BUCKETS.map(({ key, label }) => {
        const items = filtered.filter((g) => bucketOf(g.status) === key);
        if (items.length === 0) return null;
        return (
          <div key={key} className="mb-6">
            <SectionLabel>{label} · {items.length}</SectionLabel>
            {items.map((g) => {
              const done = g.nodes.filter((n) => n.status === "done").length;
              const cost = g.nodes.reduce((s, n) => s + n.costCents, 0);
              return (
                <button key={g.id} onClick={() => navigate(`goals/${g.slug}`)}
                  className="w-full text-left px-3 py-2.5 rounded-md hover:bg-raised flex items-center gap-3 min-h-11">
                  <Tag tone={toneOfStatus(g.status)}>{g.status}</Tag>
                  <span className="text-strong truncate">{g.title}</span>
                  <span className="text-[11px] text-dim ml-auto shrink-0">
                    {g.department} · {g.lead} · {done}/{g.nodes.length} · {usd(cost)}
                  </span>
                  <Tag>{provenance(g.originChannel)}</Tag>
                  {bucketOf(g.status) === "running" && g.nodes.some((n) => n.status === "running") && (
                    <span className="w-16 shrink-0"><span className="shimmer block" /></span>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
      {filtered.length === 0 && <Empty>No goals yet.</Empty>}
    </div>
  );
}

function GoalDetailView({ slug, events, onOpenChat }: {
  slug: string; events: StoredEvent[]; onOpenChat: (t: string, s?: string) => void;
}) {
  const { data: goal, error } = useLiveQuery(() => api.goal(slug), events, T.goals, [slug]);
  const [nodeKey, setNodeKey] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [askError, setAskError] = useState("");
  if (error) return <Empty>{error}</Empty>;
  if (!goal) return <Empty>Loading…</Empty>;
  const node: GoalNodeView | undefined = goal.nodes.find((n) => n.key === nodeKey) ?? goal.nodes.find((n) => n.status === "failed");
  const cost = goal.nodes.reduce((s, n) => s + n.costCents, 0);
  const failedKey = goal.nodes.find((n) => n.status === "failed")?.key;

  const verb = async (v: "pause" | "resume" | "abandon") => { await api.goalAction(goal.id, v).catch(() => {}); };
  const sendAnswer = async () => {
    if (!goal.awaitingUserAsk || !answer.trim()) return;
    setAskError("");
    try { await api.answerMail(goal.awaitingUserAsk.mailId, answer.trim()); setAnswer(""); }
    catch (err) { setAskError((err as Error).message); }
  };

  return (
    <div>
      <button onClick={() => navigate("goals")} className="label hover:text-fg mb-3">← goals</button>
      <div className="flex items-center gap-3 flex-wrap mb-1">
        <h1 className="text-[20px] text-strong">{goal.title}</h1>
        <Tag tone={toneOfStatus(goal.status)}>{goal.status}</Tag>
        <span className="text-[11px] text-dim">
          {goal.department} · {goal.lead} · replans {goal.replansUsed} · {usd(cost)} · {ts(goal.createdAt)}
        </span>
        {goal.spawnedBy && (
          <button className="text-[11px] text-dim underline underline-offset-2 hover:text-fg"
            onClick={() => navigate(`mail/${goal.spawnedBy!.mailId}`)}>
            spawned by {goal.spawnedBy.from}
          </button>
        )}
        <span className="ml-auto flex gap-2">
          {["planning", "running", "replanning"].includes(goal.status) && <Button onClick={() => verb("pause")}>Pause</Button>}
          {["paused-user", "paused-budget"].includes(goal.status) && <Button variant="primary" onClick={() => verb("resume")}>Resume</Button>}
          {!["done", "abandoned"].includes(goal.status) && <TwoStepButton label="Abandon" onConfirm={() => verb("abandon")} />}
        </span>
      </div>
      <div className="text-[12px] text-dim mb-4">{goal.planSummary}</div>

      {goal.awaitingUserAsk && (
        <div className="border border-accent/40 rounded-lg bg-surface p-4 mb-4 max-w-2xl">
          <SectionLabel>{goal.awaitingUserAsk.from} asks</SectionLabel>
          <div className="whitespace-pre-wrap mb-3">{goal.awaitingUserAsk.question}</div>
          <div className="flex gap-2">
            <input value={answer} onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendAnswer()} placeholder="Your answer resumes the goal…"
              className="flex-1 bg-bg border border-line rounded-md px-3 py-2 outline-none focus:border-dim" />
            <Button variant="primary" onClick={sendAnswer}>Answer</Button>
          </div>
          {askError && <div className="text-[12px] text-err mt-2">{askError}</div>}
        </div>
      )}

      <div className="flex gap-6 flex-col lg:flex-row">
        <div className="min-w-0">
          <MiniDag nodes={goal.nodes} failedKey={failedKey} scale={1} onSelect={setNodeKey} />
        </div>
        {node && (
          <div className="lg:w-96 shrink-0 border border-line rounded-lg bg-surface p-4 h-fit">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-strong">{node.key}</span>
              <Tag tone={toneOfStatus(node.status)}>{node.status}</Tag>
              <span className="text-[11px] text-dim ml-auto">{node.agent} · rounds {node.rounds} · {usd(node.costCents)}</span>
            </div>
            <div className="text-[12px] text-dim whitespace-pre-wrap mb-3">{node.brief}</div>
            {node.error && <pre className="text-[11px] text-err whitespace-pre-wrap mb-3">{node.error}</pre>}
            {node.artifact && <ArtifactPreview goalArtifacts={goal.artifacts} file={node.artifact} />}
            <Button onClick={() => onOpenChat(node.agent, `About node "${node.key}" of goal "${goal.title}": `)}>Discuss ⌘J</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactPreview({ goalArtifacts, file }: {
  goalArtifacts: Array<{ file: string; content: string }>; file: string;
}) {
  const [open, setOpen] = useState(false);
  const art = goalArtifacts.find((a) => a.file === file);
  if (!art) return null;
  return (
    <div className="mb-3">
      <button onClick={() => setOpen((v) => !v)} className="label hover:text-fg">
        {open ? "▾" : "▸"} {file}
      </button>
      {open && <pre className="font-mono text-[11px] whitespace-pre-wrap mt-2 max-h-80 overflow-y-auto border border-line rounded-md p-3 bg-bg">{art.content}</pre>}
    </div>
  );
}
```

- [ ] **Step 4: Run + commit**

Run: `cd ui2 && npx vitest run && npx tsc --noEmit` → green.

```bash
git add ui2/src ui2/test
git commit -m "feat(ui2): Goals — bucketed list with provenance chips, Ember DAG detail + node inspector"
```

---

### Task 8: Staff section — org columns, agent profile, governance sub-tab, department admin menu

**Files:**
- Replace placeholder: `ui2/src/views/Staff.tsx` (org + profile + governance + dept-admin all live here, drill-in by route — mirrors old `Org.tsx`/`Governance.tsx`/`Departments.tsx` data usage)

**Interfaces:**
- Consumes: `api.org/agent/mail/mailUnread/trust/demoteTrust/permissions/proposePermission/packs/setPackEnabled/packFiles/savePackFile/runPack` (Task 3), primitives (Task 4).
- Produces: `Staff({ events, route, onOpenChat })`. Routes: `staff` = org columns; `staff/agents/<name>` = profile; `staff/governance` = governance. Department admin = ⋯ menu on each department column header (spec §6: not a separate section).
- No new pure-logic tests: this section is composition over already-tested hooks/primitives; root suite covers the endpoints. (ui2 tests stay for logic, per spec §12.)

- [ ] **Step 1: Implement Staff.tsx**

```tsx
// ui2/src/views/Staff.tsx — org columns + profile + governance + department admin (spec §6 Staff).
import { useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { useFetch, useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate, type Route } from "../lib/router.js";
import { Button, Dot, Empty, SectionLabel, Tag, toneOfStatus } from "../components/ui.js";
import { TwoStepButton } from "../components/TwoStepButton.js";
import { ts, usdFloat } from "../lib/format.js";

export function Staff({ events, route, onOpenChat }: {
  events: StoredEvent[]; route: Route; onOpenChat: (t: string, s?: string) => void;
}) {
  const sub = route.parts[0];
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="flex gap-3 mb-4 items-center">
        <h1 className="text-[20px] text-strong">Staff</h1>
        <button onClick={() => navigate("staff")}
          className={`label hover:text-fg ${!sub ? "text-strong" : ""}`}>org</button>
        <button onClick={() => navigate("staff/governance")}
          className={`label hover:text-fg ${sub === "governance" ? "text-strong" : ""}`}>governance</button>
      </div>
      {sub === "agents" && route.parts[1]
        ? <Profile name={route.parts[1]} events={events} onOpenChat={onOpenChat} />
        : sub === "governance"
          ? <Governance events={events} />
          : <OrgColumns events={events} />}
    </div>
  );
}

function OrgColumns({ events }: { events: StoredEvent[] }) {
  const { data: org } = useLiveQuery(() => api.org(), events, T.agentsActions);
  const { data: unread } = useLiveQuery(() => api.mailUnread(), events, T.agentMail);
  if (!org) return <Empty>Loading…</Empty>;
  return (
    <div className="flex gap-6 overflow-x-auto items-start">
      {org.map((d) => (
        <div key={d.department} className="min-w-56 border border-line rounded-lg bg-surface p-3">
          <div className="flex items-center mb-2">
            <SectionLabel>{d.department}</SectionLabel>
            <DeptMenu department={d.department} />
          </div>
          <div className="text-[11px] text-dim mb-3">{d.mission}</div>
          {d.agents.map((a) => (
            <button key={a.name} onClick={() => navigate(`staff/agents/${a.name}`)}
              className="w-full text-left rounded-md hover:bg-raised px-2 py-2 flex flex-col gap-0.5 min-h-11">
              <span className="flex items-center gap-2">
                <Dot tone={a.status === "working" ? "agent" : a.status === "waiting" ? "accent" : "dim"} breathing={a.status === "working"} />
                <span className="text-strong">{a.name}</span>
                <span className="text-[10px] text-dim">{a.title}</span>
                <span className="ml-auto flex gap-1 text-[10px]">
                  {a.visibility === "private" && <span title="private">🔒</span>}
                  {a.guarded && <span title="guarded">🛡</span>}
                  {(unread?.byAgent[a.name] ?? 0) > 0 && <Tag tone="accent">{unread!.byAgent[a.name]}</Tag>}
                </span>
              </span>
              {a.currentTask && <span className="text-[11px] text-agent truncate">{a.currentTask}</span>}
              {a.costTodayUsd > 0 && <span className="text-[10px] text-dim">{usdFloat(a.costTodayUsd)} today</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** ⋯ department admin: enable/disable, playbook YAML editor, run playbook (spec §6 — a menu, not a section). */
function DeptMenu({ department }: { department: string }) {
  const [open, setOpen] = useState(false);
  const { data: packs, reload } = useFetch(() => api.packs(), []);
  const pack = packs?.find((p) => p.pillar === department);
  const [editing, setEditing] = useState<{ file: string; yaml: string } | null>(null);
  const [note, setNote] = useState("");
  if (!pack) return null;

  const run = async (playbook: string) => {
    setNote("");
    try {
      const { id } = await api.runPack(pack.pillar, playbook);
      setNote(`started ${id.slice(0, 8)}`);
    } catch (err) { setNote((err as Error).message); }
  };

  return (
    <span className="ml-auto relative">
      <button onClick={() => setOpen((v) => !v)} className="text-dim hover:text-fg px-1">⋯</button>
      {open && (
        <div className="absolute right-0 top-6 z-30 w-72 border border-line rounded-lg bg-raised p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[12px]">{pack.enabled ? "enabled" : "disabled"}</span>
            <TwoStepButton label={pack.enabled ? "Disable" : "Enable"} className="ml-auto"
              onConfirm={() => void api.setPackEnabled(pack.pillar, !pack.enabled).then(() => reload())} />
          </div>
          <SectionLabel>Playbooks</SectionLabel>
          {pack.playbooks.map((pb) => (
            <div key={pb.name} className="flex items-center gap-2 text-[12px]">
              <span className="truncate">{pb.name}</span>
              <Button className="ml-auto" onClick={() => void run(pb.name)}>Run</Button>
            </div>
          ))}
          <SectionLabel>Files</SectionLabel>
          <FileList pillar={pack.pillar} onEdit={setEditing} />
          {note && <div className="text-[11px] text-dim">{note}</div>}
        </div>
      )}
      {editing && (
        <YamlEditor pillar={pack.pillar} file={editing.file} initial={editing.yaml} onClose={() => setEditing(null)} />
      )}
    </span>
  );
}

function FileList({ pillar, onEdit }: { pillar: string; onEdit: (f: { file: string; yaml: string }) => void }) {
  const { data: files } = useFetch(() => api.packFiles(pillar), [pillar]);
  return (
    <>
      {(files ?? []).map((f) => (
        <button key={f.file} onClick={() => onEdit(f)} className="text-left text-[12px] font-mono text-dim hover:text-fg truncate">
          {f.file}
        </button>
      ))}
    </>
  );
}

function YamlEditor({ pillar, file, initial, onClose }: {
  pillar: string; file: string; initial: string; onClose: () => void;
}) {
  const [yaml, setYaml] = useState(initial);
  const [error, setError] = useState("");
  const save = async () => {
    setError("");
    try { await api.savePackFile(pillar, file, yaml); onClose(); }
    catch (err) { setError((err as Error).message); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={onClose}>
      <div className="w-full max-w-3xl border border-line rounded-lg bg-surface p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}>
        <div className="font-mono text-[12px] text-dim">{pillar}/{file}</div>
        <textarea value={yaml} onChange={(e) => setYaml(e.target.value)} spellCheck={false}
          className="font-mono text-[12px] bg-bg border border-line rounded-md p-3 h-96 outline-none focus:border-dim" />
        {error && <div className="text-[12px] text-err">{error}</div>}
        <div className="flex gap-2 justify-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>Save</Button>
        </div>
      </div>
    </div>
  );
}

function Profile({ name, events, onOpenChat }: {
  name: string; events: StoredEvent[]; onOpenChat: (t: string, s?: string) => void;
}) {
  const { data: p, error } = useLiveQuery(() => api.agent(name), events, T.agentsActions, [name]);
  const [note, setNote] = useState("");
  if (error) return <Empty>{error}</Empty>;
  if (!p) return <Empty>Loading…</Empty>;

  const propose = async (tool: string, action: "grant" | "revoke") => {
    setNote("");
    try { await api.proposePermission(name, tool, action); setNote(`${action} of ${tool} queued for approval`); }
    catch (err) { setNote((err as Error).message); }
  };

  return (
    <div className="max-w-3xl">
      <button onClick={() => navigate("staff")} className="label hover:text-fg mb-3">← staff</button>
      <div className="flex items-center gap-3 flex-wrap mb-1">
        <h2 className="text-[20px] text-strong">{p.name}</h2>
        <span className="text-dim">{p.title} · {p.department}</span>
        {p.model && <Tag>{p.model}</Tag>}
        {p.visibility === "private" && <Tag>🔒 private</Tag>}
        {p.guarded && <Tag>🛡 guarded</Tag>}
        <Button className="ml-auto" variant="primary" onClick={() => onOpenChat(p.name)}>Chat ⌘J</Button>
      </div>
      {p.aliases.length > 0 && <div className="text-[11px] text-dim mb-2">aka {p.aliases.join(", ")}</div>}
      <p className="text-fg leading-relaxed mb-5 whitespace-pre-wrap">{p.charter}</p>

      <SectionLabel>Access</SectionLabel>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {p.tools.map((t) => (
          <button key={t.name} title={`${t.source} — click to queue revoke`} onClick={() => void propose(t.name, "revoke")}>
            <Tag tone={t.source === "granted" ? "ok" : "dim"}>{t.name}</Tag>
          </button>
        ))}
        {p.revoked.map((t) => (
          <button key={t.name} title="revoked — click to queue grant" onClick={() => void propose(t.name, "grant")}>
            <Tag tone="err">{t.name}</Tag>
          </button>
        ))}
      </div>
      <GrantBox onGrant={(tool) => void propose(tool, "grant")} />
      {note && <div className="text-[11px] text-accent mb-4">{note}</div>}

      <SectionLabel>Trust — {p.department} action types</SectionLabel>
      <div className="flex flex-wrap gap-1.5 mb-5">
        {p.trust.length === 0 && <span className="text-[12px] text-dim">no tracked action types</span>}
        {p.trust.map((t) => (
          <Tag key={t.actionType} tone={t.state === "autonomous" ? "ok" : t.state === "graduating" ? "agent" : "dim"}>
            {t.actionType} · {t.state} · streak {t.streak}
          </Tag>
        ))}
      </div>

      <SectionLabel>Recent runs</SectionLabel>
      <div className="mb-5">
        {p.recentRuns.slice(0, 10).map((r, i) => (
          <div key={i} className="flex gap-3 text-[12px] py-1 items-center">
            <Dot tone={r.ok ? "ok" : "err"} />
            <span className="text-dim">{ts(r.ts)}</span>
            <span className="truncate">{r.context}</span>
            {r.costUsd != null && <span className="text-dim ml-auto">{usdFloat(r.costUsd)}</span>}
          </div>
        ))}
        {p.recentRuns.length === 0 && <span className="text-[12px] text-dim">none yet</span>}
      </div>

      <SectionLabel>Cost by day</SectionLabel>
      <Sparkline data={p.costByDay} />
    </div>
  );
}

function GrantBox({ onGrant }: { onGrant: (tool: string) => void }) {
  const [tool, setTool] = useState("");
  return (
    <div className="flex gap-2 mb-2">
      <input value={tool} onChange={(e) => setTool(e.target.value)} placeholder="grant a tool (queues approval)…"
        onKeyDown={(e) => { if (e.key === "Enter" && tool.trim()) { onGrant(tool.trim()); setTool(""); } }}
        className="bg-bg border border-line rounded-md px-2 py-1 text-[12px] outline-none focus:border-dim w-64" />
    </div>
  );
}

function Sparkline({ data }: { data: Record<string, number> }) {
  const days = Object.entries(data).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-14);
  const max = Math.max(0.01, ...days.map(([, v]) => v));
  return (
    <div className="flex items-end gap-1 h-12">
      {days.map(([d, v]) => (
        <div key={d} title={`${d} · ${usdFloat(v)}`} className="w-4 bg-line rounded-sm"
          style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />
      ))}
      {days.length === 0 && <span className="text-[12px] text-dim">no spend</span>}
    </div>
  );
}

function Governance({ events }: { events: StoredEvent[] }) {
  const { data: trust } = useLiveQuery(() => api.trust(), events, T.trust);
  const { data: perms } = useLiveQuery(() => api.permissions(), events, T.permissions);
  return (
    <div className="max-w-4xl">
      <SectionLabel>Trust ledger</SectionLabel>
      <table className="w-full text-[12px] mb-6">
        <thead><tr className="label text-left"><th className="py-1">action type</th><th>state</th><th>✓</th><th>✗</th><th>streak</th><th>last rejection</th><th /></tr></thead>
        <tbody>
          {(trust ?? []).map((t) => (
            <tr key={t.actionType} className="border-t border-line">
              <td className="py-1.5">{t.actionType}</td>
              <td><Tag tone={t.state === "autonomous" ? "ok" : t.state === "graduating" ? "agent" : "dim"}>{t.state}</Tag></td>
              <td>{t.approvals}</td><td>{t.rejections}</td><td>{t.streak}</td>
              <td className="text-dim">{t.lastRejection ? ts(t.lastRejection) : "—"}</td>
              <td className="text-right">
                {t.state !== "supervised" && (
                  <TwoStepButton label="Demote" onConfirm={() => void api.demoteTrust(t.actionType)} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <SectionLabel>Permission matrix</SectionLabel>
      {(perms ?? []).map((r) => (
        <div key={r.role} className="mb-4">
          <div className="text-[13px] text-strong mb-1">{r.role} <span className="text-dim text-[11px]">{r.permissionMode}</span></div>
          <div className="flex flex-wrap gap-1.5">
            {r.tools.map((t) => <Tag key={t.name} tone={t.source === "granted" ? "ok" : "dim"}>{t.name}</Tag>)}
            {r.revoked.map((t) => <Tag key={t.name} tone="err">{t.name}</Tag>)}
          </div>
          {r.denials.length > 0 && (
            <div className="text-[11px] text-dim mt-1">
              denials: {r.denials.map((d) => `${d.tool}×${d.count}`).join(" · ")}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Run + commit**

Run: `cd ui2 && npx vitest run && npx tsc --noEmit` → green.

```bash
git add ui2/src
git commit -m "feat(ui2): Staff — org columns with presence, agent profile + access panel, governance, dept admin menu"
```

---

### Task 9: Mail section — threads, thread detail, compose

**Files:**
- Replace placeholder: `ui2/src/views/Mail.tsx`

**Interfaces:**
- Consumes: `api.mailMine/mailThreadView/markMailRead/answerMail/composeMail/org` (Task 3); `MailThreadCanvas` is NOT reused here — Mail needs mark-read-on-open and ask-answer routing, so it has its own thread view (structural reuse of old `ui/src/views/Mail.tsx` in Ember dress).
- Produces: `Mail({ events, route })`. Routes: `mail` = thread list + compose; `mail/<threadId>` = detail.

- [ ] **Step 1: Implement Mail.tsx**

```tsx
// ui2/src/views/Mail.tsx — your correspondence: threads, detail bubbles, compose (spec §6 Mail).
import { useEffect, useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { useFetch, useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate, type Route } from "../lib/router.js";
import { Button, Empty, SectionLabel, Tag, toneOfStatus } from "../components/ui.js";
import { ts } from "../lib/format.js";

export function Mail({ events, route }: { events: StoredEvent[]; route: Route }) {
  const threadId = route.parts[0];
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      {threadId ? <Thread threadId={threadId} events={events} /> : <Threads events={events} />}
    </div>
  );
}

function Threads({ events }: { events: StoredEvent[] }) {
  const { data: mine } = useLiveQuery(() => api.mailMine(), events, T.agentMail);
  const [composing, setComposing] = useState(false);
  if (!mine) return <Empty>Loading…</Empty>;
  return (
    <div className="max-w-3xl">
      <div className="flex items-center mb-4">
        <h1 className="text-[20px] text-strong">Mail</h1>
        <Button variant="primary" className="ml-auto" onClick={() => setComposing(true)}>Compose</Button>
      </div>
      {composing && <Compose onDone={() => setComposing(false)} />}
      {mine.threads.map((t) => (
        <button key={t.threadId} onClick={() => navigate(`mail/${t.threadId}`)}
          className="w-full text-left px-3 py-2.5 rounded-md hover:bg-raised flex items-baseline gap-2 min-h-11">
          <span className={t.unread > 0 ? "text-accent font-medium" : "text-strong"}>{t.lastFrom}</span>
          {t.pendingAsk > 0 && <span title="waiting on your answer">🙋</span>}
          {t.refused > 0 && <span title="refused">⚠</span>}
          <span className="text-dim truncate">{t.lastBody}</span>
          <span className="text-[10px] text-dim ml-auto shrink-0">{ts(t.lastTs)}</span>
        </button>
      ))}
      {mine.threads.length === 0 && <Empty>No mail yet.</Empty>}
    </div>
  );
}

function Thread({ threadId, events }: { threadId: string; events: StoredEvent[] }) {
  const { data: thread, reload } = useLiveQuery(() => api.mailThreadView(threadId), events, T.agentMail, [threadId]);
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");

  // Opening a thread marks your unread mail in it as read (spec §5 queue parity).
  useEffect(() => {
    if (!thread) return;
    const unread = thread.filter((m) => m.to === "user" && m.status === "unread");
    if (unread.length > 0) void Promise.all(unread.map((m) => api.markMailRead(m.id))).then(reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.length]);

  if (!thread) return <Empty>Loading…</Empty>;
  const last = thread[thread.length - 1];
  const pendingAsk = thread.find((m) => m.kind === "request" && m.to === "user" && m.status === "awaiting-human");

  const send = async () => {
    if (!reply.trim()) return;
    setError("");
    try {
      if (pendingAsk) {
        await api.answerMail(pendingAsk.id, reply.trim()); // answering resumes the parked goal
      } else {
        const res = await api.composeMail({ to: last.from === "user" ? last.to : last.from, body: reply.trim(), threadId, inReplyTo: last.id });
        if ("refusal" in res && !res.ok) { setError(res.refusal); return; }
      }
      setReply("");
      reload();
    } catch (err) { setError((err as Error).message); }
  };

  return (
    <div className="max-w-2xl flex flex-col gap-3">
      <button onClick={() => navigate("mail")} className="label hover:text-fg text-left">← mail</button>
      {thread.map((m) => (
        <div key={m.id} className={m.from === "user" ? "self-end max-w-[85%]" : "self-start max-w-[85%]"}>
          <div className="label mb-1 flex gap-2 items-center">
            {m.from} → {m.to}
            <Tag tone={toneOfStatus(m.status)}>{m.kind}</Tag>
            {m.goalId && (
              <button onClick={() => navigate(`goals/${m.goalId}`)} className="underline underline-offset-2 hover:text-fg">goal</button>
            )}
            <span className="ml-auto">{ts(m.createdAt)}</span>
          </div>
          <div className={`border rounded-lg px-3 py-2 whitespace-pre-wrap leading-relaxed bg-surface ${
            m.status === "refused" ? "border-err/40" : m.from === "user" ? "border-agent/40" : "border-line"
          }`}>
            {m.body}
            {m.error && <div className="text-[11px] text-err mt-1">{m.error}</div>}
          </div>
        </div>
      ))}
      <div className="flex gap-2 mt-2">
        <input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={pendingAsk ? "Your answer resumes the goal…" : "Reply…"}
          className="flex-1 bg-bg border border-line rounded-md px-3 py-2 outline-none focus:border-dim" />
        <Button variant="primary" onClick={send}>{pendingAsk ? "Answer" : "Reply"}</Button>
      </div>
      {error && <div className="text-[12px] text-err">{error}</div>}
    </div>
  );
}

function Compose({ onDone }: { onDone: () => void }) {
  const { data: org } = useFetch(() => api.org(), []);
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const agents = (org ?? []).flatMap((d) => d.agents.map((a) => ({ name: a.name, private: a.visibility === "private" })));

  const send = async () => {
    if (!to || !body.trim()) return;
    setError("");
    try {
      const res = await api.composeMail({ to, body: body.trim() });
      if ("refusal" in res && !res.ok) { setError(res.refusal); return; }
      onDone();
    } catch (err) { setError((err as Error).message); }
  };

  return (
    <div className="border border-line rounded-lg bg-surface p-4 mb-4 flex flex-col gap-2">
      <SectionLabel>New mail</SectionLabel>
      <select value={to} onChange={(e) => setTo(e.target.value)}
        className="bg-bg border border-line rounded-md px-2 py-1.5 text-[12px] outline-none w-64">
        <option value="">to…</option>
        {agents.map((a) => <option key={a.name} value={a.name}>{a.name}{a.private ? " (private)" : ""}</option>)}
      </select>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message…"
        className="bg-bg border border-line rounded-md px-3 py-2 h-28 outline-none focus:border-dim" />
      {error && <div className="text-[12px] text-err">{error}</div>}
      <div className="flex gap-2 justify-end">
        <Button onClick={onDone}>Cancel</Button>
        <Button variant="primary" onClick={send}>Send</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run + commit**

Run: `cd ui2 && npx vitest run && npx tsc --noEmit` → green.

```bash
git add ui2/src
git commit -m "feat(ui2): Mail — threads with ask/refused badges, mark-read-on-open detail, compose"
```

---

### Task 10: System section — events tail, costs, config editor with restart polling, health

**Files:**
- Replace placeholder: `ui2/src/views/System.tsx`

**Interfaces:**
- Consumes: `api.events/costs/goals/config/saveConfig/restart/state/health` (Task 3), `useEvents` buffer from App (prop `events`).
- Produces: `System({ events, route })`. Routes: `system` = health (default), `system/events`, `system/costs`, `system/config`.

- [ ] **Step 1: Implement System.tsx**

```tsx
// ui2/src/views/System.tsx — events tail · costs · config · health (spec §6 System).
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { useFetch, useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate, type Route } from "../lib/router.js";
import { Button, Dot, Empty, SectionLabel, Tag } from "../components/ui.js";
import { tsTime, usdFloat, usd } from "../lib/format.js";

const TABS = ["health", "events", "costs", "config"] as const;

export function System({ events, route }: { events: StoredEvent[]; route: Route }) {
  const tab = (TABS as readonly string[]).includes(route.parts[0]) ? route.parts[0] : "health";
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col">
      <div className="flex gap-3 mb-4 items-center shrink-0">
        <h1 className="text-[20px] text-strong">System</h1>
        {TABS.map((t) => (
          <button key={t} onClick={() => navigate(t === "health" ? "system" : `system/${t}`)}
            className={`label hover:text-fg ${tab === t ? "text-strong" : ""}`}>{t}</button>
        ))}
      </div>
      {tab === "health" && <Health events={events} />}
      {tab === "events" && <EventsTail live={events} />}
      {tab === "costs" && <Costs events={events} />}
      {tab === "config" && <ConfigEditor />}
    </div>
  );
}

function Health({ events }: { events: StoredEvent[] }) {
  const { data: h, reload } = useLiveQuery(() => api.health(), events, T.attention);
  if (!h) return <Empty>Loading…</Empty>;
  const hours = Math.floor(h.uptimeMs / 3_600_000);
  const mins = Math.floor((h.uptimeMs % 3_600_000) / 60_000);
  return (
    <div className="max-w-xl flex flex-col gap-4">
      <div className="border border-line rounded-lg bg-surface p-4 grid grid-cols-2 gap-3 text-[12px]">
        <span className="text-dim">Daemon uptime</span><span>{hours ? `${hours}h ${mins}m` : `${mins}m`}</span>
        <span className="text-dim">Voice</span><span>{h.voice ? "available" : "off"}</span>
        <span className="text-dim">SSE clients</span><span>{h.sseClients}</span>
        <span className="text-dim">DB size</span><span>{(h.dbBytes / 1_048_576).toFixed(1)} MB</span>
      </div>
      <div>
        <SectionLabel>Senses</SectionLabel>
        {h.senses.length === 0 && <Empty>No senses configured.</Empty>}
        {h.senses.map((s) => (
          <div key={s.name} className="flex items-center gap-2 py-1 text-[12px]">
            <Dot tone={s.ok ? "ok" : "err"} />
            <span>{s.name}</span>
            {!s.ok && <span className="text-err">{s.reason ?? "degraded"} — re-auth: npx tsx scripts/google-auth.ts</span>}
          </div>
        ))}
      </div>
      <Button onClick={reload} className="w-fit">Refresh</Button>
    </div>
  );
}

const PRESETS: Record<string, string[]> = {
  all: [],
  routing: ["route.", "triage."],
  goals: ["goal.", "node."],
  agents: ["agent."],
  actions: ["action.", "trust.", "permission.", "tool.denied"],
  chat: ["chat."],
  mail: ["mail."],
};

function EventsTail({ live }: { live: StoredEvent[] }) {
  const { data: history } = useFetch(() => api.events(), []);
  const [preset, setPreset] = useState("all");
  const [q, setQ] = useState("");
  const [paused, setPaused] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const frozen = useRef<StoredEvent[]>([]);

  const merged = useMemo(() => {
    const seen = new Set<number>();
    return [...(history ?? []), ...live].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  }, [history, live]);
  if (paused && frozen.current.length === 0) frozen.current = merged;
  if (!paused) frozen.current = [];
  const shown = (paused ? frozen.current : merged).filter((e) => {
    const pats = PRESETS[preset];
    const typeOk = pats.length === 0 || pats.some((p) => (p.endsWith(".") ? e.event.type.startsWith(p) : e.event.type === p));
    const text = JSON.stringify(e.event).toLowerCase();
    return typeOk && (!q || text.includes(q.toLowerCase()));
  }).slice(-500);

  useEffect(() => {
    if (!paused) bottom.current?.scrollIntoView();
  }, [shown.length, paused]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex gap-2 mb-2 items-center shrink-0 flex-wrap">
        {Object.keys(PRESETS).map((p) => (
          <button key={p} onClick={() => setPreset(p)} className={`label hover:text-fg ${preset === p ? "text-strong" : ""}`}>{p}</button>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…"
          className="bg-bg border border-line rounded-md px-2 py-1 text-[12px] outline-none focus:border-dim w-48" />
        <Button className="ml-auto" onClick={() => setPaused((v) => !v)}>{paused ? "Resume" : "Pause"}</Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto font-mono text-[11px] text-dim border border-line rounded-lg bg-bg p-2">
        {shown.map((e) => (
          <div key={e.id} className="whitespace-nowrap">
            <span className="text-line">{tsTime(e.ts)}</span>{" "}
            <span className="text-fg">{e.event.type}</span>{" "}
            {JSON.stringify({ ...e.event, type: undefined }).slice(0, 180)}
          </div>
        ))}
        <div ref={bottom} />
      </div>
    </div>
  );
}

function Costs({ events }: { events: StoredEvent[] }) {
  const { data: costs } = useLiveQuery(() => api.costs(), events, T.costs);
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  if (!costs) return <Empty>Loading…</Empty>;
  const days = Object.entries(costs.byDay).sort(([a], [b]) => (a < b ? -1 : 1));
  const today = days[days.length - 1]?.[1] ?? 0;
  const week = days.slice(-7).reduce((s, [, v]) => s + v, 0);
  const month = days.reduce((s, [, v]) => s + v, 0); // /api/costs serves a 14-day window today; label as "14d"
  const agents = Object.entries(costs.byAgent).sort(([, a], [, b]) => b - a);
  const maxAgent = Math.max(0.01, ...agents.map(([, v]) => v));
  const maxDay = Math.max(0.01, ...days.map(([, v]) => v));
  const topGoals = (goals ?? [])
    .map((g) => ({ g, cents: g.nodes.reduce((s, n) => s + n.costCents, 0) }))
    .filter((x) => x.cents > 0)
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 5);

  return (
    <div className="max-w-3xl flex flex-col gap-6">
      <div className="flex gap-6 text-[13px]">
        <span><span className="text-dim">today </span><span className="text-strong">{usdFloat(today)}</span></span>
        <span><span className="text-dim">7d </span><span className="text-strong">{usdFloat(week)}</span></span>
        <span><span className="text-dim">14d </span><span className="text-strong">{usdFloat(month)}</span></span>
      </div>
      <div>
        <SectionLabel>Per agent</SectionLabel>
        {agents.map(([name, v]) => (
          <div key={name} className="flex items-center gap-2 py-0.5 text-[12px]">
            <span className="w-24 text-dim truncate">{name}</span>
            <div className="flex-1 h-2 bg-raised rounded-sm"><div className="h-full bg-line rounded-sm" style={{ width: `${(v / maxAgent) * 100}%` }} /></div>
            <span className="w-14 text-right">{usdFloat(v)}</span>
          </div>
        ))}
      </div>
      <div>
        <SectionLabel>Last 14 days</SectionLabel>
        <div className="flex items-end gap-1 h-24">
          {days.map(([d, v]) => (
            <div key={d} title={`${d} · ${usdFloat(v)}`} className="flex-1 bg-line rounded-sm" style={{ height: `${Math.max(3, (v / maxDay) * 100)}%` }} />
          ))}
        </div>
      </div>
      <div>
        <SectionLabel>Top goals by spend</SectionLabel>
        {topGoals.map(({ g, cents }) => (
          <button key={g.id} onClick={() => navigate(`goals/${g.slug}`)}
            className="w-full text-left flex gap-2 py-1 text-[12px] hover:text-strong">
            <span className="truncate">{g.title}</span>
            <span className="text-dim ml-auto shrink-0">{usd(cents)}</span>
          </button>
        ))}
        {topGoals.length === 0 && <Empty>No goal spend yet.</Empty>}
      </div>
    </div>
  );
}

const CONFIG_GROUPS: Record<string, string[]> = {
  Channels: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "AIOS_CHAT_BINDINGS"],
  Models: ["CLAUDE_CODE_OAUTH_TOKEN", "AIOS_MODERATOR_MODEL", "AIOS_SPECIALIST_MODEL"],
  Anchors: ["AIOS_FINANCE_COMPANY", "AIOS_FINANCE_MEMBERS", "AIOS_PROJECTS_ROOT"],
  Budgets: ["AIOS_MAX_CONCURRENT_JOBS", "AIOS_TRUST_SEED", "AIOS_ALWAYS_SUPERVISED"],
  Senses: ["AIOS_GMAIL_POLL_SECONDS", "AIOS_CALENDAR_POLL_SECONDS", "AIOS_MEETING_PING_MINUTES", "AIOS_GMAIL_SKIP_CATEGORIES"],
  Security: ["AIOS_UI_TOKEN"],
};

function ConfigEditor() {
  const { data: cfg, reload } = useFetch(() => api.config(), []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [restarting, setRestarting] = useState(false);
  if (!cfg) return <Empty>Loading…</Empty>;
  const byKey = new Map(cfg.map((c) => [c.key, c]));

  const save = async (key: string) => {
    setNote("");
    try {
      const { note: n } = await api.saveConfig(key, drafts[key] ?? "");
      setNote(n || `${key} saved — restart to apply`);
      setDrafts((d) => { const { [key]: _, ...rest } = d; return rest; });
      reload();
    } catch (err) { setNote((err as Error).message); }
  };

  const restart = async () => {
    setRestarting(true);
    await api.restart().catch(() => {}); // the daemon exits mid-response
    // Poll /api/state for real readiness — no fake timers (spec §4).
    const poll = async () => {
      try { await api.state(); setRestarting(false); reload(); }
      catch { setTimeout(poll, 2000); }
    };
    setTimeout(poll, 3000);
  };

  return (
    <div className="max-w-2xl">
      {Object.entries(CONFIG_GROUPS).map(([group, keys]) => {
        const rows = keys.map((k) => byKey.get(k)).filter((c): c is NonNullable<typeof c> => !!c);
        if (rows.length === 0) return null;
        return (
          <div key={group} className="mb-5">
            <SectionLabel>{group}</SectionLabel>
            {rows.map((c) => (
              <div key={c.key} className="flex items-center gap-2 py-1">
                <span className="w-64 font-mono text-[11px] text-dim truncate">{c.key}</span>
                <input
                  type={c.secret ? "password" : "text"}
                  value={drafts[c.key] ?? c.value}
                  placeholder={c.set ? (c.secret ? "••••••" : "") : "unset"}
                  onChange={(e) => setDrafts((d) => ({ ...d, [c.key]: e.target.value }))}
                  className="flex-1 bg-bg border border-line rounded-md px-2 py-1 text-[12px] outline-none focus:border-dim"
                />
                {drafts[c.key] !== undefined && <Button variant="primary" onClick={() => void save(c.key)}>Save</Button>}
              </div>
            ))}
          </div>
        );
      })}
      {/* Any UI-editable key the groups above miss still shows up (server owns the list). */}
      {cfg.filter((c) => !Object.values(CONFIG_GROUPS).flat().includes(c.key)).map((c) => (
        <div key={c.key} className="flex items-center gap-2 py-1">
          <span className="w-64 font-mono text-[11px] text-dim truncate">{c.key}</span>
          <input type={c.secret ? "password" : "text"} value={drafts[c.key] ?? c.value}
            onChange={(e) => setDrafts((d) => ({ ...d, [c.key]: e.target.value }))}
            className="flex-1 bg-bg border border-line rounded-md px-2 py-1 text-[12px] outline-none focus:border-dim" />
          {drafts[c.key] !== undefined && <Button variant="primary" onClick={() => void save(c.key)}>Save</Button>}
        </div>
      ))}
      <div className="flex items-center gap-3 mt-4">
        <Button variant="danger" disabled={restarting} onClick={restart}>{restarting ? "Restarting…" : "Restart daemon"}</Button>
        {note && <span className="text-[12px] text-dim">{note}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run + commit**

Run: `cd ui2 && npx vitest run && npx tsc --noEmit` → green.

```bash
git add ui2/src
git commit -m "feat(ui2): System — filtered event tail, cost charts + top goal spenders, grouped config with restart polling, health"
```

---

### Task 11: Mobile — bottom tabs, full-screen detail push, touch targets

**Files:**
- Create: `ui2/src/components/BottomTabs.tsx` (replaces the Task 4 `null` placeholder)
- Modify: `ui2/src/views/Home.tsx` (phone: selected item → full-screen canvas with back), `ui2/src/components/ChatDrawer.tsx` (tall sheet on phone)

**Interfaces:**
- Consumes: `SECTIONS`, `href` (Task 3); `Canvas` (Task 6).
- Produces: `BottomTabs({ section, needsYou })` — `<nav>` fixed bottom, `md:hidden`, 5 tabs ≥44px tall, Home badge. Main content containers already use `flex` layouts; add `pb-14 md:pb-0` on the App root's section wrapper so content clears the tab bar.

- [ ] **Step 1: BottomTabs**

```tsx
// ui2/src/components/BottomTabs.tsx — phone nav: the 5 sections as bottom tabs (spec §7).
import { SECTIONS, href } from "../lib/router.js";

const ICONS: Record<string, string> = { home: "◉", goals: "◎", staff: "▤", mail: "✉", system: "⚙" };

export function BottomTabs({ section, needsYou }: { section: string; needsYou: number }) {
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 h-14 bg-surface border-t border-line flex"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      {SECTIONS.map((s) => (
        <a key={s} href={href(s)}
          className={`flex-1 flex flex-col items-center justify-center gap-0.5 min-h-11 ${
            section === s ? "text-strong" : "text-dim"
          }`}>
          <span className="relative text-[15px]">
            {ICONS[s]}
            {s === "home" && needsYou > 0 && (
              <span className="absolute -top-1 -right-3 text-[9px] text-bg bg-accent rounded-full px-1">{needsYou}</span>
            )}
          </span>
          <span className="text-[9px] uppercase tracking-wider">{s}</span>
        </a>
      ))}
    </nav>
  );
}
```

In `App.tsx`, wrap the five section divs' parent: change the root's inner container to include `pb-14 md:pb-0` (add the classes to each `show(s)` string: `flex-1 min-h-0 flex flex-col pb-14 md:pb-0`).

- [ ] **Step 2: Home phone detail push**

In `ui2/src/views/Home.tsx`, replace the `md:hidden` queue block with a queue/detail switch — when `selected != null` on phone, render the canvas full-screen with a back row:

```tsx
        <div className="flex-1 min-h-0 md:hidden flex flex-col py-2">
          {selected ? (
            <div className="flex-1 min-h-0 overflow-y-auto px-3">
              <button onClick={() => setSelected(null)} className="label hover:text-fg mb-3">← queue</button>
              <Canvas item={selected} events={events} onAct={act} onOpenChat={onOpenChat} onDone={() => setSelected(null)} />
            </div>
          ) : (
            <Queue groups={groups} selected={selected} onSelect={setSelected} onAct={act} rowErrors={rowErrors} busy={busy} />
          )}
        </div>
```

(No idle org-pulse on phone — spec §7; when nothing is selected the queue itself is the screen.)

- [ ] **Step 3: Chat sheet tall on phone**

In `ChatDrawer.tsx`, pass `tall` on small screens via CSS instead of JS: change `Sheet`'s height classes to `h-[85vh] md:h-[min(480px,70vh)]` when `tall` is undefined — simplest: in `Sheet.tsx` replace the ternary with:

```tsx
        ${tall ? "h-[85vh]" : "h-[85vh] md:h-[min(480px,70vh)]"}
```

- [ ] **Step 4: Touch audit**

Verify every interactive row/button in Queue, Goals list, Staff cards, Mail threads, BottomTabs has `min-h-11` (44px) — Tasks 5-9 already set `min-h-11` on rows; add it anywhere missed. DAG containers are `overflow-x-auto` (MiniDag) — pinch/pan works as native scroll.

- [ ] **Step 5: Run + visual check + commit**

Run: `cd ui2 && npx vitest run && npx tsc --noEmit` → green.
Run: `cd ui2 && npm run dev` + browser-harness at 390×844 to eyeball the queue-first stack and tabs (screenshot).

```bash
git add ui2/src
git commit -m "feat(ui2): mobile — bottom tabs, queue-first home with full-screen detail push, 44px targets"
```

---

### Task 12: Merge, cutover via AIOS_UI_DIST, deploy + live smoke

**Files:**
- Modify: `.env` (add `AIOS_UI_DIST=ui2/dist`)
- No source changes — this task is verification + deployment.

- [ ] **Step 1: Final suites in the worktree**

Run: `npx vitest run && npx tsc --noEmit && cd ui2 && npx vitest run && npx tsc --noEmit && npm run build`
Expected: root green (1046+~10 new), ui2 green (~15 tests), `ui2/dist/` fresh.

- [ ] **Step 2: Merge (superpowers:finishing-a-development-branch)**

```bash
cd /Users/ihabbishara/projects/AIOS
git checkout main && git merge --ff-only ember-cockpit
git worktree remove .worktrees/ember-cockpit
npx vitest run && npx tsc --noEmit   # re-verify on main, outside the worktree
```

- [ ] **Step 3: Build + flip the flag + deploy**

```bash
cd ui2 && npm install && npm run build && cd ..
grep -q '^AIOS_UI_DIST=' .env || echo 'AIOS_UI_DIST=ui2/dist' >> .env
npm run build
launchctl kickstart -k gui/$(id -u)/com.ihab.aios
```

Web comes up ~65s after start (slack init). Old `ui/` untouched — rollback = delete the `AIOS_UI_DIST` line + kickstart.

- [ ] **Step 4: Live browser smoke (existing project policy)**

Via browser-harness (`new_tab("http://localhost:4280")`, token from `.env` `AIOS_UI_TOKEN`):
1. Token gate accepts the token; Ember shell renders; connection dot green.
2. Home: queue shows real pending items or "Nothing needs you." + org pulse with 15 agents in dept columns.
3. Create an echo goal via chat (⌘J → hermes: "run an echo test goal") → watch goal appear in org pulse / Goals; open the DAG.
4. If an approval exists (or seed one: propose a `test.echo` action via sqlite/gate), approve it inline → row collapses; verify in System/events `action.resolved`.
5. Mail: open a thread, unread clears (badge drops).
6. System: health shows senses (google:personal degraded expected until re-auth), costs render, events tail live.
7. Resize to 390px: bottom tabs, queue-first, detail push works.
8. Screenshot each section for the user.

- [ ] **Step 5: Commit the deploy note + push**

```bash
git add docs/superpowers/plans/2026-07-13-ember-cockpit-ui2.md
git commit -m "docs: ember cockpit plan executed — ui2 live behind AIOS_UI_DIST"
git push
```

(`.env` is not committed. `ui/` deletion happens one release later, per spec §10 — NOT in this plan.)

## Self-review notes (already applied)

1. **Spec coverage check:** §3 tokens/typography/motion → Task 2; §4 shell/keyboard/chat/connection → Task 4; §5 queue model+canvas → Tasks 1/5/6; §6 Goals/Staff/Mail/System → Tasks 7-10; §7 mobile → Task 11; §8 stack/data layer → Tasks 2-3; §9 server → Tasks 1-2; §10 cutover → Task 12; §11 error handling → TokenGate (T4), optimistic rollback + inline errors (T5), restart polling (T10), reduced-motion (T2); §12 testing → ui2 vitest (queue/preview/buckets/router/topics/dag-layout/shell/queue-render), root attention tests, live smoke (T12).
2. **Known simplifications (intentional):** reject-with-reason bypasses the optimistic path (Task 6 note); Costs "month" is the 14-day window `/api/costs` serves (labeled 14d); swipe-revealed row actions dropped — inline buttons are always visible on phone rows, which satisfies the parity requirement without a gesture layer (revisit only if rows get cramped).
3. **Type consistency:** `onOpenChat(target, seed?)` is uniform across Home/Goals/Staff/Canvas/palette/drawer; `AttentionItem.ref` keys are produced in Task 1 and consumed with the same names in Tasks 5-6 (`actionId`, `mailId`, `threadId`, `goalId`, `slug`, `status`, `sense`, plus client-only `brief`); `toneOfStatus` defined once (Task 4) and imported everywhere; `Route.section` (not `zone`) throughout ui2.
4. **Placeholder scan:** the only "placeholder" components are explicitly scheduled (Task 4 creates section stubs that Tasks 5-10 replace; Task 5 creates the canvas stub Task 6 replaces) — each stub's full code is given where it's created.
