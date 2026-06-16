// src/kernel/gate.ts
import { randomUUID } from "node:crypto";
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import type { ActionInput, ActionRow, ExecutorRegistry } from "./actions.js";
import {
  decide, demote, newRecord, recordApproval, recordRejection, type TrustPolicy,
} from "./trust.js";

export interface GateDeps {
  store: Store;
  registry: ExecutorRegistry;
  policy: TrustPolicy;
  bus: EventBus;
  /** How long a queued approval stays valid (ms). */
  expiryMs: number;
  log?: (line: string) => void;
}

export interface Origin {
  channel: string;
  chatId: string;
}

/**
 * The only door out: every outward effect passes through here.
 * Autonomous types execute immediately (and are audited); everything else
 * queues for a user verdict. Verdicts train the trust ledger.
 */
export class ActionGate {
  constructor(private deps: GateDeps) {}

  /** Submit an action. Executes immediately when trusted, otherwise queues for approval. */
  async propose(input: ActionInput, origin: Origin): Promise<ActionRow> {
    const { store, registry, policy, bus, expiryMs } = this.deps;
    const executor = registry.get(input.type);
    if (!executor) throw new Error(`no executor registered for action type "${input.type}"`);
    executor.schema.parse(input.payload);

    // Privileged types: the gate authors the preview so a caller can never
    // disguise what executes behind innocuous-looking text.
    const authored = this.authoredPreview(input);
    if (authored) input = { ...input, preview: authored };

    const now = new Date().toISOString();
    let trust = store.getTrust(input.type);
    if (!trust) {
      trust = newRecord(input.type, now);
      store.upsertTrust(trust);
    }

    // Short ids for chat usability; regenerate on the (rare) 32-bit collision.
    // Synchronous block — race-free.
    let id = randomUUID().slice(0, 8);
    while (store.getAction(id)) id = randomUUID().slice(0, 8);

    const row: ActionRow = {
      id,
      type: input.type,
      payload: JSON.stringify(input.payload),
      preview: input.preview,
      status: "proposed",
      origin_channel: origin.channel,
      origin_chat_id: origin.chatId,
      trust_state: trust.state,
      verdict_by: null,
      reject_reason: null,
      result: null,
      created_at: now,
      resolved_at: null,
      expires_at: new Date(Date.now() + expiryMs).toISOString(),
    };
    store.insertAction(row);

    if (decide(trust, policy) === "execute") {
      store.claimAction(row.id);
      return this.runExecutor(row, true, null);
    }

    bus.emit({ type: "action.proposed", actionId: row.id, actionType: row.type, preview: row.preview });
    return row;
  }

  /** Privileged types get gate-authored previews — a caller can never disguise what executes. */
  private authoredPreview(input: ActionInput): string | undefined {
    const p = input.payload as Record<string, unknown>;
    switch (input.type) {
      case "trust.promote": {
        const target = String(p.action_type ?? "");
        const t = this.deps.store.getTrust(target);
        return `Promote ${target} to autonomous (${t?.streak ?? 0} consecutive approvals, currently ${t?.state ?? "unknown"})`;
      }
      case "email.send":
        return `Send to ${String(p.to)}: "${String(p.subject)}" (${String(p.account)})`;
      case "email.draft":
        return `Draft to ${String(p.to)}: "${String(p.subject)}" (${String(p.account)})`;
      case "email.archive":
        return `Archive ${(p.messageIds as string[]).length} message(s) (${String(p.account)})`;
      case "email.label":
        return `Label ${(p.messageIds as string[]).length} message(s) +[${(p.add as string[]).join(",")}] -[${(p.remove as string[]).join(",")}] (${String(p.account)})`;
    }
    return undefined;
  }

  /** Apply a user verdict to a queued action. */
  async resolve(id: string, verdict: "approve" | "reject", opts: { by: string; reason?: string }): Promise<ActionRow> {
    const { store, bus } = this.deps;
    const row = store.getAction(id);
    if (!row) throw new Error(`no action ${id}`);
    if (row.status !== "proposed") throw new Error(`action ${id} already ${row.status}`);

    const now = new Date().toISOString();
    if (row.expires_at < now) {
      store.resolveAction(id, { status: "expired", verdict_by: null, reject_reason: null, result: null, resolved_at: now });
      bus.emit({ type: "action.resolved", actionId: id, actionType: row.type, verdict: "expired" });
      throw new Error(`action ${id} expired`);
    }

    if (verdict === "reject") {
      store.resolveAction(id, {
        status: "rejected", verdict_by: opts.by, reject_reason: opts.reason ?? null, result: null, resolved_at: now,
      });
      this.trainOnReject(row, now);
      bus.emit({ type: "action.resolved", actionId: id, actionType: row.type, verdict: "rejected" });
      return store.getAction(id)!;
    }

    // Claim-before-execute: atomically flip proposed → executing so a concurrent
    // resolve() can never run the executor twice for the same action.
    if (!store.claimAction(id)) throw new Error(`action ${id} already in-flight`);
    const executed = await this.runExecutor(row, false, opts.by);
    await this.trainOnApprove(row, now);
    bus.emit({ type: "action.resolved", actionId: id, actionType: row.type, verdict: "approved" });
    return executed;
  }

  /** Manual demotion from the UI — no rejection counted, just state. */
  demoteType(actionType: string): void {
    const trust = this.deps.store.getTrust(actionType);
    if (!trust) return;
    this.deps.store.upsertTrust(demote(trust));
    this.deps.bus.emit({ type: "trust.changed", actionType, state: "supervised" });
  }

  /** Mark overdue proposals expired. Called on an interval by the daemon. */
  sweepExpired(): number {
    const ids = this.deps.store.expireActions(new Date().toISOString());
    for (const id of ids) {
      const row = this.deps.store.getAction(id)!;
      this.deps.bus.emit({ type: "action.resolved", actionId: id, actionType: row.type, verdict: "expired" });
    }
    return ids.length;
  }

  private async runExecutor(row: ActionRow, auto: boolean, verdictBy: string | null): Promise<ActionRow> {
    const { store, registry, bus } = this.deps;
    const executor = registry.get(row.type)!;
    let status: "executed" | "failed";
    let result: string;
    try {
      result = await executor.execute(JSON.parse(row.payload), { by: verdictBy, auto });
      status = "executed";
    } catch (err) {
      result = (err as Error).message;
      status = "failed";
    }
    store.resolveAction(row.id, {
      status, verdict_by: verdictBy, reject_reason: null, result, resolved_at: new Date().toISOString(),
    });
    bus.emit({ type: "action.executed", actionId: row.id, actionType: row.type, auto, ok: status === "executed" });
    return store.getAction(row.id)!;
  }

  private async trainOnApprove(row: ActionRow, now: string): Promise<void> {
    // Promotions carry their own bookkeeping (the executor flips the target type).
    if (row.type === "trust.promote") return;
    const { store, policy, bus } = this.deps;
    const trust = store.getTrust(row.type) ?? newRecord(row.type, now);
    const { record, graduationReady } = recordApproval(trust, policy, now);
    store.upsertTrust(record);
    if (graduationReady) {
      bus.emit({ type: "trust.changed", actionType: row.type, state: "graduating" });
      try {
        await this.propose(
          {
            type: "trust.promote",
            payload: { action_type: row.type },
            preview: `Promote ${row.type} to autonomous (${record.streak} consecutive approvals)`,
          },
          { channel: row.origin_channel, chatId: row.origin_chat_id },
        );
      } catch (err) {
        this.deps.log?.(`promotion proposal failed: ${(err as Error).message}`);
      }
    }
  }

  private trainOnReject(row: ActionRow, now: string): void {
    const { store, bus } = this.deps;
    if (row.type === "trust.promote") {
      // Rejecting a promotion: target type back to supervised, streak reset.
      // Does NOT count as a rejection against trust.promote itself.
      const target = (JSON.parse(row.payload) as { action_type: string }).action_type;
      const trust = store.getTrust(target);
      if (trust) {
        store.upsertTrust(demote(trust));
        bus.emit({ type: "trust.changed", actionType: target, state: "supervised" });
      }
      return;
    }
    const trust = store.getTrust(row.type) ?? newRecord(row.type, now);
    store.upsertTrust(recordRejection(trust, now));
    bus.emit({ type: "trust.changed", actionType: row.type, state: "supervised" });
  }
}
