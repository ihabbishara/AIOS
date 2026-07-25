// test/moderator-prompt.test.ts — generated prompt blocks + the per-turn wall-clock line
// that lets the coordinator resolve relative times (neo scheduling follow-up).
import { describe, it, expect } from "vitest";
import { nowLine, moderatorBlocks } from "../src/moderator/prompt.js";

describe("nowLine", () => {
  it("renders local date, weekday, HH:MM and a UTC offset", () => {
    const out = nowLine(new Date(2026, 6, 25, 14, 23)); // Sat 25 Jul 2026 14:23 local
    expect(out).toContain("2026-07-25");
    expect(out).toContain("14:23");
    expect(out).toContain("Saturday");
    expect(out).toMatch(/UTC[+-]\d{2}:\d{2}/);
  });

  it("zero-pads single-digit months, days, hours and minutes", () => {
    const out = nowLine(new Date(2026, 0, 3, 9, 5));
    expect(out).toContain("2026-01-03");
    expect(out).toContain("09:05");
  });

  it("tells the model to resolve relative times itself", () => {
    const out = nowLine(new Date(2026, 6, 25, 14, 23));
    expect(out.toLowerCase()).toContain("relative");
    expect(out.toLowerCase()).toContain("never ask");
  });

  it("is a single line — it is prepended to the user message, not a prompt section", () => {
    expect(nowLine(new Date(2026, 6, 25, 14, 23)).split("\n")).toHaveLength(1);
  });
});

describe("moderatorBlocks", () => {
  it("carries no clock — a resumed session keeps its ORIGINAL system prompt, so a time here " +
     "would go stale and contradict the per-turn line", () => {
    const out = moderatorBlocks({ playbooks: [{ name: "p", description: "d" }], projectsRoot: "/tmp/projects" });
    expect(out).not.toContain("Current time");
    expect(out).not.toMatch(/UTC[+-]\d{2}:\d{2}/);
  });
});
