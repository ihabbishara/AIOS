import type { Store } from "../store/db.js";
import type { Label, Policy } from "../kernel/policy.js";
import { tokenize } from "./tokenize.js";
import { matchEntities, expandTokens, linkedEntityIds, type EntityRow } from "./entities.js";
import { cosine, type Embedder } from "./embeddings.js";

export type MemorySource = "vault" | "event" | "decision" | "memo" | "mail";
export type Domain = "inbox" | "money" | "code" | "research" | "lifeops" | "general" | "profile";
export const DOMAINS: Domain[] = ["inbox", "money", "code", "research", "lifeops", "general", "profile"];

export interface MemoryDocInput {
  source: MemorySource; ref: string; domain: Domain;
  /** Confidentiality labels (info-flow policy §6). Defaults to [] when a caller omits them. */
  labels?: Label[];
  /** Provenance (memory-v2 §7): untrusted for attacker-influenceable text (calendar, mail). */
  origin?: "trusted" | "untrusted";
  title: string; body: string; ts: string; fingerprint: string;
}
export interface RecallHit {
  source: MemorySource; ref: string; domain: Domain; ts: string;
  score: number; snippet: string;
}

const TITLE_BOOST = 3;
const K1 = 1.2;
const B = 0.75;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
export const DEFAULT_HALFLIFE_DAYS = 90;
const DAY_MS = 86_400_000;

/** Recency decay (spec §3): score × exp(-age/halfLife). Unparseable ts → 1 (no decay). */
function decayFactor(ts: string, nowMs: number, halfLifeDays: number): number {
  const ageMs = nowMs - Date.parse(ts);
  if (Number.isNaN(ageMs)) return 1;
  return Math.exp(-Math.max(0, ageMs) / (halfLifeDays * DAY_MS));
}

const STALE_WINDOW_MS = 180 * DAY_MS;

/** Usage penalty (spec §6): a doc with no retrieval activity for 180d gets a small multiplier.
 *  "Activity" = last retrieval, or (for never-retrieved docs) index time — a fresh doc is
 *  never penalized for not having been queried yet. Never deletion. */
function usageFactor(m: { indexed_at: string; last_retrieved_at: string | null }, nowMs: number, penalty: number): number {
  const lastActivity = Date.parse(m.last_retrieved_at ?? m.indexed_at);
  if (Number.isNaN(lastActivity)) return 1;
  return nowMs - lastActivity > STALE_WINDOW_MS ? penalty : 1;
}

/** Index (or re-index) a document. No-op when the fingerprint is unchanged. */
export function indexDoc(store: Store, doc: MemoryDocInput): void {
  if (store.memoryFingerprint(doc.source, doc.ref) === doc.fingerprint) return;
  const tf = new Map<string, number>();
  for (const t of tokenize(doc.title)) tf.set(t, (tf.get(t) ?? 0) + TITLE_BOOST);
  for (const t of tokenize(doc.body)) tf.set(t, (tf.get(t) ?? 0) + 1);
  const len = [...tf.values()].reduce((a, b) => a + b, 0);
  const docId = store.upsertMemoryDoc({ ...doc, labels: doc.labels ?? [], origin: doc.origin ?? "trusted", len }, [...tf.entries()]);
  // Entity linking (spec §3): a doc mentioning an entity's name/alias links to it at index time.
  const ents = store.listEntities();
  if (ents.length) store.replaceEntityLinks(docId, linkedEntityIds(ents, new Set(tf.keys())));
}

export interface RecallOpts {
  domain?: Domain;
  limit?: number;
  /** Caller's confidentiality clearance (ResolvedAgent.labels). When set, docs whose labels the
   *  caller isn't cleared for are dropped BEFORE the limit slice — closing the domain-broadening
   *  hole. `shared` docs are always visible. Absent → no filter (moderator/legacy full clearance). */
  clearance?: string[];
  policy?: Policy;
  /** Injectable clock for decay/penalty tests. Default Date.now(). */
  nowMs?: number;
  /** Recency half-life in days (spec §3). Default 90 (AIOS_MEMORY_HALFLIFE_DAYS). */
  halfLifeDays?: number;
  /** Multiplier for docs not retrieved in 180d (spec §6). Default 0.7 (AIOS_MEMORY_STALE_PENALTY). */
  stalePenalty?: number;
  /**
   * Whether this recall counts as USE. Default true.
   *
   * Set false for retrieval that isn't an agent reading to do work — the cockpit's library
   * search is the case this exists for. Two things depend on staying uncontaminated:
   * `memory_use` is the evidence base for what the org actually reads (the measurement that
   * showed 308 of 324 hits landing on 22 knowledge/ files, which is why the wiki exists at
   * all), and `last_retrieved_at` drives the 180-day stale penalty in `usageFactor`. A human
   * browsing the library would silently mark documents as "in use" and rot both.
   */
  logUse?: boolean;
}

/** A doc is visible to a caller iff every label is `shared` or in the caller's clearance. */
function visibleTo(labels: string[], clearance: string[]): boolean {
  return labels.every((l) => l === "shared" || clearance.includes(l));
}

interface CandidateSet {
  scores: Map<number, number>;
  meta: Map<number, { source: MemorySource; ref: string; domain: Domain; ts: string }>;
  labelsById: Map<number, string[]>;
}

/** Lexical core: BM25 over expanded tokens + entity link boost + decay×penalty adjustment. */
function lexicalScores(store: Store, qTokens: string[], matched: EntityRow[], opts: RecallOpts, nowMs: number): CandidateSet {
  const empty: CandidateSet = { scores: new Map(), meta: new Map(), labelsById: new Map() };
  const rows = store.memoryPostings(qTokens, opts.domain);
  if (!rows.length) return empty;

  const { count: N, avgLen } = store.memoryStats(opts.domain);
  const avgdl = avgLen || 1;

  const dfByToken = new Map<string, Set<number>>();
  for (const r of rows) {
    let set = dfByToken.get(r.token);
    if (!set) { set = new Set(); dfByToken.set(r.token, set); }
    set.add(r.doc_id);
  }

  const scores = new Map<number, number>();
  const meta = new Map<number, { source: MemorySource; ref: string; domain: Domain; ts: string }>();
  const labelsById = new Map<number, string[]>();
  for (const r of rows) {
    const df = dfByToken.get(r.token)!.size;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const denom = r.tf + K1 * (1 - B + B * (r.len / avgdl));
    const contrib = idf * (r.tf * (K1 + 1)) / denom;
    scores.set(r.doc_id, (scores.get(r.doc_id) ?? 0) + contrib);
    if (!meta.has(r.doc_id)) {
      meta.set(r.doc_id, { source: r.source as MemorySource, ref: r.ref, domain: r.domain as Domain, ts: r.ts });
      try { labelsById.set(r.doc_id, JSON.parse(r.labels) as string[]); } catch { labelsById.set(r.doc_id, []); }
    }
  }

  // Entity link boost (spec §3): docs linked to a query-matched entity outrank textual
  // coincidences. Additive — comparable to one strong BM25 term contribution.
  const ENTITY_BOOST = 2;
  if (matched.length) {
    const linked = new Set(store.docsLinkedToEntities(matched.map((e) => e.id)));
    for (const [id, score] of scores) if (linked.has(id)) scores.set(id, score + ENTITY_BOOST);
  }

  const halfLife = opts.halfLifeDays ?? DEFAULT_HALFLIFE_DAYS;
  const penalty = opts.stalePenalty ?? 0.7;
  const useMeta = new Map(store.memoryDocsMeta([...scores.keys()]).map((m) => [m.id, m]));
  for (const [id, score] of scores) {
    const m = useMeta.get(id);
    if (!m) continue;
    scores.set(id, score * decayFactor(m.ts, nowMs, halfLife) * usageFactor(m, nowMs, penalty));
  }
  return { scores, meta, labelsById };
}

/** Shared tail: clearance filter → limit slice → snippets → usage log/touch (spec §6, §7.8). */
function finalize(store: Store, cand: CandidateSet, qTokens: string[], query: string, opts: RecallOpts, nowMs: number): RecallHit[] {
  const { scores, meta, labelsById } = cand;
  // Clearance filter (spec §7.8): drop docs the caller isn't cleared for BEFORE ranking, so a
  // denied doc never occupies a result slot. Read-side filtering only HIDES a doc (no
  // write-availability risk), so it enforces clearance IMMEDIATELY regardless of the global
  // policy mode — the domain:money broadening hole is closed now, not deferred to the enforce
  // flip. policy.check is retained purely to record the violation for the audit trail.
  if (opts.clearance) {
    for (const [id, docLbls] of labelsById) {
      if (!scores.has(id)) continue;
      // Cleared iff the doc is LABELED and every label is shared/held. Unlabeled → not cleared
      // (fail-closed, matching the engine's treatment of unlabeled data at a sensitive sink).
      if (docLbls.length > 0 && visibleTo(docLbls, opts.clearance)) continue;
      if (docLbls.length) {
        opts.policy?.check(
          { labels: docLbls as Label[], sink: "recall-index", agent: { labels: opts.clearance } },
          "recall:clearance", meta.get(id)?.ref ?? "",
        );
      }
      scores.delete(id);
    }
  }

  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit);
  const bodies = new Map(store.memoryDocsByIds(ranked.map(([id]) => id)).map((d) => [d.id, d.body]));

  // Usage feedback (spec §6): a recall logs its query + hits and refreshes retrieval stamps —
  // unless the caller declared it isn't use (opts.logUse), which keeps cockpit browsing out of
  // the readership evidence and out of the stale-penalty clock.
  const returnedIds = ranked.map(([id]) => id);
  if (opts.logUse !== false) {
    store.logMemoryUse(query, returnedIds, new Date(nowMs).toISOString());
    store.touchMemoryDocs(returnedIds, new Date(nowMs).toISOString());
  }

  return ranked.map(([id, score]) => {
    const m = meta.get(id)!;
    return { ...m, score, snippet: snippet(bodies.get(id) ?? "", qTokens) };
  });
}

export function recall(store: Store, query: string, opts: RecallOpts = {}): RecallHit[] {
  const rawTokens = [...new Set(tokenize(query))];
  if (!rawTokens.length) return [];
  // Entity expansion (spec §3): "bunq" also searches the tokens of its aliases ("the bank").
  const matched = matchEntities(store.listEntities(), rawTokens);
  const qTokens = expandTokens(rawTokens, matched);
  const nowMs = opts.nowMs ?? Date.now();
  return finalize(store, lexicalScores(store, qTokens, matched, opts, nowMs), qTokens, query, opts, nowMs);
}

const RRF_K = 60;   // spec §3
const VEC_TOPK = 50;

/** Hybrid retrieval (spec §3): lexical rank + cosine top-k over memory_vec, fused via
 *  reciprocal-rank fusion. No/latched embedder or an embed failure → pure lexical path. */
export async function hybridRecall(
  store: Store, query: string, opts: RecallOpts & { embedder?: Embedder } = {},
): Promise<RecallHit[]> {
  const embedder = opts.embedder;
  if (!embedder || !embedder.available()) return recall(store, query, opts);
  const rawTokens = [...new Set(tokenize(query))];
  const matched = matchEntities(store.listEntities(), rawTokens);
  const qTokens = expandTokens(rawTokens, matched);
  const nowMs = opts.nowMs ?? Date.now();

  const lex = lexicalScores(store, qTokens, matched, opts, nowMs);

  let vecRanked: number[] = [];
  try {
    const [qVec] = await embedder.embed([query]);
    const halfLife = opts.halfLifeDays ?? DEFAULT_HALFLIFE_DAYS;
    const penaltyMul = opts.stalePenalty ?? 0.7;
    const sims = store.memoryVecs(opts.domain)
      .map((r) => ({ id: r.doc_id, sim: cosine(qVec, r.vec) }))
      .filter((r) => r.sim > 0);
    const vmeta = new Map(store.memoryDocsMeta(sims.map((r) => r.id)).map((m) => [m.id, m]));
    for (const r of sims) {
      const m = vmeta.get(r.id);
      if (m) r.sim *= decayFactor(m.ts, nowMs, halfLife) * usageFactor(m, nowMs, penaltyMul);
    }
    vecRanked = sims.sort((a, b) => b.sim - a.sim || a.id - b.id).slice(0, VEC_TOPK).map((r) => r.id);
  } catch {
    return recall(store, query, opts); // embed failed → latch tripped inside embedder; lexical-only
  }

  // Reciprocal-rank fusion (k=60, spec §3) over the two ranked lists.
  const lexRanked = [...lex.scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
  const fused = new Map<number, number>();
  for (const [rank, id] of lexRanked.entries()) fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
  for (const [rank, id] of vecRanked.entries()) fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1));

  // Vector-only docs need meta/labels for the clearance filter + hit shape.
  const missingMeta = [...fused.keys()].filter((id) => !lex.meta.has(id));
  for (const m of store.memoryDocsMeta(missingMeta)) {
    lex.meta.set(m.id, { source: m.source as MemorySource, ref: m.ref, domain: m.domain as Domain, ts: m.ts });
    try { lex.labelsById.set(m.id, JSON.parse(m.labels) as string[]); } catch { lex.labelsById.set(m.id, []); }
  }
  return finalize(store, { scores: fused, meta: lex.meta, labelsById: lex.labelsById }, qTokens, query, opts, nowMs);
}

function snippet(body: string, qTokens: string[]): string {
  const norm = body.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); // same fold as tokenize
  const lower = norm.toLowerCase();
  let at = -1;
  let hit = "";
  for (const t of qTokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at === -1 || i < at)) { at = i; hit = norm.slice(i, i + t.length); }
  }
  if (at === -1) return norm.slice(0, 120).replace(/\s+/g, " ").trim();
  const start = Math.max(0, at - 60);
  const end = Math.min(norm.length, at + 60);
  const pre = (start > 0 ? "…" : "") + norm.slice(start, at);
  const post = norm.slice(at + hit.length, end) + (end < norm.length ? "…" : "");
  return `${pre}«${hit}»${post}`.replace(/\s+/g, " ").trim();
}

export function formatHits(hits: RecallHit[]): string {
  return hits
    .map((h) => `[${h.source}/${h.domain}] ${h.ref.slice(0, 60)} (${h.ts.slice(0, 10)}): ${h.snippet}`)
    .join("\n");
}
