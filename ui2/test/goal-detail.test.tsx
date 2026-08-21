// ui2/test/goal-detail.test.tsx — detail view: map, inspector, ask box.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Goals } from "../src/views/Goals.js";
import { stubApi } from "./stubs.js";
import { CLOCK_TEXT, statusClock } from "../src/lib/goal-clock.js";

afterEach(cleanup);

const NODE = {
  key: "build-deck", type: "task", agent: "vulcan", critic: null, brief: "Build it", deps: [],
  status: "done", costCents: 44, rounds: 1, artifact: "deck.html", error: null,
  startedAt: "2026-08-03T10:00:00.000Z", finishedAt: "2026-08-03T10:22:00.000Z",
};

const DETAIL = {
  id: "g1", slug: "deck", title: "Render the deck", department: "engineering", lead: "atlas",
  originChannel: "web", status: "done", planSummary: "Two steps", replansUsed: 0, error: null,
  createdAt: "2026-08-03T09:00:00.000Z", updatedAt: "2026-08-03T10:22:00.000Z",
  projectDir: null, goalDir: "/g", nodes: [NODE],
  artifacts: [{ file: "deck.html", content: "<h1>hi</h1>" }],
  spawnedBy: null, awaitingUserAsk: null,
};

const route = { section: "goals" as const, parts: ["deck"], query: new URLSearchParams() };

describe("Goal detail", () => {
  it("renders the map and the inspector for the node", async () => {
    stubApi({ "/api/goals/deck": DETAIL });
    render(<Goals events={[]} route={route} onOpenChat={() => {}} />);
    expect(await screen.findByText("Render the deck")).toBeTruthy();
    expect(screen.getAllByTestId("map-node")).toHaveLength(1);
    expect(screen.getByText("Build it")).toBeTruthy();   // inspector brief
    expect(screen.getByText("22m")).toBeTruthy();        // card elapsed
  });

  it("surfaces the question when a goal is awaiting the user", async () => {
    stubApi({ "/api/goals/deck": {
      ...DETAIL, status: "awaiting-mail",
      awaitingUserAsk: { mailId: "m1", question: "Which repo?", from: "clio" },
    } });
    render(<Goals events={[]} route={route} onOpenChat={() => {}} />);
    expect(await screen.findByText("Which repo?")).toBeTruthy();
    expect(screen.getByPlaceholderText(/Your answer resumes the goal/)).toBeTruthy();
  });

  it("shows the node error when one failed", async () => {
    stubApi({ "/api/goals/deck": {
      ...DETAIL, status: "failed",
      nodes: [{ ...NODE, status: "failed", error: "ENOENT vault/notes" }],
    } });
    render(<Goals events={[]} route={route} onOpenChat={() => {}} />);
    // Twice over: the card carries the first line so the failure is visible
    // without a click, and the inspector carries the whole thing.
    expect(await screen.findAllByText("ENOENT vault/notes")).toHaveLength(2);
  });

  it("renders goal and node status on the clock axis, not Command Deck tone", async () => {
    // Distinct goal vs. node statuses, and neither equal to "done", so the
    // header's status text can never collide with the inspector's/card's —
    // each assertion below targets an unambiguous element.
    stubApi({ "/api/goals/deck": {
      ...DETAIL, status: "running",
      nodes: [{ ...NODE, status: "needs-review" }],
    } });
    render(<Goals events={[]} route={route} onOpenChat={() => {}} />);

    const goalStatusEl = await screen.findByText("running");
    expect(goalStatusEl.className).toContain(CLOCK_TEXT[statusClock("running")]);

    // "needs-review" renders twice (map card + inspector); both must carry
    // the clock class — a reverted inspector would leave one without it.
    const nodeStatusEls = screen.getAllByText("needs-review");
    expect(nodeStatusEls.length).toBeGreaterThan(0);
    for (const el of nodeStatusEls) {
      expect(el.className).toContain(CLOCK_TEXT[statusClock("needs-review")]);
    }
  });
  it("an artifact opens in the Reader from its card, with the on-disk path", async () => {
    stubApi({ "/api/goals/deck": DETAIL });
    render(<Goals events={[]} route={route} onOpenChat={() => {}} />);
    const card = (await screen.findAllByTestId("artifact-card"))[0];
    fireEvent.click(card);
    const reader = await screen.findByTestId("reader");
    expect(reader.textContent).toContain("deck.html");
    expect(screen.getByTitle("/g/deck.html")).toBeTruthy(); // where it lives, in the header
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("reader")).toBeNull();
  });

  it("the goal dir is named in the detail — where the files live, copyable", async () => {
    stubApi({ "/api/goals/deck": DETAIL });
    render(<Goals events={[]} route={route} onOpenChat={() => {}} />);
    expect((await screen.findByTestId("goal-dir")).textContent).toContain("/g");
  });

  it("the node detail reads BELOW the map as prose, long briefs collapsed behind a control", async () => {
    const longBrief = "Read these documents.\n\n1. First source\n2. Second source\n\n" + "Detail sentence. ".repeat(40);
    const detail = { ...DETAIL, nodes: [{ ...NODE, brief: longBrief }] };
    stubApi({ "/api/goals/deck": detail });
    const { container } = render(<Goals events={[]} route={route} onOpenChat={() => {}} />);
    const panel = await screen.findByTestId("node-detail");
    // below the map, not beside it: the panel is a sibling AFTER the map container
    const map = container.querySelector('[data-testid="map-node"]')!;
    expect(map.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // markdown, not a text wall: the numbered list became a real <ol>
    expect(panel.querySelector(".reader-prose ol")).toBeTruthy();
    // collapsed by default, expandable
    expect(screen.getByTestId("brief-prose").className).toContain("max-h-32");
    fireEvent.click(screen.getByTestId("brief-toggle"));
    expect(screen.getByTestId("brief-prose").className).not.toContain("max-h-32");
  });
});
