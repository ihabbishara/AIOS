// ui2/src/lib/activity.ts — one place that turns raw bus events into human sentences.
// Home's live feed and System · events both read through this, so the vocabulary stays consistent.
import type { StoredEvent } from "../api.js";

export type ActivityTone = "ok" | "err" | "accent" | "agent" | "info" | "dim";

const s = (ev: Record<string, unknown>, k: string): string =>
  typeof ev[k] === "string" ? (ev[k] as string) : "";

const clip = (t: string, n = 80): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Family → tone: goals violet, mail blue, failures red, executions green, policy amber. */
export function toneOfEvent(type: string, ev: Record<string, unknown>): ActivityTone {
  if (ev.ok === false || type === "policy.violation" || type === "tool.denied") return "err";
  if (type.startsWith("goal.") || type.startsWith("node.")) return "agent";
  if (type.startsWith("mail.") || type === "brief.sent") return "info";
  if (type.startsWith("action.") || type === "agent.end") return "ok";
  if (type.startsWith("chat.")) return "dim";
  return "dim";
}

/** Human line for an event, or null when it has no operator-readable story (heartbeats etc.). */
export function describeEvent(e: StoredEvent): { text: string; tone: ActivityTone } | null {
  const ev = e.event as unknown as Record<string, unknown>;
  const type = String(ev.type);
  const tone = toneOfEvent(type, ev);
  const agent = s(ev, "agent") || s(ev, "from") || s(ev, "to");

  switch (type) {
    case "chat.in": return { text: `you → ${s(ev, "channel")}: ${clip(s(ev, "text"))}`, tone };
    case "chat.out": return { text: `reply on ${s(ev, "channel")}: ${clip(s(ev, "text"))}`, tone };
    case "route.decision": return { text: `routed to ${s(ev, "to")} — ${clip(s(ev, "reason"), 60)}`, tone: "dim" };
    case "agent.start": return { text: `${agent} started ${s(ev, "context")}`, tone: "agent" };
    case "agent.end": return { text: `${agent} finished ${s(ev, "context")}${ev.ok === false ? " — failed" : ""}`, tone };
    case "goal.created": return { text: `goal created: ${clip(s(ev, "title") || s(ev, "slug"), 60)}`, tone };
    case "goal.status": return { text: `goal ${clip(s(ev, "title") || s(ev, "slug"), 48)} → ${s(ev, "status")}`, tone: s(ev, "status") === "failed" ? "err" : tone };
    case "node.status": return { text: `node ${s(ev, "node") || s(ev, "key")} → ${s(ev, "status")}`, tone };
    case "mail.sent": return { text: `mail: ${s(ev, "from")} → ${s(ev, "to")}`, tone };
    case "mail.received": return { text: `inbox: ${clip(s(ev, "from"), 48)}`, tone };
    case "mail.asked_user": return { text: `${s(ev, "from")} asked you a question`, tone: "accent" };
    case "brief.sent": return { text: "daily brief delivered", tone };
    case "action.proposed": return { text: `${agent} proposed ${s(ev, "actionType") || s(ev, "kind")} — needs approval`, tone: "accent" };
    case "action.executed": return { text: `action executed: ${s(ev, "actionType") || s(ev, "kind")}`, tone };
    case "action.resolved": return { text: `action ${s(ev, "verdict") || "resolved"}`, tone };
    case "tool.denied": return { text: `${s(ev, "role")} denied tool ${s(ev, "tool")}`, tone };
    case "policy.violation": return { text: `policy: ${s(ev, "label")} blocked at ${s(ev, "sink")}`, tone };
    case "trust.changed": return { text: `trust changed: ${s(ev, "actionType")} → ${s(ev, "state")}`, tone: "accent" };
    case "triage.decision": return null; // routing heartbeat — noise in a human feed
    default: return null;
  }
}

/** Feed = newest-last slice of events that produce a human line. */
export function activityFeed(events: StoredEvent[], limit = 12): Array<StoredEvent & { line: { text: string; tone: ActivityTone } }> {
  const out: Array<StoredEvent & { line: { text: string; tone: ActivityTone } }> = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const line = describeEvent(events[i]);
    if (line) out.push(Object.assign({}, events[i], { line }));
  }
  return out.reverse();
}
