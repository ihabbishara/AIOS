// ui2/test/clock-lanes.test.ts — the collision that shipped: 07:15 and 07:30 must never share
// a lane; a sparse day stays on the axis line.
import { describe, it, expect } from "vitest";
import { clockLanes } from "../src/lib/clock-lanes.js";
import type { ClockMark } from "../src/lib/clock.js";

const mark = (key: string, hhmm: string, label: string): ClockMark => {
  const [h, m] = hhmm.split(":").map(Number);
  return { key, label, hhmm, minutes: h * 60 + m, kind: "future" };
};

describe("clockLanes", () => {
  it("the shipped garble: 07:15 standup and 07:30 briefing land in different lanes", () => {
    const lanes = clockLanes([mark("a", "07:15", "standup"), mark("b", "07:30", "briefing")]);
    expect(lanes[0].lane).not.toBe(lanes[1].lane);
  });

  it("well-separated marks all stay in lane 0", () => {
    const lanes = clockLanes([
      mark("a", "02:00", "dream"), mark("b", "08:00", "morning"), mark("c", "21:00", "evening"),
    ]);
    expect(lanes.map((l) => l.lane)).toEqual([0, 0, 0]);
  });

  it("three tight marks ladder down three lanes, and the lane frees up again later", () => {
    const lanes = clockLanes([
      mark("a", "07:00", "one"), mark("b", "07:10", "two"), mark("c", "07:20", "three"),
      mark("d", "14:00", "afternoon"),
    ]);
    expect(new Set(lanes.slice(0, 3).map((l) => l.lane)).size).toBe(3);
    expect(lanes[3].lane).toBe(0); // far from the cluster: back on the axis
  });

  it("is deterministic regardless of input order", () => {
    const a = [mark("a", "07:15", "standup"), mark("b", "07:30", "briefing")];
    const flipped = clockLanes([...a].reverse()).map((l) => [l.key, l.lane]);
    expect(clockLanes(a).map((l) => [l.key, l.lane])).toEqual(flipped);
  });

  it("empty in, empty out", () => {
    expect(clockLanes([])).toEqual([]);
  });
});
