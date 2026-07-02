// src/heartbeat/triage.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Store, TriageRuleRow } from "../store/db.js";
import type { AiosEvent, EventBus } from "../events.js";

export type TriageVerdict = "ignore" | "batch" | "notify_now";

const VERDICTS: readonly TriageVerdict[] = ["ignore", "batch", "notify_now"];

/** First matching rule wins; exact match beats glob ("action.*" matches "action.executed"). */
export function matchRule(rules: TriageRuleRow[], eventType: string): TriageRuleRow | undefined {
  const exact = rules.find((r) => r.event_type === eventType);
  if (exact) return exact;
  return rules.find(
    (r) => r.event_type.endsWith(".*") && eventType.startsWith(r.event_type.slice(0, -1)),
  );
}

/**
 * Built-in defaults for every known event type (payload-aware — a rules table
 * can't see inside payloads). Unknown future types return undefined → model.
 */
export function defaultVerdict(event: AiosEvent): TriageVerdict | undefined {
  switch (event.type) {
    case "reminder.due":
      return "notify_now";
    case "action.executed":
      return event.auto ? "batch" : "ignore"; // approved ones were confirmed in chat already
    case "trust.changed":
      return "batch";
    case "goal.status":
      return "ignore"; // goal completion AND failure already narrated by the moderator flow
    case "calendar.reminder":
      return "notify_now";
    case "calendar.changed":
      return "batch";
    case "mail.received":
      return undefined; // model decides — quiet posture prompt below
    case "goal.created":
    case "node.status":
    case "agent.start":
    case "agent.end":
    case "chat.in":
    case "chat.out":
    case "action.proposed": // Phase 3 notifier already pings proposals — no double-ping
    case "action.resolved":
    case "triage.decision": // own output — never feed back
    case "brief.sent":
      return "ignore";
  }
  return undefined;
}

export interface TriageDeps {
  store: Store;
  bus: EventBus;
  /** Model classifier for unknown event types. Injectable for tests. */
  classify: (event: AiosEvent) => Promise<TriageVerdict>;
  /** Immediate ping delivery (routing decided by the caller/wiring). */
  notify: (event: AiosEvent) => Promise<void>;
  log?: (line: string) => void;
}

/** Interrupt gatekeeper: rules → defaults → model. batch = stay silent until the next brief. */
export class Triage {
  private unsubscribe?: () => void;

  constructor(private deps: TriageDeps) {}

  start(): void {
    this.unsubscribe = this.deps.bus.on((stored) => void this.handle(stored.event));
  }

  stop(): void {
    this.unsubscribe?.();
  }

  async handle(event: AiosEvent): Promise<void> {
    // Own outputs are never triageable — not even via user rules. A rule matching
    // "triage.*" would otherwise re-emit synchronously and storm the bus.
    if (event.type === "triage.decision" || event.type === "brief.sent") return;
    try {
      let verdict: TriageVerdict | undefined;
      let via: "rule" | "default" | "model";

      const rule = matchRule(this.deps.store.listTriageRules(), event.type);
      if (rule) {
        verdict = rule.verdict;
        via = "rule";
      } else {
        verdict = defaultVerdict(event);
        via = "default";
      }
      if (!verdict) {
        via = "model";
        try {
          const v = await this.deps.classify(event);
          verdict = VERDICTS.includes(v) ? v : "batch";
        } catch (err) {
          this.deps.log?.(`triage classify failed: ${(err as Error).message}`);
          verdict = "batch"; // fail-quiet: surfaces in the next brief, never lost or spamming
        }
      }

      if (verdict !== "ignore") {
        this.deps.bus.emit({ type: "triage.decision", eventType: event.type, verdict, via });
      }
      if (verdict === "notify_now") {
        try {
          await this.deps.notify(event);
        } catch (err) {
          this.deps.log?.(`triage notify failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.deps.log?.(`triage error on ${event.type}: ${(err as Error).message}`);
    }
  }
}

/** Real classifier: one-shot, no tools, strict JSON verdict. */
export function modelClassifier(model: string): (event: AiosEvent) => Promise<TriageVerdict> {
  return async (event) => {
    const q = query({
      prompt: `Event:\n${JSON.stringify(event)}\n\nHow should this be handled for the user?`,
      options: {
        systemPrompt:
          "You triage events for a personal AI OS. Verdicts: notify_now (interrupt the user NOW), " +
          "batch (include in the next scheduled brief), ignore (noise). " +
          "POSTURE: quiet by default. For email (mail.received): interrupt ONLY for genuinely urgent, " +
          "time-sensitive items — explicit same-day deadlines, payment or security problems, direct " +
          "personal requests that clearly cannot wait. Newsletters, receipts, notifications, FYIs, " +
          "and anything that can wait a few hours: batch. When unsure: batch.",
        allowedTools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        model,
        outputFormat: {
          type: "json_schema" as const,
          schema: {
            type: "object",
            properties: { verdict: { enum: ["ignore", "batch", "notify_now"] } },
            required: ["verdict"],
            additionalProperties: false,
          },
        },
      },
    });
    for await (const msg of q) {
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          const v = (msg.structured_output as { verdict?: string } | undefined)?.verdict;
          if (v === "ignore" || v === "batch" || v === "notify_now") return v;
        }
        break;
      }
    }
    return "batch";
  };
}
