// ui2/test/goal-clock.test.ts — status → time relationship (spec 2026-08-03 §1).
import { describe, it, expect } from "vitest";
import { statusClock, isMuted, CLOCK_TOKEN, CLOCK_TEXT } from "../src/lib/goal-clock.js";

describe("statusClock", () => {
  it("maps in-flight goal statuses to now", () => {
    for (const s of ["planning", "running", "replanning", "awaiting-mail"]) {
      expect(statusClock(s), s).toBe("now");
    }
  });

  it("maps in-flight node statuses to now", () => {
    expect(statusClock("running")).toBe("now");
  });

  it("maps finished work to past", () => {
    for (const s of ["done", "abandoned", "skipped"]) expect(statusClock(s), s).toBe("past");
  });

  it("maps not-yet-started nodes to next", () => {
    for (const s of ["pending", "ready"]) expect(statusClock(s), s).toBe("next");
  });

  it("maps everything a human must unblock to blocked", () => {
    for (const s of [
      "failed", "needs-review",
      "paused-user", "paused-budget", "paused-api", "paused-session",
    ]) expect(statusClock(s), s).toBe("blocked");
  });

  it("routes an UNKNOWN status to blocked, never to healthy", () => {
    // Carried over from laneOf, back when goal-buckets.ts still carried lane
    // logic: a new backend status must surface as needing attention, not
    // hide as if fine.
    expect(statusClock("some-new-backend-status")).toBe("blocked");
    expect(statusClock("")).toBe("blocked");
  });
});

describe("isMuted", () => {
  it("mutes work that ended without succeeding", () => {
    expect(isMuted("abandoned")).toBe(true);
    expect(isMuted("skipped")).toBe(true);
  });

  it("does not mute work that finished fine", () => {
    expect(isMuted("done")).toBe(false);
    expect(isMuted("running")).toBe(false);
  });
});

describe("token maps", () => {
  it("cover every Clock value", () => {
    for (const c of ["now", "past", "next", "blocked"] as const) {
      expect(CLOCK_TOKEN[c], c).toBeTruthy();
      expect(CLOCK_TEXT[c], c).toBeTruthy();
    }
  });

  it("use token utilities, never raw colour", () => {
    for (const v of [...Object.values(CLOCK_TOKEN), ...Object.values(CLOCK_TEXT)]) {
      expect(v).toMatch(/^(bg|text)-[a-z]+$/);
    }
  });
});
