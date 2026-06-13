# AI-OS Phase 6 — Second Brain — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorm complete, awaiting implementation plan)
**Master vision:** `docs/superpowers/specs/2026-06-11-cognitive-kernel-design.md` (§4 Memory)

## Summary

Give AI-OS a working memory layer: a lexical recall index every agent can search, and
a distillation pass that turns the system's own history into durable, human-editable
memos. Two halves, both built to full depth this phase:

1. **Recall** — an FTS5 index over the vault, events, and decisions, exposed as a
   `recall(query, domain?)` tool to every agent.
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
| Index strategy | One denormalized FTS5 table + write-time DB indexing + mtime-walk for vault files |

## Existing foundation (reused, not rebuilt)

- `node:sqlite` with FTS5 built in — **zero new dependencies** (never better-sqlite3).
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
decisions ───┼──▶ memory_fts (FTS5) ◀── recall(query, domain?)  [every agent]
vault files ─┤        ▲
memos ───────┘        │ mtime-walk reindex (boot / ~5min / pre-distill)

gate decisions ─┐
chat teachings ─┼──▶ evening distill ──▶ curator (one-shot) ──▶ memos/*.md (via gate)
profile facts ──┘                                                      │
                                                                       ▼
                                          moderator prompt: "Learned preferences & profile"
```

### 1. Data model

One FTS5 virtual table plus a change-tracking table:

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  title, body,
  source UNINDEXED,   -- 'vault' | 'event' | 'decision' | 'memo'
  ref    UNINDEXED,   -- vault relpath | event id | action id | memo path
  domain UNINDEXED,   -- inbox|money|code|research|lifeops|general|profile
  ts     UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE memory_index_state (
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  fingerprint TEXT NOT NULL,   -- mtime (vault) | row updated_at (DB)
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (source, ref)
);
```

- `title`/`body` are matched + ranked (bm25). The rest are stored for retrieval and
  equality filtering.
- Document identity = `(source, ref)`. Reindex a doc = delete its FTS rows, insert
  fresh, upsert `memory_index_state`. `fingerprint` lets the indexer skip unchanged docs.
- FTS5 has no UNIQUE constraint — dedup is managed explicitly via delete-then-insert
  keyed on `(source, ref)`.

### 2. Indexer + freshness

- **DB sources** (events, decisions, memos) are indexed **write-time** from `Store`
  methods. Every write-time index call is wrapped in try/catch — **an index failure
  must never break the underlying event/action/vault write.**
- **Vault files** are indexed by an **mtime-tracked walk**: on boot, periodically
  (~5 min), and once **before each evening distill**. This absorbs the user's direct
  Obsidian edits. A file present in `memory_index_state` but missing on disk → pruned
  from FTS and state. Binary/corrupt files → skipped.
- **Exclusions (security):**
  - `mail.received` event payloads are **never** indexed.
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

```sql
SELECT source, ref, domain, ts,
       snippet(memory_fts, 1, '«', '»', '…', 12) AS snip,
       bm25(memory_fts) AS rank
FROM memory_fts
WHERE memory_fts MATCH ?            -- sanitized query
  AND (:domain IS NULL OR domain = :domain)
ORDER BY rank LIMIT ?;
```

Output = ranked provenance lines:

```
[decision/money] action 7f3a (2026-06-02): rejected invoice — «check meter» first
[vault/research] knowledge/lng-prices.md (2026-05-30): …spot «price» dropped 12%…
```

- **Query sanitize**: wrap the raw query so FTS5 operators (`"`, `*`, `:`, `AND`,
  `NEAR`) can't break syntax or inject — quote the phrase, optionally append prefix
  tokens. A malformed query yields an empty result, never a thrown error.
- Default `limit` 8, hard cap 20. `bm25()` ascending (lower = better).
- FTS unavailable → returns `"recall index unavailable"`; the daemon is unaffected.
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
- FTS down → `recall` returns "unavailable"; the daemon is unaffected.
- Distiller: one domain fails → isolated, logged, surfaced next brief; the memo is left
  unchanged (the gate write happens only on a clean curator result).
- Curator empty/garbage → keep the prior memo.
- Reindex: deleted file → pruned; binary/corrupt → skipped.
- Token budget exhausted → defer the distill, report it.

## Testing

- **Indexer** — event/decision/vault/memo → FTS row; reindex idempotent (no dupes);
  mtime change → reindex; file delete → prune; `mail.received` excluded; decision
  indexes preview+reason, not payload.
- **recall** — bm25 order, domain filter, limit cap, FTS5-operator escaping (no throw),
  empty result.
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
- `recall` queries are sanitized against FTS5 syntax; results are reference data —
  agents still gate every effect.
- `teachings`/`forget` records are moderator-authored (trusted origin).
- `recall` is read-only — safe to expose to one-shot specialists.

## Out of scope (YAGNI)

- Embedding-based / semantic recall — lexical FTS5 first (master-vision rule).
- Mission Control "Memory" view (search + memo editing UI) — Phase 8, full Mission
  Control.
- Pillar-pack prompt wiring for memos — Phase 7 (the hook is defined here).
- The dream cycle's propose/speculate stages — Phase 8.
- Indexing inbound email content — deliberately excluded (security).

## Phase 8 rework accepted

The distillation pass and profile curation built here will be subsumed by the Phase 8
dream cycle's *consolidate* step. This is a known, accepted cost: behavioral learning
ships now rather than waiting for the full nightly cycle.
