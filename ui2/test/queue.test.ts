// ui2/test/queue.test.ts
import { describe, it, expect } from "vitest";
import { groupQueue, flatQueue } from "../src/lib/queue.js";
import type { AttentionItem } from "../src/api.js";

const item = (id: string, severity: 1 | 2 | 3 | 4 | 5, ts: string): AttentionItem =>
  ({ kind: "approval", id, title: id, meta: "", severity, ts, actions: [], ref: {} });

describe("groupQueue", () => {
  it("groups by severity in cockpit order, drops empty groups, ts-desc inside", () => {
    const groups = groupQueue([
      item("m", 4, "2026-01-02"), item("a2", 1, "2026-01-03"),
      item("a1", 1, "2026-01-01"), item("s", 5, "2026-01-01"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Approvals", "Mail", "Ambient"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a2", "a1"]);
  });
  it("flatQueue walks groups in order", () => {
    const groups = groupQueue([item("b", 3, "1"), item("a", 1, "1")]);
    expect(flatQueue(groups).map((i) => i.id)).toEqual(["a", "b"]);
  });
});
