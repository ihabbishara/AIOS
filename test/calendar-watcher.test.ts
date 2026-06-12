// test/calendar-watcher.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus, type AiosEvent } from "../src/events.js";
import { CalendarWatcher, type CalendarLike } from "../src/senses/google/calendar.js";

const NOW = new Date("2026-06-12T10:00:00.000Z");

function gevent(id: string, startIso: string, over: Record<string, unknown> = {}) {
  return {
    id, summary: `event ${id}`, status: "confirmed", updated: "2026-06-12T08:00:00.000Z",
    start: { dateTime: startIso }, end: { dateTime: startIso },
    organizer: { email: "org@x.com" }, hangoutLink: null,
    ...over,
  };
}

function stubCalendar(items: Array<ReturnType<typeof gevent>>): CalendarLike {
  return {
    events: { list: async () => ({ data: { items } }) },
  } as unknown as CalendarLike;
}

function setup(items: Array<ReturnType<typeof gevent>>, pingMinutes = 15, now = NOW) {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const events: AiosEvent[] = [];
  bus.on((e) => events.push(e.event));
  const watcher = new CalendarWatcher({
    account: "personal", calendar: stubCalendar(items), store, bus,
    pingMinutes, nowFn: () => now,
  });
  return { store, events, watcher };
}

describe("CalendarWatcher snapshot diff", () => {
  it("first poll bootstraps the snapshot without emitting calendar.changed", async () => {
    const { events, watcher, store } = setup([gevent("e1", "2026-06-13T09:00:00.000Z")]);
    await watcher.poll();
    expect(events.filter((e) => e.type === "calendar.changed")).toHaveLength(0);
    expect(store.kvGet("gcal:personal:snapshot")).toBeTruthy();
  });

  it("new event after bootstrap emits calendar.changed", async () => {
    const { watcher: w1, store } = setup([gevent("e1", "2026-06-13T09:00:00.000Z")]);
    await w1.poll();
    const store2events: AiosEvent[] = [];
    const bus2 = new EventBus(store);
    bus2.on((e) => store2events.push(e.event));
    const w2 = new CalendarWatcher({
      account: "personal",
      calendar: stubCalendar([gevent("e1", "2026-06-13T09:00:00.000Z"), gevent("e2", "2026-06-14T10:00:00.000Z")]),
      store, bus: bus2, pingMinutes: 15, nowFn: () => NOW,
    });
    await w2.poll();
    const changed = store2events.filter((e) => e.type === "calendar.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ eventId: "e2", summary: "event e2", account: "personal" });
  });

  it("updated event (newer updated stamp) emits; unchanged does not", async () => {
    const { watcher: w1, store } = setup([gevent("e1", "2026-06-13T09:00:00.000Z")]);
    await w1.poll();
    const events2: AiosEvent[] = [];
    const bus2 = new EventBus(store);
    bus2.on((e) => events2.push(e.event));
    const w2 = new CalendarWatcher({
      account: "personal",
      calendar: stubCalendar([gevent("e1", "2026-06-13T11:00:00.000Z", { updated: "2026-06-12T09:30:00.000Z" })]),
      store, bus: bus2, pingMinutes: 15, nowFn: () => NOW,
    });
    await w2.poll();
    expect(events2.filter((e) => e.type === "calendar.changed")).toHaveLength(1);
    await w2.poll(); // same data again
    expect(events2.filter((e) => e.type === "calendar.changed")).toHaveLength(1);
  });

  it("disappeared (cancelled) event emits calendar.changed with status cancelled", async () => {
    const { watcher: w1, store } = setup([gevent("e1", "2026-06-13T09:00:00.000Z")]);
    await w1.poll();
    const events2: AiosEvent[] = [];
    const bus2 = new EventBus(store);
    bus2.on((e) => events2.push(e.event));
    const w2 = new CalendarWatcher({
      account: "personal", calendar: stubCalendar([]), store, bus: bus2, pingMinutes: 15, nowFn: () => NOW,
    });
    await w2.poll();
    const changed = events2.filter((e) => e.type === "calendar.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ eventId: "e1", status: "cancelled" });
  });
});

describe("CalendarWatcher meeting pings", () => {
  it("event within the lead window pings once", async () => {
    const soon = new Date(NOW.getTime() + 10 * 60_000).toISOString(); // in 10 min
    const { events, watcher, store } = setup([gevent("m1", soon)]);
    await watcher.poll(); // bootstrap also scans pings
    const pings = events.filter((e) => e.type === "calendar.reminder");
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({ eventId: "m1", minutesUntil: 10 });
    expect(store.kvGet("gcal:pinged:m1")).toBeTruthy();
    await watcher.poll();
    expect(events.filter((e) => e.type === "calendar.reminder")).toHaveLength(1); // no re-fire
  });

  it("event outside the window does not ping", async () => {
    const later = new Date(NOW.getTime() + 60 * 60_000).toISOString();
    const { events, watcher } = setup([gevent("m2", later)]);
    await watcher.poll();
    expect(events.filter((e) => e.type === "calendar.reminder")).toHaveLength(0);
  });

  it("event already started does not ping", async () => {
    const past = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    const { events, watcher } = setup([gevent("m3", past)]);
    await watcher.poll();
    expect(events.filter((e) => e.type === "calendar.reminder")).toHaveLength(0);
  });
});
