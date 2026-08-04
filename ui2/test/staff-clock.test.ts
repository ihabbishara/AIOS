// ui2/test/staff-clock.test.ts — Staff's axis. The thresholds are load-bearing:
// they decide whether a department reads alive or abandoned.
import { describe, it, expect } from "vitest";
import { agentClock, lastActiveText, daysBetween, RECENT_DAYS } from "../src/lib/staff-clock.js";

const TODAY = "2026-08-04";

describe("agentClock", () => {
  it("separates never-run from merely quiet — the two look identical on cost alone", () => {
    // juno has never run under any of its names; odin ran, spent $480, went quiet.
    expect(agentClock(null, TODAY)).toBe("never");
    expect(agentClock("2026-07-26", TODAY)).toBe("stale");
  });

  it("is inclusive at the boundary and flips the day after", () => {
    const on = new Date(Date.parse(TODAY) - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
    const past = new Date(Date.parse(TODAY) - (RECENT_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    expect(agentClock(on, TODAY)).toBe("recent");
    expect(agentClock(past, TODAY)).toBe("stale");
  });

  it("treats a future date as active, not as a negative age", () => {
    // Only reachable via clock skew between writer and reader; reading it as
    // stale would be the one wrong answer.
    expect(agentClock("2026-09-01", TODAY)).toBe("recent");
  });

  it("splits the real roster into three non-empty groups", () => {
    // Measured from the live store on 2026-08-04. A threshold that collapses any
    // group makes the colour meaningless — at 30 days nothing is ever stale.
    const roster: Array<string | null> = [
      "2026-08-04", "2026-08-03", "2026-08-02", "2026-08-02", "2026-07-31",
      "2026-07-31", "2026-07-31", "2026-07-30", "2026-07-29", // recent (9)
      "2026-07-26", "2026-07-20", "2026-07-16", "2026-07-11", // stale (4)
      null, null, // never (2)
    ];
    const got = roster.map((d) => agentClock(d, TODAY));
    expect(got.filter((c) => c === "recent")).toHaveLength(9);
    expect(got.filter((c) => c === "stale")).toHaveLength(4);
    expect(got.filter((c) => c === "never")).toHaveLength(2);
  });
});

describe("lastActiveText", () => {
  it("names the recent days rather than counting them", () => {
    expect(lastActiveText(TODAY, TODAY)).toBe("today");
    expect(lastActiveText("2026-08-03", TODAY)).toBe("yesterday");
    expect(lastActiveText("2026-08-02", TODAY)).toBe("2 days ago");
    expect(lastActiveText("2026-07-26", TODAY)).toBe("9 days ago");
  });

  it("says never run rather than printing an age for an agent with no history", () => {
    expect(lastActiveText(null, TODAY)).toBe("never run");
  });
});

describe("daysBetween", () => {
  it("counts whole days across a month boundary and a DST shift", () => {
    expect(daysBetween("2026-07-31", "2026-08-04")).toBe(4);
    // Europe/Amsterdam shifts on 2026-03-29; UTC parsing must not lose the hour.
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
  });
});
