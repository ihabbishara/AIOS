// ui2/test/thread-render.test.tsx — the thread renders rows, not geometry.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Thread } from "../src/views/Thread.js";
import { CLOCK_TOKEN } from "../src/lib/goal-clock.js";
import type { GoalNodeView } from "../src/api.js";

afterEach(cleanup);

const node = (key: string, over: Partial<GoalNodeView> = {}): GoalNodeView => ({
  key, type: "task", agent: "clio", critic: null, brief: "", deps: [],
  status: "done", costCents: 0, rounds: 1, artifact: null, error: null,
  startedAt: "2026-08-03T10:00:00.000Z", finishedAt: "2026-08-03T10:14:00.000Z", ...over,
});

describe("Thread", () => {
  it("renders one row per node, in dependency order", () => {
    render(<Thread nodes={[node("second", { deps: ["first"] }), node("first")]} />);
    const rows = screen.getAllByTestId("thread-row");
    expect(rows.map((r) => r.dataset.key)).toEqual(["first", "second"]);
  });

  it("shows agent, elapsed and cost", () => {
    render(<Thread nodes={[node("a", { agent: "vulcan", costCents: 44 })]} />);
    expect(screen.getByText("vulcan")).toBeTruthy();
    expect(screen.getByText("14m")).toBeTruthy();
    expect(screen.getByText("$0.44")).toBeTruthy();
  });

  it("names an artifact when the node produced one", () => {
    render(<Thread nodes={[node("a", { artifact: "deck.html" })]} />);
    expect(screen.getByText("deck.html")).toBeTruthy();
  });

  it("breathes only the running row", () => {
    render(<Thread nodes={[node("a"), node("b", { status: "running", finishedAt: null })]} />);
    const dots = screen.getAllByTestId("thread-dot");
    expect(dots[0].className).not.toContain("breath");
    expect(dots[1].className).toContain("breath");
  });

  it("prints 'after:' only where the linear reading would mislead", () => {
    render(<Thread nodes={[node("a"), node("b", { deps: ["a"] }), node("join", { deps: ["a", "b"] })]} />);
    // b's only dep is the row above it — silent. join has two — named.
    expect(screen.queryByText(/after: a$/)).toBeNull();
    expect(screen.getByText("after: a, b")).toBeTruthy();
  });

  it("renders a single-node goal with no spine and no deps line", () => {
    render(<Thread nodes={[node("only")]} />);
    const rows = screen.getAllByTestId("thread-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].className).not.toContain("border-l");
    expect(screen.queryByText(/after:/)).toBeNull();
  });

  it("draws a spine when the goal has more than one node", () => {
    render(<Thread nodes={[node("a"), node("b")]} />);
    for (const row of screen.getAllByTestId("thread-row")) {
      expect(row.className).toContain("border-l");
    }
  });

  it("marks the failedKey row with the blocked tone, and only that row", () => {
    // Both nodes are "done" (clock: past) — failedKey is the only reason
    // either row could show blocked, so this proves the `||` in Thread does
    // independent work rather than merely agreeing with statusClock.
    render(<Thread nodes={[node("a"), node("b")]} failedKey="b" />);
    const dots = screen.getAllByTestId("thread-dot");
    expect(dots[0].className).toContain(CLOCK_TOKEN.past);
    expect(dots[0].className).not.toContain(CLOCK_TOKEN.blocked);
    expect(dots[1].className).toContain(CLOCK_TOKEN.blocked);
    expect(dots[1].className).not.toContain(CLOCK_TOKEN.past);
  });

  it("calls onSelect with the node key when a row is clicked", () => {
    const picked: string[] = [];
    render(<Thread nodes={[node("a"), node("b")]} onSelect={(k) => picked.push(k)} />);
    fireEvent.click(screen.getAllByTestId("thread-row")[1]);
    expect(picked).toEqual(["b"]);
  });

  it("selects with the keyboard, and puts the row in the tab order to allow it", () => {
    const picked: string[] = [];
    render(<Thread nodes={[node("a"), node("b")]} onSelect={(k) => picked.push(k)} />);
    const rows = screen.getAllByTestId("thread-row");
    expect(rows[1].getAttribute("role")).toBe("button");
    expect(rows[1].tabIndex).toBe(0);
    fireEvent.keyDown(rows[1], { key: "Enter" });
    expect(picked).toEqual(["b"]);
  });

  it("leaves a read-only thread out of the tab order entirely", () => {
    render(<Thread nodes={[node("a"), node("b")]} />);
    for (const row of screen.getAllByTestId("thread-row")) {
      expect(row.getAttribute("role")).toBeNull();
      expect(row.getAttribute("tabindex")).toBeNull();
    }
  });

  it("renders nothing at all for an empty node list", () => {
    const { container } = render(<Thread nodes={[]} />);
    expect(container.textContent).toBe("");
  });
});
