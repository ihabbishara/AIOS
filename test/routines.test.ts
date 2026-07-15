// test/routines.test.ts
import { describe, it, expect, vi } from "vitest";
import { parseRecurrence, routineDue, nextFire, makeRoutineFire, type RoutineLike } from "../src/heartbeat/routines.js";

const base: RoutineLike = { enabled: 1, recurrence: "", last_fired_at: null, last_fired_date: null };
const rec = (r: unknown): string => JSON.stringify(r);

describe("parseRecurrence", () => {
  it("accepts each valid kind", () => {
    expect(parseRecurrence({ kind: "daily", hhmm: "09:00" })).toEqual({ kind: "daily", hhmm: "09:00" });
    expect(parseRecurrence({ kind: "weekdays", hhmm: "23:59" })).toEqual({ kind: "weekdays", hhmm: "23:59" });
    expect(parseRecurrence({ kind: "weekly", dow: 1, hhmm: "09:00" })).toEqual({ kind: "weekly", dow: 1, hhmm: "09:00" });
    expect(parseRecurrence({ kind: "interval", everyMinutes: 90 })).toEqual({ kind: "interval", everyMinutes: 90 });
  });
  it("accepts a JSON string form (as stored)", () => {
    expect(parseRecurrence('{"kind":"daily","hhmm":"07:30"}')).toEqual({ kind: "daily", hhmm: "07:30" });
  });
  it("rejects malformed shapes", () => {
    expect(parseRecurrence(null)).toBeNull();
    expect(parseRecurrence("not json")).toBeNull();
    expect(parseRecurrence({ kind: "daily", hhmm: "24:00" })).toBeNull();
    expect(parseRecurrence({ kind: "daily", hhmm: "9:00" })).toBeNull();
    expect(parseRecurrence({ kind: "weekly", dow: 7, hhmm: "09:00" })).toBeNull();
    expect(parseRecurrence({ kind: "interval", everyMinutes: 0 })).toBeNull();
    expect(parseRecurrence({ kind: "cron", expr: "* * * * *" })).toBeNull();
  });
});

describe("routineDue", () => {
  // Wed Jul 15 2026 09:30 local
  const now = new Date(2026, 6, 15, 9, 30);

  it("daily: due when time passed and not fired today", () => {
    const r = { ...base, recurrence: rec({ kind: "daily", hhmm: "09:00" }) };
    expect(routineDue(now, r)).toBe(true);
    expect(routineDue(now, { ...r, last_fired_date: "2026-07-15" })).toBe(false);
    expect(routineDue(new Date(2026, 6, 15, 8, 59), r)).toBe(false);
  });
  it("daily: catch-up after downtime fires once (fired yesterday, hours late today)", () => {
    const r = { ...base, recurrence: rec({ kind: "daily", hhmm: "07:00" }), last_fired_date: "2026-07-14" };
    expect(routineDue(new Date(2026, 6, 15, 23, 0), r)).toBe(true);
  });
  it("weekdays: fires Wed, not Sat", () => {
    const r = { ...base, recurrence: rec({ kind: "weekdays", hhmm: "09:00" }) };
    expect(routineDue(now, r)).toBe(true); // Jul 15 2026 = Wednesday
    expect(routineDue(new Date(2026, 6, 18, 9, 30), r)).toBe(false); // Jul 18 = Saturday
  });
  it("weekly: only on matching dow", () => {
    const r = { ...base, recurrence: rec({ kind: "weekly", dow: 3, hhmm: "09:00" }) };
    expect(routineDue(now, r)).toBe(true); // Wed = 3
    expect(routineDue(new Date(2026, 6, 16, 9, 30), r)).toBe(false); // Thu
  });
  it("interval: first fire immediately, then only after the gap", () => {
    const r = { ...base, recurrence: rec({ kind: "interval", everyMinutes: 60 }) };
    expect(routineDue(now, r)).toBe(true); // never fired
    const at = new Date(2026, 6, 15, 9, 0).toISOString();
    expect(routineDue(now, { ...r, last_fired_at: at })).toBe(false); // 30m < 60m
    expect(routineDue(new Date(2026, 6, 15, 10, 0), { ...r, last_fired_at: at })).toBe(true);
  });
  it("disabled or unparseable never fires", () => {
    const r = { ...base, recurrence: rec({ kind: "daily", hhmm: "09:00" }) };
    expect(routineDue(now, { ...r, enabled: 0 })).toBe(false);
    expect(routineDue(now, { ...r, recurrence: "garbage" })).toBe(false);
  });
});

describe("nextFire", () => {
  const now = new Date(2026, 6, 15, 9, 30); // Wed 09:30

  it("daily before the time → today; after → tomorrow", () => {
    expect(nextFire(now, { ...base, recurrence: rec({ kind: "daily", hhmm: "10:00" }) })).toBe("2026-07-15 10:00");
    expect(nextFire(now, { ...base, recurrence: rec({ kind: "daily", hhmm: "09:00" }) })).toBe("2026-07-16 09:00");
  });
  it("weekly skips to the matching day; fired-today pushes a week", () => {
    expect(nextFire(now, { ...base, recurrence: rec({ kind: "weekly", dow: 5, hhmm: "08:00" }) })).toBe("2026-07-17 08:00");
    expect(nextFire(now, { ...base, recurrence: rec({ kind: "weekly", dow: 3, hhmm: "23:00" }), last_fired_date: "2026-07-15" })).toBe("2026-07-22 23:00");
  });
  it("interval: last fire + gap, floored at now; never-fired → now", () => {
    const at = new Date(2026, 6, 15, 9, 0).toISOString();
    expect(nextFire(now, { ...base, recurrence: rec({ kind: "interval", everyMinutes: 60 }), last_fired_at: at })).toBe("2026-07-15 10:00");
    expect(nextFire(now, { ...base, recurrence: rec({ kind: "interval", everyMinutes: 60 }) })).toBe("2026-07-15 09:30");
  });
  it("unparseable → null", () => {
    expect(nextFire(now, { ...base, recurrence: "garbage" })).toBeNull();
  });
});

describe("makeRoutineFire", () => {
  const ev = { id: 1, name: "standup", prompt: "post standup summary", channel: "", chatId: "" };

  it("routes to the event origin when present", async () => {
    const onMessage = vi.fn(async () => {});
    makeRoutineFire({ onMessage, log: () => {} })({ ...ev, channel: "telegram", chatId: "42" });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    expect(onMessage).toHaveBeenCalledWith({ channel: "telegram", chatId: "42", text: "post standup summary" });
  });
  it("falls back to primary chat when origin is empty", async () => {
    const onMessage = vi.fn(async () => {});
    makeRoutineFire({ onMessage, primaryChat: { channel: "slack", chatId: "C1" }, log: () => {} })(ev);
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    expect(onMessage).toHaveBeenCalledWith({ channel: "slack", chatId: "C1", text: "post standup summary" });
  });
  it("no origin and no primary chat → logged skip, no dispatch", () => {
    const onMessage = vi.fn(async () => {});
    const lines: string[] = [];
    makeRoutineFire({ onMessage, log: (l) => lines.push(l) })(ev);
    expect(onMessage).not.toHaveBeenCalled();
    expect(lines[0]).toContain("routine 1");
  });
  it("onMessage rejection is caught and logged, not thrown", async () => {
    const lines: string[] = [];
    const onMessage = vi.fn(async () => { throw new Error("boom"); });
    makeRoutineFire({ onMessage, primaryChat: { channel: "cli", chatId: "local" }, log: (l) => lines.push(l) })(ev);
    await vi.waitFor(() => expect(lines.some((l) => l.includes("boom"))).toBe(true));
  });
});
