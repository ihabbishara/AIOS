// ui2/test/queue.test.ts
import { describe, it, expect } from "vitest";
import { groupQueue, flatQueue } from "../src/lib/queue.js";
import type { AttentionItem } from "../src/api.js";

const item = (id: string, kind: AttentionItem["kind"], severity: 1 | 2 | 3 | 4 | 5, ts: string): AttentionItem =>
  ({ kind, id, title: id, meta: "", severity, ts, actions: [], ref: {} });

describe("groupQueue", () => {
  it("groups by kind in cockpit order, drops empty groups, ts-desc inside", () => {
    const groups = groupQueue([
      item("m", "mail", 4, "2026-01-02"), item("a2", "approval", 1, "2026-01-03"),
      item("a1", "approval", 1, "2026-01-01"), item("s", "sense", 5, "2026-01-01"),
      item("rv", "review", 2, "2026-01-01"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Approvals", "Reviews", "Mail", "Ambient"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a2", "a1"]);
  });
  it("flatQueue walks groups in order", () => {
    const groups = groupQueue([item("b", "goal", 3, "1"), item("a", "approval", 1, "1")]);
    expect(flatQueue(groups).map((i) => i.id)).toEqual(["a", "b"]);
  });
});
