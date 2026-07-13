// ui2/src/lib/queue.ts — pure grouping/ordering for the Home cockpit queue (spec §5).
import type { AttentionItem } from "../api.js";

export const GROUPS = [
  { severity: 1, label: "Approvals" },
  { severity: 2, label: "Asks" },
  { severity: 3, label: "Goals" },
  { severity: 4, label: "Mail" },
  { severity: 5, label: "Ambient" },
] as const;

export interface QueueGroup { label: string; severity: number; items: AttentionItem[] }

export function groupQueue(items: AttentionItem[]): QueueGroup[] {
  return GROUPS.map((g) => ({
    label: g.label,
    severity: g.severity,
    items: items.filter((i) => i.severity === g.severity).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)),
  })).filter((g) => g.items.length > 0);
}

/** Flat walk order for j/k navigation. */
export function flatQueue(groups: QueueGroup[]): AttentionItem[] {
  return groups.flatMap((g) => g.items);
}
