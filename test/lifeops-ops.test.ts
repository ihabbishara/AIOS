import { describe, it, expect } from "vitest";
import { openLoopsForBrief, computeLifeopsSignals } from "../src/lifeops/ops.js";
import type { PersonalTaskRow } from "../src/store/db.js";

function task(p: Partial<PersonalTaskRow>): PersonalTaskRow {
  return {
    id: 1, title: "t", status: "open", project: null, due_date: null,
    next_action: null, notes: null, created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z", ...p,
  };
}

describe("openLoopsForBrief", () => {
  it("partitions overdue vs due-today and counts", () => {
    const rows = [
      task({ id: 1, title: "late", due_date: "2026-06-28" }),
      task({ id: 2, title: "today", due_date: "2026-06-30" }),
      task({ id: 3, title: "future", due_date: "2026-07-05" }),
      task({ id: 4, title: "someday", due_date: null }),
    ];
    const ol = openLoopsForBrief(rows, "2026-06-30");
    expect(ol.overdue).toEqual([{ title: "late", due_date: "2026-06-28" }]);
    expect(ol.dueToday).toEqual(["today"]);
    expect(ol.openCount).toBe(4);
  });
});

describe("computeLifeopsSignals", () => {
  const cfg = { lifeopsSoonDays: 2, lifeopsStaleDays: 14 };
  const now = new Date("2026-06-30T09:00:00.000Z"); // today = 2026-06-30

  it("flags overdue with a today-keyed kv key", () => {
    const sigs = computeLifeopsSignals([task({ id: 7, title: "tax", due_date: "2026-06-25" })], now, cfg);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].key).toBe("lifeops:overdue:7:2026-06-30");
    expect(sigs[0].text).toContain("tax");
  });

  it("flags due-soon within the horizon, keyed by due_date", () => {
    const sigs = computeLifeopsSignals([task({ id: 8, title: "dentist", due_date: "2026-07-01" })], now, cfg);
    expect(sigs[0].key).toBe("lifeops:soon:8:2026-07-01");
  });

  it("does not flag a far-future task", () => {
    expect(computeLifeopsSignals([task({ id: 9, due_date: "2026-07-20" })], now, cfg)).toEqual([]);
  });

  it("flags stale (no due date, untouched > staleDays)", () => {
    const old = task({ id: 5, title: "reorg garage", due_date: null, updated_at: "2026-06-10T00:00:00.000Z" });
    const fresh = task({ id: 6, title: "new", due_date: null, updated_at: "2026-06-29T00:00:00.000Z" });
    const sigs = computeLifeopsSignals([old, fresh], now, cfg);
    expect(sigs.map((s) => s.key)).toEqual(["lifeops:stale:5:2026-06-30"]);
  });
});
