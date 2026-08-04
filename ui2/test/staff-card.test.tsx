// ui2/test/staff-card.test.tsx — the org card leads with aliveness (spec 2026-08-04 §2).
//
// NOTE: these drive the real Staff view, which fetches. Assertions run after the
// data has landed — asserting straight off the first findBy* passes against
// broken code, because the first render still has `data === undefined`.
// setSystemTime ALONE, never useFakeTimers: fake timers starve React's scheduler
// and findBy* never resolves.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";
import { Staff } from "../src/views/Staff.js";
import { stubApi } from "./stubs.js";
import type { OrgAgentCard, OrgDepartmentView } from "../src/api.js";

beforeEach(() => vi.setSystemTime(new Date("2026-08-04T12:00:00.000Z")));
afterEach(() => { cleanup(); vi.useRealTimers(); });

const card = (over: Partial<OrgAgentCard> = {}): OrgAgentCard => ({
  name: "vulcan", title: "Senior Engineer", charter: "c", visibility: "shared",
  guarded: false, status: "idle", currentTask: null, costTodayUsd: 0,
  lastActiveAt: "2026-08-02", costUsd: 45.94, nodes: 20, goalsLed: 0, mail: 6, ...over,
});

const dept = (agents: OrgAgentCard[]): OrgDepartmentView => ({
  department: "engineering", mission: "Build software safely.", lead: "athena",
  memoDomain: "code", sandbox: true, actions: [], agents,
});

/** Renders Staff at #/staff and drives past the fetch, so a card is really on screen. */
async function mount(agents: OrgAgentCard[]) {
  stubApi({
    "/api/org": [dept(agents)],
    "/api/mail/unread": { total: 0, byAgent: {}, pendingUser: 0, userInbox: 0 },
    "/api/packs": [],
    "/api/state": { capabilities: [] },
    "/api/agents/retired": [],
  });
  await act(async () => {
    render(
      <Staff
        events={[]}
        route={{ section: "staff", parts: [], query: new URLSearchParams() }}
        onOpenChat={() => {}}
      />,
    );
  });
  // Gate on the testid, not the name: Avatar renders name.slice(0,3), so a
  // three-letter agent ("neo") matches its own label twice.
  await screen.findAllByTestId("staff-clock");
}

describe("Staff org card", () => {
  it("says how recently the agent worked, and what it has produced over its life", async () => {
    await mount([card()]);
    expect(screen.getByText("2 days ago")).toBeTruthy();
    expect(screen.getByText("20 nodes · 6 mail · $45.94")).toBeTruthy();
    expect(screen.getByTestId("staff-clock").dataset.clock).toBe("recent");
  });

  it("separates an agent that went quiet from one that never ran", async () => {
    await mount([
      card({ name: "odin", lastActiveAt: "2026-07-26", costUsd: 480.52, nodes: 20, mail: 1 }),
      card({ name: "juno", lastActiveAt: null, costUsd: 0, nodes: 0, mail: 0 }),
    ]);
    const [odin, juno] = screen.getAllByTestId("staff-clock");
    expect(odin.dataset.clock).toBe("stale");
    expect(juno.dataset.clock).toBe("never");
    // The distinction cost-today cannot make: both would read "$0 today".
    expect(screen.getByText("9 days ago")).toBeTruthy();
    expect(screen.getByText("never run")).toBeTruthy();
    expect(screen.getByText("hired, never run")).toBeTruthy();
  });

  it("leads with goals for an agent that delegates rather than executes", async () => {
    await mount([
      card({ name: "neo", lastActiveAt: "2026-07-20", goalsLed: 9, nodes: 1, mail: 13, costUsd: 0.38 }),
    ]);
    expect(screen.getByText("9 goals led · 1 nodes · 13 mail · $0.38")).toBeTruthy();
  });

  it("shows spend with no output rather than hiding it behind a zero", async () => {
    // minos: $23.51 over 46 runs with no nodes, no mail and no goals. The absence
    // is the finding, so the card must not fall back to "hired, never run".
    await mount([
      card({ name: "minos", lastActiveAt: "2026-07-31", costUsd: 23.51, nodes: 0, mail: 0, goalsLed: 0 }),
    ]);
    expect(screen.getByText("$23.51")).toBeTruthy();
    expect(screen.queryByText("hired, never run")).toBeNull();
  });

  it("breathes only for a run happening now, not for merely-recent activity", async () => {
    await mount([
      card({ name: "vulcan", status: "working", currentTask: "chat:telegram:42" }),
      card({ name: "argus", status: "idle" }),
    ]);
    const [working, idle] = screen.getAllByTestId("staff-clock");
    expect(working.className).toContain("breath");
    expect(idle.className).not.toContain("breath"); // recent, but nothing is running
  });
});
