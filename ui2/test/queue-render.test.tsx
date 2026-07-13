// ui2/test/queue-render.test.tsx
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

describe("Home queue", () => {
  it("renders groups and collapses a row on approve", async () => {
    stubApi({
      "/api/budget": { date: "2026-07-13", spentCents: 0, capCents: null },
      "/api/mail/mine": { threads: [] },
      "/api/actions/a1/resolve": { id: "a1", status: "executed" },
    });
    render(<Home events={[]} attention={[approval]} onOpenChat={() => {}} />);
    expect((await screen.findAllByText("Send weekly report")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText("Approve")[0]);
    expect((await screen.findAllByText("Nothing needs you.")).length).toBeGreaterThan(0);
  });

  it("rolls back and shows an inline error when the mutation fails", async () => {
    stubApi({
      "/api/budget": { date: "2026-07-13", spentCents: 0, capCents: null },
      "/api/mail/mine": { threads: [] },
      // /api/actions/a1/resolve intentionally unstubbed → 404 "no stub" error
    });
    render(<Home events={[]} attention={[approval]} onOpenChat={() => {}} />);
    fireEvent.click((await screen.findAllByText("Approve"))[0]);
    expect((await screen.findAllByText(/no stub/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Send weekly report").length).toBeGreaterThan(0); // row is back
  });
});
