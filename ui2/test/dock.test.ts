// ui2/test/dock.test.ts — severity lost its hue in the Organism palette (every
// attention row is amber now), so it has to survive as order and as fill.
import { describe, it, expect } from "vitest";
import { dockChips, DOCK_MAX } from "../src/lib/dock.js";
import type { AttentionItem } from "../src/api.js";

const item = (id: string, severity: AttentionItem["severity"], ts: string): AttentionItem => ({
  kind: "approval", id, title: `T-${id}`, meta: "", severity, ts, actions: [], ref: {},
});

describe("dockChips", () => {
  it("orders by severity then newest first", () => {
    const { chips } = dockChips([
      item("c", 4, "2026-08-02T10:00:00.000Z"),
      item("a", 1, "2026-08-02T09:00:00.000Z"),
      item("b", 1, "2026-08-02T11:00:00.000Z"),
    ]);
    expect(chips.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("fills only severity 1 so the dock shows the shape of what is waiting", () => {
    const { chips } = dockChips([
      item("a", 1, "2026-08-02T09:00:00.000Z"),
      item("b", 2, "2026-08-02T09:00:00.000Z"),
    ]);
    expect(chips.map((c) => c.fill)).toEqual([true, false]);
  });

  it("caps at DOCK_MAX and reports the remainder", () => {
    const many = ["a", "b", "c", "d", "e"].map((id) => item(id, 2, "2026-08-02T09:00:00.000Z"));
    const { chips, overflow } = dockChips(many);
    expect(chips).toHaveLength(DOCK_MAX);
    expect(overflow).toBe(2);
  });

  it("reports no overflow for an empty queue", () => {
    expect(dockChips([])).toEqual({ chips: [], overflow: 0 });
  });
});
