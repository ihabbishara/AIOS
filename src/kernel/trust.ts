// src/kernel/trust.ts
export type TrustState = "supervised" | "graduating" | "autonomous";

export interface TrustRecord {
  actionType: string;
  state: TrustState;
  approvals: number;
  rejections: number;
  /** Consecutive approvals since the last rejection/demotion. */
  streak: number;
  /** ISO timestamp of the first time this type was proposed. */
  firstSeen: string;
  lastRejection: string | null;
  graduatedAt: string | null;
}

export interface TrustPolicy {
  /** Consecutive approvals required before a promotion is proposed. */
  graduationStreak: number;
  /** Minimum days since firstSeen before a promotion is proposed. */
  graduationAgeDays: number;
  /** Hard ceiling: types that can never execute autonomously. */
  alwaysSupervised: Set<string>;
}

export const DEFAULT_POLICY: TrustPolicy = {
  graduationStreak: 10,
  graduationAgeDays: 30,
  alwaysSupervised: new Set(["trust.promote", "permission.grant", "permission.revoke"]),
};

export function newRecord(actionType: string, now: string): TrustRecord {
  return {
    actionType, state: "supervised", approvals: 0, rejections: 0, streak: 0,
    firstSeen: now, lastRejection: null, graduatedAt: null,
  };
}

function ageDays(fromIso: string, nowIso: string): number {
  const ms = Date.parse(nowIso) - Date.parse(fromIso);
  if (Number.isNaN(ms)) throw new Error(`ageDays: invalid ISO timestamp — from="${fromIso}" now="${nowIso}"`);
  return ms / 86_400_000;
}

/** What the gate does with a proposed action of this type. Fail-closed: no record → queue. */
export function decide(record: TrustRecord | undefined, policy: TrustPolicy): "execute" | "queue" {
  if (!record) return "queue";
  if (policy.alwaysSupervised.has(record.actionType)) return "queue";
  return record.state === "autonomous" ? "execute" : "queue";
}

export function recordApproval(
  record: TrustRecord, policy: TrustPolicy, now: string,
): { record: TrustRecord; graduationReady: boolean } {
  const next: TrustRecord = { ...record, approvals: record.approvals + 1, streak: record.streak + 1 };
  // Evaluated eagerly (not inside the && chain) so corrupted timestamps always throw
  // instead of silently blocking graduation forever.
  const age = ageDays(next.firstSeen, now);
  const graduationReady =
    next.state === "supervised" &&
    !policy.alwaysSupervised.has(next.actionType) &&
    next.streak >= policy.graduationStreak &&
    age >= policy.graduationAgeDays;
  return {
    record: graduationReady ? { ...next, state: "graduating" } : next,
    graduationReady,
  };
}

export function recordRejection(record: TrustRecord, now: string): TrustRecord {
  return {
    ...record, rejections: record.rejections + 1, streak: 0,
    lastRejection: now, state: "supervised", graduatedAt: null,
  };
}

export function promote(record: TrustRecord, now: string): TrustRecord {
  return { ...record, state: "autonomous", graduatedAt: now, streak: 0 };
}

export function demote(record: TrustRecord): TrustRecord {
  return { ...record, state: "supervised", streak: 0, graduatedAt: null };
}
