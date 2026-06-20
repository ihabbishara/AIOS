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
