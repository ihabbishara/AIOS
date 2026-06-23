# Research Pillar Pack — Design Spec

**Date:** 2026-06-23
**Status:** Approved (brainstorm complete) — ready for implementation plan
**Related:** [[phase7-pillar-packs-design]], [[money-pillar-pack-design]], [[code-pillar-pack-design]], [[phase6-second-brain-design]], [[packs-mission-control-view-design]]

## 1. Motivation

Research is the next pillar in the pack queue. The pieces already exist but are unbound: three
read-only research playbooks (`research-report`, `market-research`, `product-design`) sit as
top-level packless playbooks, and the second brain already has a `research` memo domain plus a
`knowledge/` vault section that the indexer maps straight to that domain. This pack binds those
into a `research` pillar AND adds a durable **knowledge base**: a conversational `analyst` role
you DM to query and grow research knowledge, backed by a hybrid store (existing second-brain
recall over the `research` domain + a small `research_sources` citation table).

The pack is **shareable** (not private — opposite of the money pack), **not sandboxed** (read-only
web/file research producing markdown + structured sources, no code workspace).

## 2. Scope, decomposition, deferrals

**In scope (one spec, one plan):**
- A `research` pillar pack manifest binding persona + roles + tools + `memoDomain: research` +
  `vaultSection: knowledge` + `toolServer: research` + `actions: [vault.write]` + the 3 playbooks.
- A new conversational **`analyst`** role (research librarian).
- A **`research_sources`** table (structured citation tracking) + Store methods.
- A **`research` MCP tool server** (`save_source` / `list_sources` / `search_sources`) registered
  via the existing `ResolveDeps.toolServers` builder registry (the money-pack hook).
- Moving the 3 playbooks into `playbooks/research/` so the pack owns them (Packs card + launch).

**Deferred (later cycles):**
- Proactive/scheduled research digests (a watcher running research on tracked topics → brief).
- Richer KB relations (topic→sources→findings graph); FTS over sources (node:sqlite lacks FTS5).
- Auto-curating playbook job reports into `knowledge/` (MVP: the analyst curates; reports stay in
  `jobs/`). Editing the analyst persona/roles from the UI (the Packs view edits YAML already).

## 3. Architecture

```
@analyst (DM) ─────┐
Packs [Run] ───────┤   recall(research) ◄── vault/knowledge/*.md ──indexer──► memoDomain research (BM25)
moderator(recall) ─┘   research_sources table ◄── mcp__research__{save,list,search}_source (direct, ungated)
                       curated findings ──► vault_write ──► knowledge/  (GATED vault.write → recall-able)
playbooks: research-report · market-research · product-design   (jobs resolve pillar via pillarOf)
```

**Source of truth for retrieval = the second brain.** `domainForVaultPath` (src/memory/indexer.ts)
already maps `knowledge/*.md → research` and `memos/research.md → research`. So anything the analyst
writes to the `knowledge/` vault section is auto-indexed into the `research` memo domain and returned
by `recall(query, "research")`. **No indexer change is needed.** The `research_sources` table adds
the structured citation layer recall's prose index cannot represent (explicit url/title/topic/note).

## 4. Backend

### 4.1 `research_sources` table (src/store/db.ts)

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

`CREATE TABLE IF NOT EXISTS` in the existing init path (no `ALTER`, no migration — greenfield table,
idempotent on the live prod DB). `RESEARCH_SOURCE` field map: `id, url, title, topic, note, created_at`.

Store methods (mirror the money-table accessors):
- `addResearchSource({ url, title, topic?, note? }): void` — upsert by `url` via
  `INSERT INTO research_sources (...) VALUES (...) ON CONFLICT(url) DO UPDATE SET title=excluded.title,
  topic=excluded.topic, note=excluded.note` — re-saving a url updates title/topic/note while
  **preserving the original `created_at`** (do NOT use `INSERT OR REPLACE`, which would reset it).
- `listResearchSources(topic?): ResearchSourceRow[]` — all, or filtered by exact `topic`, newest first.
- `searchResearchSources(query: string): ResearchSourceRow[]` — case-insensitive `LIKE %query%` over
  `title`, `url`, `topic`, `note` (no FTS5 — simple `LIKE`, like other in-code search here), newest first.

### 4.2 `research` MCP tool server (src/research/server.ts)

Mirrors `src/money/server.ts` (`createSdkMcpServer` + `tool(...)`, analysis-only, no gate — these are
local-DB CRUD/read tools exactly like money's category-rule/budget tools):
- `save_source({ url, title, topic?, note? })` → `store.addResearchSource(...)` → confirmation text.
- `list_sources({ topic? })` → `store.listResearchSources(topic)` → formatted list.
- `search_sources({ query })` → `store.searchResearchSources(query)` → formatted list.

Registered in the `ResolveDeps.toolServers` registry under key `research` (the Phase-7 pack hook,
same place money's builder is wired in index.ts). Fail-soft if absent (existing framework behavior).

`recall` (defaults to the pillar's `research` memo domain), `vault_read`, and gate-routed `vault_write`
come from the scoped `aios-pack` server automatically — the research server only adds the sources tools.

### 4.3 `analyst` role (src/agents/roles/index.ts)

New `RoleDef` (conversational, shareable — NOT `privateOnly`):
- `allowedTools`: READ_TOOLS + WEB_TOOLS + `recall` + the three `mcp__research__*` tools +
  `vault_read` + `vault_write`. (When run under the pack, `pack.tools` REPLACE this anyway; the
  RoleDef list is the packless fallback + documents intent.)
- `permissionMode: "default"`.
- `systemPrompt`: research analyst + knowledge librarian. ALWAYS `recall` existing research before
  answering; cite sources (save new ones via `save_source`); persist durable findings to the vault
  `knowledge/` section; distinguish facts from inference; be concise.

### 4.4 Pack manifest (`playbooks/research/pack.yaml`)

```yaml
pillar: research
persona: |
  You are the user's research analyst and knowledge librarian. Investigate topics deeply, always
  recalling existing research first, and cite your sources. Save durable findings to the knowledge
  base and track sources. Distinguish established facts from inference. Be concise.
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

No `sandbox` flag (defaults false). The three playbook YAMLs move from `playbooks/*.yaml` into
`playbooks/research/*.yaml` unchanged.

### 4.5 Role-ownership consequences (framework behavior, by design)

`loadPacks` builds `roleOf` only for roles in exactly one pillar (loader.ts: `if (pillars.size === 1)`).
`code` already owns `researcher` and `reviewer`. Listing them here too means **both drop out of
`roleOf`** → direct `@researcher` / `@reviewer` chats become packless (lose code's advisory binding).
This is acceptable: both are read-only (READ+WEB, `dontAsk`), so packless behavior is harmless, and
**playbook jobs are unaffected** — they resolve the owning pack via `pillarOf(playbook)`, which is
unambiguous. `analyst`, `market-researcher`, and `ui-ux-designer` are code-free → bind cleanly to
research for direct chat.

## 5. Integration consequences (to verify at deploy)

- **Speculate coupling:** `research-report` moves into the pillar, so `AIOS_RESEARCH_DISABLED=1`
  (the generalized kill-switch) drops it from the registry → speculate's overnight
  `jobs.createJob({ playbook: "research-report" })` would then reject. Acceptable: research off =
  no overnight research. When enabled, those jobs now resolve the research pack → run under the
  research persona/tools/`knowledge` vault (a synergy: speculate research can feed the KB).
- **Packs view:** the research pack auto-appears as a card (`buildPacksView` scans disk) with its
  roles, the 3 playbooks, and `actions:[vault.write]`. No UI change required.
- **No behavior change** to money/code packs (their manifests untouched; the only shared roles are
  read-only and the change is additive).

## 6. Safety + privacy

- `actions: [vault.write]` is the ONLY gated ceiling: curated KB prose written to `knowledge/` flows
  through the `aios-pack` gate-routed `vault_write` → `propose_action vault.write` (supervised;
  graduates via the trust ledger). `proposeThroughCeiling` refuses any action type ∉ `[vault.write]`.
- `research_sources` writes are **direct/ungated** local-DB CRUD via the research server — exactly
  mirroring money's category-rule/budget tools (no outward effect, no gate).
- **Shareable:** no `privateOnly`, no group-refusal. The `research` memo domain is part of the normal
  second brain; `recall` reaches it on demand (the moderator's always-loaded set stays general+inbox).
- No outward effects (no email/git/payment); no sandbox needed (no code execution/writes).

## 7. Testing (TDD)

- **Store:** `addResearchSource` upserts by url (re-save updates, preserves `created_at`);
  `listResearchSources` filters by topic + orders newest-first; `searchResearchSources` LIKE-matches
  across title/url/topic/note, case-insensitive.
- **research server:** `save_source`/`list_sources`/`search_sources` call the right Store methods and
  format output (mirror the money-server test).
- **Pack loads:** `loadPacks` registers the `research` pillar with the 3 playbooks (pillarOf), the
  5 roles, `actions:[vault.write]`, `toolServer:research`; resolve builds the research mcp server into
  `mcpServers`; `pack.tools` REPLACE allowedTools; `vault_write` within ceiling, any other action
  refused by `proposeThroughCeiling`.
- **Role-ownership:** `researcher`/`reviewer` (now in code+research) absent from `roleOf`;
  `analyst`/`market-researcher`/`ui-ux-designer` → research in `roleOf`. **Regression:** money + code
  packs still resolve unchanged (money mcpServers byte-identical; code sandbox/confinement intact).
- **Kill-switch:** `AIOS_RESEARCH_DISABLED=1` drops the research pack + its 3 playbooks + its solo
  roleOf entries (via the generalized `dropPack`).
- **Recall path:** a note written to `knowledge/<x>.md` is indexed into the `research` domain and
  returned by `recall(query, "research")` (proves the KB read path end-to-end).
- **Packs view:** `buildPacksView` returns a `research` card with the 3 playbooks + 5 roles +
  `actions:[vault.write]` + `toolServer:research`.

## 8. What ships

- 1 manifest (`playbooks/research/pack.yaml`) + 3 moved playbook YAMLs + `analyst` RoleDef +
  `research_sources` table & 3 Store methods + `research` MCP server + toolServer registration.
- Built subagent-driven TDD in an isolated worktree off clean main; explicit-path commits.
  Deploy = backend + ui build + kickstart (no DB migration — `CREATE TABLE IF NOT EXISTS` only).
- Zero runtime change to money/code packs; the research card auto-appears in the Packs view.
