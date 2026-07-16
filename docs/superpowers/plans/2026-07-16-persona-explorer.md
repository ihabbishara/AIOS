# Persona Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Staff agent profile into a rich persona explorer — full manifest visibility, merged activity history, and per-field manifest editing with comment-preserving YAML splicing.

**Architecture:** Pure tested builders in `src/web/persona-view.ts` (activity merge + field splice), DTO types in `src/web/dto.ts`, thin untested routes in `src/web/server.ts` reusing `agentYamlPath` + `reloadPacks()` from the skills cycle, and a new `ui2/src/views/StaffProfile.tsx` with overview/activity/edit sub-tabs.

**Tech Stack:** Node + TypeScript, `yaml` (parseDocument AST ranges), vitest, React (ui2 hash router, useLiveQuery).

**Spec:** `docs/superpowers/specs/2026-07-16-persona-explorer-design.md`

## Global Constraints

- No new npm dependencies.
- Trunk-based: every task commits to `main`; push after the final task.
- NEVER rewrite agent YAML via `Document.toString()` — parse to locate, splice the original string (see `rewriteSkillsField` in `src/web/skills-view.ts` for the canonical pattern and its doc comment explaining why).
- No new bus event types (unknown types hit the LLM triage classifier — `routine.due` precedent).
- Repo convention: route wiring in `server.ts` is thin and untested; builders/validators carry the tests (root `test/` dir, vitest).
- `src/web/dto.ts` is shared into the ui2 type graph — it must stay pure type declarations; never import store/bus/loader from it.
- Editable manifest fields are exactly: `title`, `charter`, `persona`, `prompt`, `model`, `maxTurns`. Nothing else.
- Run root tests as `npx vitest run test/<file>.test.ts` from `/Users/ihabbishara/projects/AIOS`; ui2 tests as `npx vitest run` from `ui2/`.

---

### Task 1: DTO additions + profile enrichment (kind, capabilities, prompt)

**Files:**
- Modify: `src/web/dto.ts` (AgentProfileInfo ~line 83; add AgentActivityInfo after it)
- Modify: `src/web/org-view.ts` (`buildAgentProfile` return object, ~line 135)
- Test: `test/org-view.test.ts`

**Interfaces:**
- Consumes: `AgentDef` from `src/agents/registry/loader.js` — has `kind: AgentKind`, `capabilities: string[]`, `manifest.prompt: string` (all already loaded).
- Produces: `AgentProfileInfo` with new fields `kind: string`, `capabilities: string[]`, `prompt: string`; new exported interface `AgentActivityInfo` (consumed by Tasks 2, 4, 5, 7).

- [ ] **Step 1: Write the failing test**

Append to the `describe("buildAgentProfile", ...)` block in `test/org-view.test.ts`:

```ts
  it("exposes kind, capabilities, and the system prompt", () => {
    const { store, bus, registry } = harness();
    const p = buildAgentProfile("vulcan", registry, store, bus)!;
    expect(p.kind).toBe("coordinator");
    expect(p.capabilities).toEqual(["files-basic", "vw"]);
    expect(p.prompt).toBe("You are vulcan.");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/org-view.test.ts`
Expected: FAIL — `p.kind` is `undefined` (property does not exist on AgentProfileInfo, tsc in vitest will complain or the assertion fails).

- [ ] **Step 3: Add the DTO fields**

In `src/web/dto.ts`, inside `AgentProfileInfo`, after `permissionMode: string;` add:

```ts
  /** Org role: coordinator | lead | worker | critic. */
  kind: string;
  /** Effective capability names (dept defaults ∪ agent extras). */
  capabilities: string[];
  /** The manifest system prompt, verbatim. */
  prompt: string;
```

After the closing brace of `AgentProfileInfo` add:

```ts
export interface AgentActivityInfo {
  /** Merged per-agent event feed, newest first, capped at 100. */
  timeline: Array<{ ts: string; kind: "run" | "route" | "mail" | "goal"; summary: string; ok?: boolean }>;
  /** Goals with at least one node assigned to the agent; nodes filtered to the agent's. */
  goals: Array<{ goalId: string; title: string; status: string; nodes: Array<{ key: string; status: string }> }>;
  /** Agent mail involving this agent (from or to), newest first. */
  mail: Array<{ id: string; ts: string; from: string; to: string; kind: string; snippet: string; status: string }>;
}
```

- [ ] **Step 4: Populate the fields in buildAgentProfile**

In `src/web/org-view.ts`, in the return object of `buildAgentProfile` (after `persona: def.manifest.persona.trim(),`) add:

```ts
    prompt: def.manifest.prompt.trim(),
    kind: def.kind,
    capabilities: def.capabilities,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/org-view.test.ts`
Expected: PASS (all existing + 1 new).

- [ ] **Step 6: Commit**

```bash
git add src/web/dto.ts src/web/org-view.ts test/org-view.test.ts
git commit -m "feat(web): expose kind/capabilities/prompt on agent profile + activity DTO"
```

---

### Task 2: buildAgentActivity — merged timeline + goals + mail

**Files:**
- Create: `src/web/persona-view.ts`
- Test: `test/persona-view.test.ts` (new)

**Interfaces:**
- Consumes: `fixtureRegistry` exported from `test/org-view.test.ts`; `Store` methods `listGoals(limit)`, `listNodes(goalId)`, `listMail(agent, limit)`, `insertGoal`, `insertNodes`, `insertMail`; `EventBus.history(0, n)` (oldest-first); `LoadedRegistry.agentOf` / `.agents`.
- Produces: `buildAgentActivity(nameOrAlias: string, registry: LoadedRegistry, store: Store, bus: EventBus): AgentActivityInfo | null` (consumed by Task 4's GET route).

- [ ] **Step 1: Write the failing tests**

Create `test/persona-view.test.ts`:

```ts
// test/persona-view.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { buildAgentActivity } from "../src/web/persona-view.js";
import { fixtureRegistry } from "./org-view.test.js";

function harness() {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  return { store, bus, registry: fixtureRegistry() };
}

describe("buildAgentActivity", () => {
  it("returns null for unknown agents", () => {
    const { store, bus, registry } = harness();
    expect(buildAgentActivity("nobody", registry, store, bus)).toBeNull();
  });

  it("merges runs, routes, mail, and goal nodes newest-first; aliases canonicalize", () => {
    const { store, bus, registry } = harness();
    bus.emit({ type: "agent.end", agent: "developer", context: "chat:telegram:42", ok: true, costUsd: 0.1 });
    bus.emit({ type: "route.decision", to: "vulcan", via: "handoff", reason: "code change", channel: "telegram", chatId: "42" });
    bus.emit({ type: "mail.sent", id: "m1", from: "vulcan", to: "midas", kind: "request" });
    bus.emit({ type: "node.status", goalId: "g1", nodeKey: "implement", status: "done", agent: "vulcan" });
    bus.emit({ type: "agent.end", agent: "midas", context: "chat:telegram:9", ok: true }); // not vulcan's
    const a = buildAgentActivity("developer", registry, store, bus)!;
    expect(a.timeline.map((t) => t.kind)).toEqual(["goal", "mail", "route", "run"]); // newest first
    expect(a.timeline[3]).toMatchObject({ kind: "run", summary: "chat:telegram:42", ok: true });
    expect(a.timeline[2].summary).toBe("handoff: code change");
    expect(a.timeline.some((t) => t.summary.includes("telegram:9"))).toBe(false);
  });

  it("caps the timeline at 100 entries", () => {
    const { store, bus, registry } = harness();
    for (let i = 0; i < 120; i++) {
      bus.emit({ type: "agent.end", agent: "vulcan", context: `chat:t:${i}`, ok: true });
    }
    const a = buildAgentActivity("vulcan", registry, store, bus)!;
    expect(a.timeline).toHaveLength(100);
    expect(a.timeline[0].summary).toBe("chat:t:119"); // newest kept
  });

  it("lists goals with nodes filtered to the agent, skips uninvolved goals", () => {
    const { store, bus, registry } = harness();
    const goal = (id: string, title: string) => ({
      id, slug: id, title, request: "r", department: "engineering", lead: "vulcan",
      origin_channel: "telegram", origin_chat_id: "42", status: "running" as const,
      project_dir: null, goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, error: null,
    });
    store.insertGoal(goal("g1", "Fix auth"));
    store.insertGoal(goal("g2", "Taxes"));
    store.insertNodes("g1", [
      { node_key: "implement", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: [], max_rounds: 1 },
      { node_key: "review", type: "verify", agent: "midas", critic: null, brief: "b", depends_on: ["implement"], max_rounds: 1 },
    ]);
    store.insertNodes("g2", [
      { node_key: "collect", type: "run", agent: "midas", critic: null, brief: "b", depends_on: [], max_rounds: 1 },
    ]);
    const a = buildAgentActivity("vulcan", registry, store, bus)!;
    expect(a.goals).toHaveLength(1);
    expect(a.goals[0]).toMatchObject({ goalId: "g1", title: "Fix auth", status: "running" });
    expect(a.goals[0].nodes).toEqual([{ key: "implement", status: "pending" }]);
  });

  it("returns agent mail with a body snippet", () => {
    const { store, bus, registry } = harness();
    store.insertMail({
      id: "m1", from_agent: "vulcan", to_agent: "midas", kind: "request",
      body: "x".repeat(200), goal_id: null, origin_channel: "telegram",
      origin_chat_id: "42", chain_depth: 0, status: "unread", error: null,
    });
    const a = buildAgentActivity("vulcan", registry, store, bus)!;
    expect(a.mail).toHaveLength(1);
    expect(a.mail[0]).toMatchObject({ id: "m1", from: "vulcan", to: "midas", kind: "request", status: "unread" });
    expect(a.mail[0].snippet).toHaveLength(120);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/persona-view.test.ts`
Expected: FAIL — cannot resolve `../src/web/persona-view.js`.

- [ ] **Step 3: Implement buildAgentActivity**

Create `src/web/persona-view.ts`:

```ts
// src/web/persona-view.ts — persona explorer builders: per-agent activity merge +
// comment-preserving manifest field splicing (spec 2026-07-16-persona-explorer).
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { AgentActivityInfo } from "./dto.js";

const HISTORY_WINDOW = 5000; // same window as org-view
const TIMELINE_CAP = 100;

export function buildAgentActivity(
  nameOrAlias: string,
  registry: LoadedRegistry,
  store: Store,
  bus: EventBus,
): AgentActivityInfo | null {
  const name = registry.agentOf.get(nameOrAlias);
  if (!name || !registry.agents.has(name)) return null;
  const canon = (agent: string) => registry.agentOf.get(agent) ?? agent;

  const timeline: AgentActivityInfo["timeline"] = [];
  for (const e of bus.history(0, HISTORY_WINDOW)) {
    const ev = e.event;
    if (ev.type === "agent.end" && canon(ev.agent) === name) {
      timeline.push({ ts: e.ts, kind: "run", summary: ev.context, ok: ev.ok });
    } else if (ev.type === "route.decision" && canon(ev.to) === name) {
      timeline.push({ ts: e.ts, kind: "route", summary: `${ev.via}: ${ev.reason}` });
    } else if (ev.type === "mail.sent" && (canon(ev.from) === name || canon(ev.to) === name)) {
      timeline.push({ ts: e.ts, kind: "mail", summary: `${ev.from} → ${ev.to} (${ev.kind})` });
    } else if (ev.type === "node.status" && canon(ev.agent) === name) {
      timeline.push({
        ts: e.ts, kind: "goal",
        summary: `${ev.goalId.slice(0, 8)}/${ev.nodeKey}: ${ev.status}`,
        ...(ev.status === "failed" ? { ok: false } : {}),
      });
    }
  }
  timeline.reverse(); // history is oldest-first

  const goals: AgentActivityInfo["goals"] = [];
  for (const g of store.listGoals(50)) {
    const nodes = store.listNodes(g.id).filter((n) => canon(n.agent) === name);
    if (nodes.length === 0) continue;
    goals.push({
      goalId: g.id, title: g.title, status: g.status,
      nodes: nodes.map((n) => ({ key: n.node_key, status: n.status })),
    });
  }

  const mail = store.listMail(name, 30).map((m) => ({
    id: m.id, ts: m.created_at, from: m.from_agent, to: m.to_agent,
    kind: m.kind, snippet: m.body.slice(0, 120), status: m.status,
  }));

  return { timeline: timeline.slice(0, TIMELINE_CAP), goals, mail };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/persona-view.test.ts test/org-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/persona-view.ts test/persona-view.test.ts
git commit -m "feat(web): buildAgentActivity — merged per-agent timeline, goals, mail"
```

---

### Task 3: spliceManifestField — comment-preserving per-field YAML edit

**Files:**
- Modify: `src/web/persona-view.ts` (append)
- Test: `test/persona-view.test.ts` (append)

**Interfaces:**
- Consumes: `yaml` package — `parseDocument`, `isMap`, `isNode`, `isScalar` (same imports `skills-view.ts` uses).
- Produces: `spliceManifestField(text: string, field: string, value: string | number): string` — throws `Error` with a human-readable message on any invalid input (consumed by Task 4's PATCH route as the 400 body).

- [ ] **Step 1: Write the failing tests**

Append to `test/persona-view.test.ts` (add `spliceManifestField` to the existing import from `../src/web/persona-view.js`):

```ts
const MANIFEST = `name: vulcan
# the human-facing card
title: Senior Engineer
department: engineering
charter: >
  Owns implementing code changes.
persona: >
  Terse.
prompt: >
  You are vulcan.
tools: [Read, Edit, Write]
maxTurns: 80
aliases: [developer]
kind: coordinator
`;

describe("spliceManifestField", () => {
  it("replaces a plain scalar, leaving every other byte untouched", () => {
    const out = spliceManifestField(MANIFEST, "title", "Staff Engineer");
    expect(out).toContain("title: Staff Engineer\n");
    expect(out.replace("title: Staff Engineer\n", "title: Senior Engineer\n")).toBe(MANIFEST);
    expect(out).toContain("# the human-facing card"); // comment survives
  });

  it("replaces a block scalar as folded when single-line", () => {
    const out = spliceManifestField(MANIFEST, "charter", "Ships production code.");
    expect(out).toContain("charter: >\n  Ships production code.\n");
    expect(out).toContain("persona: >\n  Terse.\n"); // neighbor untouched
  });

  it("uses a literal block when the value has newlines (fidelity over house style)", () => {
    const out = spliceManifestField(MANIFEST, "prompt", "Line one.\n\nLine three.");
    expect(out).toContain("prompt: |\n  Line one.\n\n  Line three.\n");
  });

  it("replaces maxTurns and rejects non-positive / non-integer values", () => {
    expect(spliceManifestField(MANIFEST, "maxTurns", 40)).toContain("maxTurns: 40\n");
    expect(() => spliceManifestField(MANIFEST, "maxTurns", 0)).toThrow(/positive integer/);
    expect(() => spliceManifestField(MANIFEST, "maxTurns", 2.5)).toThrow(/positive integer/);
    expect(() => spliceManifestField(MANIFEST, "maxTurns", "40" as unknown as number)).toThrow(/positive integer/);
  });

  it("inserts model after the tools line when absent", () => {
    const out = spliceManifestField(MANIFEST, "model", "haiku");
    expect(out).toContain("tools: [Read, Edit, Write]\nmodel: haiku\n");
  });

  it("quotes scalars that need it", () => {
    const out = spliceManifestField(MANIFEST, "title", "Engineer: staff");
    expect(out).toContain(`title: "Engineer: staff"\n`);
  });

  it("rejects unknown fields, empty strings, and unparseable yaml", () => {
    expect(() => spliceManifestField(MANIFEST, "name", "loki")).toThrow(/not editable/);
    expect(() => spliceManifestField(MANIFEST, "charter", "  ")).toThrow(/non-empty/);
    expect(() => spliceManifestField("{broken: [", "title", "X")).toThrow(/yaml/i);
  });

  it("rejects a manifest missing a required field (corrupt file guard)", () => {
    expect(() => spliceManifestField("name: x\n", "charter", "New charter.")).toThrow(/missing required/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/persona-view.test.ts`
Expected: FAIL — `spliceManifestField` is not exported.

- [ ] **Step 3: Implement spliceManifestField**

Append to `src/web/persona-view.ts` (extend the imports at the top):

```ts
import { parseDocument, isMap, isNode, isScalar } from "yaml";
```

```ts
const EDITABLE: Record<string, "scalar" | "block" | "number"> = {
  title: "scalar", charter: "block", persona: "block", prompt: "block",
  model: "scalar", maxTurns: "number",
};
/** Optional manifest keys we insert when absent; required keys throw instead. */
const OPTIONAL = new Set(["model", "maxTurns"]);
const PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9 ._\/-]*$/;

/** Render one `key: value` replacement in the manifests' house style. */
function renderField(field: string, kind: "scalar" | "block" | "number", value: string | number): string {
  if (kind === "number") {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`${field} must be a positive integer`);
    }
    return `${field}: ${value}\n`;
  }
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (kind === "scalar") {
    if (value.includes("\n")) throw new Error(`${field} must be a single line`);
    return `${field}: ${PLAIN_SCALAR.test(value) ? value : JSON.stringify(value)}\n`;
  }
  // Block prose. Single-line values keep the house folded style (`>`); multi-line
  // values use a literal block (`|`) — folding would silently collapse the user's
  // line breaks to spaces on the next parse.
  const body = value.trim().split("\n").map((l) => (l.trim() === "" ? "" : `  ${l.trimEnd()}`)).join("\n");
  return `${field}: ${value.trim().includes("\n") ? "|" : ">"}\n${body}\n`;
}

/**
 * Rewrite one manifest field, leaving every other byte of the file untouched.
 * Parse to LOCATE, splice to EDIT — same rule as rewriteSkillsField (a full
 * Document.toString() round-trip re-emits the whole hand-authored file).
 * Throws on invalid field/value/yaml; the message doubles as the HTTP 400 body.
 */
export function spliceManifestField(text: string, field: string, value: string | number): string {
  const kind = EDITABLE[field];
  if (!kind) throw new Error(`field "${field}" is not editable`);
  const rendered = renderField(field, kind, value);

  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`yaml: ${doc.errors[0].message}`);
  const items = isMap(doc.contents) ? doc.contents.items : [];
  const pair = items.find((p) => isScalar(p.key) && p.key.value === field);

  if (!pair || !isNode(pair.key) || !isNode(pair.value)) {
    if (!OPTIONAL.has(field)) throw new Error(`manifest missing required field "${field}"`);
    const tools = items.find((p) => isScalar(p.key) && p.key.value === "tools");
    if (tools && isNode(tools.value)) {
      const end = tools.value.range![2];
      return text.slice(0, end) + rendered + text.slice(end);
    }
    return text === "" || text.endsWith("\n") ? text + rendered : `${text}\n${rendered}`;
  }
  const start = pair.key.range![0];
  const end = pair.value.range![2];
  return text.slice(0, start) + rendered + text.slice(end);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/persona-view.test.ts`
Expected: PASS. If the folded/literal block assertions fail on exact whitespace, print the actual output and fix the assertion only if the output is still valid YAML that round-trips (`parse(out).charter === value`) AND bytes outside the spliced range are untouched — fidelity is the requirement, not the exact test string.

- [ ] **Step 5: Full root suite + tsc**

Run: `npx vitest run` and `npx tsc --noEmit`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/web/persona-view.ts test/persona-view.test.ts
git commit -m "feat(web): spliceManifestField — comment-preserving per-field manifest edits"
```

---

### Task 4: Server routes — GET activity, PATCH manifest

**Files:**
- Modify: `src/web/server.ts` (imports ~line 20-27; routes after the agent-skills PATCH block, ~line 602)

**Interfaces:**
- Consumes: `buildAgentActivity`, `spliceManifestField` from `./persona-view.js`; `agentYamlPath` from `./skills-view.js` (already imported); `reloadPacks`, `registry`, `config`, `store`, `bus` (already destructured at ~line 135); `readFileSync`/`writeFileSync` (already imported for the skills route).
- Produces: `GET /api/agents/:name/activity` → `AgentActivityInfo` | 404; `PATCH /api/agents/:name/manifest` body `{field, value}` → fresh `AgentProfileInfo` | 400/404/500 (consumed by Task 5's api client).

- [ ] **Step 1: Add the import**

In `src/web/server.ts` next to the skills-view import block:

```ts
import { buildAgentActivity, spliceManifestField } from "./persona-view.js";
```

- [ ] **Step 2: Add the routes**

Immediately after the `agentSkillsMatch` PATCH block (after its closing `}`), add:

```ts
        // ---- persona explorer (spec 2026-07-16 persona-explorer) ----
        const agentActivityMatch = /^\/api\/agents\/([a-z][a-z0-9-]*)\/activity$/.exec(path);
        if (agentActivityMatch && req.method === "GET") {
          const a = buildAgentActivity(agentActivityMatch[1], registry, store, bus);
          if (!a) return json(res, 404, { error: "unknown agent" });
          return json(res, 200, a);
        }

        const manifestMatch = /^\/api\/agents\/([a-z][a-z0-9-]*)\/manifest$/.exec(path);
        if (manifestMatch && req.method === "PATCH") {
          const canonical = registry.agentOf.get(manifestMatch[1].toLowerCase()) ?? manifestMatch[1];
          const def = registry.agents.get(canonical);
          if (!def) return json(res, 404, { error: "unknown agent" });
          const body = JSON.parse(await readBody(req)) as { field?: unknown; value?: unknown };
          if (typeof body.field !== "string" || (typeof body.value !== "string" && typeof body.value !== "number")) {
            return json(res, 400, { error: "field (string) and value (string | number) required" });
          }
          const yamlPath = agentYamlPath(config.agentsDir, def);
          if (!yamlPath) return json(res, 500, { error: `agent yaml not found for ${canonical}` });
          let next: string;
          try {
            next = spliceManifestField(readFileSync(yamlPath, "utf8"), body.field, body.value);
          } catch (err) {
            return json(res, 400, { error: (err as Error).message });
          }
          writeFileSync(yamlPath, next);
          reloadPacks(); // registry maps mutate in place; a throw here = 500 but the file is valid yaml
          log(`persona edit: ${canonical}.${body.field}`);
          return json(res, 200, buildAgentProfile(canonical, registry, store, bus));
        }
```

- [ ] **Step 3: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean / green. (Routes are thin and untested per repo convention — the builders they call are covered by Tasks 1-3.)

- [ ] **Step 4: Commit**

```bash
git add src/web/server.ts
git commit -m "feat(web): persona explorer routes — agent activity GET, manifest PATCH"
```

---

### Task 5: ui2 api client + StaffProfile extraction with sub-tabs

**Files:**
- Modify: `ui2/src/api.ts`
- Create: `ui2/src/views/StaffProfile.tsx`
- Modify: `ui2/src/views/Staff.tsx`

**Interfaces:**
- Consumes: routes from Task 4; `AgentActivityInfo`, `AgentProfileInfo` from dto.
- Produces: `api.agentActivity(name)`, `api.patchAgentManifest(name, field, value)`; `<StaffProfile name events route onOpenChat>` component reading `route.parts[2]` as the sub-tab (`undefined` | `"activity"` | `"edit"`) — consumed by Tasks 6-8.

- [ ] **Step 1: api client additions**

In `ui2/src/api.ts`: add `AgentActivityInfo` to BOTH the `export type {...}` list and the `import type {...}` list. In the `api` object next to `agent:`:

```ts
  agentActivity: (name: string) =>
    request<AgentActivityInfo>(`/api/agents/${encodeURIComponent(name)}/activity`),
  patchAgentManifest: (name: string, field: string, value: string | number) =>
    request<AgentProfileInfo>(`/api/agents/${encodeURIComponent(name)}/manifest`, {
      method: "PATCH", body: JSON.stringify({ field, value }),
    }),
```

- [ ] **Step 2: Move Profile out of Staff.tsx**

Create `ui2/src/views/StaffProfile.tsx`. Move the entire `Profile`, `GrantBox`, and `Sparkline` functions from `Staff.tsx` verbatim (imports: copy what they need — `useState`, `api`, `StoredEvent`, `useLiveQuery`, `T`, `navigate`, `Route`, `Button`, `Dot`, `Empty`, `SectionLabel`, `Tag`, `ts`, `usdFloat`). Rename `Profile` → `StaffProfile` and export it; add `route: Route` to its props and a sub-tab header under the back-link:

```tsx
// ui2/src/views/StaffProfile.tsx — rich persona explorer: overview / activity / edit
// (spec 2026-07-16-persona-explorer). Extracted from Staff.tsx.
export function StaffProfile({ name, events, route, onOpenChat }: {
  name: string; events: StoredEvent[]; route: Route; onOpenChat: (t: string, s?: string) => void;
}) {
  const { data: p, error } = useLiveQuery(() => api.agent(name), events, T.agentsActions, [name]);
  const tab = route.parts[2]; // undefined | "activity" | "edit"
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
        <h2 className="text-[17px] font-bold text-bright">{p.name}</h2>
        <span className="text-dim">{p.title} · {p.department}</span>
        {p.model && <Tag>{p.model}</Tag>}
        <Tag>{p.kind}</Tag>
        {p.visibility === "private" && <Tag>🔒 private</Tag>}
        {p.guarded && <Tag>🛡 guarded</Tag>}
        <Button className="ml-auto" variant="primary" onClick={() => onOpenChat(p.name)}>Chat ⌘J</Button>
      </div>
      {p.aliases.length > 0 && <div className="text-[11px] text-dim mb-2">aka {p.aliases.join(", ")}</div>}
      <div className="flex gap-3 mb-4">
        <button onClick={() => navigate(`staff/agents/${name}`)}
          className={`label hover:text-fg ${!tab ? "text-strong" : ""}`}>overview</button>
        <button onClick={() => navigate(`staff/agents/${name}/activity`)}
          className={`label hover:text-fg ${tab === "activity" ? "text-strong" : ""}`}>activity</button>
        <button onClick={() => navigate(`staff/agents/${name}/edit`)}
          className={`label hover:text-fg ${tab === "edit" ? "text-strong" : ""}`}>edit</button>
      </div>
      {tab === "activity" ? <Activity name={p.name} events={events} />
        : tab === "edit" ? <EditManifest profile={p} />
        : <Overview p={p} note={note} propose={propose} />}
    </div>
  );
}
```

For this task, `Overview` is a new function in the same file holding the existing profile body verbatim (charter paragraph, Access section + GrantBox, Trust, Recent runs, Cost sparkline — cut from the old `Profile` return); `Activity` and `EditManifest` are placeholders rendering `<Empty>soon</Empty>` (replaced in Tasks 7-8):

```tsx
function Overview({ p, note, propose }: {
  p: AgentProfileInfo; note: string; propose: (tool: string, action: "grant" | "revoke") => void;
}) {
  return (
    <>
      <p className="text-fg leading-relaxed mb-5 whitespace-pre-wrap">{p.charter}</p>
      {/* ...Access / GrantBox / note / Trust / Recent runs / Cost by day — moved verbatim... */}
    </>
  );
}

function Activity({ name, events }: { name: string; events: StoredEvent[] }) {
  return <Empty>soon</Empty>;
}

function EditManifest({ profile }: { profile: AgentProfileInfo }) {
  return <Empty>soon</Empty>;
}
```

(`AgentProfileInfo` is exported from `../api.js`.) Unused-param lint on placeholders is fine — they're replaced two tasks later; if the build complains, prefix params with `_`.

In `Staff.tsx`: delete `Profile`, `GrantBox`, `Sparkline` (and now-unused imports), add `import { StaffProfile } from "./StaffProfile.js";`, and change the render branch to:

```tsx
      {sub === "agents" && route.parts[1]
        ? <StaffProfile name={route.parts[1]} events={events} route={route} onOpenChat={onOpenChat} />
        : sub === "governance"
          ? <Governance events={events} />
          : <OrgColumns events={events} />}
```

- [ ] **Step 3: Typecheck + ui2 suite + build**

Run from `ui2/`: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: clean / green / builds.

- [ ] **Step 4: Commit**

```bash
git add ui2/src/api.ts ui2/src/views/Staff.tsx ui2/src/views/StaffProfile.tsx
git commit -m "feat(ui2): extract StaffProfile with overview/activity/edit sub-tabs + api client"
```

---

### Task 6: Overview enrichment — persona, prompt, capabilities, skills, handoffs

**Files:**
- Modify: `ui2/src/views/StaffProfile.tsx` (the `Overview` function)

**Interfaces:**
- Consumes: `AgentProfileInfo.persona/prompt/capabilities/skills/handoffs` (Task 1 fields + long-unrendered DTO fields).
- Produces: complete overview tab.

- [ ] **Step 1: Add the new sections to Overview**

In `Overview`, directly under the charter paragraph:

```tsx
      <p className="text-[13px] text-dim leading-relaxed mb-4 whitespace-pre-wrap">{p.persona}</p>

      {p.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {p.capabilities.map((c) => <Tag key={c}>{c}</Tag>)}
        </div>
      )}

      {p.skills.length > 0 && (
        <>
          <SectionLabel>Skills</SectionLabel>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {p.skills.map((s) => (
              <button key={s} onClick={() => navigate(`skills/${s}`)}><Tag tone="ok">{s}</Tag></button>
            ))}
          </div>
        </>
      )}

      <details className="mb-5">
        <summary className="label cursor-pointer hover:text-fg">system prompt</summary>
        <pre className="font-mono text-[11px] text-dim whitespace-pre-wrap mt-2 p-3 card">{p.prompt}</pre>
      </details>
```

And after the Recent runs section, before Cost by day:

```tsx
      <SectionLabel>Handoffs</SectionLabel>
      <div className="mb-5">
        {p.handoffs.slice(0, 10).map((h, i) => (
          <div key={i} className="flex gap-3 text-[12px] py-1 items-center">
            <span className="text-dim">{ts(h.ts)}</span>
            <span className="truncate">{h.reason}</span>
            <span className="text-dim ml-auto">{h.channel}</span>
          </div>
        ))}
        {p.handoffs.length === 0 && <span className="text-[12px] text-dim">none yet</span>}
      </div>
```

- [ ] **Step 2: Typecheck + build**

Run from `ui2/`: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui2/src/views/StaffProfile.tsx
git commit -m "feat(ui2): profile overview — persona, prompt, capabilities, skills, handoffs"
```

---

### Task 7: Activity tab

**Files:**
- Modify: `ui2/src/views/StaffProfile.tsx` (replace the `Activity` placeholder)

**Interfaces:**
- Consumes: `api.agentActivity(name)` (Task 5), `AgentActivityInfo` (Task 1), `useLiveQuery`, `T` from `../lib/topics.js`.
- Produces: activity tab — timeline, goals, mail.

- [ ] **Step 1: Implement Activity**

Replace the placeholder (add `AgentActivityInfo` to the api import if needed; `Dot` is already imported):

```tsx
/** Everything that can add a timeline/goals/mail row for an agent. */
const ACTIVITY_TOPICS = [...T.agentsActions, ...T.agentMail, ...T.goals] as const;

const TIMELINE_TONE = { run: "ok", route: "accent", mail: "agent", goal: "dim" } as const;

function Activity({ name, events }: { name: string; events: StoredEvent[] }) {
  const { data: a, error } = useLiveQuery(() => api.agentActivity(name), events, ACTIVITY_TOPICS, [name]);
  if (error) return <Empty>{error}</Empty>;
  if (!a) return <Empty>Loading…</Empty>;
  return (
    <>
      <SectionLabel>Timeline</SectionLabel>
      <div className="mb-5">
        {a.timeline.map((t, i) => (
          <div key={i} className="flex gap-3 text-[12px] py-1 items-center">
            <Dot tone={t.ok === false ? "err" : TIMELINE_TONE[t.kind]} />
            <span className="text-dim">{ts(t.ts)}</span>
            <span className="text-[10px] text-dim w-10">{t.kind}</span>
            <span className="truncate">{t.summary}</span>
          </div>
        ))}
        {a.timeline.length === 0 && <span className="text-[12px] text-dim">no activity yet</span>}
      </div>

      <SectionLabel>Goals</SectionLabel>
      <div className="mb-5">
        {a.goals.map((g) => (
          <div key={g.goalId} className="card px-3 py-2 mb-1.5">
            <div className="flex gap-2 items-center text-[13px]">
              <span className="text-strong truncate">{g.title}</span>
              <Tag tone={g.status === "done" ? "ok" : g.status === "failed" ? "err" : "accent"}>{g.status}</Tag>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {g.nodes.map((n) => (
                <Tag key={n.key} tone={n.status === "done" ? "ok" : n.status === "failed" ? "err" : "dim"}>
                  {n.key} · {n.status}
                </Tag>
              ))}
            </div>
          </div>
        ))}
        {a.goals.length === 0 && <span className="text-[12px] text-dim">no goal work yet</span>}
      </div>

      <SectionLabel>Mail</SectionLabel>
      <div className="mb-5">
        {a.mail.map((m) => (
          <div key={m.id} className="flex gap-3 text-[12px] py-1 items-center">
            <span className="text-dim">{ts(m.ts)}</span>
            <span className="text-strong">{m.from} → {m.to}</span>
            <Tag>{m.kind}</Tag>
            <span className="truncate text-dim">{m.snippet}</span>
          </div>
        ))}
        {a.mail.length === 0 && <span className="text-[12px] text-dim">no mail yet</span>}
      </div>
    </>
  );
}
```

Check the `Dot` component's accepted tones in `ui2/src/components/ui.tsx` before using `"accent"`/`"agent"`/`"ok"`/`"err"`/`"dim"` — adjust `TIMELINE_TONE` values to tones that exist.

- [ ] **Step 2: Typecheck + build**

Run from `ui2/`: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui2/src/views/StaffProfile.tsx
git commit -m "feat(ui2): profile activity tab — timeline, goals, mail"
```

---

### Task 8: Edit tab — per-field manifest editing

**Files:**
- Modify: `ui2/src/views/StaffProfile.tsx` (replace the `EditManifest` placeholder)

**Interfaces:**
- Consumes: `api.patchAgentManifest` (Task 5); `AgentProfileInfo.title/charter/persona/prompt/model/maxTurns`.
- Produces: edit tab with six independently-savable fields.

- [ ] **Step 1: Implement EditManifest**

Replace the placeholder:

```tsx
function EditManifest({ profile }: { profile: AgentProfileInfo }) {
  return (
    <div className="flex flex-col gap-4 mb-5">
      <div className="text-[11px] text-dim">
        Edits splice the agent's YAML in place and reload the registry. Structural fields
        (name, department, capabilities, tools, skills) are managed elsewhere.
      </div>
      <Field agent={profile.name} field="title" initial={profile.title} />
      <Field agent={profile.name} field="model" initial={profile.model ?? ""}
        hint="empty is rejected — removing the key stays a YAML-file operation" />
      <Field agent={profile.name} field="maxTurns" initial={String(profile.maxTurns)} number />
      <Field agent={profile.name} field="charter" initial={profile.charter} multiline />
      <Field agent={profile.name} field="persona" initial={profile.persona} multiline />
      <Field agent={profile.name} field="prompt" initial={profile.prompt} multiline />
    </div>
  );
}

function Field({ agent, field, initial, multiline, number, hint }: {
  agent: string; field: string; initial: string; multiline?: boolean; number?: boolean; hint?: string;
}) {
  const [val, setVal] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [note, setNote] = useState("");
  const dirty = val !== saved;

  const save = async () => {
    setNote("");
    try {
      await api.patchAgentManifest(agent, field, number ? Number(val) : val);
      setSaved(val);
      setNote("saved");
    } catch (err) { setNote((err as Error).message); }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <SectionLabel>{field}</SectionLabel>
        {hint && <span className="text-[10px] text-dim">{hint}</span>}
        {dirty && <Button className="ml-auto" variant="primary" onClick={() => void save()}>Save</Button>}
        {note && <span className={`text-[11px] ${note === "saved" ? "text-dim" : "text-err"} ${dirty ? "" : "ml-auto"}`}>{note}</span>}
      </div>
      {multiline ? (
        <textarea value={val} onChange={(e) => { setVal(e.target.value); setNote(""); }} spellCheck={false}
          className="font-mono text-[12px] bg-bg border border-line rounded-md p-3 h-32 outline-none focus:border-dim" />
      ) : (
        <input value={val} onChange={(e) => { setVal(e.target.value); setNote(""); }}
          className="bg-bg border border-line rounded-md px-2 py-1 text-[12px] outline-none focus:border-dim w-64" />
      )}
    </div>
  );
}
```

Note: `Field` seeds state from `initial` on mount only — after a save, `saved` tracks the new baseline locally, so the parent's `useLiveQuery` refresh (which re-renders with fresh profile data) doesn't need to remount it. Key the fields by agent so switching agents resets state: in `EditManifest`, wrap the six `<Field>`s with `key={profile.name + field}` — i.e. `<Field key={profile.name + "-title"} .../>` etc.

- [ ] **Step 2: Typecheck + ui2 suite + build**

Run from `ui2/`: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: clean / green / builds.

- [ ] **Step 3: Commit**

```bash
git add ui2/src/views/StaffProfile.tsx
git commit -m "feat(ui2): profile edit tab — per-field manifest editing via splice PATCH"
```

---

### Task 9: Deploy + live smoke verification

**Files:** none (verification only)

- [ ] **Step 1: Full test + typecheck sweep**

```bash
cd /Users/ihabbishara/projects/AIOS && npx vitest run && npx tsc --noEmit \
  && cd ui2 && npx vitest run && npx tsc --noEmit && cd ..
```
Expected: root suite green (1224+ tests), ui2 suite green (43+), both tsc clean.

- [ ] **Step 2: Build + restart daemon**

```bash
npm run build && cd ui2 && npm run build && cd .. \
  && launchctl kickstart -k gui/501/com.ihab.aios && sleep 5
```
(The sleep matters — curl exits 7 if you smoke immediately after kickstart.)

- [ ] **Step 3: Smoke the activity route**

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/agents/athena/activity | head -c 400
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/agents/nobody/activity
```
Expected: JSON with `timeline`/`goals`/`mail` keys; then `404`.

- [ ] **Step 4: Idempotent live PATCH (safe write-path proof)**

PATCH `title` with its CURRENT value, then verify the file diff is confined to that one line:

```bash
CURRENT=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/agents/athena | python3 -c "import json,sys; print(json.load(sys.stdin)['title'])")
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"field\":\"title\",\"value\":\"$CURRENT\"}" http://localhost:4280/api/agents/athena/manifest | head -c 200
git diff --stat agents/
```
Expected: PATCH returns the profile JSON; `git diff` shows either nothing or `agents/engineering/athena.yaml | 2 +-`-class single-line churn (title line only). If more lines changed, the splice is broken — stop and fix before pushing. Revert any diff: `git checkout -- agents/`.

- [ ] **Step 5: Validation smoke (400 paths)**

```bash
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"field":"name","value":"loki"}' http://localhost:4280/api/agents/athena/manifest
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"field":"maxTurns","value":0}' http://localhost:4280/api/agents/athena/manifest
```
Expected: `{"error":"field \"name\" is not editable"}` and `{"error":"maxTurns must be a positive integer"}`.

- [ ] **Step 6: UI eyeball**

Open `http://localhost:4280/#/staff/agents/athena` — check overview shows persona/prompt/capabilities/skills/handoffs, activity tab renders three sections, edit tab saves a field (edit title, save, revert it, save again; confirm `git diff agents/` is clean after the revert).

- [ ] **Step 7: Push**

```bash
git push origin main
```

---

## Self-Review Notes

- Spec coverage: DTO additions (T1), buildAgentActivity (T2), spliceManifestField (T3), routes (T4), StaffProfile + sub-tabs + api client (T5), overview enrichment (T6), activity tab (T7), edit tab (T8), verification incl. idempotent PATCH + zero-diff check (T9). Spec's "loader adds file path" was superseded — `agentYamlPath` in skills-view.ts already resolves manifest paths and T4 reuses it.
- Block-scalar style deviation from spec noted inline in T3: multi-line values use `|` (literal) instead of `>` because folding silently collapses user line breaks; single-line values keep `>` house style.
- Type consistency: `AgentActivityInfo` field names (`timeline/goals/mail`, `snippet`, `goalId`, `key`) match across T1 DTO, T2 builder, T7 UI. `patchAgentManifest` signature matches T4 body shape `{field, value}`.
