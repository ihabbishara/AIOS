// src/kernel/labels.ts — derive confidentiality labels from a doc/event's source (spec §6).
// Labels are code-derived, never user-set. Shared by indexer, distiller, senses.
import type { Label } from "./policy.js";
import type { MemorySource, Domain } from "../memory/recall.js";

/** A department's confidentiality label. Private-money → personal.finance; life → personal.tasks;
 *  client work → client.halalo; everything else is internal org traffic. */
export function deptLabel(dept: string): Label {
  switch (dept) {
    case "finance": return "personal.finance";
    case "life": return "personal.tasks";
    case "clients": return "client.halalo";
    default: return "org.internal";
  }
}

/** Domain → label for memo/decision docs (they inherit their domain's sensitivity). */
export function domainLabel(domain: Domain): Label {
  switch (domain) {
    case "money": return "personal.finance";
    case "lifeops": return "personal.tasks";
    case "inbox": return "personal.calendar"; // inbox docs are calendar-derived
    default: return "org.internal";
  }
}

/** The label union a memory_doc carries, from its source. Private-participant mail protection is
 *  NOT a label concern — it is enforced separately by the indexer's deleteMemoryDoc wall
 *  (src/memory/indexer.ts), so no `mailPrivate` param here (it would be dead + misleading). */
export function docLabels(args: { source: MemorySource; domain: Domain; dept?: string }): Label[] {
  switch (args.source) {
    case "event": return ["personal.calendar"];                       // only calendar events are indexed
    case "mail":  return [args.dept ? deptLabel(args.dept) : "org.internal"];
    case "decision": return [domainLabel(args.domain)];
    case "memo": return [domainLabel(args.domain)];
    case "vault": return ["shared"];                                  // hand-written notes default shared
  }
}
