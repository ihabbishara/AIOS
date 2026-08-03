// ui2/test/goal-recency.test.ts — recency banding (spec 2026-08-03 §1).
import { describe, it, expect } from "vitest";
import { bandOf, groupByBand, BANDS } from "../src/lib/goal-recency.js";
import type { GoalView } from "../src/api.js";

const NOW = new Date("2026-08-03T14:00:00.000Z");

const goal = (over: Partial<GoalView> = {}): GoalView => ({
  id: "g", slug: "g", title: "t", department: "ops", lead: "neo", originChannel: "web",
  status: "done", planSummary: "", replansUsed: 0, error: null,
  createdAt: "2026-08-03T09:00:00.000Z", updatedAt: "2026-08-03T09:00:00.000Z",
  projectDir: null, goalDir: null, nodes: [], ...over,
});

describe("bandOf", () => {
  it("puts anything still in flight in live, regardless of age", () => {
    for (const status of ["planning", "running", "replanning", "awaiting-mail"]) {
      expect(bandOf(goal({ status, createdAt: "2026-01-01T00:00:00.000Z" }), NOW), status).toBe("live");
    }
  });

  it("puts a goal needing the user in live too", () => {
    // A failed goal is not settled; burying it under EARLIER hides the one row
    // that most wants attention.
    expect(bandOf(goal({ status: "failed", createdAt: "2026-01-01T00:00:00.000Z" }), NOW)).toBe("live");
  });

  it("bands a finished goal from today as today", () => {
    expect(bandOf(goal({ createdAt: "2026-08-03T02:00:00.000Z" }), NOW)).toBe("today");
  });

  it("uses local midnight as the today boundary", () => {
    const justBefore = new Date(NOW); justBefore.setHours(0, 0, 0, 0);
    const before = new Date(justBefore.getTime() - 1000).toISOString();
    const after = new Date(justBefore.getTime() + 1000).toISOString();
    expect(bandOf(goal({ createdAt: after }), NOW)).toBe("today");
    expect(bandOf(goal({ createdAt: before }), NOW)).toBe("week");
  });

  it("bands the last seven days as week", () => {
    expect(bandOf(goal({ createdAt: "2026-07-30T09:00:00.000Z" }), NOW)).toBe("week");
  });

  it("bands anything older as earlier", () => {
    expect(bandOf(goal({ createdAt: "2026-07-20T09:00:00.000Z" }), NOW)).toBe("earlier");
  });

  it("bands a future-dated goal as today rather than losing it", () => {
    // Clock skew between the daemon host and the browser must not make a row
    // vanish off the top of the list.
    expect(bandOf(goal({ createdAt: "2026-08-04T09:00:00.000Z" }), NOW)).toBe("today");
  });

  it("bands an unparseable date as earlier rather than throwing", () => {
    expect(bandOf(goal({ createdAt: "not-a-date" }), NOW)).toBe("earlier");
  });
});

describe("groupByBand", () => {
  it("returns bands in BANDS order and drops empty ones", () => {
    const out = groupByBand([
      goal({ id: "a", createdAt: "2026-07-20T09:00:00.000Z" }),
      goal({ id: "b", createdAt: "2026-08-03T09:00:00.000Z" }),
    ], NOW);
    expect(out.map((b) => b.key)).toEqual(["today", "earlier"]);
  });

  it("omits live entirely when nothing is live", () => {
    // Spec §1: absent, not empty-with-placeholder.
    const out = groupByBand([goal()], NOW);
    expect(out.some((b) => b.key === "live")).toBe(false);
  });

  it("sorts newest first inside a band", () => {
    const out = groupByBand([
      goal({ id: "older", createdAt: "2026-08-03T02:00:00.000Z" }),
      goal({ id: "newer", createdAt: "2026-08-03T11:00:00.000Z" }),
    ], NOW);
    expect(out[0].items.map((g) => g.id)).toEqual(["newer", "older"]);
  });

  it("labels every band it can emit", () => {
    expect(BANDS.map((b) => b.key)).toEqual(["live", "today", "week", "earlier"]);
    for (const b of BANDS) expect(b.label).toBeTruthy();
  });
});
