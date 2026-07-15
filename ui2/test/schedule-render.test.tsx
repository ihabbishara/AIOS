// ui2/test/schedule-render.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Schedule } from "../src/views/Schedule.js";
import { stubApi } from "./stubs.js";

afterEach(cleanup);

const SCHEDULE = {
  anchors: [
    { name: "morning", hhmm: "07:30", overridden: false, firedToday: true },
    { name: "evening", hhmm: "21:00", overridden: true, firedToday: false },
  ],
  routines: [
    {
      id: 1, name: "weekly market scan", prompt: "run research playbook on X",
      recurrence: { kind: "weekly", dow: 1, hhmm: "09:00" }, enabled: true,
      lastFiredAt: null, nextFire: "2026-07-20 09:00",
    },
  ],
  reminders: [{ id: 5, text: "call accountant", dueAt: "2026-07-16T09:00:00.000Z", origin: "telegram:42" }],
};

describe("Schedule view", () => {
  it("renders all three groups", async () => {
    stubApi({ "/api/schedule": SCHEDULE });
    render(<Schedule />);
    expect(await screen.findByText("weekly market scan")).toBeTruthy();
    expect(screen.getByText("call accountant")).toBeTruthy();
    expect(screen.getByText("morning")).toBeTruthy();
    expect(screen.getByText("2026-07-20 09:00")).toBeTruthy();
  });

  it("creates a routine through the form", async () => {
    stubApi({ "/api/schedule": SCHEDULE, "/api/routines": { id: 2 } });
    render(<Schedule />);
    await screen.findByText("weekly market scan");
    fireEvent.change(screen.getByPlaceholderText("Routine name"), { target: { value: "daily digest" } });
    fireEvent.change(screen.getByPlaceholderText("Prompt — what should run"), { target: { value: "summarize inbox" } });
    fireEvent.click(screen.getByText("Create routine"));
    // POST accepted → form clears (input back to empty)
    expect(((await screen.findByPlaceholderText("Routine name")) as HTMLInputElement).value).toBe("");
  });

  it("run-now button exists per routine", async () => {
    stubApi({ "/api/schedule": SCHEDULE, "/api/routines/1/run": { ok: true } });
    render(<Schedule />);
    await screen.findByText("weekly market scan");
    expect(screen.getByText("Run now")).toBeTruthy();
  });
});
