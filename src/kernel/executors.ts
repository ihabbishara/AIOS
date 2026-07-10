// src/kernel/executors.ts
import { z } from "zod";
import type { Executor } from "./actions.js";
import type { VaultWriter } from "../vault/writer.js";
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import { promote } from "./trust.js";

export function vaultWriteExecutor(vault: VaultWriter): Executor {
  return {
    type: "vault.write",
    schema: z.object({ path: z.string(), content: z.string() }),
    async execute(payload) {
      const p = payload as { path: string; content: string };
      vault.writeNote(p.path, p.content);
      return `Saved: ${p.path}`;
    },
  };
}

/** Harmless supervised action used for demos and end-to-end tests of the approval loop. */
export function echoExecutor(): Executor {
  return {
    type: "test.echo",
    schema: z.object({ text: z.string() }),
    async execute(payload) {
      return `echo: ${(payload as { text: string }).text}`;
    },
  };
}

/** Approving this action is what actually promotes a type — the gate never auto-promotes. */
export function trustPromoteExecutor(store: Store, bus: EventBus): Executor {
  return {
    type: "trust.promote",
    schema: z.object({ action_type: z.string() }),
    async execute(payload) {
      const type = (payload as { action_type: string }).action_type;
      const record = store.getTrust(type);
      if (!record) throw new Error(`no trust record for ${type}`);
      if (record.state !== "graduating") {
        throw new Error(`${type} is not graduating (current: ${record.state}) — promotion aborted`);
      }
      store.upsertTrust(promote(record, new Date().toISOString()));
      bus.emit({ type: "trust.changed", actionType: type, state: "autonomous" });
      return `${type} promoted to autonomous`;
    },
  };
}

/** Approving a permission.grant action is the ONLY thing that writes a grant — the gate never auto-applies. */
export function permissionGrantExecutor(store: Store, bus: EventBus): Executor {
  return {
    type: "permission.grant",
    schema: z.object({ role: z.string(), tool: z.string() }),
    async execute(payload, ctx) {
      const p = payload as { role: string; tool: string };
      const by = ctx?.by ?? "unknown";
      store.setRolePermission(p.role, p.tool, 1, by);
      bus.emit({ type: "permission.changed", role: p.role, tool: p.tool, allow: true, by });
      return `Granted ${p.tool} to ${p.role}`;
    },
  };
}

export function permissionRevokeExecutor(store: Store, bus: EventBus): Executor {
  return {
    type: "permission.revoke",
    schema: z.object({ role: z.string(), tool: z.string() }),
    async execute(payload, ctx) {
      const p = payload as { role: string; tool: string };
      const by = ctx?.by ?? "unknown";
      store.setRolePermission(p.role, p.tool, 0, by);
      bus.emit({ type: "permission.changed", role: p.role, tool: p.tool, allow: false, by });
      return `Revoked ${p.tool} from ${p.role}`;
    },
  };
}

/** Group-ledger mutations flow through the gate for audit + demotability.
 *  Seeded autonomous by default (config.trustSeeds) — same UX, full audit trail. */
export function ledgerWriteExecutor(store: Store, vault: VaultWriter, company: string): Executor {
  return {
    type: "ledger.write",
    schema: z.object({
      op: z.enum(["add", "remove"]),
      ledger: z.string(),
      payer: z.string().optional(),
      amount_cents: z.number().int().positive().optional(),
      currency: z.string().optional(),
      description: z.string().optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      receipt_path: z.string().optional(),
      id: z.number().int().optional(),
    }).refine((p) => p.op === "remove" ? p.id != null
      : p.payer != null && p.amount_cents != null && p.currency != null && p.description != null && p.date != null,
      { message: "add needs payer/amount_cents/currency/description/date; remove needs id" }),
    async execute(payload) {
      const p = payload as {
        op: "add" | "remove"; ledger: string; payer?: string; amount_cents?: number;
        currency?: string; description?: string; date?: string; receipt_path?: string; id?: number;
      };
      if (p.op === "add") {
        const id = store.addExpense({
          ledger: p.ledger, payer: p.payer!, amountCents: p.amount_cents!,
          currency: p.currency!, description: p.description!, date: p.date!, receiptPath: p.receipt_path,
        });
        const pretty = `${(p.amount_cents! / 100).toFixed(2)} ${p.currency}`;
        vault.appendDaily(`${company} expense #${id}: ${p.payer} paid ${pretty} — ${p.description}`);
        return `Recorded #${id}: ${p.payer} paid ${pretty} for "${p.description}" on ${p.date}.`;
      }
      return store.deleteExpense(p.ledger, p.id!)
        ? `Removed expense #${p.id}.`
        : `No expense #${p.id} in this ledger.`;
    },
  };
}
