// test/routines-store.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

const add = (store: Store) =>
  store.addRoutine({ name: "standup", prompt: "post summary", recurrence: '{"kind":"daily","hhmm":"09:00"}' });

describe("routines store", () => {
  it("add/get/list round-trips with defaults", () => {
    const store = new Store(":memory:");
    const id = add(store);
    const r = store.getRoutine(id)!;
    expect(r.name).toBe("standup");
    expect(r.enabled).toBe(1);
    expect(r.last_fired_at).toBeNull();
    expect(r.last_fired_date).toBeNull();
    expect(r.origin_channel).toBeNull();
    expect(store.listRoutines()).toHaveLength(1);
  });

  it("updateRoutine patches only provided fields; false for unknown id", () => {
    const store = new Store(":memory:");
    const id = add(store);
    expect(store.updateRoutine(id, { enabled: false })).toBe(true);
    const r = store.getRoutine(id)!;
    expect(r.enabled).toBe(0);
    expect(r.name).toBe("standup"); // untouched
    expect(store.updateRoutine(999, { name: "x" })).toBe(false);
  });

  it("deleteRoutine removes; false for unknown id", () => {
    const store = new Store(":memory:");
    const id = add(store);
    expect(store.deleteRoutine(id)).toBe(true);
    expect(store.getRoutine(id)).toBeUndefined();
    expect(store.deleteRoutine(id)).toBe(false);
  });

  it("stampRoutineFired is CAS on last_fired_at — second claim with a stale expectation loses", () => {
    const store = new Store(":memory:");
    const id = add(store);
    expect(store.stampRoutineFired(id, null, "2026-07-15", "2026-07-15T09:00:00.000Z")).toBe(true);
    // same expectation again (stale read) must not double-fire
    expect(store.stampRoutineFired(id, null, "2026-07-15", "2026-07-15T09:00:30.000Z")).toBe(false);
    const r = store.getRoutine(id)!;
    expect(r.last_fired_date).toBe("2026-07-15");
    expect(r.last_fired_at).toBe("2026-07-15T09:00:00.000Z");
    // next fire with the fresh expectation succeeds
    expect(store.stampRoutineFired(id, "2026-07-15T09:00:00.000Z", "2026-07-16", "2026-07-16T09:00:00.000Z")).toBe(true);
  });
});
