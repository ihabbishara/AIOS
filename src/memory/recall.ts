import type { Store } from "../store/db.js";
import type { Label, Policy } from "../kernel/policy.js";
import { tokenize } from "./tokenize.js";

export type MemorySource = "vault" | "event" | "decision" | "memo" | "mail";
export type Domain = "inbox" | "money" | "code" | "research" | "lifeops" | "general" | "profile";
export const DOMAINS: Domain[] = ["inbox", "money", "code", "research", "lifeops", "general", "profile"];

export interface MemoryDocInput {
  source: MemorySource; ref: string; domain: Domain;
  /** Confidentiality labels (info-flow policy §6). Defaults to [] when a caller omits them. */
  labels?: Label[];
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

/** Index (or re-index) a document. No-op when the fingerprint is unchanged. */
export function indexDoc(store: Store, doc: MemoryDocInput): void {
  if (store.memoryFingerprint(doc.source, doc.ref) === doc.fingerprint) return;
  const tf = new Map<string, number>();
  for (const t of tokenize(doc.title)) tf.set(t, (tf.get(t) ?? 0) + TITLE_BOOST);
  for (const t of tokenize(doc.body)) tf.set(t, (tf.get(t) ?? 0) + 1);
  const len = [...tf.values()].reduce((a, b) => a + b, 0);
  store.upsertMemoryDoc({ ...doc, labels: doc.labels ?? [], len }, [...tf.entries()]);
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
}

/** A doc is visible to a caller iff every label is `shared` or in the caller's clearance. */
function visibleTo(labels: string[], clearance: string[]): boolean {
  return labels.every((l) => l === "shared" || clearance.includes(l));
}

export function recall(store: Store, query: string, opts: RecallOpts = {}): RecallHit[] {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length) return [];
  const rows = store.memoryPostings(qTokens, opts.domain);
  if (!rows.length) return [];

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

  const nowMs = opts.nowMs ?? Date.now();
  const halfLife = opts.halfLifeDays ?? DEFAULT_HALFLIFE_DAYS;
  for (const [id, score] of scores) {
    scores.set(id, score * decayFactor(meta.get(id)!.ts, nowMs, halfLife));
  }

  // Clearance filter (spec §7.8): drop docs the caller isn't cleared for BEFORE ranking, so a
  // denied doc never occupies a result slot. Audit logs but keeps the hole open; enforce drops.
  if (opts.clearance) {
    for (const [id, docLbls] of labelsById) {
      if (docLbls.length === 0 || visibleTo(docLbls, opts.clearance)) continue;
      const decision = opts.policy?.check(
        { labels: docLbls as Label[], sink: "recall-index", agent: { labels: opts.clearance } },
        "recall:clearance", meta.get(id)!.ref,
      );
      if (decision === "deny") scores.delete(id); // enforce: remove; audit returns "allow", kept
    }
  }

  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit);
  const bodies = new Map(store.memoryDocsByIds(ranked.map(([id]) => id)).map((d) => [d.id, d.body]));

  return ranked.map(([id, score]) => {
    const m = meta.get(id)!;
    return { ...m, score, snippet: snippet(bodies.get(id) ?? "", qTokens) };
  });
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
