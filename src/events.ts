import { EventEmitter } from "node:events";
import type { Store } from "./store/db.js";

export type AiosEvent =
  | { type: "agent.start"; agent: string; context: string }
  | { type: "agent.end"; agent: string; context: string; costUsd?: number; turns?: number; ok: boolean }
  | { type: "chat.in"; channel: string; chatId: string; text: string; sender?: string }
  | { type: "chat.out"; channel: string; chatId: string; text: string }
  | { type: "action.proposed"; actionId: string; actionType: string; preview: string }
  | { type: "action.executed"; actionId: string; actionType: string; auto: boolean; ok: boolean }
  | { type: "action.resolved"; actionId: string; actionType: string; verdict: "approved" | "rejected" | "expired" }
  | { type: "trust.changed"; actionType: string; state: string }
  | { type: "reminder.due"; id: number; text: string; channel: string; chatId: string }
  | { type: "brief.sent"; anchor: "morning" | "evening"; chatKey: string | null }
  | { type: "triage.decision"; eventType: string; verdict: string; via: "rule" | "default" | "model" }
  | { type: "mail.received"; account: string; messageId: string; threadId: string; from: string; to: string; subject: string; snippet: string; labels: string[]; receivedAt: string }
  | { type: "calendar.changed"; account: string; eventId: string; summary: string; start: string; end: string; status: string; organizer: string }
  | { type: "calendar.reminder"; account: string; eventId: string; summary: string; start: string; minutesUntil: number; link: string | null }
  | { type: "permission.changed"; role: string; tool: string; allow: boolean; by: string }
  | { type: "tool.denied"; role: string; tool: string }
  | { type: "route.decision"; to: string; via: "mention" | "binding" | "handoff" | "default" | "verdict" | "reset" | "plan"; reason: string; channel: string; chatId: string }
  | { type: "goal.created"; goalId: string; title: string; department: string }
  | { type: "goal.status"; goalId: string; status: string; error?: string }
  | { type: "node.status"; goalId: string; nodeKey: string; status: string; agent: string; error?: string }
  | { type: "mail.sent"; id: string; from: string; to: string; kind: string }
  | { type: "mail.spawned"; mailId: string; goalId: string }
  | { type: "mail.read"; ids: string[] }
  | { type: "mail.asked_user"; id: string; from: string; question: string; goalId: string }
  | { type: "policy.violation"; label: string; sink: string; site: string; hash: string }
  | { type: "memory.ungrounded"; domain: string; hash: string };

export interface StoredEvent {
  id: number;
  ts: string;
  event: AiosEvent;
  /** Info-flow confidentiality labels stamped by source at emit (spec §6). */
  labels?: string[];
  /** Info-flow integrity origin — untrusted for inbound email/calendar text. */
  origin?: "trusted" | "untrusted";
}

/** Per-type source-label stamp (spec §6). Inbound gmail/calendar carry untrusted external text;
 *  everything else is internal org traffic from a trusted origin. The single emit choke point
 *  stamps every event so senses don't each have to. */
const EVENT_LABELS: Record<string, { labels: string[]; origin: "trusted" | "untrusted" }> = {
  "mail.received": { labels: ["personal.email"], origin: "untrusted" },
  "calendar.changed": { labels: ["personal.calendar"], origin: "untrusted" },
  "calendar.reminder": { labels: ["personal.calendar"], origin: "untrusted" },
};
const DEFAULT_STAMP = { labels: ["org.internal"], origin: "trusted" as const };
const stampFor = (type: string) => EVENT_LABELS[type] ?? DEFAULT_STAMP;

/** In-process event bus; every event is also persisted for history/replay/dashboards. */
export class EventBus {
  private emitter = new EventEmitter();

  constructor(private store: Store) {
    this.emitter.setMaxListeners(50);
  }

  emit(event: AiosEvent): void {
    const id = this.store.addEvent(JSON.stringify(event));
    const s = stampFor(event.type);
    const stored: StoredEvent = { id, ts: new Date().toISOString(), event, labels: s.labels, origin: s.origin };
    for (const l of this.emitter.listeners("event")) {
      try {
        (l as (e: StoredEvent) => void)(stored);
      } catch {
        /* a misbehaving listener must never break event emission or other listeners */
      }
    }
  }

  on(listener: (e: StoredEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  history(sinceId = 0, limit = 500): StoredEvent[] {
    return this.store.listEvents(sinceId, limit).map((row) => {
      const event = JSON.parse(row.payload) as AiosEvent;
      const s = stampFor(event.type);
      return { id: row.id, ts: row.ts, event, labels: s.labels, origin: s.origin };
    });
  }
}
