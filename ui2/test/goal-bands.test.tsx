// ui2/test/goal-bands.test.tsx — recency bands replace the kanban lanes.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { GoalList } from "../src/views/Goals.js";
import { stubApi } from "./stubs.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const goal = (over: Record<string, unknown>) => ({
  id: "g", slug: "g", title: "t", department: "ops", lead: "neo", originChannel: "web",
  status: "done", planSummary: "", replansUsed: 0, error: null,
  createdAt: "2026-08-03T09:00:00.000Z", updatedAt: "2026-08-03T09:00:00.000Z",
  projectDir: null, goalDir: null,
  nodes: [{
    key: "a", type: "task", agent: "neo", critic: null, brief: "", deps: [],
    status: "done", costCents: 10, rounds: 1, artifact: null, error: null,
    startedAt: "2026-08-03T09:00:00.000Z", finishedAt: "2026-08-03T09:03:00.000Z",
  }],
  ...over,
});

/** Pin the clock so band boundaries are deterministic. `vi.useFakeTimers()` also fakes
 *  setTimeout/setInterval/MessageChannel scheduling, which starves React's own scheduler and
 *  testing-library's real-timer `findBy` polling of the tick they need to flush a fetch-driven
 *  re-render — every `findByText` below would hang to the outer test timeout. `setSystemTime`
 *  alone pins `Date`/`Date.now()` (all `bandOf` needs) without touching the timer queue. */
const at = (iso: string) => { vi.setSystemTime(new Date(iso)); };

describe("Goals bands", () => {
  it("omits the LIVE band entirely when nothing is live", async () => {
    at("2026-08-03T14:00:00.000Z");
    stubApi({ "/api/goals": [goal({ id: "d1", slug: "d1", title: "Finished thing" })] });
    render(<GoalList events={[]} />);
    expect(await screen.findByText("Finished thing")).toBeTruthy();
    expect(screen.queryByText("Live")).toBeNull();
  });

  it("shows a running goal under LIVE", async () => {
    at("2026-08-03T14:00:00.000Z");
    stubApi({ "/api/goals": [goal({ id: "r1", slug: "r1", title: "Running thing", status: "running" })] });
    render(<GoalList events={[]} />);
    expect(await screen.findByText("Running thing")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("keeps an OLD failed goal in NEEDS YOU rather than burying it", async () => {
    at("2026-08-03T14:00:00.000Z");
    stubApi({ "/api/goals": [
      goal({ id: "f1", slug: "f1", title: "Old failure", status: "failed", createdAt: "2026-01-02T09:00:00.000Z" }),
    ] });
    render(<GoalList events={[]} />);
    expect(await screen.findByText("Old failure")).toBeTruthy();
    expect(screen.getByText("Needs you")).toBeTruthy();
    // LIVE and NEEDS are two bands, not one — an old failure must not also
    // render a "Live" header over it.
    expect(screen.queryByText("Live")).toBeNull();
  });

  it("splits finished goals across TODAY / THIS WEEK / EARLIER", async () => {
    at("2026-08-03T14:00:00.000Z");
    stubApi({ "/api/goals": [
      goal({ id: "a", slug: "a", title: "From today", createdAt: "2026-08-03T09:00:00.000Z" }),
      goal({ id: "b", slug: "b", title: "From this week", createdAt: "2026-07-30T09:00:00.000Z" }),
      goal({ id: "c", slug: "c", title: "From long ago", createdAt: "2026-06-01T09:00:00.000Z" }),
    ] });
    render(<GoalList events={[]} />);
    expect(await screen.findByText("Today")).toBeTruthy();
    expect(screen.getByText("This week")).toBeTruthy();
    expect(screen.getByText("Earlier")).toBeTruthy();
  });

  it("shows every goal — there is no Done cap any more", async () => {
    at("2026-08-03T14:00:00.000Z");
    stubApi({ "/api/goals": Array.from({ length: 12 }, (_, i) =>
      goal({ id: `d${i}`, slug: `d${i}`, title: `Done goal ${i}` })) });
    render(<GoalList events={[]} />);
    expect(await screen.findByText("Done goal 11")).toBeTruthy();
    expect(screen.queryByText(/Show all/)).toBeNull();
  });

  it("names the artifacts a goal produced", async () => {
    at("2026-08-03T14:00:00.000Z");
    stubApi({ "/api/goals": [goal({
      id: "a", slug: "a", title: "Made a deck",
      nodes: [{
        key: "a", type: "task", agent: "vulcan", critic: null, brief: "", deps: [],
        status: "done", costCents: 10, rounds: 1, artifact: "deck.html", error: null,
        startedAt: "2026-08-03T09:00:00.000Z", finishedAt: "2026-08-03T09:03:00.000Z",
      }],
    })] });
    render(<GoalList events={[]} />);
    expect(await screen.findByText("deck.html")).toBeTruthy();
  });

  it("filters by title substring", async () => {
    at("2026-08-03T14:00:00.000Z");
    stubApi({ "/api/goals": [
      goal({ id: "a", slug: "a", title: "Investor deck" }),
      goal({ id: "b", slug: "b", title: "Market analysis" }),
    ] });
    render(<GoalList events={[]} />);
    const box = await screen.findByPlaceholderText("filter…");
    fireEvent.change(box, { target: { value: "deck" } });
    expect(screen.getByText("Investor deck")).toBeTruthy();
    expect(screen.queryByText("Market analysis")).toBeNull();
  });
});
