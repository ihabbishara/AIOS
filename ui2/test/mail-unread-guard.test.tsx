// ui2/test/mail-unread-guard.test.tsx — a /api/mail/unread payload missing byAgent must not
// white-screen the surfaces that read the per-agent counts. buildMailUnread always sends the field
// today, so this is a latent trap: a stopped-short optional chain (unread?.byAgent[name]) reads
// undefined[name] and throws. It survives the FIRST render — `unread` is still undefined then, so
// the `?.` covers it — and only detonates once the fetch lands, taking the mounted tree with it.
// Hence the settle() below: without it these tests pass against the broken code.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { Staff } from "../src/views/Staff.js";
import { Chat } from "../src/components/Chat.js";
import { stubApi, STATE_STUB } from "./stubs.js";

afterEach(cleanup);

/** Let the in-flight queries resolve and React re-render. act() rethrows a render crash. */
const settle = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); });

/** What the server would send if unreadCountsByAgent() were ever dropped from the payload. */
const UNREAD_NO_BY_AGENT = { total: 0, pendingUser: 0, userInbox: 0 };

const ORG = [{
  department: "engineering", mission: "ship it", lead: "atlas", memoDomain: "eng",
  sandbox: false, actions: [],
  agents: [{
    name: "vulcan", title: "builder", charter: "builds", visibility: "shared" as const,
    guarded: false, status: "idle" as const, currentTask: null, costTodayUsd: 0,
  }],
}];

const route = { section: "staff" as const, parts: [], query: new URLSearchParams() };

describe("mail unread payload without byAgent", () => {
  it("keeps the Staff org columns mounted", async () => {
    stubApi({
      "/api/org": ORG, "/api/mail/unread": UNREAD_NO_BY_AGENT,
      "/api/packs": [], "/api/state": STATE_STUB,
    });
    render(<Staff events={[]} route={route} onOpenChat={() => {}} />);
    await settle();
    expect(screen.getByText("vulcan")).toBeTruthy();
  });

  it("keeps the Chat target tabs mounted", async () => {
    stubApi({ "/api/org": ORG, "/api/mail/unread": UNREAD_NO_BY_AGENT });
    render(<Chat state={STATE_STUB as never} events={[]} target="neo" setTarget={() => {}} />);
    await settle();
    // iris is the one non-moderator in STATE_STUB, so it gets a tab whose badge reads byAgent.
    expect(screen.getByText("iris")).toBeTruthy();
  });

  it("still renders the badge when byAgent is present", async () => {
    stubApi({
      "/api/org": ORG, "/api/mail/unread": { total: 3, byAgent: { vulcan: 3 }, pendingUser: 0, userInbox: 0 },
      "/api/packs": [], "/api/state": STATE_STUB,
    });
    render(<Staff events={[]} route={route} onOpenChat={() => {}} />);
    await settle();
    expect(screen.getByText("3")).toBeTruthy();
  });
});
