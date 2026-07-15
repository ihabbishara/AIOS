// test/dag-layout.test.ts — pure layout math for the goals DAG canvas.
import { describe, it, expect } from "vitest";
import { layoutDag, BOX_W, BOX_H, GAP_X, GAP_Y, PAD } from "../ui2/src/views/dag-layout.js";

describe("layoutDag", () => {
  it("lays a linear chain into consecutive layers, one row each", () => {
    const l = layoutDag([
      { key: "a", deps: [] },
      { key: "b", deps: ["a"] },
      { key: "c", deps: ["b"] },
    ]);
    expect(l.boxes.map((b) => [b.key, b.layer, b.row])).toEqual([["a", 0, 0], ["b", 1, 0], ["c", 2, 0]]);
    expect(l.edges).toHaveLength(2);
    expect(l.height).toBe(PAD * 2 + BOX_H);
  });

  it("lays a diamond: parallel nodes share a layer with distinct rows", () => {
    const l = layoutDag([
      { key: "a", deps: [] },
      { key: "b", deps: ["a"] },
      { key: "c", deps: ["a"] },
      { key: "d", deps: ["b", "c"] },
    ]);
    const at = (k: string) => l.boxes.find((b) => b.key === k)!;
    expect([at("a").layer, at("b").layer, at("c").layer, at("d").layer]).toEqual([0, 1, 1, 2]);
    expect([at("b").row, at("c").row]).toEqual([0, 1]);
    expect(l.edges).toHaveLength(4);
    expect(l.width).toBe(PAD * 2 + 3 * BOX_W + 2 * GAP_X);
    expect(l.height).toBe(PAD * 2 + 2 * BOX_H + GAP_Y);
  });

  it("positions boxes on the layer/row grid", () => {
    const l = layoutDag([{ key: "a", deps: [] }, { key: "b", deps: ["a"] }]);
    const b = l.boxes.find((x) => x.key === "b")!;
    expect(b.x).toBe(PAD + BOX_W + GAP_X);
    expect(b.y).toBe(PAD);
  });

  it("emits SVG bezier paths from dep box to node box", () => {
    const l = layoutDag([{ key: "a", deps: [] }, { key: "b", deps: ["a"] }]);
    expect(l.edges[0].from).toBe("a");
    expect(l.edges[0].to).toBe("b");
    expect(l.edges[0].path).toMatch(/^M [\d.]+ [\d.]+ C /);
  });

  it("ignores unknown deps (no edge, layer 0)", () => {
    const l = layoutDag([{ key: "a", deps: ["ghost"] }]);
    expect(l.boxes[0].layer).toBe(0);
    expect(l.edges).toHaveLength(0);
  });

  it("terminates on a (theoretically impossible) cycle", () => {
    const l = layoutDag([{ key: "a", deps: ["b"] }, { key: "b", deps: ["a"] }]);
    expect(l.boxes).toHaveLength(2);
    expect(l.boxes.every((b) => Number.isFinite(b.layer))).toBe(true);
  });
});
