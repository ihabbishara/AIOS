// ui2/test/queue-render.test.tsx — triage behaviour is unchanged by the Organism
// redesign; it just lives behind `q` now. These are the same two assertions as
// before, with the sheet opened first.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Home } from "../src/views/Home.js";
import { stubApi } from "./stubs.js";
import type { AttentionItem } from "../src/api.js";

afterEach(cleanup);

const approval: AttentionItem = {
  kind: "approval", id: "a1", title: "Send weekly report", meta: "email.draft",
  severity: 1, ts: "2026-07-13T09:00:00.000Z", actions: ["approve", "reject", "open"], ref: { actionId: "a1" },
};

const BASE = {
  "/api/budget": { date: "2026-07-13", spentCents: 0, capCents: null },
  "/api/mail/mine": { threads: [] },
  "/api/org": [],
  "/api/schedule": { anchors: [], routines: [], reminders: [] },
  "/api/health": {
    uptimeMs: 0, voice: false, senses: [], sseClients: 1,
    dbBytes: 0, policyMode: "audit", policyViolations: 0,
  },
};

describe("Home queue", () => {
  it("renders groups and collapses a row on approve", async () => {
    stubApi({ ...BASE, "/api/actions/a1/resolve": { id: "a1", status: "executed" } });
    render(<Home events={[]} attention={[approval]} connected={true} coordinator="nova" onOpenChat={() => {}} />);
    fireEvent.keyDown(window, { key: "q" });
    expect((await screen.findAllByText("Send weekly report")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText("Approve")[0]);
    expect((await screen.findAllByText("Nothing needs you.")).length).toBeGreaterThan(0);
  });

  it("rolls back and shows an inline error when the mutation fails", async () => {
    // /api/actions/a1/resolve intentionally unstubbed → 404 "no stub" error
    stubApi(BASE);
    render(<Home events={[]} attention={[approval]} connected={true} coordinator="nova" onOpenChat={() => {}} />);
    fireEvent.keyDown(window, { key: "q" });
    fireEvent.click((await screen.findAllByText("Approve"))[0]);
    expect((await screen.findAllByText(/no stub/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Send weekly report").length).toBeGreaterThan(0); // row is back
  });
});
