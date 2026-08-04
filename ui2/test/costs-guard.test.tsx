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
