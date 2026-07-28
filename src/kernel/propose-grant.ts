// src/kernel/propose-grant.ts — the engine's path into the action gate for policy-wall parks
// (policy-wall spec §3). Queue-only: approving the proposal is the ONLY thing that ever writes
// a grant (executors.ts), and permission.grant is always-supervised (trust.ts).
import type { Store } from "../store/db.js";
import type { ActionGate } from "./gate.js";

export function makeGrantProposer(store: Store, gate: ActionGate) {
  return async (role: string, tool: string): Promise<void> => {
    const queued = store.listActions("proposed", 200).some((a) => {
      if (a.type !== "permission.grant") return false;
      const p = JSON.parse(a.payload) as { role?: string; tool?: string };
      return p.role === role && p.tool === tool;
    });
    if (queued) return; // never double-propose the same wall
    await gate.propose(
      { type: "permission.grant", payload: { role, tool }, preview: "" },
      { channel: "engine", chatId: "goals" },
    );
  };
}
