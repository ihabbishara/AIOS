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

function stubAll() {
  stubApi({
    "/api/org": ORG,
    "/api/schedule": SCHEDULE,
    "/api/budget": { date: "2026-08-02", spentCents: 214, capCents: null },
    "/api/health": HEALTH,
    "/api/mail/mine": { threads: [] },
  });
}

describe("Home — Organism", () => {
  it("states how many are working and how many need you", async () => {
    stubAll();
    render(<Home events={[]} attention={[approval]} connected={true} onOpenChat={() => {}} />);
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
    render(<Home events={[]} attention={[]} connected={true} onOpenChat={() => {}} />);
    expect(await screen.findByText("Resting.")).toBeTruthy();
    expect(screen.getByText("Nothing needs you.")).toBeTruthy();
  });

  it("opens the queue sheet on q and closes it on escape", async () => {
    stubAll();
    render(<Home events={[]} attention={[approval]} connected={true} onOpenChat={() => {}} />);
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
    stubAll();
    const { container } = render(<Home events={[]} attention={[]} connected={false} onOpenChat={() => {}} />);
    await screen.findByText(/One is working/);
    expect(container.querySelectorAll(".breath, .approach, .travel")).toHaveLength(0);
  });

  it("starts at the mid tide with one agent working and does not jump on mount", async () => {
    stubAll();
    const { container } = render(<Home events={[]} attention={[]} connected={true} onOpenChat={() => {}} />);
    await screen.findByText(/One is working/);
    expect(container.querySelector("[data-tide]")?.getAttribute("data-tide")).toBe("mid");
  });

  it("shows the dock chip without opening the sheet", async () => {
    stubAll();
    render(<Home events={[]} attention={[approval]} connected={true} onOpenChat={() => {}} />);
    await screen.findByText(/One is working/);
    expect(screen.getByRole("button", { name: "Send weekly report" })).toBeTruthy();
  });
});
