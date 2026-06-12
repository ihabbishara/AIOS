// src/kernel/actions.ts
import type { z } from "zod";

export type ActionStatus = "proposed" | "executing" | "executed" | "failed" | "rejected" | "expired";

export interface ActionInput {
  /** Namespaced action type, e.g. "vault.write", "email.send". */
  type: string;
  /** In-memory payload object. Serialized to JSON when persisted as ActionRow.payload. */
  payload: Record<string, unknown>;
  /** Human-readable one-liner shown in approval requests and the audit log. */
  preview: string;
}

/** Persisted action — doubles as the approval queue (status=proposed) and the audit log (terminal statuses). */
export interface ActionRow {
  id: string;
  type: string;
  /** JSON-encoded payload. */
  payload: string;
  preview: string;
  status: ActionStatus;
  origin_channel: string;
  origin_chat_id: string;
  /** Trust state at proposal time — part of the audit record. */
  trust_state: string;
  verdict_by: string | null;
  reject_reason: string | null;
  result: string | null;
  created_at: string;
  resolved_at: string | null;
  expires_at: string;
}

export interface Executor {
  type: string;
  /** Validates the payload at propose() time — invalid payloads never enter the queue. */
  schema: z.ZodTypeAny;
  /** Performs the outward effect. Returns a short result summary for audit/chat. */
  execute(payload: unknown): Promise<string>;
}

export class ExecutorRegistry {
  private executors = new Map<string, Executor>();

  register(e: Executor): void {
    if (this.executors.has(e.type)) {
      throw new Error(`executor already registered for type "${e.type}"`);
    }
    this.executors.set(e.type, e);
  }

  get(type: string): Executor | undefined {
    return this.executors.get(type);
  }

  types(): string[] {
    return [...this.executors.keys()];
  }
}
