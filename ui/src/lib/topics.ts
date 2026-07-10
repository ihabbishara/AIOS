// ui/src/lib/topics.ts — single source of which event types invalidate which queries.
// A topic ending in "." is a prefix match; anything else is exact.
import type { StoredEvent } from "../api.js";

export const T = {
  /** Agent-mailbox events only — a bare "mail." prefix would also match Gmail's mail.received. */
  agentMail: ["mail.sent", "mail.spawned", "mail.read", "mail.asked_user"],
  goals: ["goal.", "node."],
  agentsActions: ["agent.", "action."],
  actions: ["action."],
  trust: ["trust.changed", "action."],
  permissions: ["permission.changed", "tool.denied"],
  costs: ["agent.end"],
  budget: ["agent.end", "goal."],
} as const;

export function matches(type: string, topics: readonly string[]): boolean {
  return topics.some((t) => (t.endsWith(".") ? type.startsWith(t) : type === t));
}

/** Id of the newest event matching topics — the stable invalidation key for useLiveQuery. */
export function lastMatching(events: StoredEvent[], topics: readonly string[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (matches(events[i].event.type, topics)) return events[i].id;
  }
  return undefined;
}
