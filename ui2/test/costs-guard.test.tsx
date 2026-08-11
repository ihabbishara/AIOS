// ui2/test/costs-guard.test.tsx — a /api/costs payload missing byAgent or byDay must not
// white-screen the System view. Same class as the mail/unread byAgent crash: the early
// `if (!costs)` guard covers the whole object but not its fields, so Object.entries(undefined)
// throws on the render AFTER the fetch lands — the first pass is healthy and hides it.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { System } from "../src/views/System.js";
import { stubApi } from "./stubs.js";

afterEach(cleanup);

/** Let the query resolve and React re-render; act() rethrows a render crash. */
const settle = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); });

const route = { section: "system" as const, parts: ["costs"], query: new URLSearchParams() };

describe("costs payload with missing fields", () => {
  it("survives a payload with no byAgent", async () => {
    stubApi({ "/api/costs": { byDay: { "2026-08-03": 1.5 } }, "/api/goals": [] });
    render(<System events={[]} route={route} />);
    await settle();
    expect(screen.getByText("Last 14 days")).toBeTruthy();
  });

  it("survives a payload with no byDay", async () => {
    stubApi({ "/api/costs": { byAgent: { vulcan: 2.25 } }, "/api/goals": [] });
    render(<System events={[]} route={route} />);
    await settle();
    expect(screen.getByText("Last 14 days")).toBeTruthy();
  });

  it("survives an empty payload entirely", async () => {
    stubApi({ "/api/costs": {}, "/api/goals": [] });
    render(<System events={[]} route={route} />);
    await settle();
    expect(screen.getByText("Last 14 days")).toBeTruthy();
  });

  it("still renders the real numbers when both fields are present", async () => {
    stubApi({
      "/api/costs": { byAgent: { vulcan: 2.25 }, byDay: { "2026-08-03": 1.5 } },
      "/api/goals": [],
    });
    render(<System events={[]} route={route} />);
    await settle();
    expect(screen.getByText("vulcan")).toBeTruthy();
    expect(screen.getByText("$2.25")).toBeTruthy();          // the agent's spend, from byAgent
    // Today / 7d / 14d all read $1.50 off a single-day byDay, so this must be getAll.
    expect(screen.getAllByText("$1.50").length).toBeGreaterThan(0);
  });
});

// The cap is the one control that stops a runaway day, and Costs used to render spend without
// ever mentioning it. On this install AIOS_DAILY_BUDGET_USD was unset — SpendGuard.allow() is
// then always true — while the ledger held a $56.71 day.
describe("the daily spend cap", () => {
  const costs = { byAgent: { vulcan: 2.25 }, byDay: { "2026-08-11": 4.9 } };

  it("says plainly when there is no cap at all", async () => {
    stubApi({
      "/api/costs": costs, "/api/goals": [],
      "/api/budget": { date: "2026-08-11", spentCents: 490, capCents: null },
    });
    render(<System events={[]} route={route} />);
    await settle();
    expect(screen.getByText(/No daily cap/)).toBeTruthy();
    // Names the setting, so the next action is obvious rather than a hunt.
    expect(screen.getByText(/AIOS_DAILY_BUDGET_USD/)).toBeTruthy();
  });

  it("shows spend against the cap, and what is left", async () => {
    stubApi({
      "/api/costs": costs, "/api/goals": [],
      "/api/budget": { date: "2026-08-11", spentCents: 490, capCents: 2000 },
    });
    render(<System events={[]} route={route} />);
    await settle();
    expect(screen.getByText(/\$4\.90 of \$20\.00 today/)).toBeTruthy();
    expect(screen.getByText(/\$15\.10 left/)).toBeTruthy();
    expect(screen.queryByText(/No daily cap/)).toBeNull();
  });

  it("says background work is paused once the cap is reached", async () => {
    stubApi({
      "/api/costs": costs, "/api/goals": [],
      "/api/budget": { date: "2026-08-11", spentCents: 2500, capCents: 2000 },
    });
    render(<System events={[]} route={route} />);
    await settle();
    expect(screen.getByText(/cap reached/)).toBeTruthy();
  });

  it("a budget endpoint that fails leaves the rest of Costs intact", async () => {
    stubApi({ "/api/costs": costs, "/api/goals": [] }); // no /api/budget stub → 404
    render(<System events={[]} route={route} />);
    await settle();
    expect(screen.getByText("Last 14 days")).toBeTruthy();
    expect(screen.queryByText(/No daily cap/)).toBeNull();
  });
});
