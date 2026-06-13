# AI-OS Phase 6 — Second Brain — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorm complete, awaiting implementation plan)
**Master vision:** `docs/superpowers/specs/2026-06-11-cognitive-kernel-design.md` (§4 Memory)

## Summary

Give AI-OS a working memory layer: a lexical recall index every agent can search, and
a distillation pass that turns the system's own history into durable, human-editable
memos. Two halves, both built to full depth this phase:

1. **Recall** — a hand-rolled inverted index over the vault, events, and decisions,
   exposed as a `recall(query, domain?)` tool to every agent.
2. **Memos** — an evening distillation pass that folds three signal sources (gate
   decisions, explicit chat teachings, profile facts) into per-domain **preference
   memos** and a curated **profile memo**, which then load into prompts so the system
   stops re-asking.

The distillation here is a deliberate pull-forward of the Phase 8 dream cycle's
*consolidate* step. Phase 8 will subsume and extend it (propose/speculate, profile
curation at scale); some rework is accepted as the cost of getting behavioral learning
live now.

## Requirements (from brainstorm)

| Decision | Choice |
|---|---|
| Phase 6 focus | Both halves, full depth — recall AND a real distillation pass at the evening anchor |
| Memo inputs | All three — gate decisions + explicit chat teachings + profile facts (with curation) |
| Recall safety | **Exclude inbound email** from the index (smallest injection surface) |
| Index engine | **Hand-rolled inverted index** in plain SQLite (FTS5 is NOT compiled into this Node's `node:sqlite` — confirmed `no such module: fts5`). JS tokenizer + postings tables + BM25 scoring in code. Zero deps, no native artifact. |
| Index strategy | Write-time DB indexing + mtime-walk reindex for vault files |

## Existing foundation (reused, not rebuilt)

- `node:sqlite` — **zero new dependencies** (never better-sqlite3). **Note:** FTS5 is not
  compiled into this build (`no such module: fts5`), so the index is hand-rolled in plain
  SQLite tables rather than an FTS5 virtual table. Recall ranking is BM25 computed in code.
- `actions` table already is the decision journal: `type, payload, preview, status,
  verdict_by, reject_reason, result, trust_state, created_at, resolved_at`.
- `events` table: `id, ts, payload` (JSON).
- `VaultWriter` (`~/Desktop/AI-Vault/AIOS/`, subdirs `jobs/ knowledge/ daily/ notes/
  briefs/`) with `assertContained` traversal guard on every path.
- Moderator MCP server (`src/moderator/tools.ts`, `tool()` + `createSdkMcpServer`) —
  where `recall`, `remember`, `forget` plug in.
- Action Gate (`src/kernel/gate.ts`) — `vault.write` seeded autonomous; memo writes go
  through it (audited, no friction).
- Heartbeat evening close (`src/heartbeat/briefs.ts`) — where the distillation pass hooks.

## Architecture

```
write-time ──┐
events ──────┤
decisions ───┼──▶ memory_doc + memory_token (inverted index) ◀── recall(query, domain?)
vault files ─┤        ▲                                            [every agent, BM25-ranked]
memos ───────┘        │ mtime-walk reindex (boot / ~5min / pre-distill)

gate decisions ─┐
chat teachings ─┼──▶ evening distill ──▶ curator (one-shot) ──▶ memos/*.md (via gate)
profile facts ──┘                                                      │
                                                                       ▼
                                          moderator prompt: "Learned preferences & profile"
```

### 1. Data model

Two plain tables — a document store and an inverted index of postings:

```sql
CREATE TABLE memory_doc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,        -- 'vault' | 'event' | 'decision' | 'memo'
  ref TEXT NOT NULL,           -- vault relpath | event id | action id | memo path
  domain TEXT NOT NULL,        -- inbox|money|code|research|lifeops|general|profile
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  ts TEXT NOT NULL,
  len INTEGER NOT NULL,        -- total weighted token count (BM25 length norm)
  fingerprint TEXT NOT NULL,   -- mtime (vault) | row updated_at (DB) — skip unchanged
  indexed_at TEXT NOT NULL,
  UNIQUE(source, ref)
);

CREATE TABLE memory_token (
  token TEXT NOT NULL,
  doc_id INTEGER NOT NULL,
  tf INTEGER NOT NULL,         -- weighted term frequency (title tokens counted ×TITLE_BOOST)
  PRIMARY KEY (token, doc_id)
);
CREATE INDEX idx_memory_token_token ON memory_token(token);
CREATE INDEX idx_memory_token_doc ON memory_token(doc_id);
```

- Document identity = `(source, ref)` (UNIQUE). Reindex a doc = delete its `memory_doc`
  row + its `memory_token` postings, then insert fresh. `fingerprint` lets the indexer
  skip unchanged docs (compare before re-tokenizing).
- `title` tokens are folded into the postings with a small boost (`TITLE_BOOST`, e.g. ×3)
  so a query term in a title outranks one buried in a body.
- `len` (weighted token count) and the per-token `tf` are everything BM25 needs; `df`
  (docs containing a token) is computed at query time from `memory_token`.

### 2. Indexer + freshness

- **DB sources** (events, decisions, memos) are indexed **write-time** from `Store`
  methods. Every write-time index call is wrapped in try/catch — **an index failure
  must never break the underlying event/action/vault write.**
- **Vault files** are indexed by an **mtime-tracked walk**: on boot, periodically
  (~5 min, configurable), and once **before each evening distill**. This absorbs the
  user's direct Obsidian edits. A `(source='vault')` doc whose file is missing on disk →
  pruned (`memory_doc` row + its postings deleted). Binary/corrupt files → skipped.
- **Event indexing is an explicit allowlist** — only `calendar.changed` (meeting/context
  recall) for v1. All operational/noisy types (job/stage/agent/action/trust/brief/triage/
  reminder/chat) are not indexed. The allowlist is one easily-audited constant, extensible
  later.
- **Exclusions (security):**
  - `mail.received` event payloads are **never** indexed (not on the event allowlist).
  - Decisions are indexed via the **system-authored `preview` + `reject_reason`
    only**, not the raw `actions` payload — which also keeps drafted email bodies out
    of the index for free.

### 3. Domain derivation

One mapping function, used by every source:

- **decision** → action-type namespace: `email.*`/`calendar.*` → `inbox`,
  `finance.*`/`purchase.*` → `money`, `git.*` → `code`, else `general`.
- **event** → watcher source (calendar → `inbox`, git → `code`, clock → `general`, …).
- **vault** → path: `memos/<d>.md` → `d`, `briefs/` → `general`, `knowledge/` →
  `research`, `jobs/` → `general`, else `general`.
- **memo** → the memo's own domain.

Domain set = the five future pillars (`inbox, money, code, research, lifeops`) +
`general` + `profile`. Phase 7 pillar packs inherit this taxonomy directly.

### 4. recall() tool

Added to the shared moderator MCP server, so the moderator gets it now and one-shot
specialists + Phase 7 pillar packs inherit it.

```
recall(query: string, domain?: enum, limit?: number = 8)
```

Scoring is **BM25 computed in code** (no FTS5 `bm25()` / `MATCH`):

1. Tokenize the query with the **same** tokenizer used at index time (so a query never
   needs SQL-operator escaping — the tokenizer strips everything non-alphanumeric, so
   no user input ever reaches a `MATCH` parser; malformed input simply yields zero
   tokens → empty result, never a thrown error).
2. Fetch postings for those tokens: `SELECT t.token, t.doc_id, t.tf, d.len, d.domain,
   d.source, d.ref, d.ts FROM memory_token t JOIN memory_doc d ON d.id = t.doc_id WHERE
   t.token IN (…) [AND d.domain = ?]`.
3. Compute per token `df` (distinct docs in the candidate set) and
   `idf = ln(1 + (N − df + 0.5)/(df + 0.5))`, where `N` = doc count (in the domain if
   filtered). Accumulate per doc:
   `score += idf · tf·(k1+1) / (tf + k1·(1 − b + b·dl/avgdl))` with `k1=1.2`, `b=0.75`.
4. Sort by score descending, take `limit`. Snippet = a ±~60-char window of `body`
   around the first matching token, with the match wrapped in `«»`.

Output = ranked provenance lines:

```
[decision/money] action 7f3a (2026-06-02): rejected invoice — «check meter» first
[vault/research] knowledge/lng-prices.md (2026-05-30): …spot «price» dropped 12%…
```

- Default `limit` 8, hard cap 20.
- Index empty / no matches → `"no matches"`; the daemon is unaffected either way.
- Results are **reference data only** — agents still gate every effect. `recall` never
  authorizes anything (defense-in-depth).

### 5. Decision-journal read model

No new storage — a view over `actions`. Real `ActionStatus` is `proposed | executing |
executed | failed | rejected | expired`; there is no separate `approved`/`edited`
status. The read model derives a **verdict** from `(status, verdict_by)`:

| Derived verdict | Condition | Signal |
|---|---|---|
| `approved` | `executed` AND `verdict_by` is a user | positive (user tapped approve) |
| `auto` | `executed` AND no user `verdict_by` | already-trusted, weak signal |
| `rejected` | `rejected` (carries `reject_reason`) | negative + reason |
| `failed` | `failed` | execution error, not a preference signal |

```
Store.listDecisions({ domain?, since? })
  → { type, domain, preview, verdict, reason, ts }[]   // verdict per table above
```

`expired` actions carry no decision and are skipped. Two consumers: the indexer
(`source='decision'`, indexing `preview` + `reject_reason`) and the distiller. No
dedicated tool — `recall` already covers decision Q&A.

### 6. Capture paths

Two moderator tools, user-authored (trusted origin):

```
remember(text, domain?, kind? = 'preference' | 'fact')
forget(text, domain?)
```

Both write a raw `teachings` row — **never directly to a memo file** (single writer =
distiller, avoiding two-writer races):

```sql
CREATE TABLE teachings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  domain TEXT,
  kind TEXT NOT NULL,          -- 'preference' | 'fact' | 'forget'
  created_at TEXT NOT NULL,
  consolidated_at TEXT         -- NULL until folded in by a distill run
);
```

**Instant effect** without waiting for evening: the moderator prompt loads
**unconsolidated teachings** directly (§8). "Always CC Sara" works the same minute; the
distiller just folds it into the memo later and stamps `consolidated_at`.

### 7. Distillation engine

Runs at the **evening anchor, after the brief, async, non-blocking**. For each domain
with new signal since its last distill (`kv: distill:last:<domain>`):

1. **Gather** — new decisions (`listDecisions({ domain, since })`) + unconsolidated
   teachings for the domain. The profile run gathers `kind='fact'` + `kind='forget'`
   teachings (and may mine decisions for stable facts).
2. **Read** the existing memo (`memos/<domain>.md`, or `memos/profile.md`).
3. **Curator** — a one-shot specialist on a cheap model. Input: existing memo + new
   signals. Output: the rewritten memo. Curation rules live in the prompt:
   - dedup semantically;
   - attach evidence (approval/rejection counts, dates);
   - drop expired/stale facts;
   - contradictions → keep the newer, note `(was: X)`;
   - apply `forget` deletions.
4. **Write** the memo via the Action Gate (`vault.write`, autonomous → audited). On
   success: mark the consumed teachings `consolidated_at`, stamp `distill:last:<domain>`.

**Guards:**
- Empty/garbage curator output → reject the write, keep the prior memo, log.
- Never overwrite a non-empty memo with an empty one.
- Idempotent — a domain with no new signal is a no-op.
- Per-domain isolation — one domain failing never blocks the others.
- Token-budget aware — exhausted budget defers the distill and reports it next brief.

### 8. Memo format + consumption

Memos are markdown, hand-editable, Obsidian-browsable, under `memos/`:

```
# Money — preferences
_updated 2026-06-13 · distill_

- Approve invoices < €200 without asking. (10 approvals, 0 rejections)
- Never auto-pay utilities — always preview. (rejected 2026-06-02: "check meter first")
```

```
# Profile
## People
- Sara — business partner; CC on all invoices. (since 2026-05)
## Accounts / Patterns / Tastes
...
```

**Consumption** (before pillar packs exist):
- The moderator system prompt gains a **"Learned preferences & profile"** block:
  `profile.md` + the `general`/`inbox` preference memos + today's **unconsolidated
  teachings**. Size-capped (~2–3k chars total; truncate with `…(more in memos/)`).
- `recall` indexes memos too → any agent can pull a domain memo on demand.
- **Phase 7 hook (noted, not built):** pillar packs load their own `memos/<pillar>.md`
  into their pack prompts.

## Error handling — fail-safe, never silent

- Write-time index failure → try/catch, log, skip. The real write always succeeds.
- Index empty or query yields no tokens → `recall` returns "no matches"; daemon unaffected.
- Distiller: one domain fails → isolated, logged, surfaced next brief; the memo is left
  unchanged (the gate write happens only on a clean curator result).
- Curator empty/garbage → keep the prior memo.
- Reindex: deleted file → pruned; binary/corrupt → skipped.
- Token budget exhausted → defer the distill, report it.

## Testing

- **Tokenizer** — lowercase, accent-strip, stopword drop, length bounds, light stemming;
  deterministic; same fn used at index + query time.
- **Indexer** — event/decision/vault/memo → `memory_doc` + postings; reindex idempotent
  (no dupes); fingerprint-unchanged → skipped; mtime change → reindex; file delete →
  prune (doc + postings); `mail.received` excluded; decision indexes preview+reason, not
  payload.
- **recall** — BM25 order (idf·tf saturation, length norm), domain filter, limit cap,
  punctuation/garbage query → empty (no throw), empty index → "no matches".
- **Decision read model** — resolved-action mapping + domain derivation per namespace.
- **remember/forget** — teaching captured, `consolidated_at` flips, forget applied
  (fake curator).
- **Distiller (fake-curator deterministic mode)** — new decisions → memo via gate;
  no-signal no-op; empty-output guard; per-domain isolation; teachings marked
  consolidated.
- **Consumption** — prompt block includes memos + unconsolidated teachings; size-cap
  truncates.
- **E2E** — reject-with-reason → evening distill → memo line appears → `recall` finds
  it. Zero real side effects throughout.

## Security

- Inbound email is excluded from the index; decisions are indexed via the
  system-authored preview + reason only.
- Memo writes are audited through the Action Gate.
- `recall` takes no raw SQL/`MATCH` — the query is tokenized to alphanumerics before
  any DB access, so there is no query-injection surface. Results are reference data —
  agents still gate every effect.
- `teachings`/`forget` records are moderator-authored (trusted origin).
- `recall` is read-only — safe to expose to one-shot specialists.

## Out of scope (YAGNI)

- Embedding-based / semantic recall — lexical (inverted-index BM25) first
  (master-vision rule; the vision said FTS5, but FTS5 is unavailable in this build).
- Mission Control "Memory" view (search + memo editing UI) — Phase 8, full Mission
  Control.
- Pillar-pack prompt wiring for memos — Phase 7 (the hook is defined here).
- The dream cycle's propose/speculate stages — Phase 8.
- Indexing inbound email content — deliberately excluded (security).

## Phase 8 rework accepted

The distillation pass and profile curation built here will be subsumed by the Phase 8
dream cycle's *consolidate* step. This is a known, accepted cost: behavioral learning
ships now rather than waiting for the full nightly cycle.
