import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store/db.js";
import type { StoredEvent } from "../events.js";
import type { VaultWriter } from "../vault/writer.js";
import { indexDoc } from "./recall.js";
import type { Domain, MemorySource } from "./recall.js";

// ---- domain mapping ----

const DOMAIN_PREFIX_MAP: Array<[string, Domain]> = [
  ["email.", "inbox"],
  ["calendar.", "inbox"],
  ["mail.", "inbox"],
  ["finance.", "money"],
  ["purchase.", "money"],
  ["payment.", "money"],
  ["git.", "code"],
  ["code.", "code"],
  ["repo.", "code"],
  ["research.", "research"],
  ["note.", "general"],
  ["vault.", "general"],
  ["task.", "lifeops"],
  ["health.", "lifeops"],
  ["profile.", "profile"],
];

export function domainForType(type: string): Domain {
  for (const [prefix, domain] of DOMAIN_PREFIX_MAP) {
    if (type.startsWith(prefix)) return domain;
  }
  return "general";
}

// ---- event indexer ----

/**
 * Only calendar.changed events are indexed. mail.received is NEVER indexed
 * (privacy / prompt-injection risk). Other event types are ignored.
 */
const EVENT_INDEX_ALLOW = new Set(["calendar.changed"]);

export function indexEvent(store: Store, e: StoredEvent): void {
  const { event } = e;
  if (!EVENT_INDEX_ALLOW.has(event.type)) return;

  if (event.type === "calendar.changed") {
    const ref = `event:${e.id}`;
    const title = event.summary;
    const body = [event.summary, event.account, event.organizer, event.status].filter(Boolean).join(" ");
    const fingerprint = sha256(`${event.eventId}|${event.summary}|${event.start}|${event.status}`);
    indexDoc(store, {
      source: "event",
      ref,
      domain: "inbox",
      title,
      body,
      ts: e.ts,
      fingerprint,
    });
  }
}

// ---- decision indexer ----

/**
 * Indexes only the preview and reject_reason of a resolved action.
 * The raw payload field is NEVER indexed — it may contain secrets (IBANs, tokens, etc.).
 */
export function indexDecision(store: Store, actionId: string): void {
  const action = store.getAction(actionId);
  if (!action) return;

  // Only index resolved decisions (rejected, executed, failed) — not proposed/expired
  if (!["rejected", "executed", "failed"].includes(action.status)) return;

  const domain = domainForType(action.type);
  const parts: string[] = [action.preview];
  if (action.reject_reason) parts.push(action.reject_reason);
  const body = parts.join(" ");
  const fingerprint = sha256(`${action.id}|${action.preview}|${action.reject_reason ?? ""}|${action.status}`);

  indexDoc(store, {
    source: "decision",
    ref: actionId,
    domain,
    title: action.preview,
    body,
    ts: action.resolved_at ?? action.created_at,
    fingerprint,
  });
}

// ---- vault walk ----

/**
 * Determine the MemorySource for a vault-relative path.
 * Files under memos/ are tagged "memo"; everything else is "vault".
 */
function sourceForPath(relPath: string): MemorySource {
  return relPath.startsWith("memos/") ? "memo" : "vault";
}

/**
 * Determine the Domain for a vault-relative path.
 * memos/<domain>.md → domain from filename (if it's a known domain keyword).
 * Everything else defaults to "general".
 */
function domainForVaultPath(relPath: string): Domain {
  if (relPath.startsWith("memos/")) {
    const filename = relPath.replace(/^memos\//, "").replace(/\.md$/, "");
    // Use the basename as a domain hint
    const knownDomains: Domain[] = ["inbox", "money", "code", "research", "lifeops", "general", "profile"];
    const lower = filename.toLowerCase() as Domain;
    if (knownDomains.includes(lower)) return lower;
  }
  return "general";
}

/**
 * Walk the vault, index all .md files, and prune deleted ones.
 * Idempotent — fingerprint check inside indexDoc skips unchanged files.
 */
export function reindexVault(store: Store, vault: VaultWriter): void {
  const notes = vault.listNotes();

  // Build a set of currently known refs (for pruning)
  const currentRefs = new Set(notes.map((relPath) => `vault:${relPath}`));
  const memoRefs = new Set(
    notes
      .filter((p) => p.startsWith("memos/"))
      .map((relPath) => `vault:${relPath}`),
  );

  // Index each note
  for (const relPath of notes) {
    const absPath = join(vault.root, relPath);
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath, "utf8");
    const source = sourceForPath(relPath);
    const domain = domainForVaultPath(relPath);
    const ref = `vault:${relPath}`;
    const fingerprint = sha256(content);

    // Derive a title from the first heading or the filename
    const headingMatch = content.match(/^#\s+(.+)/m);
    const title = headingMatch ? headingMatch[1].trim() : relPath.replace(/.*\//, "").replace(/\.md$/, "");

    indexDoc(store, {
      source,
      ref,
      domain,
      title,
      body: content,
      ts: new Date().toISOString(),
      fingerprint,
    });
  }

  // Prune docs that no longer exist on disk
  // We need to check both "vault" and "memo" sources
  for (const src of ["vault", "memo"] as MemorySource[]) {
    const existingRefs = store.listMemoryRefs(src);
    for (const ref of existingRefs) {
      // Determine which set to check — memo refs also use vault: prefix in our scheme
      if (!currentRefs.has(ref)) {
        store.deleteMemoryDoc(src, ref);
      }
    }
  }
}

// ---- boot reconcile ----

/**
 * Backfill indexing on boot. Walks vault and re-indexes decisions.
 * Safe to call multiple times — fingerprint checks make it idempotent.
 */
export function reconcile(store: Store, vault: VaultWriter): void {
  reindexVault(store, vault);

  // Re-index all resolved decisions
  const decisions = store.listDecisions();
  for (const d of decisions) {
    indexDecision(store, d.id);
  }
}

// ---- helpers ----

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
