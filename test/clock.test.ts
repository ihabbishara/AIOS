// test/clock.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { localParts, anchorDue, Clock } from "../src/heartbeat/clock.js";
import type { ReminderRow } from "../src/store/db.js";

describe("localParts", () => {
  it("formats local date and HH:MM with zero padding", () => {
    const d = new Date(2026, 0, 5, 7, 5); // Jan 5 2026, 07:05 LOCAL
    expect(localParts(d)).toEqual({ date: "2026-01-05", hhmm: "07:05" });
  });
});

describe("anchorDue", () => {
  const now = { date: "2026-06-12", hhmm: "07:30" };
  it("due when time reached and not yet fired today", () => {
    expect(anchorDue(now, "07:30", undefined)).toBe(true);
    expect(anchorDue(now, "07:30", "2026-06-11")).toBe(true);
  });
  it("not due before the anchor time", () => {
    expect(anchorDue({ ...now, hhmm: "07:29" }, "07:30", undefined)).toBe(false);
  });
  it("not due when already fired today (fire-once)", () => {
    expect(anchorDue(now, "07:30", "2026-06-12")).toBe(false);
  });
  it("catch-up: hours past the anchor still fires once", () => {
    expect(anchorDue({ ...now, hhmm: "23:59" }, "07:30", undefined)).toBe(true);
  });
});

describe("Clock.tick", () => {
  function setup(nowLocal: Date) {
    const store = new Store(":memory:");
    const anchorsFired: string[] = [];
    const remindersFired: ReminderRow[] = [];
    const clock = new Clock({
      store,
      anchors: [
        { name: "morning", hhmm: "07:30" },
        { name: "evening", hhmm: "21:00" },
      ],
      onAnchor: async (name) => { anchorsFired.push(name); },
      onReminderDue: (r) => { remindersFired.push(r); },
      nowFn: () => nowLocal,
    });
    return { store, clock, anchorsFired, remindersFired };
  }

  it("fires a due anchor once and stamps kv", async () => {
    const { store, clock, anchorsFired } = setup(new Date(2026, 5, 12, 8, 0));
    await clock.tick();
    expect(anchorsFired).toEqual(["morning"]);
    expect(store.kvGet("anchor:morning:last")).toBe("2026-06-12");
    await clock.tick();
    expect(anchorsFired).toEqual(["morning"]); // no refire
  });

  it("double catch-up fires morning first, then evening", async () => {
    const { clock, anchorsFired } = setup(new Date(2026, 5, 12, 22, 0));
    await clock.tick();
    expect(anchorsFired).toEqual(["morning", "evening"]);
  });

  it("stamps BEFORE running so a crashing brief does not retry", async () => {
    const store = new Store(":memory:");
    let calls = 0;
    const clock = new Clock({
      store,
      anchors: [{ name: "morning", hhmm: "07:30" }],
      onAnchor: async () => { calls++; throw new Error("brief exploded"); },
      onReminderDue: () => {},
      nowFn: () => new Date(2026, 5, 12, 8, 0),
    });
    await clock.tick();
    await clock.tick();
    expect(calls).toBe(1);
    expect(store.kvGet("anchor:morning:last")).toBe("2026-06-12");
  });

  it("claims and emits due reminders", async () => {
    const { store, clock, remindersFired } = setup(new Date(2026, 5, 12, 6, 0)); // before anchors
    store.addReminder({ text: "due now", dueAt: "2026-06-12T00:00:00.000Z", originChannel: "cli", originChatId: "local" });
    await clock.tick();
    expect(remindersFired).toHaveLength(1);
    expect(remindersFired[0].text).toBe("due now");
    await clock.tick();
    expect(remindersFired).toHaveLength(1); // at-most-once
  });

  it("a throwing tick body never propagates", async () => {
    const store = new Store(":memory:");
    const clock = new Clock({
      store,
      anchors: [{ name: "morning", hhmm: "07:30" }],
      onAnchor: async () => {},
      onReminderDue: () => { throw new Error("listener exploded"); },
      nowFn: () => new Date(2026, 5, 12, 6, 0),
    });
    store.addReminder({ text: "x", dueAt: "2026-06-12T00:00:00.000Z", originChannel: "cli", originChatId: "local" });
    await expect(clock.tick()).resolves.toBeUndefined();
  });
});
