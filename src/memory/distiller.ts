import { createHash } from "node:crypto";
import type { Store, MemoFactRow } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { ActionGate } from "../kernel/gate.js";
import type { EventBus } from "../events.js";
import type { Origin, Policy } from "../kernel/policy.js";
import { domainLabel } from "../kernel/labels.js";
import { DOMAINS, type Domain } from "./recall.js";
import { domainForType } from "./indexer.js";
import { memoRelPath, ALWAYS_LOADED } from "./memos.js";
import { renderMemo } from "./facts.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

const ORIGIN = { channel: "system", chatId: "distill" };

export interface FactCandidate { subject: string; fact: string; source_ref: string; supersedes?: number }
export type FactDiffFn = (input: {
  domain: string; active: MemoFactRow[]; signals: Array<{ ref: string; text: string }>;
}) => Promise<FactCandidate[]>;
/** Grounding verifier (spec §4): per candidate, does sourceText actually support the claim?
 *  Fail-closed: a thrown error means NOTHING lands this run. */
export type GroundFn = (batch: Array<{ subject: string; fact: string; sourceText: string }>) => Promise<boolean[]>;

export interface DistillDeps {
  store: Store;
  vault: VaultWriter;
  gate: ActionGate;
  /** Fact-diff extractor (memory-v2 §4): signals + active facts → new/supersede candidates. */
  factDiff: FactDiffFn;
  /** Grounding verifier — ungrounded candidates are dropped + memory.ungrounded emitted. */
  ground: GroundFn;
  /** memory.ungrounded emitter (optional — tests may omit). */
  bus?: EventBus;
  /** Info-flow checkpoint — memos bound for the SYSTEM prompt (ALWAYS_LOADED domains) may only
   *  derive from trusted-origin signals; untrusted signals are excluded + logged (spec §6). */
  policy?: Policy;
  /** Origin of a distiller input — decisions and teachings are trusted by construction; this
   *  seam lets a test inject an untrusted signal to prove it is dropped. Default: trusted. */
  signalOrigin?: (source: "decision" | "teaching", ref: string) => Origin;
  nowIso?: string;
  log?: (line: string) => void;
}

export async function distill(deps: DistillDeps): Promise<void> {
  for (const domain of DOMAINS) {
    try {
      await distillDomain(deps, domain);
    } catch (err) {
      deps.log?.(`distill ${domain} failed: ${(err as Error).message}`);
    }
  }
}

async function distillDomain(deps: DistillDeps, domain: Domain): Promise<void> {
  const { store, vault, gate } = deps;
  const since = store.kvGet(`distill:last:${domain}`) ?? undefined;

  const decisions = domain === "profile"
    ? []
    // Exclude vault.write: the distiller's own gate-audited memo writes are recorded as
    // decisions; re-consuming them would create a self-feeding loop (every run re-curates the
    // 'general' domain those writes map to). Memo writes carry no preference signal.
    : store.listDecisions(since).filter((d) => d.type !== "vault.write" && domainForType(d.type) === domain);

  // The two queries are disjoint (domain IS NULL vs domain = 'profile'), so no dedup is needed.
  // Collecting both also rescues any pre-existing rows mis-stamped with the literal "profile" domain.
  const teachings = domain === "profile"
    ? [...store.listUnconsolidatedTeachings(null), ...store.listUnconsolidatedTeachings("profile")].filter((t) => t.kind === "fact" || t.kind === "forget")
    : store.listUnconsolidatedTeachings(domain).filter((t) => t.kind === "preference" || t.kind === "forget");

  const existing = vault.readNote(memoRelPath(domain)) ?? "";
  // A prose memo whose facts were never extracted must count as a signal source, or a QUIET
  // domain (no new decisions/teachings) never bootstraps — general.md sat unextracted for weeks
  // behind the early return. But once a bootstrap run has completed with no extractable facts,
  // stamp a kv marker so it does NOT re-run the LLM every night forever (a prose memo that never
  // yields a fact). A genuine factDiff error THROWS (never reaches the stamp), so the stamp only
  // fires on a clean empty extraction; a later fact still lands via the normal decision/teaching
  // path. The marker clears implicitly once facts exist (bootstrapPending is false anyway).
  const bootstrapDone = !!store.kvGet(`distill:bootstrapped:${domain}`);
  const bootstrapPending = !!existing.trim() && !store.activeMemoFacts(domain).length && !bootstrapDone;
  // No-op without bumping the cursor: decisions are deliberately re-read every run until a write
  // succeeds, so the cursor stays write-dependent (do not "fix" it into a write-independent one).
  if (!decisions.length && !teachings.length && !bootstrapPending) return;
  const originOf = deps.signalOrigin ?? (() => "trusted" as Origin);
  const typed: Array<{ text: string; origin: Origin; ref: string }> = [
    ...decisions.map((d) => ({
      text: `- decision[${d.verdict}] ${d.preview}${d.reason ? ` — reason: ${d.reason}` : ""}`,
      origin: originOf("decision", d.id),
      ref: `decision:${d.id}`,
    })),
    ...teachings.map((t) => ({ text: `- ${t.kind}: ${t.text}`, origin: originOf("teaching", String(t.id)), ref: `teaching:${t.id}` })),
  ];

  // Memos that reach a SYSTEM prompt must never carry an untrusted-origin signal (the inbox.md
  // injection vector). The system-prompt-injected set is `profile` (memoContext AND every dept's
  // memoContextForDomain) PLUS ALWAYS_LOADED — NOT just ALWAYS_LOADED, or profile is a hole.
  // Structural guarantee: decisions/teachings are trusted by construction, so it's a no-op on
  // real data, but any future untrusted source can never become system-prompt prose (spec §6).
  const systemPromptMemo = domain === "profile" || ALWAYS_LOADED.includes(domain);
  let kept = typed;
  if (systemPromptMemo) {
    kept = typed.filter((s) => {
      if (s.origin === "trusted") return true;
      deps.policy?.check(
        { labels: [domainLabel(domain)], origin: "untrusted", sink: "prompt.system:hermes" },
        `distiller:${domain}`, s.text,
      );
      return false;
    });
  }
  const signals = kept.map((s) => ({ ref: s.ref, text: s.text }));
  const active = store.activeMemoFacts(domain);
  // Bootstrap (first fact-diff run): fold the existing prose memo in as a signal; its facts
  // ground against the vault memo itself (source_ref memo:<domain>).
  if (!active.length && existing.trim()) signals.push({ ref: `memo:${domain}`, text: existing });
  if (!signals.length) return;

  const nowIso = deps.nowIso ?? new Date().toISOString();
  const candidates = await deps.factDiff({ domain, active, signals });
  if (!candidates.length) {
    // Clean empty extraction on a bootstrap run → stamp so we don't re-hit the LLM nightly. A
    // real factDiff failure throws before here, so a transient error never stamps.
    if (bootstrapPending) store.kvSet(`distill:bootstrapped:${domain}`, nowIso);
    return;
  }

  // Resolve + ground (spec §4, fail-closed): unresolvable refs never reach the verifier.
  // A teaching whose candidate is DROPPED (unresolvable ref or ungrounded) must NOT be marked
  // consolidated below — otherwise a verifier false-negative silently consumes it forever.
  const retryTeachingIds = new Set<number>();
  const noteRetry = (ref: string) => { if (ref.startsWith("teaching:")) retryTeachingIds.add(Number(ref.slice(9))); };

  const resolved = candidates
    .map((c) => ({ c, sourceText: resolveSourceRef(store, vault, domain, c.source_ref) }))
    .filter((r): r is { c: FactCandidate; sourceText: string } => {
      if (r.sourceText !== undefined) return true;
      emitUngrounded(deps, domain, r.c.fact); noteRetry(r.c.source_ref);
      return false;
    });
  let verdicts: boolean[];
  try {
    verdicts = await deps.ground(resolved.map((r) => ({ subject: r.c.subject, fact: r.c.fact, sourceText: r.sourceText })));
  } catch (err) {
    deps.log?.(`distill ${domain}: grounding verifier failed (${(err as Error).message}) — dropping all candidates`);
    verdicts = resolved.map(() => false);
  }

  const accepted: Array<{ c: FactCandidate; origin: MemoFactRow["origin"] }> = [];
  resolved.forEach((r, i) => {
    if (!verdicts[i]) { emitUngrounded(deps, domain, r.c.fact); noteRetry(r.c.source_ref); return; }
    accepted.push({ c: r.c, origin: originOfRef(store, r.c.source_ref) });
  });
  if (!accepted.length) return;

  // Render PROSPECTIVELY and persist facts only when the gate write executes — otherwise a
  // queued (non-autonomous) write would re-insert the same facts on every retry run.
  // Re-read active AFTER the LLM awaits: forgetNow (the moderator's forget tool) can supersede a
  // fact during the minutes of factDiff/ground latency; the stale `active` snapshot would render
  // the forgotten fact straight back into a system-prompt memo. The fresh set has it dropped.
  const freshActive = store.activeMemoFacts(domain);
  const supersededIds = new Set(accepted.map((a) => a.c.supersedes).filter((x): x is number => !!x));
  const prospective: MemoFactRow[] = [
    ...freshActive.filter((f) => !supersededIds.has(f.id)),
    ...accepted.map((a, i) => ({
      id: -(i + 1), domain, subject: a.c.subject, fact: a.c.fact, ts: nowIso,
      source_ref: a.c.source_ref, status: "active" as const, origin: a.origin, superseded_by: null,
    })),
  ];
  const rendered = renderMemo(domain, prospective);
  if (!rendered) return;
  // Content-hash idempotencyKey: while autonomy is revoked, an identical nightly re-render dedupes
  // against the still-pending proposal (gate.propose returns the dup) instead of stacking a new
  // approval every night; a genuinely changed render hashes differently and proposes fresh.
  const idempotencyKey = `distill:${domain}:${createHash("sha256").update(rendered).digest("hex").slice(0, 12)}`;
  const row = await gate.propose(
    { type: "vault.write", idempotencyKey, payload: { path: memoRelPath(domain), content: rendered }, preview: `Update ${domain} memo (${accepted.length} fact${accepted.length === 1 ? "" : "s"})` },
    ORIGIN,
  );
  if (row.status === "executed") {
    for (const a of accepted) {
      const newId = store.addMemoFact({
        domain, subject: a.c.subject, fact: a.c.fact, sourceRef: a.c.source_ref, origin: a.origin, ts: nowIso,
      });
      if (a.c.supersedes) store.supersedeMemoFact(a.c.supersedes, newId);
    }
    if (teachings.length) {
      // Consume only teachings whose candidate wasn't dropped — a dropped one is retried next run.
      const consumed = teachings.filter((t) => !retryTeachingIds.has(t.id)).map((t) => t.id);
      if (consumed.length) store.markTeachingsConsolidated(consumed);
    }
    if (decisions.length) {
      // Stamp the cursor with the MAX consumed decision ts (not "now") so a decision resolved
      // mid-run is re-read next run (a benign re-curate) instead of being silently skipped.
      const watermark = decisions.reduce((m, d) => (d.ts > m ? d.ts : m), decisions[0].ts);
      store.kvSet(`distill:last:${domain}`, watermark);
    }
  } else {
    deps.log?.(`distill ${domain}: memo write not executed (${row.status})`);
  }
}

function emitUngrounded(deps: DistillDeps, domain: string, fact: string): void {
  const hash = createHash("sha256").update(fact).digest("hex").slice(0, 12);
  deps.log?.(`distill ${domain}: ungrounded fact dropped (${hash})`);
  deps.bus?.emit({ type: "memory.ungrounded", domain, hash });
}

/** source_ref grammar: teaching:<id> | decision:<id> | memo:<domain> | doc:<source>:<ref>.
 *  Returns the supporting text, or undefined when the ref does not resolve (→ fact dropped).
 *
 *  NOTE (grounding is circular for teaching refs): a teaching resolves to its OWN text, so the
 *  grounding verifier ("does SOURCE support FACT") is trivially satisfied for teaching-derived
 *  facts and provides NO integrity protection there — grounding only bites for doc:/decision:
 *  refs against independent sources. The protection for a capture-derived (agent-inferred)
 *  teaching is therefore its ORIGIN classification + renderMemo's untrusted exclusion, not the
 *  verifier. Do not add trust weight to teaching-sourced facts on the strength of grounding. */
function resolveSourceRef(store: Store, vault: VaultWriter, domain: string, ref: string): string | undefined {
  if (ref.startsWith("teaching:")) return store.getTeaching(Number(ref.slice(9)))?.text;
  if (ref.startsWith("decision:")) {
    const a = store.getAction(ref.slice(9));
    return a ? `${a.preview}${a.reject_reason ? ` — ${a.reject_reason}` : ""}` : undefined;
  }
  if (ref === `memo:${domain}`) return vault.readNote(memoRelPath(domain as Domain));
  if (ref.startsWith("doc:")) {
    const [, source, ...rest] = ref.split(":");
    return store.memoryDocBody(source, rest.join(":"));
  }
  return undefined;
}

function originOfRef(store: Store, ref: string): MemoFactRow["origin"] {
  if (ref.startsWith("teaching:")) {
    const t = store.getTeaching(Number(ref.slice(9)));
    const o = t?.origin;
    return o === "agent-inferred" || o === "untrusted" ? o : "user-stated";
  }
  if (ref.startsWith("decision:")) return "user-stated"; // human verdicts are the user's own acts
  return "agent-inferred"; // memo bootstrap / doc-derived
}

const FACT_DIFF_SYSTEM =
  "You maintain a fact-granular memory. Given ACTIVE facts and NEW signals, output ONLY a JSON " +
  "array of candidate changes: {\"subject\", \"fact\", \"source_ref\", \"supersedes\"?}. subject is a " +
  "short stable topic key; fact is one concise sentence; source_ref MUST be copied verbatim from a " +
  "signal's ref. Use supersedes:<id> when a new fact contradicts/replaces an active fact (newer wins). " +
  "Emit nothing for signals that add no durable fact. Empty array if no changes.";

/** Production fact-diff: single-turn, tool-less; [] on ANY failure (no-diff is always safe).
 *  Uses the Claude subscription via the SDK (CLAUDE_CODE_OAUTH_TOKEN) — never an API key. */
export function factDiffLLM(model?: string, log?: (line: string) => void): FactDiffFn {
  return async ({ domain, active, signals }) => {
    try {
      const prompt = [
        `Domain: ${domain}`,
        "## Active facts (id: subject: fact)",
        active.map((f) => `${f.id}: ${f.subject}: ${f.fact}`).join("\n") || "(none)",
        "## New signals (ref: text)",
        signals.map((s) => `${s.ref}: ${s.text}`).join("\n"),
        "JSON array only.",
      ].join("\n\n");
      const q = query({ prompt, options: {
        systemPrompt: FACT_DIFF_SYSTEM, allowedTools: [], permissionMode: "dontAsk",
        settingSources: [], persistSession: false, maxTurns: 1, ...(model ? { model } : {}),
      } });
      for await (const msg of q) {
        if (msg.type === "result") {
          if (msg.subtype !== "success") return [];
          const m = /\[[\s\S]*\]/.exec(msg.result);
          return m ? (JSON.parse(m[0]) as FactCandidate[]) : [];
        }
      }
      return [];
    } catch (err) {
      // THROW, don't mask as []: distill's per-domain catch skips this domain (retries next run)
      // and — critically — the bootstrap stamp only fires on a clean empty extraction, never on a
      // transient failure that would otherwise permanently skip bootstrap.
      log?.(`factDiffLLM ${domain} failed: ${(err as Error).message}`);
      throw err;
    }
  };
}

const GROUND_SYSTEM =
  "You are a strict fact-checker. For each numbered candidate, answer whether the SOURCE text " +
  "genuinely supports the FACT (not merely mentions related words). Output ONLY a JSON array of " +
  "booleans, one per candidate, in order.";

/** Production grounding verifier. THROWS on failure — the distiller drops everything that run
 *  (fail-closed for writes, spec §4). */
export function groundLLM(model?: string, log?: (line: string) => void): GroundFn {
  return async (batch) => {
    if (!batch.length) return [];
    const prompt = batch
      .map((b, i) => `${i + 1}. FACT: ${b.subject}: ${b.fact}\n   SOURCE: ${b.sourceText.slice(0, 1500)}`)
      .join("\n\n") + "\n\nJSON array of booleans only.";
    log?.(`groundLLM: verifying ${batch.length} candidate(s)`);
    const q = query({ prompt, options: {
      systemPrompt: GROUND_SYSTEM, allowedTools: [], permissionMode: "dontAsk",
      settingSources: [], persistSession: false, maxTurns: 1, ...(model ? { model } : {}),
    } });
    for await (const msg of q) {
      if (msg.type === "result") {
        if (msg.subtype !== "success") throw new Error("grounding verifier returned no result");
        const m = /\[[\s\S]*\]/.exec(msg.result);
        if (!m) throw new Error("grounding verifier output unparseable");
        const arr = JSON.parse(m[0]) as boolean[];
        if (arr.length !== batch.length) throw new Error("grounding verdict count mismatch");
        return arr;
      }
    }
    throw new Error("grounding verifier stream ended without result");
  };
}
