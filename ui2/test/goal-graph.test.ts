// ui2/test/goal-graph.test.ts — shape, ranks, edges, gaps and the geometry the
// map is drawn on. The load-bearing test here is the agreement with
// threadOrder: two modules order the same nodes, and they must never disagree.
import { describe, it, expect } from "vitest";
import { buildGoalGraph, cardXY, edgePath, edgeToken, CARD } from "../src/lib/goal-graph.js";
import { threadOrder } from "../src/lib/thread.js";
import type { GoalNodeView } from "../src/api.js";

const node = (key: string, deps: string[] = [], over: Partial<GoalNodeView> = {}): GoalNodeView => ({
  key, type: "run", agent: "clio", critic: null, brief: "", deps,
  status: "done", costCents: 0, rounds: 1, artifact: null, error: null,
  startedAt: null, finishedAt: null, ...over,
});

const keys = (ns: GoalNodeView[]) => ns.map((n) => n.key);
const rankKeys = (rs: GoalNodeView[][]) => rs.map(keys);

const CHAIN = [node("a"), node("b", ["a"]), node("c", ["b"])];
const DIAMOND = [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])];

describe("buildGoalGraph — shape", () => {
  it("calls a lone node single", () => {
    expect(buildGoalGraph([node("a")]).shape).toBe("single");
  });

  it("calls a linear plan a chain, however the array was ordered", () => {
    expect(buildGoalGraph(CHAIN).shape).toBe("chain");
    expect(buildGoalGraph([node("c", ["b"]), node("a"), node("b", ["a"])]).shape).toBe("chain");
  });

  it("calls a diamond a dag", () => {
    expect(buildGoalGraph(DIAMOND).shape).toBe("dag");
  });

  it("calls two independent roots a dag — they are concurrent, not sequential", () => {
    // Both are ready at once. Stacking them as a chain would claim an order the
    // engine never planned.
    expect(buildGoalGraph([node("a"), node("b")]).shape).toBe("dag");
  });

  it("is still a chain when the only branching dep points outside the set", () => {
    // A dangling dep draws no edge, so it must not talk the view into geometry
    // it cannot render either.
    expect(buildGoalGraph([node("a"), node("b", ["a", "ghost"])]).shape).toBe("chain");
  });
});

describe("buildGoalGraph — ranks", () => {
  it("puts a diamond's two middles in one rank", () => {
    expect(rankKeys(buildGoalGraph(DIAMOND).ranks)).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("flattens to exactly threadOrder's order, for every shape", () => {
    // The map and the thread must never disagree about what comes after what.
    const cases: GoalNodeView[][] = [
      [node("a")],
      CHAIN,
      [node("c", ["b"]), node("a"), node("b", ["a"])],
      DIAMOND,
      [node("join", ["a", "b"]), node("a"), node("b")],
      [node("orphan", ["nope"]), node("a")],
      [node("z"), node("y"), node("x")],
    ];
    for (const nodes of cases) {
      expect(keys(buildGoalGraph(nodes).ranks.flat())).toEqual(keys(threadOrder(nodes)));
    }
  });

  it("terminates on a cycle, emitting every node exactly once", () => {
    const flat = keys(buildGoalGraph([node("a", ["b"]), node("b", ["a"])]).ranks.flat());
    expect(flat.sort()).toEqual(["a", "b"]);
  });

  it("positions every node at its rank and lane", () => {
    const { pos } = buildGoalGraph(DIAMOND);
    expect(pos.get("a")).toEqual({ rank: 0, lane: 0 });
    expect(pos.get("b")).toEqual({ rank: 1, lane: 0 });
    expect(pos.get("c")).toEqual({ rank: 1, lane: 1 });
    expect(pos.get("d")).toEqual({ rank: 2, lane: 0 });
  });
});

describe("buildGoalGraph — edges", () => {
  it("draws one edge per dep, parent → child", () => {
    expect(buildGoalGraph(DIAMOND).edges).toEqual([
      { from: "a", to: "b" }, { from: "a", to: "c" },
      { from: "b", to: "d" }, { from: "c", to: "d" },
    ]);
  });

  it("keeps a node whose dep is absent, but draws no edge to nowhere", () => {
    const g = buildGoalGraph([node("orphan", ["nope"]), node("a")]);
    expect(g.edges).toEqual([]);
    expect(keys(g.ranks.flat()).sort()).toEqual(["a", "orphan"]);
  });
});

describe("buildGoalGraph — gaps", () => {
  const at = (key: string, deps: string[], started: string, finished: string) =>
    node(key, deps, { startedAt: started, finishedAt: finished });

  it("names the days a plan sat idle between two ranks", () => {
    const g = buildGoalGraph([
      at("a", [], "2026-08-01T10:00:00.000Z", "2026-08-01T10:30:00.000Z"),
      at("b", ["a"], "2026-08-06T10:30:00.000Z", "2026-08-06T11:00:00.000Z"),
    ]);
    expect(g.gaps).toEqual([{ afterRank: 0, days: 5 }]);
  });

  it("says nothing about a wait shorter than a day", () => {
    const g = buildGoalGraph([
      at("a", [], "2026-08-01T10:00:00.000Z", "2026-08-01T10:30:00.000Z"),
      at("b", ["a"], "2026-08-02T09:00:00.000Z", "2026-08-02T09:30:00.000Z"),
    ]);
    expect(g.gaps).toEqual([]);
  });

  it("measures from the LAST finish of a rank to the FIRST start of the next", () => {
    // b finishes long after c; the wait d actually endured starts there.
    const g = buildGoalGraph([
      at("a", [], "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z"),
      at("b", ["a"], "2026-08-01T01:00:00.000Z", "2026-08-04T00:00:00.000Z"),
      at("c", ["a"], "2026-08-01T01:00:00.000Z", "2026-08-01T02:00:00.000Z"),
      at("d", ["b", "c"], "2026-08-06T00:00:00.000Z", "2026-08-06T01:00:00.000Z"),
    ]);
    expect(g.gaps).toEqual([{ afterRank: 1, days: 2 }]);
  });

  it("stays silent when a rank has no usable timestamps", () => {
    expect(buildGoalGraph(CHAIN).gaps).toEqual([]);
  });
});

describe("cardXY", () => {
  it("centres a lone lane in its container", () => {
    expect(cardXY({ rank: 0, lane: 0 }, 1, 400)).toEqual({ x: (400 - CARD.w) / 2, y: 0 });
  });

  it("spaces lanes by one card plus the gutter", () => {
    const row = [0, 1, 2].map((lane) => cardXY({ rank: 1, lane }, 3, 800).x);
    expect(row[1] - row[0]).toBe(CARD.w + CARD.gapX);
    expect(row[2] - row[1]).toBe(CARD.w + CARD.gapX);
  });

  it("stacks ranks by one card plus the vertical gutter", () => {
    expect(cardXY({ rank: 2, lane: 0 }, 1, 400).y).toBe(2 * (CARD.h + CARD.gapY));
  });

  it("never pushes the first lane off the left edge of a narrow container", () => {
    expect(cardXY({ rank: 0, lane: 0 }, 3, 100).x).toBe(0);
  });
});

describe("edgePath", () => {
  it("leaves and arrives vertically, as one cubic", () => {
    const d = edgePath({ x: 10, y: 0 }, { x: 90, y: 100 });
    expect(d).toBe("M 10 0 C 10 50, 90 50, 90 100");
  });
});

describe("edgeToken", () => {
  const st = (status: string) => edgeToken(node("n", [], { status }));

  it("colours the line into a running node as now", () => {
    expect(st("running")).toBe("var(--color-now)");
    expect(st("working")).toBe("var(--color-now)");
  });

  it("colours the line into a node that needs a human as accent", () => {
    expect(st("failed")).toBe("var(--color-accent)");
    expect(st("needs-review")).toBe("var(--color-accent)");
  });

  it("colours a carried edge as past", () => {
    expect(st("done")).toBe("var(--color-past)");
  });

  it("leaves an edge that has not carried anything as plain structure", () => {
    expect(st("pending")).toBe("var(--color-line)");
  });

  it("never emits a raw colour — the theme has to be able to move it", () => {
    for (const s of ["running", "failed", "done", "pending", "skipped", "who-knows"]) {
      expect(st(s).startsWith("var(--color-")).toBe(true);
    }
  });
});
