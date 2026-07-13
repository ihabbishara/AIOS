// ui2/test/shell.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { App } from "../src/App.js";
import { stubApi, STATE_STUB } from "./stubs.js";

afterEach(cleanup);

describe("app shell", () => {
  it("renders the 5-section nav and the calm empty home", async () => {
    stubApi({
      "/api/state": STATE_STUB,
      "/api/budget": { date: "2026-07-13", spentCents: 120, capCents: 1000 },
      "/api/attention": [],
    });
    render(<App />);
    for (const s of ["home", "goals", "staff", "mail", "system"]) {
      expect(await screen.findByText(s)).toBeTruthy();
    }
    expect(await screen.findByText("Nothing needs you.")).toBeTruthy();
  });

  it("gates on 401", async () => {
    stubApi({});
    (globalThis.fetch as unknown as { mockImplementation: (fn: () => Promise<Response>) => void })
      .mockImplementation(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    render(<App />);
    expect(await screen.findByPlaceholderText("AIOS_UI_TOKEN")).toBeTruthy();
  });
});
