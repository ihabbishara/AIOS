// ui2/test/home-org-shapes.test.tsx — Home against a realistic /api/org payload:
// several departments, a cluster that wraps past PER_ROW, and a department with
// no lead. The single-department fixture in home-organism.test.tsx missed a
// crash that only appears at this shape.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Home } from "../src/views/Home.js";
import { stubApi } from "./stubs.js";

afterEach(cleanup);

const agent = (name: string, status: string, currentTask: string | null = null) => ({
  name, title: "T", charter: "c", visibility: "shared", guarded: false,
  status, currentTask, costTodayUsd: 0,
});

const ORG = [
  { department: "engineering", mission: "ship", lead: "atlas", memoDomain: "engineering", sandbox: false, actions: [],
    agents: [
      agent("argus", "waiting"), agent("athena", "idle"), agent("atlas", "idle"),
      agent("odin", "idle"), agent("themis", "idle"), agent("vulcan", "working", "node 3/5"),
    ] },
  { department: "operations", mission: "run", lead: "neo", memoDomain: "operations", sandbox: false, actions: [],
    agents: [agent("neo", "working", "daily brief")] },
  { department: "life", mission: "rest", lead: null, memoDomain: "life", sandbox: false, actions: [],
    agents: [agent("hestia", "idle")] },
];

const SCHEDULE = {
  anchors: [
    { name: "morning brief", hhmm: "08:00", overridden: false, firedToday: true },
    { name: "evening wrap", hhmm: "21:30", overridden: false, firedToday: false },
  ],
  routines: [{ id: 1, name: "inbox sweep", prompt: "p", recurrence: { kind: "daily", hhmm: "09:30" },
    enabled: true, lastFiredAt: null, nextFire: "2026-08-02 09:30" }],
  reminders: [{ id: 7, text: "renew domain", dueAt: new Date(2026, 7, 2, 12, 0).toISOString(), origin: "user" }],
};

describe("Home against a realistic org", () => {
  it("renders a wrapping cluster and a lead-less department without crashing", async () => {
    stubApi({
      "/api/org": ORG,
      "/api/schedule": SCHEDULE,
      "/api/budget": { date: "2026-08-02", spentCents: 214, capCents: null },
      "/api/health": { uptimeMs: 22_320_000, voice: false, senses: [], sseClients: 1, dbBytes: 0, policyMode: "audit", policyViolations: 0 },
      "/api/mail/mine": { threads: [{ threadId: "t1", lastFrom: "neo", subject: "Daily brief", ts: "2026-08-02T08:00:00.000Z", unread: 0 }] },
    });
    const { container } = render(<Home events={[]} attention={[]} connected={true} coordinator="neo" onOpenChat={() => {}} />);
    expect(await screen.findByText(/Two are working/)).toBeTruthy();
    expect(container.querySelectorAll("[data-dot]")).toHaveLength(8);
    expect(container.querySelectorAll("[data-mark]")).toHaveLength(4);
  });
});
