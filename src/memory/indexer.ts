import { statSync } from "node:fs";
import { join } from "node:path";
import type { Store, MailRow } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { StoredEvent } from "../events.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { Policy } from "../kernel/policy.js";
import { docLabels } from "../kernel/labels.js";
import { indexDoc, DOMAINS, type Domain, type MemorySource } from "./recall.js";

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

export function indexEvent(store: Store, e: StoredEvent, policy?: Policy): void {
  if (!EVENT_INDEX_ALLOW.has(e.event.type)) return;
  if (e.event.type !== "calendar.changed") return;
  const ev = e.event;
  // summary/organizer are attacker-influenceable (external invites) — indexed as retrieval
  // context only; the Action Gate still protects all effects. Do not widen to attendee-set fields.
  const body = `${ev.summary} ${ev.organizer} ${ev.start}`;
  const labels = docLabels({ source: "event", domain: "inbox" });
  // Audit the flow to the recall-index sink (calendar text is untrusted origin).
  policy?.check({ labels, origin: "untrusted", sink: "recall-index" }, "indexer:event", body);
  indexDoc(store, {
    source: "event", ref: `event:${e.id}`, domain: "inbox", labels, origin: "untrusted",
    title: ev.summary, body, ts: e.ts, fingerprint: String(e.id),
  });
}

export function indexDecision(store: Store, actionId: string, policy?: Policy): void {
  const a = store.getAction(actionId);
  if (!a) return;
  // Privacy wall: email decisions carry recipient/subject in their preview — never index them.
  if (a.type.startsWith("email.")) return;
  if (!RESOLVED_STATUSES.includes(a.status)) return;
  const body = `${a.preview}${a.reject_reason ? ` ${a.reject_reason}` : ""}`;
  const domain = domainForType(a.type);
  const labels = docLabels({ source: "decision", domain });
  policy?.check({ labels, sink: "recall-index" }, "indexer:decision", body);
  indexDoc(store, {
    source: "decision", ref: a.id, domain, labels, origin: "trusted",
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
    const domain = domainForVaultPath(rel);
    indexDoc(store, {
      source, ref: rel, domain, labels: docLabels({ source, domain }), origin: "trusted",
      title: rel.split("/").pop()!.replace(/\.md$/, ""), body: content, ts: isoTs, fingerprint: mtime,
    });
  }
  for (const source of ["vault", "memo"] as MemorySource[]) {
    for (const ref of store.listMemoryRefs(source)) {
      if (!onDisk.has(`${source}::${ref}`)) store.deleteMemoryDoc(source, ref);
    }
  }
}

/** Boot backfill: vault + all resolved decisions + allowlisted historical events + mail
 *  threads (when a registry is provided). Idempotent; also deletes newly-walled mail docs. */
export function reconcile(store: Store, vault: VaultWriter, registry?: LoadedRegistry, policy?: Policy): void {
  reindexVault(store, vault);
  // 5000 caps are a deliberate boot-backfill bound (steady state is covered by live indexing +
  // reindexVault), not a paginated full scan.
  for (const a of store.listActions(undefined, 5000)) {
    if (RESOLVED_STATUSES.includes(a.status)) indexDecision(store, a.id, policy);
  }
  for (const row of store.listEvents(0, 5000)) {
    try {
      const event = JSON.parse(row.payload);
      indexEvent(store, { id: row.id, ts: row.ts, event }, policy);
    } catch { /* skip malformed */ }
  }
  if (registry) {
    for (const tid of store.listMailThreadIds()) indexMailThread(store, registry, tid, policy);
  }
}

/** Recall domain for a mail thread: the root recipient's dept memoDomain; asks to the
 *  owner fall back to the asking agent's dept; unresolvable agents → general. */
function mailThreadDomain(registry: LoadedRegistry, root: MailRow): Domain {
  const target = root.to_agent === "user" ? root.from_agent : root.to_agent;
  const canonical = registry.agentOf.get(target);
  const def = canonical ? registry.agents.get(canonical) : undefined;
  const memoDomain = def ? registry.departments.get(def.department)?.memoDomain : undefined;
  return DOMAINS.includes(memoDomain as Domain) ? (memoDomain as Domain) : "general";
}

/** Index one mail thread as a single recall doc — or delete it. Privacy wall at index
 *  time: a thread with ANY private-visibility participant is never indexed, and a stale
 *  doc is deleted (self-healing on visibility flips). Refused messages are excluded from
 *  the body; the count in the fingerprint forces a rebuild when a sweep refusal flips a
 *  message after insert. Bodies may embed external data — indexed as retrieval context
 *  only; the Action Gate still protects all effects (same posture as indexEvent). */
export function indexMailThread(store: Store, registry: LoadedRegistry, threadId: string, policy?: Policy): void {
  const rows = store.mailThread(threadId);
  if (!rows.length) return;
  const ref = `thread:${threadId}`;
  const root = rows[0];
  const domain = mailThreadDomain(registry, root);
  const dept = mailThreadDept(registry, root);
  const participants = new Set<string>();
  for (const m of rows) { participants.add(m.from_agent); participants.add(m.to_agent); }
  participants.delete("user");
  let mailPrivate = false;
  for (const p of participants) {
    const canonical = registry.agentOf.get(p);
    const def = canonical ? registry.agents.get(canonical) : undefined;
    if (def?.manifest.visibility === "private") { mailPrivate = true; break; }
  }
  const labels = docLabels({ source: "mail", domain, dept });
  // Audit the recall-index flow BEFORE the private-participant wall drops it — so the log fires
  // and enforce mode has the label even if the redundant wall is removed later.
  if (mailPrivate) {
    policy?.check({ labels, sink: "recall-index" }, "indexer:mail",
      rows.map((m) => m.body).join("\n"));
    store.deleteMemoryDoc("mail", ref); // wall intact (spec: walls stay in audit)
    return;
  }
  const included = rows.filter((m) => m.status !== "refused");
  if (!included.length) { store.deleteMemoryDoc("mail", ref); return; }
  policy?.check({ labels, sink: "recall-index" }, "indexer:mail",
    included.map((m) => m.body).join("\n"));
  indexDoc(store, {
    source: "mail", ref, domain, labels, origin: "untrusted",
    title: `mail ${root.from_agent} ↔ ${root.to_agent} (${root.kind})`,
    body: included.map((m) => `${m.from_agent} → ${m.to_agent}: ${m.body}`).join("\n"),
    ts: included[included.length - 1].created_at,
    fingerprint: `${included.length}:${rows[rows.length - 1].id}`,
  });
}

/** The department a mail thread belongs to (root recipient's dept; user-asks → asker's dept). */
function mailThreadDept(registry: LoadedRegistry, root: MailRow): string | undefined {
  const target = root.to_agent === "user" ? root.from_agent : root.to_agent;
  const canonical = registry.agentOf.get(target);
  return canonical ? registry.agents.get(canonical)?.department : undefined;
}
