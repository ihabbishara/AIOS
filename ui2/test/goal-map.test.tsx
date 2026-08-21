// ui2/test/goal-map.test.tsx — the map draws only what the plan earns: no
// geometry for one node, a spine for a chain, an SVG only for a real branch.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { GoalMap } from "../src/views/goal/GoalMap.js";
import type { GoalNodeView } from "../src/api.js";

afterEach(cleanup);

const node = (key: string, deps: string[] = [], over: Partial<GoalNodeView> = {}): GoalNodeView => ({
  key, type: "run", agent: "clio", critic: null, brief: "", deps,
  status: "done", costCents: 0, rounds: 1, artifact: null, error: null,
  startedAt: "2026-08-03T10:00:00.000Z", finishedAt: "2026-08-03T10:14:00.000Z", ...over,
});

const CHAIN = [node("a"), node("b", ["a"]), node("c", ["b"])];
const DIAMOND = [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])];

describe("GoalMap — fidelity", () => {
  it("renders nothing at all for an empty node list", () => {
    const { container } = render(<GoalMap nodes={[]} />);
    expect(container.textContent).toBe("");
  });

  it("draws a lone node as one card, with no geometry around it", () => {
    const { container } = render(<GoalMap nodes={[node("only")]} />);
    expect(screen.getAllByTestId("map-node")).toHaveLength(1);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryAllByTestId("map-link")).toHaveLength(0);
  });

  it("draws a chain as a spine — one link between each pair, still no SVG", () => {
    const { container } = render(<GoalMap nodes={CHAIN} />);
    const cards = screen.getAllByTestId("map-node");
    expect(cards.map((c) => c.dataset.key)).toEqual(["a", "b", "c"]);
    expect(screen.getAllByTestId("map-link")).toHaveLength(2);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("draws a branch as an SVG, one path per dep edge", () => {
    const { container } = render(<GoalMap nodes={DIAMOND} />);
    expect(screen.getAllByTestId("map-node")).toHaveLength(4);
    const paths = container.querySelectorAll("svg path");
    expect(paths).toHaveLength(4);
    for (const p of paths) {
      expect(p.getAttribute("d")?.startsWith("M ")).toBe(true);
      expect(p.getAttribute("fill")).toBe("none");
    }
  });

  it("strokes every edge with a token, never a literal colour", () => {
    // SVG cannot take a Tailwind utility, so this is the one place the theme
    // could quietly be hard-coded out of the picture.
    const { container } = render(<GoalMap nodes={DIAMOND} />);
    for (const p of container.querySelectorAll("svg path")) {
      expect(p.getAttribute("stroke")?.startsWith("var(--color-")).toBe(true);
    }
    for (const l of render(<GoalMap nodes={CHAIN} />).container.querySelectorAll("[data-testid=map-link]")) {
      expect((l as HTMLElement).style.background.startsWith("var(--color-")).toBe(true);
    }
  });

  it("keeps the SVG out of the way of the cards", () => {
    const { container } = render(<GoalMap nodes={DIAMOND} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("class")).toContain("pointer-events-none");
  });
});

describe("GoalMap — selection", () => {
  it("calls onSelect with the node key when a card is clicked", () => {
    const picked: string[] = [];
    render(<GoalMap nodes={CHAIN} onSelect={(k) => picked.push(k)} />);
    fireEvent.click(screen.getAllByTestId("map-node")[1]);
    expect(picked).toEqual(["b"]);
  });

  it("selects with the keyboard, and puts the card in the tab order to allow it", () => {
    const picked: string[] = [];
    render(<GoalMap nodes={DIAMOND} onSelect={(k) => picked.push(k)} />);
    const card = screen.getAllByTestId("map-node")[2];
    expect(card.getAttribute("role")).toBe("button");
    expect(card.tabIndex).toBe(0);
    fireEvent.keyDown(card, { key: "Enter" });
    expect(picked).toEqual([card.dataset.key]);
  });

  it("leaves a read-only map out of the tab order entirely", () => {
    render(<GoalMap nodes={CHAIN} />);
    for (const card of screen.getAllByTestId("map-node")) {
      expect(card.getAttribute("role")).toBeNull();
      expect(card.getAttribute("tabindex")).toBeNull();
    }
  });

  it("rings the selected card, and only that one", () => {
    render(<GoalMap nodes={CHAIN} selectedKey="b" onSelect={() => {}} />);
    const [a, b] = screen.getAllByTestId("map-node");
    expect(b.className).toContain("border-dim");
    expect(b.className).not.toContain("border-line");
    expect(a.className).toContain("border-line");
  });
});

describe("GoalMap — what a card says", () => {
  it("breathes a running node only while the stream is actually live", () => {
    const running = [node("a"), node("b", ["a"], { status: "running", finishedAt: null })];
    const live = render(<GoalMap nodes={running} live />);
    expect(live.container.querySelectorAll("[data-testid=map-dot]")[1].className).toContain("breath");
    cleanup();
    const dead = render(<GoalMap nodes={running} live={false} />);
    for (const dot of dead.container.querySelectorAll("[data-testid=map-dot]")) {
      expect(dot.className).not.toContain("breath");
    }
  });

  it("shows the first line of an error, not the whole trace", () => {
    render(<GoalMap nodes={[node("a", [], { status: "failed", error: "ENOENT vault/notes\n  at fs.read" })]} />);
    expect(screen.getByText("ENOENT vault/notes")).toBeTruthy();
    expect(screen.queryByText(/at fs\.read/)).toBeNull();
  });

  it("shows the agent, the type glyph, elapsed and cost", () => {
    render(<GoalMap nodes={[node("a", [], { agent: "vulcan", type: "loop", critic: "momus", costCents: 44 })]} />);
    expect(screen.getByText("vul")).toBeTruthy();     // Avatar initials
    expect(screen.getByText("⟳")).toBeTruthy();
    expect(screen.getByText("momus")).toBeTruthy();   // critic badge
    expect(screen.getByText("14m")).toBeTruthy();
    expect(screen.getByText("$0.44")).toBeTruthy();
  });

  it("names no critic when the node has none", () => {
    render(<GoalMap nodes={[node("a")]} />);
    expect(screen.getAllByTestId("map-node")[0].textContent).not.toContain("null");
  });

  it("marks the failedKey card as blocked even when its own status is not", () => {
    render(<GoalMap nodes={CHAIN} failedKey="c" />);
    const dots = screen.getAllByTestId("map-dot");
    expect(dots[0].className).toContain("bg-past");
    expect(dots[2].className).toContain("bg-accent");
  });
});

describe("GoalMap — gaps", () => {
  it("says how long the plan sat idle between two steps", () => {
    render(<GoalMap nodes={[
      node("a", [], { startedAt: "2026-08-01T10:00:00.000Z", finishedAt: "2026-08-01T10:30:00.000Z" }),
      node("b", ["a"], { startedAt: "2026-08-06T10:30:00.000Z", finishedAt: "2026-08-06T11:00:00.000Z" }),
    ]} />);
    expect(screen.getByText("5 days later")).toBeTruthy();
  });

  it("says nothing when the next step picked straight up", () => {
    render(<GoalMap nodes={CHAIN} />);
    expect(screen.queryByText(/later/)).toBeNull();
  });

  it("carries the gap into the branch layout too", () => {
    render(<GoalMap nodes={[
      node("a", [], { startedAt: "2026-08-01T10:00:00.000Z", finishedAt: "2026-08-01T10:30:00.000Z" }),
      node("b", ["a"], { startedAt: "2026-08-06T10:30:00.000Z", finishedAt: "2026-08-06T11:00:00.000Z" }),
      node("c", ["a"], { startedAt: "2026-08-06T10:30:00.000Z", finishedAt: "2026-08-06T11:00:00.000Z" }),
    ]} />);
    expect(screen.getByText("5 days later")).toBeTruthy();
  });
});
