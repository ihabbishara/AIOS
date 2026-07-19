// src/kernel/policy.ts — central information-flow checkpoint (spec §4–5). Pure table + a
// mode-aware wrapper. Sibling of the gate: governs information flow, not effects (spec §10).
export type Label =
  | "personal.finance" | "personal.email" | "personal.tasks" | "personal.calendar"
  | "client.halalo" | "org.internal" | "shared";
export type Origin = "trusted" | "untrusted";
export type Sink = string; // prefixed: recall-index | vault | brief | standup | chat:<o> | mail:<r> | prompt.system:<a> | prompt.context:<a> | file-export
export type PolicyMode = "audit" | "enforce";

export interface CheckInput {
  labels: Label[];
  origin?: Origin;              // default "trusted"
  sink: Sink;
  agent?: { labels: string[] }; // ResolvedAgent.labels — the reader's clearance
  /** Narrow flow discriminator for declassify rules that rescue one specific pathway
   *  (e.g. "decision-preview" for D2) — set by the call site, never derived from content. */
  flow?: string;
}
export type Verdict = "allow" | "deny" | { declassify: string };

export interface Violation { label: Label; sink: Sink; site: string; hash: string }

const PRIMARY_CHATS = new Set(["chat:primary", "chat:web-ui"]);
const isChat = (s: Sink) => s.startsWith("chat:");
const isPrimaryChat = (s: Sink) => PRIMARY_CHATS.has(s);
const promptAgent = (s: Sink): string | null => {
  const m = /^prompt\.(system|context):(.+)$/.exec(s);
  return m ? m[2] : null;
};
/** The reader agent holds this confidentiality label as clearance. */
const agentCleared = (label: Label, agent?: CheckInput["agent"]) => !!agent?.labels.includes(label);

/** Coordinator (hermes) prompts may carry calendar context (spec §5 "private + coordinator prompts"). */
function isCoordinatorSink(sink: Sink): boolean {
  return sink === "prompt.system:hermes" || sink === "prompt.context:hermes";
}

// Per-label allowed-sink predicate (spec §5). Returns true=allow, false=deny; declassification is
// handled separately below so the table stays boolean.
const POLICY_TABLE: Record<Label, (sink: Sink, agent?: CheckInput["agent"]) => boolean> = {
  shared: () => true,
  "personal.finance": (sink, agent) =>
    isPrimaryChat(sink) || (!!promptAgent(sink) && agentCleared("personal.finance", agent)),
  "personal.email": (sink) => sink === "prompt.context:speculate-email",
  // life/clients standups + halalo brief mail: the "money wall" was finance-only, so these two
  // labels ride the brief/standup sinks (parity with pre-wall-deletion; the digest is goal
  // metadata, never personal_* or email bodies). Only personal.finance stays fully walled there.
  "personal.tasks": (sink, agent) =>
    isPrimaryChat(sink) || sink === "brief" || sink === "standup" ||
    (!!promptAgent(sink) && agentCleared("personal.tasks", agent)),
  "personal.calendar": (sink, agent) =>
    sink === "brief" || sink === "recall-index" ||
    (!!promptAgent(sink) && (agentCleared("personal.calendar", agent) || isCoordinatorSink(sink))),
  "client.halalo": (sink, agent) =>
    sink === "file-export" || sink === "brief" || sink === "standup" ||
    (!!promptAgent(sink) && agentCleared("client.halalo", agent)),
  "org.internal": (sink) => sink !== "file-export" && !(isChat(sink) && !isPrimaryChat(sink)),
};

// Enumerated declassify rules (spec §5). Each rule is SCOPED to the single label it lowers —
// a rule may only rescue its own label, never a co-present stricter one (that would be laundering).
const DECLASSIFY_RULES: Record<string, { label: Label; ok: (input: CheckInput) => boolean }> = {
  // D1: personal.email → brief ONLY as a count-only summary ("N reply drafts await approval").
  "D1-email-count": { label: "personal.email", ok: (i) => i.sink === "brief" },
  // D2: finance DECISION PREVIEWS may be recall-indexed (wall-deletion cycle). Previews are
  // curated one-liners (payloads are never indexed) and pre-policy behavior always indexed
  // them; the read-side clearance filter still gates who can retrieve them. Finance MAIL and
  // raw finance docs stay denied — this rescues only the decision-preview flow.
  "D2-finance-decision-preview": {
    label: "personal.finance",
    ok: (i) => i.sink === "recall-index" && i.flow === "decision-preview",
  },
};

/** Full evaluation: the verdict plus, on a deny, the specific label that caused it (for the
 *  audit record — labels[0] would misname the offender on a multi-label union). */
function evaluate(input: CheckInput): { verdict: Verdict; deniedBy?: Label } {
  const origin = input.origin ?? "trusted";
  // Untrusted integrity: never system-prompt prose; context (fenced data) is allowed.
  if (origin === "untrusted" && input.sink.startsWith("prompt.system:")) {
    return { verdict: "deny", deniedBy: input.labels[0] };
  }
  // Strictest label wins. A declassify rule may only rescue THE label it is keyed to, so a
  // co-present stricter label cannot ride a weaker label's rule to the sink (no laundering).
  let declassify: string | undefined;
  for (const label of input.labels) {
    if (POLICY_TABLE[label](input.sink, input.agent)) continue;
    const rule = Object.entries(DECLASSIFY_RULES).find(([, r]) => r.label === label && r.ok(input));
    if (rule) { declassify = rule[0]; continue; }
    return { verdict: "deny", deniedBy: label };
  }
  return { verdict: declassify ? { declassify } : "allow" };
}

export function rawCheck(input: CheckInput): Verdict {
  return evaluate(input).verdict;
}

export { POLICY_TABLE, DECLASSIFY_RULES };

export function labelHash(s: string): string {
  // Short, non-reversible: a violation must never carry content, only a stable fingerprint.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** A sink is "sensitive" (stricter than chat) when an unlabeled flow to it must be denied in
 *  enforce mode (spec §4). Chat sinks are the only non-sensitive default. */
const isSensitiveSink = (s: Sink) => !s.startsWith("chat:");

export class Policy {
  constructor(private deps: { mode: PolicyMode; report: (v: Violation) => void }) {}

  get mode(): PolicyMode { return this.deps.mode; }

  /** Returns the enforced verdict for the current mode ("allow"/"deny"), reporting any raw deny.
   *  `contentForHash` is hashed for the violation record and NEVER stored/emitted as text. */
  check(input: CheckInput, site: string, contentForHash = ""): "allow" | "deny" {
    // An unlabeled flow at a sink stricter than chat is what enforce will deny (spec §4). Detect
    // it mode-independently so AUDIT reports (previews) it — otherwise "one clean audit week"
    // hides exactly the flows the enforce flip is about to start denying.
    const unlabeledSensitive = input.labels.length === 0 && isSensitiveSink(input.sink);
    const { verdict, deniedBy } = unlabeledSensitive
      ? { verdict: "deny" as Verdict, deniedBy: undefined }
      : evaluate(input);
    const denied = verdict === "deny";
    if (denied) {
      const label = deniedBy ?? input.labels[0] ?? "shared";
      this.deps.report({ label, sink: input.sink, site, hash: labelHash(contentForHash) });
    }
    if (this.deps.mode === "audit") return "allow"; // block nothing new
    return denied ? "deny" : "allow"; // declassify → allow
  }

  /** Wall-replacement sites (wall-deletion spec): the table verdict is authoritative in BOTH
   *  modes. These flows were blocked by bespoke walls before the policy engine existed, so
   *  honoring the table in audit is parity with the old behavior, not a new block. Denials are
   *  reported exactly like check() — the violation stream is how we observe walls working. */
  wall(input: CheckInput, site: string, contentForHash = ""): "allow" | "deny" {
    const { verdict, deniedBy } = evaluate(input);
    if (verdict === "deny") {
      const label = deniedBy ?? input.labels[0] ?? "shared";
      this.deps.report({ label, sink: input.sink, site, hash: labelHash(contentForHash) });
      return "deny";
    }
    return "allow"; // declassify → allow
  }
}

/** Wall-site verdict when the Policy instance may be absent (unit tests): the TABLE is still
 *  authoritative — a missing reporter must never fail open. Prod always wires a Policy, so
 *  denials are reported; without one the verdict alone stands. */
export function wallVerdict(
  policy: Policy | undefined, input: CheckInput, site: string, contentForHash = "",
): "allow" | "deny" {
  if (policy) return policy.wall(input, site, contentForHash);
  return rawCheck(input) === "deny" ? "deny" : "allow";
}
