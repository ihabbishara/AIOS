// ui2/test/goal-detail.test.tsx — detail view: thread, inspector, ask box.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Goals } from "../src/views/Goals.js";
import { stubApi } from "./stubs.js";

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
  it("renders the thread and the inspector for the node", async () => {
    stubApi({ "/api/goals/deck": DETAIL });
    render(<Goals events={[]} route={route} onOpenChat={() => {}} />);
    expect(await screen.findByText("Render the deck")).toBeTruthy();
    expect(screen.getAllByTestId("thread-row")).toHaveLength(1);
    expect(screen.getByText("Build it")).toBeTruthy();   // inspector brief
    expect(screen.getByText("22m")).toBeTruthy();        // thread elapsed
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
    expect(await screen.findByText("ENOENT vault/notes")).toBeTruthy();
  });
});
