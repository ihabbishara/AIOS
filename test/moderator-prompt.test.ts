// test/moderator-prompt.test.ts — generated prompt blocks, incl. the wall-clock block
// that lets the coordinator resolve relative times (spec: neo scheduling follow-up).
import { describe, it, expect } from "vitest";
import { nowBlock, moderatorBlocks } from "../src/moderator/prompt.js";

describe("nowBlock", () => {
  it("renders local date, weekday, HH:MM and a UTC offset", () => {
    const out = nowBlock(new Date(2026, 6, 25, 14, 23)); // Sat 25 Jul 2026 14:23 local
    expect(out).toContain("2026-07-25");
    expect(out).toContain("14:23");
    expect(out).toContain("Saturday");
    expect(out).toMatch(/UTC[+-]\d{2}:\d{2}/);
  });

  it("zero-pads single-digit months, days, hours and minutes", () => {
    const out = nowBlock(new Date(2026, 0, 3, 9, 5));
    expect(out).toContain("2026-01-03");
    expect(out).toContain("09:05");
  });

  it("tells the model to resolve relative times itself", () => {
    const out = nowBlock(new Date(2026, 6, 25, 14, 23));
    expect(out.toLowerCase()).toContain("relative");
    expect(out).toContain("add_reminder");
  });
});

describe("moderatorBlocks", () => {
  const args = { playbooks: [{ name: "p", description: "d" }], projectsRoot: "/tmp/projects" };

  it("appends the current-time block last (keeps the static prefix cacheable)", () => {
    const out = moderatorBlocks({ ...args, now: new Date(2026, 6, 25, 14, 23) });
    expect(out).toContain("## Current time");
    expect(out.indexOf("## Current time")).toBeGreaterThan(out.indexOf("## Project directories"));
  });

  it("omits the block when no clock is supplied", () => {
    expect(moderatorBlocks(args)).not.toContain("## Current time");
  });
});
