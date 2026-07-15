// test/schedule-view.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { buildConfig } from "../src/config.js";
import { buildScheduleView, validateRoutineBody, isValidHHMM, anchorOverrideKey, ANCHOR_NAMES } from "../src/web/schedule-view.js";

// buildConfig({}) yields all defaults — anchorMorning "07:30" etc.; only anchor* fields matter here.
const config = buildConfig({});
const now = new Date(2026, 6, 15, 9, 30);

describe("buildScheduleView", () => {
  it("lists all five anchors with override + firedToday flags", () => {
    const store = new Store(":memory:");
    store.kvSet(anchorOverrideKey("morning"), "08:15");
    store.kvSet("anchor:evening:last", "2026-07-15");
    const v = buildScheduleView(store, config, now);
    expect(v.anchors.map((a) => a.name)).toEqual([...ANCHOR_NAMES]);
    const morning = v.anchors.find((a) => a.name === "morning")!;
    expect(morning).toMatchObject({ hhmm: "08:15", overridden: true });
    expect(v.anchors.find((a) => a.name === "evening")!.firedToday).toBe(true);
    expect(v.anchors.find((a) => a.name === "dream")!.overridden).toBe(false);
  });

  it("routines carry parsed recurrence, enabled bool, and nextFire", () => {
    const store = new Store(":memory:");
    store.addRoutine({ name: "r1", prompt: "p", recurrence: '{"kind":"daily","hhmm":"10:00"}' });
    const [r] = buildScheduleView(store, config, now).routines;
    expect(r.recurrence).toEqual({ kind: "daily", hhmm: "10:00" });
    expect(r.enabled).toBe(true);
    expect(r.nextFire).toBe("2026-07-15 10:00");
  });

  it("only pending reminders appear", () => {
    const store = new Store(":memory:");
    const id = store.addReminder({ text: "call", dueAt: "2026-07-16T09:00:00.000Z", originChannel: "cli", originChatId: "x" });
    store.addReminder({ text: "gone", dueAt: "2026-07-16T09:00:00.000Z", originChannel: "cli", originChatId: "x" });
    store.cancelReminder(id + 1);
    const v = buildScheduleView(store, config, now);
    expect(v.reminders).toHaveLength(1);
    expect(v.reminders[0]).toMatchObject({ text: "call", origin: "cli:x" });
  });
});

describe("validateRoutineBody", () => {
  it("full body: all three required", () => {
    expect(validateRoutineBody({ name: "n", prompt: "p", recurrence: { kind: "daily", hhmm: "09:00" } }, false))
      .toEqual({ ok: true, fields: { name: "n", prompt: "p", recurrence: '{"kind":"daily","hhmm":"09:00"}' } });
    expect(validateRoutineBody({ name: "n", prompt: "p" }, false)).toMatchObject({ ok: false });
    expect(validateRoutineBody({ name: " ", prompt: "p", recurrence: { kind: "daily", hhmm: "09:00" } }, false)).toMatchObject({ ok: false });
  });
  it("partial: any subset, but present fields must be valid", () => {
    expect(validateRoutineBody({ enabled: false }, true)).toEqual({ ok: true, fields: { enabled: false } });
    expect(validateRoutineBody({ recurrence: { kind: "cron" } }, true)).toMatchObject({ ok: false });
    expect(validateRoutineBody("nope", true)).toMatchObject({ ok: false });
  });
});

describe("isValidHHMM", () => {
  it("accepts 24h zero-padded, rejects everything else", () => {
    expect(isValidHHMM("07:30")).toBe(true);
    expect(isValidHHMM("23:59")).toBe(true);
    expect(isValidHHMM("24:00")).toBe(false);
    expect(isValidHHMM("7:30")).toBe(false);
    expect(isValidHHMM(730)).toBe(false);
  });
});
