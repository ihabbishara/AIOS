// ui2/test/goal-kanban.test.tsx — lanes render, done lane caps at 10 with Show all.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { GoalList } from "../src/views/Goals.js";
import { stubApi } from "./stubs.js";

afterEach(cleanup);

const goal = (over: Record<string, unknown>) => ({
  id: "g", slug: "g", title: "t", department: "ops", lead: "hermes", originChannel: "web",
  status: "done", planSummary: "", replansUsed: 0, error: null,
  createdAt: "2026-07-15T08:00:00.000Z", updatedAt: "2026-07-15T08:00:00.000Z",
  projectDir: null, goalDir: null,
  nodes: [{ key: "a", label: "a", agent: "hermes", brief: "", deps: [], status: "done", costCents: 10, rounds: 1, error: null, artifact: null }],
  ...over,
});

describe("Goals kanban", () => {
  it("renders three lanes, caps Done at 10, Show all expands", async () => {
    stubApi({
      "/api/goals": [
        goal({ id: "g1", slug: "g1", title: "Failed goal", status: "failed", department: "eng", lead: "athena" }),
        ...Array.from({ length: 12 }, (_, i) => goal({ id: `d${i}`, slug: `d${i}`, title: `Done goal ${i}` })),
      ],
    });
    render(<GoalList events={[]} />);
    expect((await screen.findAllByText(/Needs you/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Running/)).length).toBeGreaterThan(0);
    expect(await screen.findByText("Failed goal")).toBeTruthy();
    expect(screen.queryByText("Done goal 11")).toBeNull(); // capped at 10
    fireEvent.click(await screen.findByText(/Show all 12/));
    expect(await screen.findByText("Done goal 11")).toBeTruthy();
  });
});
