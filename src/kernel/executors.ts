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
