import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { assembleBrief, isEmptyBrief, renderBriefNote } from "../src/heartbeat/briefs.js";

const NOW = "2026-06-30T07:30:00.000Z"; // local date 2026-06-30 (UTC test env)

describe("brief Open loops section", () => {
  it("morning brief surfaces overdue + due-today; section renders; not empty", () => {
    const store = new Store(":memory:");
    store.addTask({ title: "tax return", due_date: "2026-06-20" }); // overdue
    store.addTask({ title: "call dentist", due_date: "2026-06-30" }); // today
    store.addTask({ title: "someday", due_date: null });             // open, not actionable
    const data = assembleBrief(store, "morning", NOW, null);
    expect(data.openLoops!.overdue).toEqual([{ title: "tax return", due_date: "2026-06-20" }]);
    expect(data.openLoops!.dueToday).toEqual(["call dentist"]);
    expect(data.openLoops!.openCount).toBe(3);
    expect(isEmptyBrief(data)).toBe(false);
    const note = renderBriefNote(data, "narration");
    expect(note).toContain("## Open loops");
    expect(note).toContain("tax return");
    expect(note).toContain("3 open loops total");
  });

  it("evening brief omits open loops", () => {
    const store = new Store(":memory:");
    store.addTask({ title: "x", due_date: "2026-06-20" });
    const data = assembleBrief(store, "evening", NOW, null);
    expect(data.openLoops).toBeUndefined();
  });

  it("only someday tasks (no overdue/due-today) → empty brief", () => {
    const store = new Store(":memory:");
    store.addTask({ title: "someday", due_date: null });
    const data = assembleBrief(store, "morning", NOW, null);
    expect(isEmptyBrief(data)).toBe(true);
  });
});
