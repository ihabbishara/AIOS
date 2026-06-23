# Research Pillar Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `research` pillar pack — a conversational `analyst` role + a hybrid knowledge base (second-brain recall over the `research` domain + a `research_sources` citation table) — binding the existing read-only research playbooks into the pillar.

**Architecture:** A new `research_sources` SQLite table + a `research` MCP tool server (save/list/search sources, direct/ungated, mirroring the money server) registered via the existing `ResolveDeps.toolServers` builder hook. A new `analyst` RoleDef. A `playbooks/research/pack.yaml` manifest that owns the three moved playbooks (`research-report`, `market-research`, `product-design`). Retrieval reuses the second brain: the analyst writes findings to the vault `knowledge/` section, which `domainForVaultPath` already maps to the `research` memo domain, so `recall(query, "research")` returns them — no indexer change.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 23 `node:sqlite`, vitest (backend), `@anthropic-ai/claude-agent-sdk` (`tool`/`createSdkMcpServer`), zod. Subscription auth, no API keys.

## Global Constraints

- Node 23 built-in `node:sqlite` only; subscription auth, no API keys. ESM: every relative import ends in `.js`.
- Backend tests: `import { describe, it, expect } from "vitest"`; run `npx vitest run <file>`.
- Commit EXPLICIT paths only (`git add <path> …`) — NEVER `git add -A`. The working tree is clean at the branch base; keep commits scoped to the listed paths.
- Work in the isolated worktree's absolute path (off clean committed HEAD).
- **No DB migration** — the only schema change is `CREATE TABLE IF NOT EXISTS research_sources` in the existing init path (idempotent on the live prod DB; no `ALTER`).
- The pack is **shareable** (no `privateOnly`, no group-refusal) and **NOT sandboxed** (no `sandbox` flag).
- `actions: [vault.write]` is the only gated ceiling. `research_sources` writes are direct/ungated (local-DB CRUD, mirroring the money server).
- Mirror existing patterns: the money server (`src/money/server.ts`), money Store methods + table (`src/store/db.ts`), the `cfo` RoleDef, and the money toolServer registration (`src/index.ts:168`).
- Money + code packs must stay byte-for-byte unaffected at runtime (their manifests untouched; only additive shared read-only roles).

**Module map.** New: `src/research/server.ts` (MCP tool server), `playbooks/research/pack.yaml` (manifest), `playbooks/research/{research-report,market-research,product-design}.yaml` (moved). Modified: `src/store/db.ts` (`research_sources` table + 3 Store methods + `ResearchSourceRow`), `src/agents/roles/index.ts` (`analyst` RoleDef), `src/index.ts` (register the `research` toolServer builder), `test/playbook.test.ts` (drop the 3 moved playbooks from the top-level `loadPlaybooks` assertion).

---

### Task 1: `research_sources` table + Store methods

**Files:**
- Modify: `src/store/db.ts` (add `ResearchSourceRow`, the `CREATE TABLE`, and 3 methods)
- Test: `test/research-sources.test.ts`

**Interfaces:**
- Produces:
  - `interface ResearchSourceRow { id: number; url: string; title: string; topic: string | null; note: string | null; created_at: string; }`
  - `Store.addResearchSource(s: { url: string; title: string; topic?: string | null; note?: string | null }): void` — upsert by `url`, preserving `created_at`.
  - `Store.listResearchSources(topic?: string): ResearchSourceRow[]` — all or topic-filtered, newest-first.
  - `Store.searchResearchSources(query: string): ResearchSourceRow[]` — case-insensitive `LIKE` over title/url/topic/note, newest-first.

- [ ] **Step 1: Write the failing test**

```ts
// test/research-sources.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

describe("research_sources Store", () => {
  it("adds and lists a source", () => {
    const s = new Store(":memory:");
    s.addResearchSource({ url: "https://a.com", title: "A", topic: "llm", note: "n" });
    const all = s.listResearchSources();
    expect(all.length).toBe(1);
    expect(all[0]).toMatchObject({ url: "https://a.com", title: "A", topic: "llm", note: "n" });
    expect(typeof all[0].created_at).toBe("string");
  });

  it("upserts by url, preserving created_at and updating title/topic/note", () => {
    const s = new Store(":memory:");
    s.addResearchSource({ url: "https://a.com", title: "A", topic: "llm" });
    const first = s.listResearchSources()[0];
    s.addResearchSource({ url: "https://a.com", title: "A2", topic: "agents", note: "added" });
    const rows = s.listResearchSources();
    expect(rows.length).toBe(1); // still one row (upsert, not insert)
    expect(rows[0].title).toBe("A2");
    expect(rows[0].topic).toBe("agents");
    expect(rows[0].note).toBe("added");
    expect(rows[0].created_at).toBe(first.created_at); // preserved
  });

  it("filters by topic, newest first", () => {
    const s = new Store(":memory:");
    s.addResearchSource({ url: "https://a.com", title: "A", topic: "llm" });
    s.addResearchSource({ url: "https://b.com", title: "B", topic: "ops" });
    s.addResearchSource({ url: "https://c.com", title: "C", topic: "llm" });
    const llm = s.listResearchSources("llm");
    expect(llm.map((r) => r.url)).toEqual(["https://c.com", "https://a.com"]); // newest (higher id) first
  });

  it("searches case-insensitively across title/url/topic/note", () => {
    const s = new Store(":memory:");
    s.addResearchSource({ url: "https://example.com/Vector", title: "Embeddings", topic: "ml", note: "BM25 vs ANN" });
    expect(s.searchResearchSources("vector").map((r) => r.title)).toEqual(["Embeddings"]); // matches url
    expect(s.searchResearchSources("BM25").map((r) => r.title)).toEqual(["Embeddings"]); // matches note
    expect(s.searchResearchSources("nope")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/research-sources.test.ts`
Expected: FAIL — `addResearchSource` is not a function (and the table doesn't exist).

- [ ] **Step 3: Implement**

In `src/store/db.ts`, add the row interface near the other row interfaces (e.g. after `BudgetRow` ~line 105):
```ts
export interface ResearchSourceRow { id: number; url: string; title: string; topic: string | null; note: string | null; created_at: string; }
```

In the table-init `this.db.exec(...)` block (alongside the other `CREATE TABLE IF NOT EXISTS`, e.g. right after the `personal_budgets` block ~line 287):
```sql
      CREATE TABLE IF NOT EXISTS research_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        topic TEXT,
        note TEXT,
        created_at TEXT NOT NULL
      );
```

Add the three methods (near the money Store methods, e.g. after `listBudgets` ~line 832):
```ts
  addResearchSource(s: { url: string; title: string; topic?: string | null; note?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO research_sources (url, title, topic, note, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET title=excluded.title, topic=excluded.topic, note=excluded.note`,
      )
      .run(s.url, s.title, s.topic ?? null, s.note ?? null, new Date().toISOString());
  }

  listResearchSources(topic?: string): ResearchSourceRow[] {
    return (
      topic
        ? this.db.prepare("SELECT * FROM research_sources WHERE topic = ? ORDER BY created_at DESC, id DESC").all(topic)
        : this.db.prepare("SELECT * FROM research_sources ORDER BY created_at DESC, id DESC").all()
    ) as unknown as ResearchSourceRow[];
  }

  searchResearchSources(query: string): ResearchSourceRow[] {
    const q = `%${query.toLowerCase()}%`;
    return this.db
      .prepare(
        `SELECT * FROM research_sources
         WHERE lower(title) LIKE ? OR lower(url) LIKE ? OR lower(coalesce(topic,'')) LIKE ? OR lower(coalesce(note,'')) LIKE ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(q, q, q, q) as unknown as ResearchSourceRow[];
  }
```

- [ ] **Step 4: Run test + type-check**

Run: `npx vitest run test/research-sources.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests) + clean tsc.

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts test/research-sources.test.ts
git commit -m "feat(research-pack): research_sources table + Store accessors (upsert/list/search)"
```

---

### Task 2: `research` MCP tool server + registration

**Files:**
- Create: `src/research/server.ts`
- Modify: `src/index.ts` (register the `research` toolServer builder)
- Test: `test/research-server.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 1 methods); `tool`/`createSdkMcpServer` from `@anthropic-ai/claude-agent-sdk`.
- Produces: `buildResearchServer(deps: { store: Store })` → an SDK MCP server named `research` with tools `save_source`, `list_sources`, `search_sources`.

- [ ] **Step 1: Write the failing test**

```ts
// test/research-server.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { buildResearchServer } from "../src/research/server.js";

// The SDK wraps tools; reach the handler via the server's tool list.
function handlersOf(server: any): Record<string, (args: any) => Promise<any>> {
  const out: Record<string, (args: any) => Promise<any>> = {};
  for (const t of server.instance?.tools ?? server.tools ?? []) out[t.name] = t.handler;
  return out;
}

describe("research MCP server", () => {
  it("save_source persists, list_sources + search_sources read back", async () => {
    const store = new Store(":memory:");
    const server = buildResearchServer({ store });
    const h = handlersOf(server);
    // Fallback: if the SDK shape differs, drive the Store directly to assert wiring intent.
    if (h.save_source) {
      await h.save_source({ url: "https://x.com", title: "X", topic: "t", note: "n" });
    } else {
      store.addResearchSource({ url: "https://x.com", title: "X", topic: "t", note: "n" });
    }
    expect(store.listResearchSources().map((r) => r.url)).toContain("https://x.com");
    expect(store.searchResearchSources("x").length).toBe(1);
  });

  it("exposes the three tools", () => {
    const store = new Store(":memory:");
    const server = buildResearchServer({ store });
    const names = (server.instance?.tools ?? server.tools ?? []).map((t: any) => t.name).sort();
    expect(names).toEqual(["list_sources", "save_source", "search_sources"]);
  });
});
```

> Note on the test: the SDK's `createSdkMcpServer` return shape is what `buildMoneyServer` returns; the helper reads `.instance?.tools ?? .tools`. If neither exposes handlers in this SDK version, the first test still asserts the Store-level contract (the second test asserts the tool names off whichever list is present). Inspect what `buildMoneyServer(...)` returns at runtime if the shape surprises you, and adjust the accessor — do not weaken the assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/research-server.test.ts`
Expected: FAIL — module `../src/research/server.js` not found.

- [ ] **Step 3: Implement the server**

```ts
// src/research/server.ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store/db.js";

function text(s: string) { return { content: [{ type: "text" as const, text: s }] }; }

function fmt(rows: { url: string; title: string; topic: string | null; note: string | null }[]): string {
  return rows.map((r) => `  ${r.title} — ${r.url}${r.topic ? ` [${r.topic}]` : ""}${r.note ? `\n    ${r.note}` : ""}`).join("\n") || "(none)";
}

export interface ResearchServerDeps { store: Store; }

/** Direct-CRUD MCP server for the research analyst's source library. Analysis-only — no gate, no outward effects. */
export function buildResearchServer(deps: ResearchServerDeps) {
  const { store } = deps;

  const saveSource = tool(
    "save_source",
    "Save (or update) a research source in the knowledge base, keyed by URL.",
    { url: z.string(), title: z.string(), topic: z.string().optional(), note: z.string().optional() },
    async (a) => { store.addResearchSource({ url: a.url, title: a.title, topic: a.topic ?? null, note: a.note ?? null }); return text(`Saved source: ${a.title} (${a.url}).`); },
  );

  const listSources = tool(
    "list_sources",
    "List saved research sources, optionally filtered by exact topic.",
    { topic: z.string().optional() },
    async (a) => text(fmt(store.listResearchSources(a.topic))),
  );

  const searchSources = tool(
    "search_sources",
    "Search saved research sources by keyword (matches title, url, topic, note).",
    { query: z.string() },
    async (a) => text(fmt(store.searchResearchSources(a.query))),
  );

  return createSdkMcpServer({ name: "research", version: "0.1.0", tools: [saveSource, listSources, searchSources] });
}
```

- [ ] **Step 4: Register the builder in `src/index.ts`**

Add the import alongside `import { buildMoneyServer } from "./money/server.js";` (~line 44):
```ts
import { buildResearchServer } from "./research/server.js";
```
Extend the `toolServers` map passed to `makeResolvePackFor` (~line 168) — currently `{ money: (d) => buildMoneyServer({ store: d.store, categorize }) }`:
```ts
        toolServers: {
          money: (d) => buildMoneyServer({ store: d.store, categorize }),
          research: (d) => buildResearchServer({ store: d.store }),
        },
```

- [ ] **Step 5: Run test + type-check**

Run: `npx vitest run test/research-server.test.ts && npx tsc --noEmit`
Expected: PASS + clean tsc.

- [ ] **Step 6: Commit**

```bash
git add src/research/server.ts src/index.ts test/research-server.test.ts
git commit -m "feat(research-pack): research MCP tool server (save/list/search source) + register"
```

---

### Task 3: `analyst` role

**Files:**
- Modify: `src/agents/roles/index.ts` (add the `analyst` RoleDef)
- Test: `test/research-analyst-role.test.ts`

**Interfaces:**
- Consumes: the `roles` record + `RoleDef` shape (existing). `READ_TOOLS`, `WEB_TOOLS` consts (already in the file).
- Produces: `roles.analyst` — a shareable conversational research role.

- [ ] **Step 1: Write the failing test**

```ts
// test/research-analyst-role.test.ts
import { describe, it, expect } from "vitest";
import { roles } from "../src/agents/roles/index.js";

describe("analyst role", () => {
  it("exists, is shareable, and is read/web/recall oriented", () => {
    const a = roles.analyst;
    expect(a).toBeTruthy();
    expect(a.privateOnly).toBeFalsy(); // shareable — unlike cfo
    expect(a.allowedTools).toContain("WebSearch");
    expect(a.allowedTools).toContain("recall");
    expect(a.allowedTools).toContain("mcp__research__save_source");
    // read-only posture: no Bash/Edit/Write
    expect(a.allowedTools).not.toContain("Bash");
    expect(a.allowedTools).not.toContain("Write");
    expect(a.systemPrompt).toMatch(/knowledge\//); // persists findings under knowledge/
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/research-analyst-role.test.ts`
Expected: FAIL — `roles.analyst` is undefined.

- [ ] **Step 3: Implement**

In `src/agents/roles/index.ts`, add to the `roles` record (e.g. after the `cfo` entry). `READ_TOOLS` and `WEB_TOOLS` are the consts already used by `researcher` in this file:
```ts
  analyst: {
    name: "analyst",
    description: "Research analyst + knowledge librarian — recalls past research, cites + saves sources, builds the knowledge base.",
    systemPrompt:
      "You are the user's research analyst and knowledge librarian in a multi-agent system. " +
      "Before answering, ALWAYS `recall` existing research (your domain is `research`) so you build on " +
      "what is already known instead of repeating work. Investigate with web search and provided files; " +
      "distinguish established facts from inference and cite URLs. When you find a useful source, save it " +
      "with `save_source` (url + title + topic); use `list_sources`/`search_sources` to reuse them. " +
      "Persist durable findings as vault notes UNDER `knowledge/` (e.g. `knowledge/<topic>.md`) via " +
      "`vault_write` — notes under `knowledge/` enter your `research` recall index; do not write them " +
      "elsewhere. Be concise and concrete.",
    allowedTools: [
      ...READ_TOOLS,
      ...WEB_TOOLS,
      "recall",
      "vault_read",
      "vault_write",
      "mcp__research__save_source",
      "mcp__research__list_sources",
      "mcp__research__search_sources",
    ],
    permissionMode: "dontAsk",
    maxTurns: 25,
  },
```
> `permissionMode: "dontAsk"` matches the other read-only specialist roles (`researcher`, `cfo`) and is headless-safe; `vault_write` is still gated through the Action Gate regardless of permission mode (the `aios-pack` server routes it to `propose_action vault.write`). This refines the spec's "default" — record it in your report.

- [ ] **Step 4: Run test + type-check**

Run: `npx vitest run test/research-analyst-role.test.ts && npx tsc --noEmit`
Expected: PASS + clean tsc.

- [ ] **Step 5: Commit**

```bash
git add src/agents/roles/index.ts test/research-analyst-role.test.ts
git commit -m "feat(research-pack): analyst role (shareable research librarian, knowledge/ write path)"
```

---

### Task 4: Pack manifest + move the three playbooks

**Files:**
- Create: `playbooks/research/pack.yaml`
- Move (git mv): `playbooks/research-report.yaml` → `playbooks/research/research-report.yaml`; `playbooks/market-research.yaml` → `playbooks/research/market-research.yaml`; `playbooks/product-design.yaml` → `playbooks/research/product-design.yaml`
- Modify: `test/playbook.test.ts` (top-level `loadPlaybooks` no longer sees the 3 moved files)
- Test: `test/research-pack.test.ts`

**Interfaces:**
- Consumes: `loadPacks` (`src/packs/loader.js`), `dropPack` (Task-1-of-the-prior-cycle generalized kill-switch), `packSchema` (`src/packs/types.js`).
- Produces: the on-disk `research` pillar pack (no new exported symbols).

- [ ] **Step 1: Move the playbooks**

```bash
git mv playbooks/research-report.yaml playbooks/research/research-report.yaml
git mv playbooks/market-research.yaml playbooks/research/market-research.yaml
git mv playbooks/product-design.yaml playbooks/research/product-design.yaml
```
> `git mv` creates `playbooks/research/` and stages the moves. The YAML contents are unchanged.

- [ ] **Step 2: Create the manifest**

```yaml
# playbooks/research/pack.yaml
pillar: research
persona: |
  You are the user's research analyst and knowledge librarian. Investigate topics deeply, always
  recalling existing research first, and cite your sources. Save durable findings to the knowledge
  base (vault notes under knowledge/) and track sources. Distinguish established facts from
  inference. Be concise.
memoDomain: research
vaultSection: knowledge
toolServer: research
roles: [analyst, researcher, market-researcher, ui-ux-designer, reviewer]
actions: [vault.write]
tools:
  - Read
  - Grep
  - Glob
  - WebSearch
  - WebFetch
  - TodoWrite
  - mcp__research__save_source
  - mcp__research__list_sources
  - mcp__research__search_sources
  - recall
  - vault_read
  - vault_write
playbooks: [research-report, market-research, product-design]
```

- [ ] **Step 3: Write the failing test**

```ts
// test/research-pack.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { loadPacks, dropPack } from "../src/packs/loader.js";

const PB = join(process.cwd(), "playbooks");

describe("research pack", () => {
  it("registers the research pillar from disk", () => {
    const reg = loadPacks(PB);
    const pack = reg.packs.get("research")!;
    expect(pack).toBeTruthy();
    expect(pack.toolServer).toBe("research");
    expect(pack.actions).toEqual(["vault.write"]);
    expect(pack.sandbox).toBeFalsy();
    expect(pack.memoDomain).toBe("research");
    expect(pack.vaultSection).toBe("knowledge");
    // owns its three playbooks via pillarOf
    for (const pb of ["research-report", "market-research", "product-design"]) {
      expect(reg.pillarOf.get(pb)).toBe("research");
      expect(reg.playbooks.has(pb)).toBe(true);
    }
  });

  it("binds solo roles to research; shared roles (also in code) drop from roleOf", () => {
    const reg = loadPacks(PB);
    expect(reg.roleOf.get("analyst")).toBe("research");
    expect(reg.roleOf.get("market-researcher")).toBe("research");
    expect(reg.roleOf.get("ui-ux-designer")).toBe("research");
    // researcher + reviewer are in BOTH code and research → no single owner → absent from roleOf
    expect(reg.roleOf.has("researcher")).toBe(false);
    expect(reg.roleOf.has("reviewer")).toBe(false);
  });

  it("leaves money + code packs intact", () => {
    const reg = loadPacks(PB);
    expect(reg.packs.get("money")?.toolServer).toBe("money");
    expect(reg.packs.get("code")?.sandbox).toBe(true);
    expect(reg.roleOf.get("cfo")).toBe("money");
    expect(reg.roleOf.get("devops")).toBe("code");
  });

  it("AIOS_RESEARCH_DISABLED drops the research pack + its playbooks + solo roleOf", () => {
    const reg = loadPacks(PB);
    dropPack(reg, "research");
    expect(reg.packs.has("research")).toBe(false);
    expect(reg.playbooks.has("research-report")).toBe(false);
    expect(reg.pillarOf.has("research-report")).toBe(false);
    expect(reg.roleOf.has("analyst")).toBe(false);
    expect(reg.roleOf.has("market-researcher")).toBe(false);
    // code + money survive
    expect(reg.packs.has("code")).toBe(true);
    expect(reg.packs.has("money")).toBe(true);
  });
});
```

- [ ] **Step 4: Run test to verify it fails (and observe the playbook.test.ts break)**

Run: `npx vitest run test/research-pack.test.ts test/playbook.test.ts`
Expected: `research-pack.test.ts` PASSES once the manifest+moves are in place (it needs no new source code — `loadPacks` is generic), BUT `test/playbook.test.ts` now FAILS: its "loads all shipped playbooks" assertion lists the 3 moved files, which top-level `loadPlaybooks` no longer sees.
> If `research-pack.test.ts` fails, fix the manifest/move first. The point of this step is to surface the `playbook.test.ts` regression before fixing it in Step 5.

- [ ] **Step 5: Fix `test/playbook.test.ts`**

In `test/playbook.test.ts`, the first test (`loads all shipped playbooks`) asserts the TOP-LEVEL playbooks. After the move, only `echo` and `software-feature` remain top-level. Replace the expected array:
```ts
    expect([...playbooks.keys()].sort()).toEqual([
      "echo",
      "software-feature",
    ]);
```
> `loadPlaybooks` (used only by this test) scans top-level `*.yaml` only. The three moved playbooks now load via `loadPacks` under the `research` pillar — covered by `test/research-pack.test.ts`. Leave the other three tests in `playbook.test.ts` unchanged.

- [ ] **Step 6: Run tests + type-check**

Run: `npx vitest run test/research-pack.test.ts test/playbook.test.ts && npx tsc --noEmit`
Expected: both files PASS + clean tsc.

- [ ] **Step 7: Commit**

```bash
git add playbooks/research/pack.yaml playbooks/research/research-report.yaml playbooks/research/market-research.yaml playbooks/research/product-design.yaml test/research-pack.test.ts test/playbook.test.ts
git commit -m "feat(research-pack): pillar manifest + move research playbooks into playbooks/research/"
```
> The `git mv` already staged the deletions of the old paths; `git add` of the new paths + the tests completes the set. Confirm with `git status` that no other file is staged.

---

### Task 5: Resolve + recall-path + Packs-view integration

**Files:**
- Test: `test/research-resolve.test.ts` (verification of existing generic code with the new manifest)

**Interfaces:**
- Consumes: `loadPacks`, `makeResolvePackFor` (`src/packs/resolve.js`), `buildResearchServer` (Task 2), `buildPacksView` (`src/web/packs-view.js`), `reindexVault` + `recall` (`src/memory/*`), `VaultWriter`, `Store`, `ActionGate`.
- Produces: nothing new — proves the wiring end-to-end.

- [ ] **Step 1: Write the test**

```ts
// test/research-resolve.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPacks } from "../src/packs/loader.js";
import { makeResolvePackFor } from "../src/packs/resolve.js";
import { buildResearchServer } from "../src/research/server.js";
import { buildPacksView } from "../src/web/packs-view.js";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { reindexVault } from "../src/memory/indexer.js";
import { recall } from "../src/memory/recall.js";

const PB = join(process.cwd(), "playbooks");

describe("research pack resolve + recall + view", () => {
  it("resolvePack builds the research mcp server, persona, and replaced tools", () => {
    const reg = loadPacks(PB);
    const store = new Store(":memory:");
    const vaultRoot = mkdtempSync(join(tmpdir(), "rv-"));
    const vault = new VaultWriter(vaultRoot);
    const gate: any = { propose: async () => ({ id: "x" }) };
    const resolve = makeResolvePackFor(reg, { store, vault, gate, toolServers: { research: (d) => buildResearchServer({ store: d.store }) } });
    const resolved = resolve("research-report", { channel: "web", chatId: "t" })!;
    expect(resolved).toBeTruthy();
    expect(resolved.contextBlock).toMatch(/research analyst/i);
    const serverNames = Object.keys(resolved.mcpServers);
    expect(serverNames).toContain("research");
    expect(serverNames).toContain("aios-pack");
  });

  it("a knowledge/ note is recallable in the research domain (KB read path)", () => {
    const store = new Store(":memory:");
    const vaultRoot = mkdtempSync(join(tmpdir(), "rk-"));
    const vault = new VaultWriter(vaultRoot);
    vault.writeNote("knowledge/vector-search", "Vector search uses embeddings and ANN indexes for recall.");
    reindexVault(store, vault);
    const hits = recall(store, "embeddings ANN", { domain: "research" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].ref).toBe("knowledge/vector-search.md");
  });

  it("buildPacksView returns a research card", () => {
    const view = buildPacksView({ playbooksDir: PB, workspaceRoot: join(tmpdir(), "ws"), projectsRoot: tmpdir() } as any, new Store(":memory:"));
    const research = view.find((p) => p.pillar === "research")!;
    expect(research).toBeTruthy();
    expect(research.toolServer).toBe("research");
    expect(research.actions).toEqual(["vault.write"]);
    expect(research.playbooks.map((p) => p.name).sort()).toEqual(["market-research", "product-design", "research-report"]);
    expect(research.roles.map((r) => r.name)).toContain("analyst");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/research-resolve.test.ts`
Expected: PASS — all wiring is generic and already present (resolve threads `toolServer`; the indexer maps `knowledge/` → research; `buildPacksView` scans disk). If the `resolvePack`/`makeResolvePackFor` signature differs from the test's call, read `src/packs/resolve.ts` and match the real signature exactly — do NOT change production code; this task is verification.
> If any assertion fails because of a real wiring gap (not a test-signature mismatch), STOP and report it — that means an earlier task or the framework needs a fix, which is out of this task's file scope.

- [ ] **Step 3: Type-check + commit**

Run: `npx tsc --noEmit`
```bash
git add test/research-resolve.test.ts
git commit -m "test(research-pack): resolve mcp wiring + knowledge/ recall path + Packs card"
```

---

### Task 6: Full verification + build

**Files:** none (verification only)

- [ ] **Step 1: Backend suite + type-check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green (prior baseline + the new `research-sources`, `research-server`, `research-analyst-role`, `research-pack`, `research-resolve`; `playbook.test.ts` updated), tsc clean.

- [ ] **Step 2: Builds**

Run: `npm run build && (cd ui && npm run build)`
Expected: both clean; backend emits `dist/src/research/server.js`.

- [ ] **Step 3: Manual smoke (after deploy or against a running daemon)**

`curl -s localhost:4280/api/packs` → now includes a `research` object (toolServer `research`, 3 playbooks, roles incl `analyst`, actions `[vault.write]`). Open `:4280` → **Packs**: the research card renders. DM `@analyst` privately: it should `recall` (empty at first), web-search, and `save_source`.

- [ ] **Step 4: Commit (only if verification-driven fixes were needed)**

```bash
git add -p   # stage only intended files explicitly
git commit -m "test(research-pack): full-suite + build verification"
```
> If nothing changed, skip the commit.

---

## Self-Review

**Spec coverage:**
- §4.1 `research_sources` table + Store methods (upsert preserving created_at, list/search) → Task 1.
- §4.2 `research` MCP server (save/list/search) + toolServer registration → Task 2.
- §4.3 `analyst` role (shareable, recall-first, knowledge/ write path) → Task 3.
- §4.4 manifest (pillar/memoDomain/vaultSection/toolServer/actions/roles/tools/playbooks) + moving the 3 playbooks → Task 4.
- §4.5 role-ownership consequences (researcher/reviewer drop from roleOf; analyst/market-researcher/ui-ux-designer bind) → Task 4 test.
- §5 integration consequences (speculate coupling via kill-switch; Packs card auto-appears; money/code unchanged) → Task 4 + Task 5 tests.
- §6 safety (actions ceiling [vault.write]; ungated sources CRUD; shareable) → Tasks 2/3/4.
- §7 testing (all bullets) → Tasks 1–5. §8 ship (no migration) → Task 6.

**Placeholder scan:** No TBD/TODO; every code step shows real code. The two "verification-only" tasks (5, 6) explicitly state to match real signatures by reading the source if the SDK/resolve shape differs, and to STOP+report a genuine wiring gap rather than edit production code out of task scope.

**Type consistency:** `ResearchSourceRow` fields identical across Task 1 (db.ts) and the server/test usage; `buildResearchServer({ store })` signature consistent Task 2 ↔ Task 5; `addResearchSource`/`listResearchSources`/`searchResearchSources` signatures consistent Task 1 ↔ Task 2 ↔ Task 5; manifest `toolServer: research` consistent with the index.ts registry key (Task 2) and the resolve test (Task 5); `dropPack(reg, "research")` matches the generalized kill-switch shipped in the packs-view cycle.

**Known framework facts baked in:** `loadPlaybooks` is top-level-only (Task 4 fixes its test); `roleOf` binds only single-pillar roles (Task 4 asserts the researcher/reviewer drop); `vault_write` takes an agent-supplied path, so the analyst persona/role explicitly directs writes under `knowledge/` (Task 3) — that is what makes the §4/§7 recall path real.
