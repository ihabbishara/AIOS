import { statSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { StoredEvent } from "../events.js";
import { indexDoc, type Domain, type MemorySource } from "./recall.js";

/** Event types worth recalling. Inbound email is deliberately absent (security). */
export const EVENT_INDEX_ALLOW = new Set(["calendar.changed"]);

/** Action statuses considered resolved (a decision worth remembering). */
const RESOLVED_STATUSES = ["executed", "failed", "rejected"];

/** Map an action type namespace to a memo/recall domain. */
export function domainForType(type: string): Domain {
  const ns = type.split(".")[0];
  switch (ns) {
    case "email": case "calendar": return "inbox";
    case "finance": case "purchase": return "money";
    case "git": return "code";
    default: return "general";
  }
}

/** Map a vault-relative path to a domain. memos/<d>.md uses the memo's own domain. */
export function domainForVaultPath(rel: string): Domain {
  if (rel.startsWith("memos/")) {
    const d = rel.slice("memos/".length).replace(/\.md$/, "") as Domain;
    return (["inbox", "money", "code", "research", "lifeops", "general", "profile"] as Domain[]).includes(d) ? d : "general";
  }
  if (rel.startsWith("knowledge/")) return "research";
  return "general";
}

export function indexEvent(store: Store, e: StoredEvent): void {
  if (!EVENT_INDEX_ALLOW.has(e.event.type)) return;
  if (e.event.type !== "calendar.changed") return;
  const ev = e.event;
  // summary/organizer are attacker-influenceable (external invites) — indexed as retrieval
  // context only; the Action Gate still protects all effects. Do not widen to attendee-set fields.
  const body = `${ev.summary} ${ev.organizer} ${ev.start}`;
  indexDoc(store, {
    source: "event", ref: `event:${e.id}`, domain: "inbox",
    title: ev.summary, body, ts: e.ts, fingerprint: String(e.id),
  });
}

export function indexDecision(store: Store, actionId: string): void {
  const a = store.getAction(actionId);
  if (!a) return;
  // Privacy wall: email decisions carry recipient/subject in their preview — never index them.
  if (a.type.startsWith("email.")) return;
  if (!RESOLVED_STATUSES.includes(a.status)) return;
  const body = `${a.preview}${a.reject_reason ? ` ${a.reject_reason}` : ""}`;
  indexDoc(store, {
    source: "decision", ref: a.id, domain: domainForType(a.type),
    title: a.type, body, ts: a.resolved_at ?? a.created_at, fingerprint: a.resolved_at ?? a.status,
  });
}

export function reindexVault(store: Store, vault: VaultWriter): void {
  const onDisk = new Set<string>();
  for (const rel of vault.listNotes()) {
    const source: MemorySource = rel.startsWith("memos/") ? "memo" : "vault";
    onDisk.add(`${source}::${rel}`);
    let mtime: string;
    let isoTs: string;
    try {
      const st = statSync(join(vault.root, rel));
      mtime = String(st.mtimeMs);
      isoTs = new Date(st.mtime).toISOString();
    } catch { continue; }
    if (store.memoryFingerprint(source, rel) === mtime) continue;
    const content = vault.readNote(rel);
    if (content === undefined) continue;
    indexDoc(store, {
      source, ref: rel, domain: domainForVaultPath(rel),
      title: rel.split("/").pop()!.replace(/\.md$/, ""), body: content, ts: isoTs, fingerprint: mtime,
    });
  }
  for (const source of ["vault", "memo"] as MemorySource[]) {
    for (const ref of store.listMemoryRefs(source)) {
      if (!onDisk.has(`${source}::${ref}`)) store.deleteMemoryDoc(source, ref);
    }
  }
}

/** Boot backfill: vault + all resolved decisions + allowlisted historical events. Idempotent. */
export function reconcile(store: Store, vault: VaultWriter): void {
  reindexVault(store, vault);
  // 5000 caps are a deliberate boot-backfill bound (steady state is covered by live indexing +
  // reindexVault), not a paginated full scan.
  for (const a of store.listActions(undefined, 5000)) {
    if (RESOLVED_STATUSES.includes(a.status)) indexDecision(store, a.id);
  }
  for (const row of store.listEvents(0, 5000)) {
    try {
      const event = JSON.parse(row.payload);
      indexEvent(store, { id: row.id, ts: row.ts, event });
    } catch { /* skip malformed */ }
  }
}
