# Mission Control 2.0 — Org-First UI (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mission Control answer "who works here, who is doing what right now, and why did they get the job?" — org home with live agent cards, agent profile pages, chat promoted with a routing trail, and a filterable route.decision feed.

**Architecture:** Two pure view builders in `src/web/org-view.ts` (unit-tested like `packs-view.ts`) feed two new read-only endpoints (`GET /api/org`, `GET /api/agents/<name>`) wired into the existing token-gated `server.ts`. The React app gains an Org home tab (default), a drill-in agent profile, a controlled chat target lifted to `App`, and a routing-trail tab; the packs tab is relabeled "departments". Live status derives from `agent.start`/`agent.end` events plus pending actions; no new event types, no new write endpoints, no schema changes.

**Tech Stack:** Node HTTP (existing `server.ts`), node:sqlite via existing `Store`, React 19 + Tailwind 4 (existing `ui/`), vitest for backend tests.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-02-agent-registry-legibility-design.md` §4. Spec §3 uses pre-rename names — the live registry uses mythic names (hermes, athena, vulcan, argus, themis, atlas, odin, clio, janus, venus, minos, midas, juno, jasmine, halalo). Use mythic names everywhere; aliases keep working.
- No new npm dependencies (backend or ui). node:sqlite only (no better-sqlite3, no FTS5).
- All new endpoints go inside the existing `/api/` token-auth branch of `startWebServer` — behind `AIOS_UI_TOKEN`. Read-only: no new write endpoints.
- Do not create new files via pack file-edit endpoints; `resolvePackFilePath` 404s unknown files by design — leave it.
- UI views stay mounted (`hidden`, not unmounted) — preserve the existing App.tsx pattern.
- Backend test pattern: pure view-builder unit tests with tmp-dir registry fixtures (mirror `test/packs-view.test.ts`). No HTTP-server spin-up tests.
- UI has no test runner; UI verification is `cd ui && npx tsc --noEmit && npm run build`.
- Suite baseline before this plan: 731 pass + 1 skip; `npx tsc --noEmit` and `npm run build` clean. Keep it that way after every task.
- Worktree caveat: EnterWorktree branches from origin/main. main == origin/main == 80fbcbc at plan time; if local-only commits exist at execution time, rebase the worktree branch onto local main first.
- Deploy after merge: `npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`.

## File Structure

- Create: `src/web/org-view.ts` — `buildOrgView` + `buildAgentProfile` (pure, registry+store+bus in, JSON out).
- Create: `test/org-view.test.ts` — fixture-driven unit tests for both builders.
- Modify: `src/web/server.ts` — wire `GET /api/org`, `GET /api/agents/<name>`.
- Modify: `ui/src/api.ts` — `OrgAgentCard`, `OrgDepartmentView`, `AgentProfileInfo` types; `api.org()`, `api.agent()`, `api.events()`.
- Create: `ui/src/views/Org.tsx` — org home (dept columns, agent cards, drill-in `AgentProfile`).
- Create: `ui/src/views/RoutingTrail.tsx` — filterable route.decision feed.
- Modify: `ui/src/views/Chat.tsx` — controlled target props, hermes-first picker, inline routing trail.
- Modify: `ui/src/App.tsx` — tabs `org` (default) + `routing` + `departments` relabel, remove `agents` tab, lift chat target.
- Delete: `ui/src/views/Agents.tsx` — superseded by the Org home (same data, better grouped).

---

### Task 1: `buildOrgView` — departments + live agent status + cost today

**Files:**
- Create: `src/web/org-view.ts`
- Test: `test/org-view.test.ts`

**Interfaces:**
- Consumes: `LoadedRegistry` (`src/agents/registry/loader.ts`), `Store.listActions(status?)` (`src/store/db.ts`), `EventBus.history(sinceId, limit)` (`src/events.ts`).
- Produces: `buildOrgView(registry: LoadedRegistry, store: Store, bus: EventBus, today?: string): OrgDepartmentView[]` where `OrgDepartmentView = { department: string; mission: string; lead: string | null; memoDomain: string; sandbox: boolean; actions: string[]; agents: OrgAgentCard[] }` and `OrgAgentCard = { name: string; title: string; charter: string; visibility: "shared" | "private"; guarded: boolean; status: "idle" | "working" | "waiting"; currentTask: string | null; costTodayUsd: number }`. Task 3 wires this to `GET /api/org`; Task 4 mirrors the types client-side.

Status semantics (the one design decision in this task):
- An agent is **working** when the event history holds an `agent.start` without a matching `agent.end` (agent names canonicalized through `registry.agentOf` — the router emits alias names like `developer` on mention paths).
- A working agent is **waiting** when a pending action's origin (`chat:<origin_channel>:<origin_chat_id>`) equals its live run context. Job-context runs (`job:slug/stage`) never match — acceptable: job approvals surface on the Approvals tab.
- Otherwise **idle**. `costTodayUsd` sums `agent.end.costUsd` for events whose `ts` date equals `today` (injectable for tests, defaults to the current date).

- [ ] **Step 1: Write the failing test**

Create `test/org-view.test.ts`:

```typescript
// test/org-view.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildOrgView } from "../src/web/org-view.js";

/** Minimal two-department registry: engineering (vulcan, alias developer) + finance (midas, private). */
export function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "org-"));
  const agentsDir = join(root, "agents");
  const playbooksDir = join(root, "playbooks");
  const eng = join(agentsDir, "engineering");
  const fin = join(agentsDir, "finance");
  mkdirSync(eng, { recursive: true });
  mkdirSync(fin, { recursive: true });
  mkdirSync(playbooksDir, { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    `department: engineering\nmission: Build software safely.\nlead: athena\nmemoDomain: code\nsandbox: true\nactions: [vault.write]\nplaybooks: []\n`);
  writeFileSync(join(eng, "vulcan.yaml"),
    `name: vulcan\ntitle: Senior Engineer\ndepartment: engineering\ncharter: Owns implementing code changes.\npersona: Terse.\nprompt: You are vulcan.\ntools: [Read, Edit, Write]\npermissionMode: bypassPermissions\nmaxTurns: 80\naliases: [developer]\n`);
  writeFileSync(join(fin, "department.yaml"),
    `department: finance\nmission: Money visibility.\nmemoDomain: money\nactions: []\nplaybooks: []\nprivateMemo: true\n`);
  writeFileSync(join(fin, "midas.yaml"),
    `name: midas\ntitle: CFO\ndepartment: finance\ncharter: Watches the money.\npersona: Discreet.\nprompt: You are the CFO.\ntools: []\nmaxTurns: 20\nvisibility: private\naliases: [cfo]\n`);
  return loadRegistry(agentsDir, playbooksDir);
}

function pendingAction(channel: string, chatId: string) {
  return {
    id: "act-1", type: "vault.write", payload: "{}", preview: "write a note",
    status: "pending" as const, origin_channel: channel, origin_chat_id: chatId,
    trust_state: "supervised", verdict_by: null, reject_reason: null, result: null,
    created_at: new Date().toISOString(), resolved_at: null,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function harness() {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  return { store, bus, registry: fixtureRegistry() };
}

describe("buildOrgView", () => {
  it("lists departments with their agents, idle by default", () => {
    const { store, bus, registry } = harness();
    const org = buildOrgView(registry, store, bus);
    const eng = org.find((d) => d.department === "engineering")!;
    expect(eng.mission).toBe("Build software safely.");
    expect(eng.lead).toBe("athena");
    expect(eng.agents.map((a) => a.name)).toEqual(["vulcan"]);
    expect(eng.agents[0]).toMatchObject({
      title: "Senior Engineer", status: "idle", currentTask: null, costTodayUsd: 0,
      visibility: "shared", guarded: false,
    });
    const fin = org.find((d) => d.department === "finance")!;
    expect(fin.agents[0]).toMatchObject({ name: "midas", visibility: "private" });
  });

  it("agent.start marks working — alias names canonicalize", () => {
    const { store, bus, registry } = harness();
    bus.emit({ type: "agent.start", agent: "developer", context: "chat:telegram:42" });
    const eng = buildOrgView(registry, store, bus).find((d) => d.department === "engineering")!;
    expect(eng.agents[0].status).toBe("working");
    expect(eng.agents[0].currentTask).toBe("chat:telegram:42");
  });

  it("working + pending action from the same chat origin = waiting", () => {
    const { store, bus, registry } = harness();
    bus.emit({ type: "agent.start", agent: "vulcan", context: "chat:telegram:42" });
    store.insertAction(pendingAction("telegram", "42"));
    const eng = buildOrgView(registry, store, bus).find((d) => d.department === "engineering")!;
    expect(eng.agents[0].status).toBe("waiting");
  });

  it("pending action from a different origin does NOT mark waiting", () => {
    const { store, bus, registry } = harness();
    bus.emit({ type: "agent.start", agent: "vulcan", context: "chat:telegram:42" });
    store.insertAction(pendingAction("telegram", "999"));
    const eng = buildOrgView(registry, store, bus).find((d) => d.department === "engineering")!;
    expect(eng.agents[0].status).toBe("working");
  });

  it("agent.end returns to idle and sums today's cost", () => {
    const { store, bus, registry } = harness();
    bus.emit({ type: "agent.start", agent: "vulcan", context: "chat:telegram:42" });
    bus.emit({ type: "agent.end", agent: "vulcan", context: "chat:telegram:42", ok: true, costUsd: 0.25 });
    bus.emit({ type: "agent.start", agent: "developer", context: "chat:web:ui" });
    bus.emit({ type: "agent.end", agent: "developer", context: "chat:web:ui", ok: true, costUsd: 0.5 });
    const eng = buildOrgView(registry, store, bus).find((d) => d.department === "engineering")!;
    expect(eng.agents[0].status).toBe("idle");
    expect(eng.agents[0].costTodayUsd).toBeCloseTo(0.75);
  });

  it("cost from another day is excluded", () => {
    const { store, bus, registry } = harness();
    bus.emit({ type: "agent.end", agent: "vulcan", context: "chat:telegram:42", ok: true, costUsd: 0.25 });
    const eng = buildOrgView(registry, store, bus, "1999-01-01").find((d) => d.department === "engineering")!;
    expect(eng.agents[0].costTodayUsd).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/org-view.test.ts`
Expected: FAIL — `Cannot find module '../src/web/org-view.js'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `src/web/org-view.ts`:

```typescript
// src/web/org-view.ts — pure builders behind GET /api/org and GET /api/agents/<name>.
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";

export type AgentLiveStatus = "idle" | "working" | "waiting";

export interface OrgAgentCard {
  name: string;
  title: string;
  charter: string;
  visibility: "shared" | "private";
  guarded: boolean;
  status: AgentLiveStatus;
  /** Live run context ("chat:telegram:42" | "job:slug/stage") or null when idle. */
  currentTask: string | null;
  costTodayUsd: number;
}

export interface OrgDepartmentView {
  department: string;
  mission: string;
  lead: string | null;
  memoDomain: string;
  sandbox: boolean;
  actions: string[];
  agents: OrgAgentCard[];
}

const HISTORY_WINDOW = 5000; // same window as /api/costs

/** The router emits alias names on mention paths — canonicalize before matching registry entries. */
function canonical(registry: LoadedRegistry, agent: string): string {
  return registry.agentOf.get(agent) ?? agent;
}

export function buildOrgView(
  registry: LoadedRegistry,
  store: Store,
  bus: EventBus,
  today: string = new Date().toISOString().slice(0, 10),
): OrgDepartmentView[] {
  // One history scan: open runs (start without end) + per-agent cost today.
  const liveRuns = new Map<string, string>();
  const costToday = new Map<string, number>();
  for (const e of bus.history(0, HISTORY_WINDOW)) {
    if (e.event.type === "agent.start") {
      liveRuns.set(canonical(registry, e.event.agent), e.event.context);
    } else if (e.event.type === "agent.end") {
      const name = canonical(registry, e.event.agent);
      liveRuns.delete(name);
      if (e.event.costUsd && e.ts.slice(0, 10) === today) {
        costToday.set(name, (costToday.get(name) ?? 0) + e.event.costUsd);
      }
    }
  }

  // waiting = live chat run whose origin has a pending action. Job contexts never match — by design.
  const pendingOrigins = new Set(
    store.listActions("pending").map((a) => `chat:${a.origin_channel}:${a.origin_chat_id}`),
  );

  const out: OrgDepartmentView[] = [];
  for (const [deptName, dept] of registry.departments) {
    const agents: OrgAgentCard[] = [...registry.agents.values()]
      .filter((a) => a.department === deptName)
      .map((a) => {
        const context = liveRuns.get(a.manifest.name) ?? null;
        const status: AgentLiveStatus =
          context && pendingOrigins.has(context) ? "waiting" : context ? "working" : "idle";
        return {
          name: a.manifest.name,
          title: a.manifest.title,
          charter: a.manifest.charter.trim(),
          visibility: a.manifest.visibility,
          guarded: !!a.role.toolChecks,
          status,
          currentTask: context,
          costTodayUsd: costToday.get(a.manifest.name) ?? 0,
        };
      });
    out.push({
      department: deptName,
      mission: dept.mission,
      lead: dept.lead ?? null,
      memoDomain: dept.memoDomain,
      sandbox: dept.sandbox,
      actions: dept.actions,
      agents,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/org-view.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: clean.

```bash
git add src/web/org-view.ts test/org-view.test.ts
git commit -m "feat(web): buildOrgView — departments, live agent status, cost today"
```

---

### Task 2: `buildAgentProfile` — charter/persona/effective tools/trust/history

**Files:**
- Modify: `src/web/org-view.ts` (append)
- Test: `test/org-view.test.ts` (append)

**Interfaces:**
- Consumes: `effectiveAllowedTools(roleName, base, store)` from `src/agents/permissions.js`; `MODERATOR_ALLOWED_TOOLS` from `src/moderator/session.js`; `Store.listRolePermissions(role)`, `Store.setRolePermission(role, tool, allow, grantedBy)`, `Store.listTrust()`, `Store.upsertTrust(t)`; `TrustRecord` type from `src/kernel/trust.js`; `canonical()` + `HISTORY_WINDOW` from Task 1.
- Produces: `buildAgentProfile(nameOrAlias: string, registry: LoadedRegistry, store: Store, bus: EventBus): AgentProfileView | null` — null for unknown names (Task 3 turns that into a 404). Shape below; Task 4 mirrors it client-side as `AgentProfileInfo`.

- [ ] **Step 1: Write the failing test**

Append to `test/org-view.test.ts` (add `buildAgentProfile` to the existing import from `../src/web/org-view.js`):

```typescript
import { buildAgentProfile } from "../src/web/org-view.js"; // merge into the existing import line

describe("buildAgentProfile", () => {
  it("returns null for unknown agents", () => {
    const { store, bus, registry } = harness();
    expect(buildAgentProfile("nobody", registry, store, bus)).toBeNull();
  });

  it("resolves aliases to the canonical profile", () => {
    const { store, bus, registry } = harness();
    const p = buildAgentProfile("developer", registry, store, bus)!;
    expect(p.name).toBe("vulcan");
    expect(p.title).toBe("Senior Engineer");
    expect(p.department).toBe("engineering");
    expect(p.charter).toBe("Owns implementing code changes.");
    expect(p.persona).toBe("Terse.");
    expect(p.aliases).toEqual(["developer"]);
  });

  it("effective tools tag grants; revoked defaults listed separately", () => {
    const { store, bus, registry } = harness();
    store.setRolePermission("vulcan", "WebSearch", 1, "test");
    store.setRolePermission("vulcan", "Write", 0, "test");
    const p = buildAgentProfile("vulcan", registry, store, bus)!;
    expect(p.tools).toContainEqual({ name: "WebSearch", source: "granted" });
    expect(p.tools).toContainEqual({ name: "Read", source: "default" });
    expect(p.tools.some((t) => t.name === "Write")).toBe(false);
    expect(p.revoked).toEqual([{ name: "Write", source: "revoked" }]);
  });

  it("trust rows filter to the department's action ceiling", () => {
    const { store, bus, registry } = harness();
    const trustRow = (actionType: string) => ({
      actionType, state: "supervised" as const, approvals: 1, rejections: 0, streak: 1,
      firstSeen: new Date().toISOString(), lastRejection: null, graduatedAt: null,
    });
    store.upsertTrust(trustRow("vault.write"));
    store.upsertTrust(trustRow("email.send"));
    const p = buildAgentProfile("vulcan", registry, store, bus)!;
    expect(p.trust.map((t) => t.actionType)).toEqual(["vault.write"]);
  });

  it("recent runs, handoffs, and cost history come from the event stream", () => {
    const { store, bus, registry } = harness();
    bus.emit({ type: "agent.end", agent: "vulcan", context: "chat:telegram:42", ok: true, costUsd: 0.3 });
    bus.emit({ type: "agent.end", agent: "developer", context: "job:fix-auth/implement", ok: false });
    bus.emit({
      type: "route.decision", to: "vulcan", via: "handoff",
      reason: "charter match — code change", channel: "telegram", chatId: "42",
    });
    bus.emit({
      type: "route.decision", to: "vulcan", via: "mention",
      reason: "direct mention", channel: "telegram", chatId: "42",
    });
    const p = buildAgentProfile("vulcan", registry, store, bus)!;
    expect(p.recentRuns).toHaveLength(2);
    expect(p.recentRuns[0]).toMatchObject({ context: "job:fix-auth/implement", ok: false }); // newest first
    expect(p.handoffs).toHaveLength(1); // via=handoff only
    expect(p.handoffs[0].reason).toBe("charter match — code change");
    expect(Object.values(p.costByDay)).toEqual([0.3]);
  });
});
```

Trust seeding uses `store.upsertTrust(t: TrustRecord)` — the real write API at `src/store/db.ts:553`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/org-view.test.ts`
Expected: FAIL — `buildAgentProfile` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/web/org-view.ts`:

```typescript
import { effectiveAllowedTools } from "../agents/permissions.js";
import { MODERATOR_ALLOWED_TOOLS } from "../moderator/session.js";
import type { TrustRecord } from "../kernel/trust.js";
// (merge these imports into the header import block)

export interface AgentProfileView {
  name: string;
  title: string;
  department: string;
  mission: string;
  charter: string;
  persona: string;
  aliases: string[];
  visibility: "shared" | "private";
  permissionMode: string;
  model: string | null;
  skills: string[];
  guarded: boolean;
  maxTurns: number;
  tools: Array<{ name: string; source: "default" | "granted" }>;
  revoked: Array<{ name: string; source: "revoked" }>;
  /** Trust ledger rows for action types this agent's department can propose. */
  trust: TrustRecord[];
  /** Newest first, capped at 20. */
  recentRuns: Array<{ ts: string; context: string; ok: boolean; costUsd: number | null }>;
  /** hand_off dispatches to this agent (route.decision via=handoff), newest first, capped at 20. */
  handoffs: Array<{ ts: string; reason: string; channel: string; chatId: string }>;
  costByDay: Record<string, number>;
}

export function buildAgentProfile(
  nameOrAlias: string,
  registry: LoadedRegistry,
  store: Store,
  bus: EventBus,
): AgentProfileView | null {
  const name = registry.agentOf.get(nameOrAlias);
  const def = name ? registry.agents.get(name) : undefined;
  if (!def) return null;
  const dept = registry.departments.get(def.department);

  // hermes's real allowlist is the moderator toolset, not its empty manifest tools
  // (same special case as permissionRoleCatalog in permissions-view.ts).
  const base = def.manifest.name === "hermes" ? MODERATOR_ALLOWED_TOOLS : def.role.allowedTools;
  const overrides = store.listRolePermissions(def.manifest.name);
  const granted = new Set(overrides.filter((o) => o.allow === 1).map((o) => o.tool));
  const baseSet = new Set(base);
  const tools = effectiveAllowedTools(def.manifest.name, base, store).map((t) => ({
    name: t,
    source: (!baseSet.has(t) && granted.has(t) ? "granted" : "default") as "granted" | "default",
  }));
  const revoked = overrides
    .filter((o) => o.allow === 0 && baseSet.has(o.tool))
    .map((o) => ({ name: o.tool, source: "revoked" as const }));

  const deptActions = new Set(dept?.actions ?? []);
  const trust = store.listTrust().filter((t) => deptActions.has(t.actionType));

  const recentRuns: AgentProfileView["recentRuns"] = [];
  const handoffs: AgentProfileView["handoffs"] = [];
  const costByDay: Record<string, number> = {};
  for (const e of bus.history(0, HISTORY_WINDOW)) {
    if (e.event.type === "agent.end" && canonical(registry, e.event.agent) === def.manifest.name) {
      recentRuns.push({ ts: e.ts, context: e.event.context, ok: e.event.ok, costUsd: e.event.costUsd ?? null });
      if (e.event.costUsd) {
        const day = e.ts.slice(0, 10);
        costByDay[day] = (costByDay[day] ?? 0) + e.event.costUsd;
      }
    } else if (
      e.event.type === "route.decision" && e.event.via === "handoff" &&
      canonical(registry, e.event.to) === def.manifest.name
    ) {
      handoffs.push({ ts: e.ts, reason: e.event.reason, channel: e.event.channel, chatId: e.event.chatId });
    }
  }

  return {
    name: def.manifest.name,
    title: def.manifest.title,
    department: def.department,
    mission: dept?.mission ?? "",
    charter: def.manifest.charter.trim(),
    persona: def.manifest.persona.trim(),
    aliases: def.manifest.aliases,
    visibility: def.manifest.visibility,
    permissionMode: def.role.permissionMode,
    model: def.manifest.model ?? null,
    skills: def.manifest.skills,
    guarded: !!def.role.toolChecks,
    maxTurns: def.manifest.maxTurns,
    tools,
    revoked,
    trust,
    recentRuns: recentRuns.slice(-20).reverse(),
    handoffs: handoffs.slice(-20).reverse(),
    costByDay,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/org-view.test.ts`
Expected: 11 pass.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: clean.

```bash
git add src/web/org-view.ts test/org-view.test.ts
git commit -m "feat(web): buildAgentProfile — charter, effective tools, trust, run history"
```

---

### Task 3: Wire `GET /api/org` and `GET /api/agents/<name>` into the web server

**Files:**
- Modify: `src/web/server.ts` (import block + two route blocks before the `/api/permissions` handler)

**Interfaces:**
- Consumes: `buildOrgView`, `buildAgentProfile` from Task 1/2; existing `registry`, `store`, `bus` already destructured in `startWebServer`.
- Produces: `GET /api/org` → `OrgDepartmentView[]` (200); `GET /api/agents/<name-or-alias>` → `AgentProfileView` (200) or `{ error: "unknown agent" }` (404). Both inside the token-gated `/api/` branch.

- [ ] **Step 1: Add the import**

In `src/web/server.ts`, after the `buildPacksView` import line, add:

```typescript
import { buildOrgView, buildAgentProfile } from "./org-view.js";
```

- [ ] **Step 2: Add the routes**

Immediately before the `if (path === "/api/permissions" && req.method === "GET")` block, insert:

```typescript
        // ---- org ----
        if (path === "/api/org" && req.method === "GET") {
          return json(res, 200, buildOrgView(registry, store, bus));
        }

        const agentMatch = /^\/api\/agents\/([a-z][a-z0-9-]*)$/.exec(path);
        if (agentMatch && req.method === "GET") {
          const profile = buildAgentProfile(agentMatch[1], registry, store, bus);
          if (!profile) return json(res, 404, { error: "unknown agent" });
          return json(res, 200, profile);
        }
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean; suite ≥ 742 pass (731 baseline + 11 from Tasks 1–2) + 1 skip.

- [ ] **Step 4: Commit**

```bash
git add src/web/server.ts
git commit -m "feat(web): GET /api/org and GET /api/agents/<name> endpoints"
```

---

### Task 4: UI API client — org/profile/events types and methods

**Files:**
- Modify: `ui/src/api.ts`

**Interfaces:**
- Consumes: endpoint shapes from Tasks 1–3.
- Produces: `api.org(): Promise<OrgDepartmentView[]>`, `api.agent(name): Promise<AgentProfileInfo>`, `api.events(since?): Promise<StoredEvent[]>`; exported types `OrgAgentCard`, `OrgDepartmentView`, `AgentProfileInfo`, `TrustInfo` (already exists). Tasks 5–7 import these.

- [ ] **Step 1: Add types**

In `ui/src/api.ts`, after the `TrustInfo` interface, add:

```typescript
export interface OrgAgentCard {
  name: string;
  title: string;
  charter: string;
  visibility: "shared" | "private";
  guarded: boolean;
  status: "idle" | "working" | "waiting";
  currentTask: string | null;
  costTodayUsd: number;
}

export interface OrgDepartmentView {
  department: string;
  mission: string;
  lead: string | null;
  memoDomain: string;
  sandbox: boolean;
  actions: string[];
  agents: OrgAgentCard[];
}

export interface AgentProfileInfo {
  name: string;
  title: string;
  department: string;
  mission: string;
  charter: string;
  persona: string;
  aliases: string[];
  visibility: "shared" | "private";
  permissionMode: string;
  model: string | null;
  skills: string[];
  guarded: boolean;
  maxTurns: number;
  tools: Array<{ name: string; source: "default" | "granted" }>;
  revoked: Array<{ name: string; source: "revoked" }>;
  trust: TrustInfo[];
  recentRuns: Array<{ ts: string; context: string; ok: boolean; costUsd: number | null }>;
  handoffs: Array<{ ts: string; reason: string; channel: string; chatId: string }>;
  costByDay: Record<string, number>;
}
```

- [ ] **Step 2: Add methods**

In the `api` object, after `state:`, add:

```typescript
  org: () => request<OrgDepartmentView[]>("/api/org"),
  agent: (name: string) => request<AgentProfileInfo>(`/api/agents/${encodeURIComponent(name)}`),
  events: (since = 0) => request<StoredEvent[]>(`/api/events?since=${since}`),
```

- [ ] **Step 3: Verify**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(ui): api client for org, agent profile, event history"
```

---

### Task 5: Chat promoted — controlled target, hermes-first picker, inline routing trail

**Files:**
- Modify: `ui/src/views/Chat.tsx`
- Modify: `ui/src/App.tsx` (only the Chat wiring — the tab overhaul lands in Task 6)

**Interfaces:**
- Consumes: `StoredEvent[]` events prop; `route.decision` events carry `{ to, via, reason, channel, chatId }` with `via ∈ mention|binding|handoff|default|verdict|reset`.
- Produces: `Chat` props become `{ state, events, target, setTarget }` (target lifted to App). Task 6's Org profile "Chat" button relies on App's `setChatTarget`.

- [ ] **Step 1: Lift target state into App**

In `ui/src/App.tsx`, inside `App()` after the `tab` state, add:

```typescript
  const [chatTarget, setChatTarget] = useState("hermes");
```

Change the Chat mount line to:

```tsx
          <div className={tab === "chat" ? "h-full" : "hidden"}><Chat state={state} events={events} target={chatTarget} setTarget={setChatTarget} /></div>
```

- [ ] **Step 2: Convert Chat to controlled target + trail**

In `ui/src/views/Chat.tsx`:

1. Change the imports and signature:

```typescript
import { api, type StateInfo, type StoredEvent } from "../api.js";

export function Chat({ state, events, target, setTarget }: {
  state: StateInfo | undefined;
  events: StoredEvent[];
  target: string;
  setTarget: (t: string) => void;
}) {
```

2. Delete the line `const [target, setTarget] = useState("moderator");`.

3. Replace the `targets` derivation with a hermes-first registry-fed picker:

```typescript
  const targets = ["hermes", ...(state?.agents.filter((a) => a.kind !== "moderator").map((a) => a.name) ?? [])];
```

4. Add the trail derivation after `targets` (web-cockpit decisions only):

```typescript
  const trail = events.filter(
    (e) => e.event.type === "route.decision" && e.event.channel === "web" && e.event.chatId === "ui",
  ).slice(-3);
```

5. Render the trail at the bottom of the log container, just above `<div ref={bottom} />`:

```tsx
        {trail.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5">
            {trail.map((e) => {
              const v = e.event as unknown as { to: string; via: string; reason: string };
              return (
                <div key={e.id} className="text-[10px] text-dim self-center">
                  ⇢ hermes → <span className="text-phosphor">{v.to}</span> ({v.via}) — {v.reason}
                </div>
              );
            })}
          </div>
        )}
```

The picker buttons, send/voice paths, and localStorage log are untouched — `isChiefOfStaff` on the server already accepts `"hermes"` so no `@` prefix is added for the default target.

- [ ] **Step 3: Verify**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/views/Chat.tsx ui/src/App.tsx
git commit -m "feat(ui): chat promoted — lifted target, hermes-first picker, inline routing trail"
```

---

### Task 6: Org home view + agent profile drill-in + App tab overhaul

**Files:**
- Create: `ui/src/views/Org.tsx`
- Modify: `ui/src/App.tsx`
- Delete: `ui/src/views/Agents.tsx` (superseded — the Org home shows the same fleet, grouped by department, with live status)

**Interfaces:**
- Consumes: `api.org()`, `api.agent()` (Task 4); `usePoll` from `ui/src/hooks.ts`; `setChatTarget`/`setTab` from App (passed as `onOpenChat`).
- Produces: `Org({ events, onOpenChat })` component; App tabs become `["org", "chat", "routing", "board", "approvals", "trust", "permissions", "departments", "config", "costs"]` with `org` default. Task 7 fills the `routing` slot; until then App simply doesn't render that tab's view (add the tab in Task 7 to keep every commit green — see Step 2).

- [ ] **Step 1: Create `ui/src/views/Org.tsx`**

```tsx
// ui/src/views/Org.tsx — org-first home: department columns, live agent cards, profile drill-in.
import { useMemo, useState } from "react";
import { api, type OrgAgentCard, type StoredEvent } from "../api.js";
import { usePoll } from "../hooks.js";

const DEPT_ORDER = ["operations", "engineering", "research", "finance", "life", "clients"];

const STATUS_DOT: Record<OrgAgentCard["status"], string> = {
  idle: "bg-panel-2 border border-line",
  working: "bg-amber live-dot",
  waiting: "bg-alert live-dot",
};

export function Org({ events, onOpenChat }: { events: StoredEvent[]; onOpenChat: (name: string) => void }) {
  // Re-fetch when agent or action events arrive — same lastEvt pattern as Packs.
  const lastEvt = useMemo(
    () => events.filter((e) => e.event.type.startsWith("agent.") || e.event.type.startsWith("action.")).at(-1)?.id,
    [events],
  );
  const { data: org } = usePoll(() => api.org(), [lastEvt]);
  const [selected, setSelected] = useState<string | null>(null);

  if (selected) return <AgentProfile name={selected} onBack={() => setSelected(null)} onOpenChat={onOpenChat} />;
  if (!org) return <div className="text-dim">loading…</div>;

  const depts = [...org].sort(
    (a, b) => (DEPT_ORDER.indexOf(a.department) + 99) - (DEPT_ORDER.indexOf(b.department) + 99),
  );

  return (
    <div className="flex gap-4 items-start overflow-x-auto h-full min-h-0 pb-2">
      {depts.map((d, i) => (
        <section key={d.department} className="boot w-64 shrink-0" style={{ animationDelay: `${i * 60}ms` }}>
          <div className="mb-2">
            <div className="font-display uppercase tracking-[0.2em] text-[12px] text-phosphor glow-green">{d.department}</div>
            <div className="text-[10px] text-dim mt-0.5 line-clamp-2">{d.mission}</div>
            {d.lead && <div className="text-[10px] text-cyan mt-0.5">lead: {d.lead}</div>}
          </div>
          <div className="flex flex-col gap-2">
            {d.agents.map((a) => (
              <button key={a.name} onClick={() => setSelected(a.name)}
                className={`hud p-3 text-left hover:border-phosphor transition-colors ${a.status !== "idle" ? "hud-amber running-sweep" : ""}`}>
                <div className="flex items-center gap-2">
                  <span className={`inline-block w-2 h-2 rounded-full ${STATUS_DOT[a.status]}`} />
                  <span className="font-display text-bright tracking-wider text-[13px]">{a.name}</span>
                  {a.visibility === "private" && <span className="text-[9px] text-violet border border-violet px-1">private</span>}
                  {a.guarded && <span title="deterministic tool gate" className="text-[9px] text-cyan border border-cyan px-1">⛨</span>}
                  <span className={`ml-auto text-[9px] ${a.status === "idle" ? "text-dim" : a.status === "waiting" ? "text-alert" : "text-amber"}`}>
                    {a.status}
                  </span>
                </div>
                <div className="text-[10px] text-dim mt-1">{a.title}</div>
                {a.currentTask && (
                  <div className="text-[10px] text-amber mt-1 truncate">▸ {a.currentTask.replace(/^(job|chat):/, "")}</div>
                )}
                <div className="text-[10px] text-dim mt-1">today: ${a.costTodayUsd.toFixed(2)}</div>
              </button>
            ))}
          </div>
        </section>
      ))}
      {depts.length === 0 && (
        <div className="border border-dashed border-line text-dim text-[11px] p-4">no departments loaded</div>
      )}
    </div>
  );
}

function AgentProfile({ name, onBack, onOpenChat }: {
  name: string; onBack: () => void; onOpenChat: (name: string) => void;
}) {
  const { data: p, error } = usePoll(() => api.agent(name), [name]);
  if (error) return <div className="text-alert text-[12px]">error: {error} <button className="text-dim underline" onClick={onBack}>back</button></div>;
  if (!p) return <div className="text-dim">loading…</div>;

  return (
    <div className="max-w-3xl flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-[11px] text-dim border border-line px-2 py-1 hover:text-fg hover:border-fg">← org</button>
        <span className="font-display text-bright tracking-wider text-lg">{p.name}</span>
        <span className="text-[11px] text-dim">{p.title} · {p.department}</span>
        {p.visibility === "private" && <span className="text-[9px] text-violet border border-violet px-1">private</span>}
        {p.guarded && <span className="text-[9px] text-cyan border border-cyan px-1">⛨ guarded</span>}
        <button onClick={() => onOpenChat(p.name)}
          className="ml-auto border border-phosphor text-phosphor px-4 py-1.5 font-display uppercase tracking-[0.2em] text-[11px] hover:bg-phosphor hover:text-void transition-colors">
          Chat
        </button>
      </div>

      <div className="hud p-4">
        <div className="label mb-1">Charter</div>
        <p className="text-[12px] text-fg leading-relaxed whitespace-pre-wrap">{p.charter}</p>
        <div className="label mb-1 mt-3">Persona</div>
        <p className="text-[12px] text-dim leading-relaxed whitespace-pre-wrap">{p.persona}</p>
        <div className="text-[10px] text-dim mt-3">
          mode: {p.permissionMode} · maxTurns: {p.maxTurns}
          {p.model ? ` · model: ${p.model}` : ""}
          {p.aliases.length ? ` · aliases: ${p.aliases.join(", ")}` : ""}
        </div>
        {!!p.skills.length && <div className="text-[11px] text-violet mt-1">skills: {p.skills.join(", ")}</div>}
      </div>

      <div className="hud p-4">
        <div className="label mb-2">Effective tools</div>
        <div className="flex flex-wrap gap-1">
          {p.tools.map((t) => (
            <span key={t.name}
              className={`text-[10px] px-1.5 py-0.5 border ${t.source === "granted" ? "border-phosphor text-phosphor" : "border-line text-dim"}`}>
              {t.name}{t.source === "granted" ? " +" : ""}
            </span>
          ))}
          {p.revoked.map((t) => (
            <span key={t.name} className="text-[10px] px-1.5 py-0.5 border border-alert text-alert line-through">{t.name}</span>
          ))}
        </div>
      </div>

      {p.trust.length > 0 && (
        <div className="hud p-4">
          <div className="label mb-2">Trust</div>
          {p.trust.map((t) => (
            <div key={t.actionType} className="text-[11px] flex gap-3">
              <span className="text-fg w-40">{t.actionType}</span>
              <span className={t.state === "autonomous" ? "text-phosphor" : t.state === "graduating" ? "text-amber" : "text-dim"}>{t.state}</span>
              <span className="text-dim">✓{t.approvals} ✗{t.rejections} streak {t.streak}</span>
            </div>
          ))}
        </div>
      )}

      <div className="hud p-4">
        <div className="label mb-2">Recent runs</div>
        {p.recentRuns.length === 0 && <div className="text-[11px] text-dim">no runs yet</div>}
        {p.recentRuns.map((r, i) => (
          <div key={i} className="text-[11px] flex gap-2">
            <span className="text-dim">{r.ts.slice(5, 16).replace("T", " ")}</span>
            <span className={r.ok ? "text-phosphor" : "text-alert"}>{r.ok ? "ok" : "FAILED"}</span>
            <span className="text-fg truncate">{r.context.replace(/^(job|chat):/, "")}</span>
            {r.costUsd != null && <span className="text-dim ml-auto">${r.costUsd.toFixed(3)}</span>}
          </div>
        ))}
      </div>

      {p.handoffs.length > 0 && (
        <div className="hud p-4">
          <div className="label mb-2">Handoffs received</div>
          {p.handoffs.map((h, i) => (
            <div key={i} className="text-[11px] flex gap-2">
              <span className="text-dim">{h.ts.slice(5, 16).replace("T", " ")}</span>
              <span className="text-fg">{h.reason}</span>
              <span className="text-dim ml-auto">{h.channel}:{h.chatId}</span>
            </div>
          ))}
        </div>
      )}

      {Object.keys(p.costByDay).length > 0 && (
        <div className="hud p-4">
          <div className="label mb-2">Cost history</div>
          {Object.entries(p.costByDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14).map(([day, usd]) => (
            <div key={day} className="text-[11px] flex gap-3">
              <span className="text-dim">{day}</span>
              <span className="text-fg">${usd.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Overhaul App tabs**

In `ui/src/App.tsx`:

1. Replace the Agents import with Org:

```typescript
import { Org } from "./views/Org.js";
```

(delete `import { Agents } from "./views/Agents.js";`)

2. Replace the TABS line (routing lands in Task 7; include it now with a placeholder mount so tab order is final — the placeholder renders EventFeed's empty-state style text):

```typescript
const TABS = ["org", "chat", "routing", "board", "approvals", "trust", "permissions", "departments", "config", "costs"] as const;
```

3. Change the default tab:

```typescript
  const [tab, setTab] = useState<Tab>("org");
```

4. Add the open-chat callback after `chatTarget` state (from Task 5):

```typescript
  const openChat = (name: string) => { setChatTarget(name); setTab("chat"); };
```

5. Replace the `agents` view mount with `org` + `routing` placeholder, and rename the packs mount key to `departments` (component unchanged):

```tsx
          <div className={tab === "org" ? "h-full" : "hidden"}><Org events={events} onOpenChat={openChat} /></div>
          <div className={tab === "routing" ? "" : "hidden"}><div className="text-dim text-[11px]">routing trail lands in the next commit</div></div>
          <div className={tab === "departments" ? "" : "hidden"}><Packs events={events} /></div>
```

(delete the old `agents` and `packs` mount lines)

6. Delete `ui/src/views/Agents.tsx`.

- [ ] **Step 3: Verify**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/views/Org.tsx ui/src/App.tsx
git rm ui/src/views/Agents.tsx
git commit -m "feat(ui): org-first home — department columns, live agent cards, profile drill-in"
```

---

### Task 7: Routing trail view

**Files:**
- Create: `ui/src/views/RoutingTrail.tsx`
- Modify: `ui/src/App.tsx` (replace the routing placeholder)

**Interfaces:**
- Consumes: `api.events()` (Task 4), live `events` prop; `route.decision` shape `{ to, via, reason, channel, chatId }`.
- Produces: `RoutingTrail({ events })` component mounted at the `routing` tab.

- [ ] **Step 1: Create `ui/src/views/RoutingTrail.tsx`**

```tsx
// ui/src/views/RoutingTrail.tsx — filterable feed of route.decision events.
import { useMemo, useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { usePoll } from "../hooks.js";

const VIAS = ["all", "mention", "binding", "handoff", "default", "verdict", "reset"] as const;

const VIA_COLOR: Record<string, string> = {
  mention: "text-cyan", binding: "text-violet", handoff: "text-amber",
  default: "text-dim", verdict: "text-phosphor", reset: "text-alert",
};

interface RouteEvt { to: string; via: string; reason: string; channel: string; chatId: string }

export function RoutingTrail({ events }: { events: StoredEvent[] }) {
  const { data: history } = usePoll(() => api.events(), []);
  const [q, setQ] = useState("");
  const [via, setVia] = useState<(typeof VIAS)[number]>("all");

  // Merge persisted history with the live SSE buffer, dedupe by event id.
  const rows = useMemo(() => {
    const byId = new Map<number, StoredEvent>();
    for (const e of history ?? []) byId.set(e.id, e);
    for (const e of events) byId.set(e.id, e);
    return [...byId.values()]
      .filter((e) => e.event.type === "route.decision")
      .sort((a, b) => b.id - a.id);
  }, [history, events]);

  const filtered = rows.filter((e) => {
    const v = e.event as unknown as RouteEvt;
    if (via !== "all" && v.via !== via) return false;
    if (!q.trim()) return true;
    return `${v.to} ${v.reason} ${v.channel}:${v.chatId}`.toLowerCase().includes(q.toLowerCase());
  });

  return (
    <div className="max-w-4xl flex flex-col gap-3">
      <div className="flex gap-2 items-center flex-wrap">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter by agent, reason, chat…"
          className="bg-panel border border-line px-3 py-1.5 text-[12px] text-fg outline-none focus:border-phosphor w-64"
        />
        {VIAS.map((v) => (
          <button key={v} onClick={() => setVia(v)}
            className={`px-2 py-1 text-[10px] font-display uppercase tracking-wider border transition-colors ${
              via === v ? "border-phosphor text-phosphor" : "border-line text-dim hover:text-fg"}`}>
            {v}
          </button>
        ))}
      </div>
      <div className="hud p-4 flex flex-col gap-1.5">
        {filtered.slice(0, 200).map((e) => {
          const v = e.event as unknown as RouteEvt;
          return (
            <div key={e.id} className="text-[11px] leading-relaxed">
              <span className="text-dim">{e.ts.slice(5, 19).replace("T", " ")} </span>
              <span className={VIA_COLOR[v.via] ?? "text-fg"}>[{v.via}]</span>{" "}
              <span className="text-bright">→ {v.to}</span>{" "}
              <span className="text-fg">{v.reason}</span>{" "}
              <span className="text-dim">({v.channel}:{v.chatId})</span>
            </div>
          );
        })}
        {filtered.length === 0 && <div className="text-dim text-[11px]">no routing decisions yet</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount it**

In `ui/src/App.tsx`, add the import:

```typescript
import { RoutingTrail } from "./views/RoutingTrail.js";
```

Replace the routing placeholder mount from Task 6 with:

```tsx
          <div className={tab === "routing" ? "" : "hidden"}><RoutingTrail events={events} /></div>
```

- [ ] **Step 3: Verify**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/views/RoutingTrail.tsx ui/src/App.tsx
git commit -m "feat(ui): routing trail — filterable route.decision feed"
```

---

### Task 8: Packs view header copy → departments

**Files:**
- Modify: `ui/src/views/Packs.tsx` (empty-state copy only — the tab label became `departments` in Task 6)

**Interfaces:**
- Consumes/Produces: none new — cosmetic alignment with the department vocabulary.

- [ ] **Step 1: Update the empty-state copy**

In `ui/src/views/Packs.tsx`, change:

```tsx
        <div className="border border-dashed border-line text-dim text-[11px] p-4 text-center">no packs bound</div>
```

to:

```tsx
        <div className="border border-dashed border-line text-dim text-[11px] p-4 text-center">no departments loaded</div>
```

- [ ] **Step 2: Verify and commit**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean.

```bash
git add ui/src/views/Packs.tsx
git commit -m "chore(ui): packs empty-state copy speaks departments"
```

---

### Task 9: Full verification, merge, deploy, live smoke

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: ≥ 742 pass + 1 skip, zero failures.

- [ ] **Step 2: Typecheck + builds**

Run: `npx tsc --noEmit && npm run build && (cd ui && npx tsc --noEmit && npm run build)`
Expected: all clean.

- [ ] **Step 3: Merge to main (FF), deploy**

Follow superpowers:finishing-a-development-branch. After FF merge to main:

```bash
npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios
```

- [ ] **Step 4: Live smoke against the daemon**

```bash
TOKEN=$(grep '^AIOS_UI_TOKEN=' .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/org | head -c 400
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/agents/vulcan | head -c 400
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/agents/developer | head -c 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/agents/nobody
```

Expected: `/api/org` returns 6 departments / 15 agents; `vulcan` and alias `developer` both return the vulcan profile; `nobody` returns 404. Then open http://localhost:4280 — org home renders as default tab, click vulcan → profile → Chat button lands on chat with target vulcan; routing tab shows decisions after sending one chat message.

- [ ] **Step 5: Commit any smoke fixes, update memory**

If smoke passes with no fixes, done. Record Phase 2 completion in the project memory file.

---

## Self-Review (done at plan time)

- **Spec coverage:** Org home (Task 6), agent profiles incl. charter/persona/effective tools/trust/recent jobs+handoffs/cost/Chat button (Tasks 2, 6), chat-first with registry picker + inline trail (Task 5), routing trail view (Task 7), packs→department settings (Tasks 6, 8), `/api/org` + `/api/agents/<name>` behind token auth (Task 3), route.decision over existing SSE (already shipped in Phase 1 — consumed by Tasks 5–7). No new write endpoints. Out-of-scope items (task DAGs, budget meters) untouched.
- **Status derivation:** spec says "derived from existing agent.start/agent.end events plus pending actions" — implemented as working=open run, waiting=open chat-run with pending action at same origin. Job-origin approvals don't attribute to an agent (actions carry no agent column) — documented limitation, Approvals tab still covers them.
- **Type consistency:** `OrgDepartmentView`/`OrgAgentCard`/`AgentProfileView` names match across builder (Tasks 1–2), server (Task 3), and client mirror `AgentProfileInfo` (Task 4); `TrustRecord` (backend) ↔ `TrustInfo` (existing ui type) are field-identical.
- **Known judgment calls:** deleting the Agents tab (superseded by Org home); trust seeding in Task 2 tests verified against the real API (`Store.upsertTrust`, `src/store/db.ts:553`).
