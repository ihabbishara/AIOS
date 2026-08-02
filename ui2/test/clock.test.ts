// ui2/test/clock.test.ts — exactly one mark may pulse. "Approach" means the next
// thing that will happen, singular; two pulsing pins would be decoration.
//
// Everything here is built in LOCAL time. The clock axis is the user's day, and
// Home derives `nowMinutes` from local getters — a UTC fixture would pass in
// London and fail everywhere else.
import { describe, it, expect } from "vitest";
import { clockMarks } from "../src/lib/clock.js";
import type { ScheduleView } from "../src/api.js";

/** Aug 2 2026 at a local wall-clock time. */
const localAt = (h: number, m = 0) => new Date(2026, 7, 2, h, m, 0, 0);

const schedule: ScheduleView = {
  anchors: [
    { name: "morning", hhmm: "08:00", overridden: false, firedToday: true },
    { name: "evening", hhmm: "21:30", overridden: false, firedToday: false },
  ],
  routines: [
    { id: 1, name: "inbox sweep", prompt: "p", recurrence: { kind: "daily", hhmm: "09:30" },
      enabled: true, lastFiredAt: null, nextFire: "2026-08-02 09:30" },
  ],
  // Built from a local Date so its local hour is 12:00 in any timezone.
  reminders: [{ id: 7, text: "renew domain", dueAt: localAt(12).toISOString(), origin: "user" }],
};

describe("clockMarks", () => {
  it("marks a fired anchor as past", () => {
    const m = clockMarks(schedule, localAt(10)).find((x) => x.key === "anchor:morning");
    expect(m?.kind).toBe("past");
  });

  it("marks exactly one upcoming entry as next — the earliest", () => {
    const next = clockMarks(schedule, localAt(10)).filter((m) => m.kind === "next");
    expect(next).toHaveLength(1);
    expect(next[0].key).toBe("reminder:7");
  });

  it("demotes everything after the next to future", () => {
    const marks = clockMarks(schedule, localAt(10));
    expect(marks.find((m) => m.key === "anchor:evening")?.kind).toBe("future");
  });

  it("treats an unfired anchor already past its time as past, not next", () => {
    const marks = clockMarks(schedule, localAt(10));
    expect(marks.find((m) => m.key === "routine:1")?.kind).toBe("past");
  });

  it("returns marks sorted by minutes from midnight", () => {
    const mins = clockMarks(schedule, localAt(10)).map((m) => m.minutes);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
  });

  it("resolves a reminder to its local wall-clock time", () => {
    const m = clockMarks(schedule, localAt(10)).find((x) => x.key === "reminder:7");
    expect(m?.hhmm).toBe("12:00");
    expect(m?.minutes).toBe(720);
  });

  it("has no next when everything has already fired", () => {
    const done: ScheduleView = {
      anchors: [{ name: "morning", hhmm: "08:00", overridden: false, firedToday: true }],
      routines: [], reminders: [],
    };
    expect(clockMarks(done, localAt(23)).some((m) => m.kind === "next")).toBe(false);
  });

  it("skips disabled routines", () => {
    const off: ScheduleView = {
      anchors: [], reminders: [],
      routines: [{ id: 2, name: "off", prompt: "p", recurrence: { kind: "daily", hhmm: "10:00" },
        enabled: false, lastFiredAt: null, nextFire: "2026-08-02 10:00" }],
    };
    expect(clockMarks(off, localAt(9))).toEqual([]);
  });

  it("returns an empty list for an empty schedule", () => {
    expect(clockMarks({ anchors: [], routines: [], reminders: [] }, localAt(10))).toEqual([]);
  });
});
