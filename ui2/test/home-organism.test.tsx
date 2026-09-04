// ui2/test/home-organism.test.tsx — Home's own claims: it states what is true,
// it opens the queue on `q`, and it goes still when the stream dies.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Home } from "../src/views/Home.js";
import { stubApi } from "./stubs.js";
import type { AttentionItem } from "../src/api.js";

afterEach(cleanup);

const ORG = [{
  department: "engineering", mission: "m", lead: "atlas",
  memoDomain: "engineering", sandbox: false, actions: [],
  agents: [
    { name: "atlas", title: "T", charter: "c", visibility: "shared", guarded: false,
      status: "working", currentTask: "node 3/5", costTodayUsd: 0 },
    { name: "vulcan", title: "T", charter: "c", visibility: "shared", guarded: false,
      status: "idle", currentTask: null, costTodayUsd: 0 },
  ],
}];

const SCHEDULE = {
  anchors: [{ name: "morning", hhmm: "08:00", overridden: false, firedToday: false }],
  routines: [], reminders: [],
};

const HEALTH = {
  uptimeMs: 22_320_000, voice: false, senses: [], sseClients: 1,
  dbBytes: 0, policyMode: "audit", policyViolations: 0,
};

const approval: AttentionItem = {
  kind: "approval", id: "a1", title: "Send weekly report", meta: "email.draft",
  severity: 1, ts: "2026-08-02T09:00:00.000Z", actions: ["approve", "reject", "open"], ref: { actionId: "a1" },
};

const IDLE_ORG = [{ ...ORG[0], agents: ORG[0].agents.map((a) => ({ ...a, status: "idle", currentTask: null })) }];

/** Dated off the wall clock, not a fixture date: the offer's own copy counts days
 *  from today, so a frozen timestamp would drift into a different sentence. */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const FAILED_GOAL = {
  id: "g-audit", slug: "ship-the-audit", title: "Ship the audit", department: "engineering",
  lead: "vulcan", originChannel: "web", status: "failed", planSummary: "", replansUsed: 0,
  error: "boom", createdAt: daysAgo(9), updatedAt: daysAgo(5),
  projectDir: null, goalDir: null, nodes: [],
};

const NO_UNREAD = { total: 0, byAgent: {}, pendingUser: 0, userInbox: 0 };

function stubAll() {
  stubApi({
    "/api/org": ORG,
    "/api/schedule": SCHEDULE,
    "/api/budget": { date: "2026-08-02", spentCents: 214, capCents: null },
    "/api/health": HEALTH,
    "/api/mail/mine": { threads: [] },
    "/api/goals": [],
    "/api/mail/unread": NO_UNREAD,
  });
}

/** stubAll with nothing running, so the tide settles at low and the rest state renders. */
function stubResting(routes: Record<string, unknown> = {}) {
  stubApi({
    "/api/org": IDLE_ORG,
    "/api/schedule": SCHEDULE,
    "/api/budget": { date: "2026-08-02", spentCents: 0, capCents: null },
    "/api/health": HEALTH,
    "/api/mail/mine": { threads: [] },
    "/api/goals": [],
    "/api/mail/unread": NO_UNREAD,
    ...routes,
  });
}

describe("Home — Organism", () => {
  it("states how many are working and how many need you", async () => {
    stubAll();
    render(<Home events={[]} attention={[approval]} connected={true} coordinator="nova" onOpenChat={() => {}} />);
    expect(await screen.findByText(/One is working/)).toBeTruthy();
    expect(screen.getByText(/One thing needs you/)).toBeTruthy();
  });

  it("says Resting when nothing is running", async () => {
    stubApi({
      "/api/org": [{ ...ORG[0], agents: ORG[0].agents.map((a) => ({ ...a, status: "idle", currentTask: null })) }],
      "/api/schedule": SCHEDULE,
      "/api/budget": { date: "2026-08-02", spentCents: 0, capCents: null },
      "/api/health": HEALTH,
      "/api/mail/mine": { threads: [] },
    });
    render(<Home events={[]} attention={[]} connected={true} coordinator="nova" onOpenChat={() => {}} />);
    expect(await screen.findByText("Resting.")).toBeTruthy();
    expect(screen.getByText("Nothing needs you.")).toBeTruthy();
  });

  it("opens the queue sheet on q and closes it on escape", async () => {
    stubAll();
    render(<Home events={[]} attention={[approval]} connected={true} coordinator="nova" onOpenChat={() => {}} />);
    await screen.findByText(/One is working/);
    // The dock chip carries the same title, so presence of the text proves
    // nothing. The row's action buttons only exist inside the sheet.
    expect(screen.queryByText("Approve")).toBeNull();
    fireEvent.keyDown(window, { key: "q" });
    expect(screen.getAllByText("Approve").length).toBeGreaterThan(0);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Approve")).toBeNull();
  });

  it("goes completely still when the stream is down", async () => {
    const MOTION = ".breath, .approach, .travel, .rest-pulse";
    stubAll();
    const busy = render(<Home events={[]} attention={[]} connected={false} coordinator="nova" onOpenChat={() => {}} />);
    await screen.findByText(/One is working/);
    expect(busy.container.querySelectorAll(MOTION)).toHaveLength(0);
    cleanup();

    // The resting org is where the selector has teeth: rest-pulse exists only at the
    // low tide, so the busy render above could never have matched it either way.
    stubResting();
    const alive = render(<Home events={[]} attention={[]} connected={true} coordinator="nova" onOpenChat={() => {}} />);
    await screen.findByText("Resting.");
    // Named, not just counted: .approach can fire off the schedule at some hours, so
    // a bare MOTION count would pass even if rest-pulse never rendered at all.
    expect(alive.container.querySelectorAll(".rest-pulse").length).toBeGreaterThan(0);
    cleanup();

    stubResting();
    const dead = render(<Home events={[]} attention={[]} connected={false} coordinator="nova" onOpenChat={() => {}} />);
    await screen.findByText("Resting.");
    expect(dead.container.querySelectorAll(MOTION)).toHaveLength(0);
  });

  it("surfaces what an idle agent could do, and takes you there", async () => {
    window.location.hash = "";
    stubResting({ "/api/goals": [FAILED_GOAL] });
    render(<Home events={[]} attention={[]} connected={true} coordinator="nova" onOpenChat={() => {}} />);
    expect(await screen.findByText("Resting.")).toBeTruthy();
    const chip = await screen.findByRole("button", { name: /I could pick "Ship the audit" back up/ });
    fireEvent.click(chip);
    expect(window.location.hash).toBe("#/goals/ship-the-audit");
  });

  it("keeps the offers out of a busy tide — a working org has better things to say", async () => {
    // Same goal, same idle lead; the difference is that one agent is mid-turn, so the
    // field's caption belongs to the work that IS running.
    stubApi({
      "/api/org": ORG,
      "/api/schedule": SCHEDULE,
      "/api/budget": { date: "2026-08-02", spentCents: 214, capCents: null },
      "/api/health": HEALTH,
      "/api/mail/mine": { threads: [] },
      "/api/goals": [FAILED_GOAL],
      "/api/mail/unread": NO_UNREAD,
    });
    render(<Home events={[]} attention={[]} connected={true} coordinator="nova" onOpenChat={() => {}} />);
    await screen.findByText(/One is working/);
    expect(screen.queryByText(/I could pick/)).toBeNull();
  });

  it("starts at the mid tide with one agent working and does not jump on mount", async () => {
    stubAll();
    const { container } = render(<Home events={[]} attention={[]} connected={true} coordinator="nova" onOpenChat={() => {}} />);
    await screen.findByText(/One is working/);
    expect(container.querySelector("[data-tide]")?.getAttribute("data-tide")).toBe("mid");
  });

  it("shows the dock chip without opening the sheet", async () => {
    stubAll();
    render(<Home events={[]} attention={[approval]} connected={true} coordinator="nova" onOpenChat={() => {}} />);
    await screen.findByText(/One is working/);
    expect(screen.getByRole("button", { name: "Send weekly report" })).toBeTruthy();
  });
});
