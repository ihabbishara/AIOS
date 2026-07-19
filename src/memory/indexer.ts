import { statSync } from "node:fs";
import { join } from "node:path";
import type { Store, MailRow } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { StoredEvent } from "../events.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import { wallVerdict, type Policy } from "../kernel/policy.js";
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
  // The table is the wall (wall-deletion spec) — calendar allows recall-index today; this is
  // defense in depth for any future label the allowlist admits.
  if (wallVerdict(policy, { labels, origin: "untrusted", sink: "recall-index" }, "indexer:event", body) === "deny") return;
  indexDoc(store, {
    source: "event", ref: `event:${e.id}`, domain: "inbox", labels, origin: "untrusted",
    title: ev.summary, body, ts: e.ts, fingerprint: String(e.id),
  });
}

export function indexDecision(store: Store, actionId: string, policy?: Policy): void {
  const a = store.getAction(actionId);
  if (!a) return;
  if (!RESOLVED_STATUSES.includes(a.status)) return;
  const body = `${a.preview}${a.reject_reason ? ` ${a.reject_reason}` : ""}`;
  const domain = domainForType(a.type);
  // email.* decisions label personal.email (previews carry recipient/subject) — the table denies
  // them at recall-index, replacing the old email-prefix wall (wall-deletion spec).
  const labels = docLabels({ source: "decision", domain, actionType: a.type });
  // flow "decision-preview" → D2 declassify keeps finance decision previews recallable.
  if (wallVerdict(policy, { labels, sink: "recall-index", flow: "decision-preview" }, "indexer:decision", body) === "deny") return;
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

/** Index one mail thread as a single recall doc — or delete it. The policy table is the
 *  privacy wall: labels union the thread dept with every participant's dept, and a deny at
 *  the recall-index sink deletes the doc (self-healing on label/dept changes). Refused
 *  messages are excluded from the body; the count in the fingerprint forces a rebuild when
 *  a sweep refusal flips a message after insert. Bodies may embed external data — indexed
 *  as retrieval context only; the Action Gate still protects all effects (same posture as
 *  indexEvent). */
export function indexMailThread(store: Store, registry: LoadedRegistry, threadId: string, policy?: Policy): void {
  const rows = store.mailThread(threadId);
  if (!rows.length) return;
  const ref = `thread:${threadId}`;
  const root = rows[0];
  const domain = mailThreadDomain(registry, root);
  const dept = mailThreadDept(registry, root);
  // Labels union the thread dept with every participant's dept — a private-dept agent
  // participating in a cross-dept thread marks the whole thread. The table verdict below is the
  // wall (deny → doc deleted); the old private-participant visibility loop is gone
  // (wall-deletion spec §3/§4).
  const participantDepts: string[] = [];
  let hasGhost = false;
  for (const m of rows) {
    for (const p of [m.from_agent, m.to_agent]) {
      if (p === "user") continue;
      const canonical = registry.agentOf.get(p);
      const d = canonical ? registry.agents.get(canonical)?.department : undefined;
      if (d) participantDepts.push(d);
      else hasGhost = true; // unresolvable agent — see fail-closed note below
    }
  }
  // Fail closed on a ghost participant: an agent that no longer resolves (a disabled department,
  // e.g. AIOS_MONEY_DISABLED=1 drops finance) would otherwise contribute NO label to the union,
  // silently laundering a once-private thread down to org.internal and re-indexing it. Skip +
  // purge instead — self-healing when the agent returns.
  if (hasGhost) { store.deleteMemoryDoc("mail", ref); return; }
  const labels = docLabels({ source: "mail", domain, dept, participantDepts });
  const included = rows.filter((m) => m.status !== "refused");
  if (!included.length) { store.deleteMemoryDoc("mail", ref); return; }
  if (wallVerdict(policy, { labels, sink: "recall-index" }, "indexer:mail",
    included.map((m) => m.body).join("\n")) === "deny") {
    store.deleteMemoryDoc("mail", ref); // self-healing: stale docs purge on the next reconcile
    return;
  }
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
