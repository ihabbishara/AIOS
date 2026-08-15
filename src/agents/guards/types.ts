// src/agents/guards/types.ts — the guard primitive every check is written against.
//
// These lived in a guard named after one operator's client, so the core type of the permission
// layer was imported from a file that had no business being load-bearing (code/guard.ts,
// roles/index.ts, registry/loader.ts and three sibling guards all reached into it). They are
// product types: keep them where a reader would look for them.

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

export type ToolCheck = (input: Record<string, unknown>) => GuardVerdict;

export const allow: GuardVerdict = { ok: true };
export const deny = (reason: string): GuardVerdict => ({ ok: false, reason });
