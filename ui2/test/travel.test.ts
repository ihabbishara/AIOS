// ui2/test/travel.test.ts — `travel` draws one real memo or nothing. Both halves are
// pure so the choice of crossing and the shape of the arc can be asserted without a DOM.
import { describe, it, expect } from "vitest";
import { pickTravel, travelPath } from "../src/lib/travel.js";
import type { StoredEvent } from "../src/api.js";

const ON_FIELD = new Set(["atlas", "vulcan", "clio"]);

const sent = (id: number, from: string, to: string): StoredEvent => ({
  id, ts: "2026-08-19T12:00:00.000Z", event: { type: "mail.sent", id: `m${id}`, from, to, kind: "request" },
});

describe("pickTravel", () => {
  it("takes the newest crossing after the high-water mark, not the oldest", () => {
    const events = [sent(1, "atlas", "vulcan"), sent(2, "vulcan", "clio"), sent(3, "clio", "atlas")];
    expect(pickTravel(events, 0, ON_FIELD)).toEqual({ id: 3, from: "clio", to: "atlas" });
    expect(pickTravel(events, 1, ON_FIELD)).toEqual({ id: 3, from: "clio", to: "atlas" });
  });

  it("returns null once every crossing has already flown", () => {
    expect(pickTravel([sent(1, "atlas", "vulcan")], 1, ON_FIELD)).toBeNull();
    expect(pickTravel([], 0, ON_FIELD)).toBeNull();
  });

  it("skips mail to or from the user — there is no user dot to draw to", () => {
    const events = [sent(1, "atlas", "vulcan"), sent(2, "clio", "user"), sent(3, "user", "atlas")];
    expect(pickTravel(events, 0, ON_FIELD)).toEqual({ id: 1, from: "atlas", to: "vulcan" });
  });

  it("skips an agent that is not on the field, and events that are not mail", () => {
    expect(pickTravel([sent(1, "atlas", "ghost")], 0, ON_FIELD)).toBeNull();
    expect(pickTravel([sent(1, "ghost", "atlas")], 0, ON_FIELD)).toBeNull();
    const other: StoredEvent = {
      id: 2, ts: "2026-08-19T12:00:00.000Z",
      event: { type: "mail.read", from: "atlas", to: "vulcan" },
    };
    expect(pickTravel([other], 0, ON_FIELD)).toBeNull();
  });
});

describe("travelPath", () => {
  it("is a quadratic arc that starts and ends on the two dots", () => {
    const d = travelPath({ x: 10, y: 20 }, { x: 110, y: 20 });
    expect(d.startsWith("M 10 20")).toBe(true);
    expect(d.endsWith("110 20")).toBe(true);
    expect(d).toBe("M 10 20 Q 60 38 110 20");
  });

  it("bows off the straight line rather than tracing it", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 100 };
    const [, mx, my] = travelPath(a, b).match(/Q (-?[\d.]+) (-?[\d.]+)/)!;
    expect(Number(mx)).not.toBe(0);
    expect(Number(my)).toBe(50);
  });

  it("is deterministic — a re-measure mid-flight cannot move the mote onto a new route", () => {
    const a = { x: 12.4, y: 7.1 };
    const b = { x: 90.9, y: 61.2 };
    expect(travelPath(a, b)).toBe(travelPath(a, b));
  });
});
