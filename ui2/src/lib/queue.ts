// ui2/src/lib/queue.ts — pure grouping/ordering for the Home cockpit queue (spec §5).
import type { AttentionItem } from "../api.js";

export const GROUPS = [
  { kind: "approval", severity: 1, label: "Approvals" },
  { kind: "review", severity: 2, label: "Reviews" },
  { kind: "ask", severity: 2, label: "Asks" },
  { kind: "goal", severity: 3, label: "Goals" },
  { kind: "mail", severity: 4, label: "Mail" },
  { kind: "sense", severity: 5, label: "Ambient" },
] as const;

export interface QueueGroup { label: string; severity: number; items: AttentionItem[] }

export function groupQueue(items: AttentionItem[]): QueueGroup[] {
  return GROUPS.map((g) => ({
    label: g.label,
    severity: g.severity,
    items: items.filter((i) => i.kind === g.kind).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)),
  })).filter((g) => g.items.length > 0);
}

/** Flat walk order for j/k navigation. */
export function flatQueue(groups: QueueGroup[]): AttentionItem[] {
  return groups.flatMap((g) => g.items);
}
