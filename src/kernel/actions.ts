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
  /** Goal-attempt dedupe key (goalId:node:attempt#). A duplicate proposal returns the
   *  original row instead of double-executing an effect (journaled engine, spec §7). */
  idempotencyKey?: string;
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
  idempotency_key?: string | null;
  /** What autonomy would have done, stamped at propose time for graduating types ("execute"); null otherwise. */
  shadow_decision?: string | null;
}

/** Context handed to an executor at run time. `by` is the approver (verdict_by); null for autonomous runs. */
export interface ExecutorContext {
  by: string | null;
  auto: boolean;
}

export interface Executor {
  type: string;
  /** Validates the payload at propose() time — invalid payloads never enter the queue. */
  schema: z.ZodTypeAny;
  /** Performs the outward effect. Returns a short result summary for audit/chat.
   * ctx is OPTIONAL only to preserve direct single-arg test call sites; the gate always passes it. Read ctx?.by. */
  execute(payload: unknown, ctx?: ExecutorContext): Promise<string>;
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

/** Key-order-independent JSON — the identity of an effect is its payload's VALUE, not the
 *  order an agent happened to emit its fields in. Used for idempotency keys and for the gate's
 *  "same key, same effect?" check. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
