// test/clock.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { localParts, anchorDue, yesterdayOf, Clock } from "../src/heartbeat/clock.js";
import type { ReminderRow } from "../src/store/db.js";

describe("localParts", () => {
  it("formats local date and HH:MM with zero padding", () => {
    const d = new Date(2026, 0, 5, 7, 5); // Jan 5 2026, 07:05 LOCAL
    expect(localParts(d)).toEqual({ date: "2026-01-05", hhmm: "07:05" });
  });
});

describe("yesterdayOf", () => {
  it("handles plain, month-rollover, and year-rollover dates", () => {
    expect(yesterdayOf("2026-06-12")).toBe("2026-06-11");
    expect(yesterdayOf("2026-07-01")).toBe("2026-06-30");
    expect(yesterdayOf("2026-01-01")).toBe("2025-12-31");
  });
});

describe("anchorDue", () => {
  const now = { date: "2026-06-12", hhmm: "07:30" };
  it("due when time reached and not yet fired today — returns today's occurrence", () => {
    expect(anchorDue(now, "07:30", undefined)).toBe("2026-06-12");
    expect(anchorDue(now, "07:30", "2026-06-11")).toBe("2026-06-12");
  });
  it("not due before the anchor time (last fired yesterday — that occurrence is covered)", () => {
    expect(anchorDue({ ...now, hhmm: "07:29" }, "07:30", "2026-06-11")).toBeNull();
  });
  it("not due when already fired today (fire-once)", () => {
    expect(anchorDue(now, "07:30", "2026-06-12")).toBeNull();
  });
  it("same-day catch-up: hours past the anchor still fires once", () => {
    expect(anchorDue({ ...now, hhmm: "23:59" }, "07:30", undefined)).toBe("2026-06-12");
  });
  it("cross-midnight catch-up: missed yesterday's occurrence fires after the gate", () => {
    // evening 21:00 missed on 06-12; daemon back 06-13 09:00
    expect(anchorDue({ date: "2026-06-13", hhmm: "09:00" }, "21:00", "2026-06-11")).toBe("2026-06-12");
  });
  it("cross-midnight catch-up is gated before catchupAfter", () => {
    expect(anchorDue({ date: "2026-06-13", hhmm: "03:00" }, "21:00", "2026-06-11")).toBeNull();
    expect(anchorDue({ date: "2026-06-13", hhmm: "08:00" }, "21:00", "2026-06-11")).toBe("2026-06-12"); // boundary: >= fires
  });
  it("the gate never blocks a today-occurrence fire", () => {
    // dream 02:00, daemon restarts 03:00 — occurrence is today, fires despite hhmm < 08:00
    expect(anchorDue({ date: "2026-06-13", hhmm: "03:00" }, "02:00", "2026-06-12")).toBe("2026-06-13");
  });
  it("multi-day outage catches up a single occurrence (yesterday), never stacks", () => {
    expect(anchorDue({ date: "2026-06-13", hhmm: "09:00" }, "21:00", "2026-06-01")).toBe("2026-06-12");
  });
  it("undefined lastFiredDate before anchor time still catches up yesterday after the gate", () => {
    expect(anchorDue({ date: "2026-06-13", hhmm: "09:00" }, "21:00", undefined)).toBe("2026-06-12");
  });
  it("custom catchupAfter is honored", () => {
    expect(anchorDue({ date: "2026-06-13", hhmm: "09:00" }, "21:00", "2026-06-11", "10:00")).toBeNull();
    expect(anchorDue({ date: "2026-06-13", hhmm: "10:00" }, "21:00", "2026-06-11", "10:00")).toBe("2026-06-12");
  });
  it("gate boundary is inclusive even with no prior fire", () => {
    expect(anchorDue({ date: "2026-06-13", hhmm: "08:00" }, "21:00", undefined)).toBe("2026-06-12");
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
    store.kvSet("anchor:evening:last", "2026-06-11"); // yesterday's evening already covered — isolate morning
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

  it("fires a 'speculate' anchor once at its time", async () => {
    const store = new Store(":memory:");
    const fired: string[] = [];
    const clock = new Clock({
      store,
      anchors: [{ name: "speculate", hhmm: "03:00" }],
      onAnchor: async (name) => { fired.push(name); },
      onReminderDue: () => {},
      nowFn: () => new Date(2026, 5, 17, 3, 30), // 03:30 local, past 03:00
    });
    await clock.tick();
    expect(fired).toEqual(["speculate"]);
    await clock.tick();
    expect(fired).toEqual(["speculate"]); // fire-once
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

describe("Clock.tick — routines", () => {
  function setupRoutines(nowLocal: Date) {
    const store = new Store(":memory:");
    const fired: Array<{ id: number; name: string }> = [];
    const clock = new Clock({
      store,
      anchors: [],
      onAnchor: async () => {},
      onReminderDue: () => {},
      onRoutineDue: (r) => { fired.push({ id: r.id, name: r.name }); },
      nowFn: () => nowLocal,
    });
    return { store, clock, fired };
  }

  it("fires a due routine once and stamps; second tick is a no-op", async () => {
    const { store, clock, fired } = setupRoutines(new Date(2026, 6, 15, 9, 30));
    const id = store.addRoutine({ name: "r1", prompt: "p", recurrence: '{"kind":"daily","hhmm":"09:00"}' });
    await clock.tick();
    await clock.tick();
    expect(fired).toEqual([{ id, name: "r1" }]);
    expect(store.getRoutine(id)!.last_fired_date).toBe("2026-07-15");
  });

  it("disabled routine never fires", async () => {
    const { store, clock, fired } = setupRoutines(new Date(2026, 6, 15, 9, 30));
    const id = store.addRoutine({ name: "r1", prompt: "p", recurrence: '{"kind":"daily","hhmm":"09:00"}' });
    store.updateRoutine(id, { enabled: false });
    await clock.tick();
    expect(fired).toEqual([]);
  });

  it("a throwing onRoutineDue does not kill the tick", async () => {
    const store = new Store(":memory:");
    store.addRoutine({ name: "bad", prompt: "p", recurrence: '{"kind":"daily","hhmm":"09:00"}' });
    store.addReminder({ text: "after", dueAt: "2026-07-15T00:00:00.000Z", originChannel: "cli", originChatId: "x" });
    const remindersFired: string[] = [];
    const clock = new Clock({
      store,
      anchors: [],
      onAnchor: async () => {},
      onReminderDue: (r) => { remindersFired.push(r.text); },
      onRoutineDue: () => { throw new Error("boom"); },
      nowFn: () => new Date(2026, 6, 15, 9, 30),
    });
    await clock.tick();
    expect(remindersFired).toEqual(["after"]); // reminders ran despite the throw
  });
});

describe("Clock.tick — anchor kv override", () => {
  it("kv override moves an anchor's effective time without restart", async () => {
    const store = new Store(":memory:");
    const anchorsFired: string[] = [];
    const clock = new Clock({
      store,
      anchors: [{ name: "morning", hhmm: "07:30" }],
      onAnchor: async (name) => { anchorsFired.push(name); },
      onReminderDue: () => {},
      nowFn: () => new Date(2026, 6, 15, 8, 0), // 08:00
    });
    store.kvSet("anchor:morning:last", "2026-07-14"); // yesterday covered — no catch-up noise
    store.kvSet("anchor:morning:hhmm", "09:00"); // pushed later than now
    await clock.tick();
    expect(anchorsFired).toEqual([]); // 08:00 < 09:00 override
    store.kvSet("anchor:morning:hhmm", "07:00"); // pulled earlier
    await clock.tick();
    expect(anchorsFired).toEqual(["morning"]);
  });
});
