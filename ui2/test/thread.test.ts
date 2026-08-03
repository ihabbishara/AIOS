// ui2/test/thread.test.ts — ordering, duration, and when a row must name its deps.
import { describe, it, expect } from "vitest";
import { threadOrder, elapsed, showsDeps } from "../src/lib/thread.js";
import type { GoalNodeView } from "../src/api.js";

const node = (key: string, deps: string[] = [], over: Partial<GoalNodeView> = {}): GoalNodeView => ({
  key, type: "task", agent: "clio", critic: null, brief: "", deps,
  status: "done", costCents: 0, rounds: 1, artifact: null, error: null,
  startedAt: null, finishedAt: null, ...over,
});

const keys = (ns: GoalNodeView[]) => ns.map((n) => n.key);

describe("threadOrder", () => {
  it("keeps a single node as-is", () => {
    expect(keys(threadOrder([node("a")]))).toEqual(["a"]);
  });

  it("orders a linear chain by dependency, not array order", () => {
    const out = threadOrder([node("c", ["b"]), node("a"), node("b", ["a"])]);
    expect(keys(out)).toEqual(["a", "b", "c"]);
  });

  it("breaks ties by original array index, so order is deterministic", () => {
    const out = threadOrder([node("x"), node("y"), node("z")]);
    expect(keys(out)).toEqual(["x", "y", "z"]);
    const reordered = threadOrder([node("z"), node("y"), node("x")]);
    expect(keys(reordered)).toEqual(["z", "y", "x"]);
  });

  it("places a fan-in node after both parents", () => {
    const out = threadOrder([node("join", ["a", "b"]), node("a"), node("b")]);
    expect(keys(out).indexOf("join")).toBeGreaterThan(keys(out).indexOf("a"));
    expect(keys(out).indexOf("join")).toBeGreaterThan(keys(out).indexOf("b"));
  });

  it("does not strand a node whose dep is absent from the set", () => {
    // canvas/Ask.tsx renders a goal's nodes directly; a dep naming something
    // outside the array must not swallow its dependent.
    const out = threadOrder([node("orphan", ["nope"]), node("a")]);
    expect(keys(out).sort()).toEqual(["a", "orphan"]);
  });

  it("terminates on a cycle instead of hanging", () => {
    const out = threadOrder([node("a", ["b"]), node("b", ["a"])]);
    expect(keys(out).sort()).toEqual(["a", "b"]);
  });
});

describe("elapsed", () => {
  const T0 = "2026-08-03T10:00:00.000Z";

  it("returns an em dash when there is no start", () => {
    // 3 of 107 stored nodes have a finished_at and no started_at.
    expect(elapsed(null, "2026-08-03T10:05:00.000Z")).toBe("—");
  });

  it("formats whole minutes", () => {
    expect(elapsed(T0, "2026-08-03T10:14:00.000Z")).toBe("14m");
  });

  it("formats sub-minute as <1m rather than 0m", () => {
    expect(elapsed(T0, "2026-08-03T10:00:20.000Z")).toBe("<1m");
  });

  it("formats hours and minutes", () => {
    expect(elapsed(T0, "2026-08-03T12:18:00.000Z")).toBe("2h 18m");
  });

  it("measures an unfinished node against now", () => {
    expect(elapsed(T0, null, Date.parse("2026-08-03T10:22:00.000Z"))).toBe("22m");
  });

  it("returns an em dash rather than a negative duration", () => {
    expect(elapsed("2026-08-03T10:05:00.000Z", T0)).toBe("—");
  });

  it("returns an em dash on an unparseable stamp", () => {
    expect(elapsed("not-a-date", T0)).toBe("—");
  });
});

describe("showsDeps", () => {
  it("is false for a node with no deps", () => {
    expect(showsDeps(node("a"), undefined)).toBe(false);
  });

  it("is false when the single dep is the row directly above", () => {
    expect(showsDeps(node("b", ["a"]), node("a"))).toBe(false);
  });

  it("is true when the single dep is NOT the row above", () => {
    expect(showsDeps(node("c", ["a"]), node("b"))).toBe(true);
  });

  it("is true whenever there is more than one dep", () => {
    expect(showsDeps(node("join", ["a", "b"]), node("b"))).toBe(true);
  });
});
