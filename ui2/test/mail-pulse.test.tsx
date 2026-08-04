// ui2/test/mail-pulse.test.tsx — the pulse surface: the strip, a failed morning, a silent
// day, the work band and the empty corpus. The failed and silent states are the whole point
// of this view and neither existed in any test before it.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { Mail } from "../src/views/Mail.js";
import { stubApi } from "./stubs.js";

// vi.setSystemTime ALONE pins Date on Vitest 3; useFakeTimers() would starve React's
// scheduler and hang every findBy* query (documented at goal-bands.test.tsx:22-26).
beforeEach(() => vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z")));
afterEach(() => { vi.useRealTimers(); cleanup(); });

const CANONICAL = `Done: Investor deck rendered to professional PDF ($9.82).
Today: Nothing queued — awaiting next design task.
Blockers: None.`;

const row = (o: Record<string, unknown>) => ({
  id: "m1", from: "clio", to: "neo", kind: "standup", status: "read", body: CANONICAL,
  goalId: null, chainDepth: 1, createdAt: "2026-08-03T05:15:00.000Z", readAt: null, error: null, ...o,
});

const route = { section: "mail" as const, parts: [] as string[], query: new URLSearchParams() };
const NO_THREADS = { threads: [] };

describe("Mail pulse", () => {
  it("renders today's check-in with the three fields parsed out", async () => {
    stubApi({ "/api/mail": [row({})], "/api/mail/mine": NO_THREADS });
    render(<Mail events={[]} route={route} />);
    expect(await screen.findByText("clio")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Investor deck rendered to professional PDF ($9.82).")).toBeTruthy();
    expect(screen.getByText("Blockers")).toBeTruthy();
  });

  it("counts only genuine check-ins in the header, not failures", async () => {
    stubApi({
      "/api/mail": [
        row({ id: "a", createdAt: "2026-08-03T05:00:00.000Z" }),
        row({ id: "b", from: "athena", createdAt: "2026-08-01T05:00:00.000Z",
          body: "API Error: Unable to connect to API (ConnectionRefused)" }),
      ],
      "/api/mail/mine": NO_THREADS,
    });
    render(<Mail events={[]} route={route} />);
    // 30-day window, one clean morning (Aug 3); Aug 1 errored so it is not a check-in.
    expect(await screen.findByText("checked in 1 of 30 days")).toBeTruthy();
  });

  it("shows a failed morning as a failure, not as an empty check-in", async () => {
    stubApi({
      "/api/mail": [row({ from: "athena", createdAt: "2026-08-03T05:00:00.000Z",
        body: "API Error: Unable to connect to API (ConnectionRefused)" })],
      "/api/mail/mine": NO_THREADS,
    });
    render(<Mail events={[]} route={route} />);
    expect(await screen.findByText("standup failed")).toBeTruthy();
    expect(screen.getByText("Unable to connect to API (ConnectionRefused)")).toBeTruthy();
    expect(screen.queryByText("Done")).toBeNull();   // no empty field lanes
  });

  it("states a silent day rather than leaving a gap", async () => {
    stubApi({ "/api/mail": [row({})], "/api/mail/mine": NO_THREADS });
    render(<Mail events={[]} route={route} />);
    await screen.findByText("clio");
    // Aug 2 has no standup and sits directly under today.
    const yesterday = screen.getByText("Yesterday").closest("div")?.parentElement;
    expect(yesterday).toBeTruthy();
    expect(within(yesterday!).getByText("No standup — the org did not check in.")).toBeTruthy();
    expect(within(yesterday!).getByText("silent")).toBeTruthy();
  });

  it("draws one strip column per day in the window, marking silent ones", async () => {
    stubApi({ "/api/mail": [row({})], "/api/mail/mine": NO_THREADS });
    render(<Mail events={[]} route={route} />);
    await screen.findByText("clio");
    expect(screen.getByTitle("2026-08-03 — 1 check-in")).toBeTruthy();
    expect(screen.getByTitle("2026-08-02 — no standup")).toBeTruthy();
    expect(screen.getByTitle("2026-07-05 — no standup")).toBeTruthy();   // oldest in a 30-day window
  });

  it("groups the work band into request → report exchanges with a goal link", async () => {
    stubApi({
      "/api/mail": [
        row({ id: "q", kind: "request", goalId: "g1", from: "vulcan", to: "atlas",
          body: "DELIVERY HANDOFF — copy the file", status: "spawned", createdAt: "2026-07-28T10:00:00.000Z" }),
        row({ id: "r", kind: "report", goalId: "g1", from: "atlas", to: "vulcan",
          body: "Done: copied to vault", createdAt: "2026-07-28T11:00:00.000Z" }),
      ],
      "/api/mail/mine": NO_THREADS,
    });
    render(<Mail events={[]} route={route} />);
    expect(await screen.findByText("DELIVERY HANDOFF — copy the file")).toBeTruthy();
    expect(screen.getByText("1 report back")).toBeTruthy();
    expect(screen.getByText("goal ↗")).toBeTruthy();
    expect(screen.getByText("Work")).toBeTruthy();
  });

  it("renders an unparseable standup verbatim instead of dropping it", async () => {
    stubApi({
      "/api/mail": [row({ body: "just some prose with no fields at all" })],
      "/api/mail/mine": NO_THREADS,
    });
    render(<Mail events={[]} route={route} />);
    expect(await screen.findByText("just some prose with no fields at all")).toBeTruthy();
  });

  it("asks the server for the window, not for a row count", async () => {
    stubApi({ "/api/mail": [row({})], "/api/mail/mine": NO_THREADS });
    render(<Mail events={[]} route={route} />);
    await screen.findByText("clio");
    const urls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.map((c) => String(c[0]));
    const mailCall = urls.find((u) => u.startsWith("/api/mail?"));
    // Without `since` the server falls back to a row limit taken over the whole corpus,
    // which drops the OLDEST days once the corpus outgrows it — silently.
    expect(mailCall).toContain(`since=${encodeURIComponent("2026-07-05T00:00:00.000Z")}`);
  });

  it("shows the empty state on a fresh install", async () => {
    stubApi({ "/api/mail": [], "/api/mail/mine": NO_THREADS });
    render(<Mail events={[]} route={route} />);
    expect(await screen.findByText(/No mail yet/)).toBeTruthy();
  });

  it("keeps your correspondence and the compose entry point", async () => {
    stubApi({
      "/api/mail": [row({})],
      "/api/mail/mine": { threads: [{ threadId: "t1", lastTs: "2026-07-16T20:08:29.911Z",
        lastFrom: "jasmine", lastBody: "the briefing is ready", unread: 0, pendingAsk: 0, refused: 0 }] },
    });
    render(<Mail events={[]} route={route} />);
    // "Yours" renders before mailMine resolves, so the thread row is the thing to await.
    expect(await screen.findByText("jasmine")).toBeTruthy();
    expect(screen.getByText("Yours")).toBeTruthy();
    expect(screen.getByText("the briefing is ready")).toBeTruthy();
    expect(screen.getByText("Compose")).toBeTruthy();
  });

  it("opens a day on its own route with full, unclamped bodies", async () => {
    stubApi({ "/api/mail": [row({})], "/api/mail/mine": NO_THREADS });
    render(<Mail events={[]} route={{ ...route, parts: ["day", "2026-08-03"] }} />);
    expect(await screen.findByText("1 checked in")).toBeTruthy();
    expect(screen.getByText("Investor deck rendered to professional PDF ($9.82).")).toBeTruthy();
  });

  it("says so when a requested day had no standup", async () => {
    stubApi({ "/api/mail": [row({})], "/api/mail/mine": NO_THREADS });
    render(<Mail events={[]} route={{ ...route, parts: ["day", "2026-07-21"] }} />);
    expect(await screen.findByText(/No standup on 2026-07-21/)).toBeTruthy();
  });
});
