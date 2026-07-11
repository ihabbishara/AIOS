# Memory v2 — Design

**Date:** 2026-07-12
**Status:** Approved (brainstorm with user)
**Scope:** Retrieval quality, memo correctness, conversational capture, light usage feedback. Depends on: Information-Flow Policy spec (labels/origin columns). Subscription-pure — no API keys.

## 1. Problem

User confirmed all three failure modes in daily use:

1. **Recall misses things that are stored** — lexical BM25 with trailing-`s`-only stemming; no synonyms, no entity awareness, no recency (old and new docs rank identically).
2. **Memos go stale or wrong** — the distiller merges prose with an LLM; bad merges (dropped facts, kept-stale facts) persist until the next signal for that domain, unverified.
3. **Agents forget across sessions** — capture is explicit-only (`remember`, teachings); conversational facts evaporate unless the user remembers to save them.

## 2. Decisions (locked with user)

| Decision | Choice |
|---|---|
| Depth | Full v2 (all three subsystems) — real pain confirmed on all axes |
| Semantic layer | Local ONNX embeddings (no API key), hybrid with BM25, shipped on (`AIOS_EMBEDDINGS=1` default) |
| Memos | Fact-granular with supersede semantics + grounding verification |
| Capture | Automatic post-turn extraction, origin-labeled, through existing teachings pipeline |

## 3. Retrieval

### Recency decay
`score × exp(-age / halfLife)`, half-life default 90 days (`AIOS_MEMORY_HALFLIFE_DAYS`). Applied at scoring time; index untouched.

### Entity layer
- `entities(id, name, kind: person|project|merchant|agent|org, aliases JSON)` + `entity_link(doc_id, entity_id)`.
- Seeded deterministically: registry agents/departments, money counterparties, mail participants, research source domains.
- New entities extracted during the nightly distill (LLM-assisted, fail-silent).
- Query time: query tokens matched against entity names/aliases → query expanded with canonical name + linked aliases ("bunq" finds docs that said "the bank").

### Hybrid semantic layer
- Local ONNX sentence-embedding model (MiniLM-class, ~90MB), lazy-loaded on first use — same pattern as Kokoro TTS (timeout-guarded load, fail-latch to lexical-only). **No API dependency; subscription-auth constraint preserved.**
- `memory_vec(doc_id, vec BLOB)`; embeddings computed at index time (write-time seam) + lazy backfill on enable.
- Query: cosine top-k in JS (personal scale — thousands of docs, not millions), fused with BM25 ranks via reciprocal-rank fusion (k=60).
- Config `AIOS_EMBEDDINGS` (default on); off → pure lexical path unchanged.
- Injection-safe tokenizer untouched — the embedding layer is additive; no user text reaches any parser.

## 4. Memos: fact-granular with grounding

- New `memo_facts(id, domain, subject, fact, ts, source_ref, status: active|superseded, origin: user-stated|agent-inferred|untrusted, superseded_by?)`.
- Distiller becomes a **fact-diff**: extract candidate facts from new decisions/teachings/docs → compare against active facts → emit new / supersede / no-op. Contradiction: newer supersedes; superseded rows kept as history.
- Memo markdown = **rendered view** of active facts (facts are the truth, prose is a projection). Same vault path, same prompt-injection seams, same 3k cap.
- **Grounding check**: post-distill verifier (one-shot, fail-closed for writes) confirms each new/changed fact traces to a source doc (`source_ref` must resolve and support the claim); ungrounded → dropped + `memory.ungrounded` event logged.
- User corrections ("wrong — forget X" / `forget` tool) supersede the fact **immediately**, not at next distill; the render refreshes on the spot.
- Policy tie-in: facts destined for `prompt.system` must have origin `user-stated` or `agent-inferred` — never `untrusted` (closes the inbox.md vector at the fact level too).

## 5. Capture: post-turn extraction

- After each coordinator/direct-chat turn: one-shot Haiku extractor (no tools, fail-silent, `AIOS_CAPTURE_MODEL` → triage model) over the user↔agent exchange → candidate facts/preferences.
- Candidates land in the existing teachings/pending pipeline: injected as "Pending (not yet distilled)" immediately, folded by the nightly distiller (now fact-diff).
- Origin-labeled `agent-inferred` — distinguishable from explicit `remember` (`user-stated`).
- Untrusted-origin content in the exchange (quoted email text, web content) is never captured as fact — policy rule.
- Dedup guard: extractor sees current pending + active facts for the domain to avoid re-capturing knowns.

## 6. Usage feedback (light)

- Recall logs query + returned doc ids (`memory_use` table, pruned at 90d).
- Docs never retrieved in 180 days get a small ranking penalty (multiplier, config) — never deletion.
- No citation detection in v1 (deliberately skipped).

## 7. Plumbing

- `memory_doc` gains `labels` (policy spec) and `origin` columns — idempotent ALTERs.
- Entities + vectors built lazily on first enable, then maintained incrementally at the existing write-time indexer seams (`indexer.ts` bus subscriptions + `reconcile`).
- New model file lives in `data/models/` beside whisper (gitignored).

## 8. Testing

- **Retrieval goldens over a fixture corpus**: paraphrase queries that must hit with entities+vectors and must miss on pure BM25 — proves each layer earns its keep; decay ordering tests (same content, different ages).
- Fact-diff: new/supersede/no-op cases; immediate user-correction supersede; render matches active set.
- Grounding: fabricated fact dropped + event emitted.
- Capture: extraction goldens (exchange → expected facts), untrusted-content exclusion, dedup against pending.
- Privacy regressions: `personal.*` still never indexed; embeddings table respects the same exclusions (vector for an excluded doc must not exist).
- Fail-latch: embedding model load failure → lexical-only, no crash (mirrors Kokoro tests).

## 9. Out of scope

- Citation-level feedback / reranking models.
- Cross-encoder rerank; FTS5 (still unavailable in this Node build).
- Memory UI (Ember Cockpit owns any surfacing).
- Vault reorganization.

## 10. Open questions

None — resolved in brainstorm (§2).
