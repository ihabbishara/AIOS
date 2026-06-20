import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "../store/db.js";
import type { GoogleAccounts } from "../senses/google/auth.js";
import type { ActionInput, ActionRow } from "../kernel/actions.js";
import type { Origin } from "../kernel/gate.js";
import { extractBody, type GmailReadLike } from "../senses/google/read.js";

/** Inbox metadata used for triage (no body yet). */
export interface EmailCandidate { id: string; threadId: string; from: string; subject: string; snippet: string; }
/** A fully-read message (body included) used for composing. */
export interface EmailMessage { id: string; threadId: string; from: string; subject: string; body: string; }
/** Minimal ActionGate slice — lets tests inject a recording stub. */
export interface GateLike { propose(input: ActionInput, origin: Origin): Promise<ActionRow>; }

export interface SpeculateEmailDeps {
  store: Store;
  gate: GateLike;
  /** Metadata scan of the resolved account's unread inbox. */
  scan: () => Promise<EmailCandidate[]>;
  /** Structured full read of one message (null on failure/unknown account). */
  read: (messageId: string) => Promise<EmailMessage | null>;
  /** LLM triage → chosen message ids (caller still slices to maxJobs). */
  triage: (candidates: EmailCandidate[]) => Promise<string[]>;
  /** LLM compose → reply body, or null/empty to decline. */
  compose: (msg: EmailMessage) => Promise<string | null>;
  /** Account name baked into the email.draft payload. */
  account: string;
  maxJobs: number;
  /** Gate origin — where approve/reject verdicts come from (primaryChat). */
  origin: Origin;
  log?: (line: string) => void;
}

const DRAFTED_KEY = "speculate-email:drafted";
const DRAFTED_CAP = 100;

/** Extract the bare email address from a From header ("Name <a@b>" → "a@b"). */
export function parseFrom(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

/** "Re: " prefix, de-duplicated (case-insensitive). */
export function reSubject(subject: string): string {
  const s = subject.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** Thread ids we already drafted for — skip on subsequent nights. Bad/absent → empty. */
export function readDrafted(store: Store): Set<string> {
  try {
    const raw = store.kvGet(DRAFTED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function writeDrafted(store: Store, threadIds: string[]): void {
  const merged = [...readDrafted(store), ...threadIds];
  const capped = merged.slice(Math.max(0, merged.length - DRAFTED_CAP));
  try { store.kvSet(DRAFTED_KEY, JSON.stringify(capped)); } catch { /* non-fatal */ }
}

/**
 * The nightly email-drafts pass: scan unread inbox → triage ≤K reply-worthy →
 * read those bodies → compose a reply → gate.propose(email.draft).
 * Envelope (to/subject/threadId) is derived from the ORIGINAL headers, never
 * from composer output. Fail-silent throughout; the only effect is gate.propose.
 */
export async function runSpeculateEmail(deps: SpeculateEmailDeps): Promise<void> {
  let candidates: EmailCandidate[];
  try {
    candidates = await deps.scan();
  } catch (err) {
    deps.log?.(`speculate-email: scan failed: ${(err as Error).message}`);
    return;
  }

  const drafted = readDrafted(deps.store);
  const fresh = candidates.filter((c) => c.threadId && !drafted.has(c.threadId));
  if (!fresh.length) { deps.log?.("speculate-email: no fresh candidates"); return; }

  let chosenIds: string[];
  try {
    chosenIds = (await deps.triage(fresh)).slice(0, deps.maxJobs);
  } catch (err) {
    deps.log?.(`speculate-email: triage failed: ${(err as Error).message}`);
    return;
  }
  if (!chosenIds.length) { deps.log?.("speculate-email: triage chose nothing"); return; }

  const draftedThreads: string[] = [];
  for (const id of chosenIds) {
    try {
      const candidate = fresh.find((c) => c.id === id);
      if (!candidate) continue; // triage returned an id not in the candidate set
      const msg = await deps.read(id);
      if (!msg) continue;
      const body = await deps.compose(msg);
      if (!body || !body.trim()) continue; // composer declined
      // Deterministic envelope from the ORIGINAL headers — composer output is body-only.
      const to = parseFrom(msg.from);
      const subject = reSubject(msg.subject);
      // Use the canonical threadId from the scan candidate so the dedupe key and
      // payload threadId are always consistent with the scan metadata. (msg.threadId
      // is the same in production; the candidate is the authoritative source here.)
      const threadId = candidate.threadId;
      await deps.gate.propose(
        {
          type: "email.draft",
          preview: "email draft", // gate authors the real preview for email.* types
          payload: { account: deps.account, to, subject, body, threadId },
        },
        deps.origin,
      );
      draftedThreads.push(threadId);
    } catch (err) {
      deps.log?.(`speculate-email: draft failed for ${id}: ${(err as Error).message}`);
    }
  }
  if (draftedThreads.length) writeDrafted(deps.store, draftedThreads);
}
