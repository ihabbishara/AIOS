// ui2/src/lib/dock.ts — the three chips that stand in for the queue (spec §7).
// Colour can no longer carry severity (everything needing a human is amber), so
// order carries it and fill marks the top rank.
import type { AttentionItem } from "../api.js";

export interface DockChip {
  id: string;
  title: string;
  severity: number;
  /** Solid amber for severity 1 (approvals); outline for everything else. */
  fill: boolean;
}

export const DOCK_MAX = 3;

export function dockChips(items: AttentionItem[]): { chips: DockChip[]; overflow: number } {
  const sorted = [...items].sort(
    (a, b) => a.severity - b.severity || b.ts.localeCompare(a.ts),
  );
  return {
    chips: sorted.slice(0, DOCK_MAX).map((i) => ({
      id: i.id, title: i.title, severity: i.severity, fill: i.severity === 1,
    })),
    overflow: Math.max(0, sorted.length - DOCK_MAX),
  };
}
