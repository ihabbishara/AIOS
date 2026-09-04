// ui2/test/home-clock-label.test.tsx — a mark on the day axis is a NAME, not a message.
//
// Ground truth (2026-09-04, Home at 2000px): reminders carried `label: rem.text`, so a reminder
// holding a paragraph of deadlines rendered as one nowrap line wider than the page. Two of them
// stacked in lanes across the bottom of the screen and spilled off both edges, burying the axis
// they were supposed to annotate.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { clockMarks, shortLabel } from "../src/lib/clock.js";
import { Clock } from "../src/views/home/Clock.js";
import type { ScheduleView } from "../src/api.js";

afterEach(cleanup);

// The real reminder from the screenshot, trimmed of nothing.
const HUGE = "Book the CADA session on 2 October — Dutch cloud companies only. Hard deadline "
  + "Thu 25 Sep 17:00. Also: Het Ontwerp review points due 23 Sep (18 drafted in "
  + "knowledge/sovereign-cloud-nl/), and Kamer schriftelijk overleg Cloudbeleid inbreng due 22 Sep.";

const schedule = (over: Partial<ScheduleView> = {}): ScheduleView => ({
  anchors: [], routines: [], reminders: [], ...over,
} as ScheduleView);

describe("shortLabel", () => {
  it("keeps a real name untouched", () => {
    for (const n of ["evening", "daily brief", "OCA & sovereign cloud NL watch"]) {
      expect(shortLabel(n)).toBe(n);
    }
  });

  it("cuts the paragraph reminder down to something that reads as a name", () => {
    const out = shortLabel(HUGE);
    expect(out.length).toBeLessThanOrEqual(44);
    expect(out).toBe("Book the CADA session on 2 October");  // the half before the em-dash
    expect(out).not.toMatch(/…$/);                            // a clean break needs no ellipsis
  });

  it("falls back to a word break, then to a blunt cut, and never exceeds the budget", () => {
    expect(shortLabel("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda"))
      .toBe("alpha beta gamma delta epsilon zeta eta…");
    // No spaces and no sentence end: still bounded.
    const runOn = shortLabel("x".repeat(300));
    expect(runOn.length).toBeLessThanOrEqual(45);
    expect(runOn.endsWith("…")).toBe(true);
  });

  it("collapses newlines, so a multi-line reminder cannot break the axis either", () => {
    expect(shortLabel("first line\n\nsecond line")).toBe("first line second line");
  });
});

describe("clockMarks", () => {
  it("labels a reminder with its short name and keeps the full text for the tooltip", () => {
    const [m] = clockMarks(
      schedule({ reminders: [{ id: 1, text: HUGE, dueAt: "2026-09-04T09:00:00.000Z" }] as never }),
      new Date("2026-09-04T08:00:00.000Z"),
    );
    expect(m.label.length).toBeLessThanOrEqual(44);
    expect(m.full).toBe(HUGE);
  });

  it("carries no tooltip when nothing was shortened", () => {
    const [m] = clockMarks(
      schedule({ anchors: [{ name: "evening", hhmm: "21:00", firedToday: false }] as never }),
      new Date("2026-09-04T08:00:00.000Z"),
    );
    expect(m.label).toBe("evening");
    expect(m.full).toBeUndefined();
  });
});

describe("Clock rendering", () => {
  const mark = (key: string, hhmm: string, minutes: number, label: string, kind: "past" | "next" | "future", full?: string) =>
    ({ key, label, hhmm, minutes, kind, ...(full ? { full } : {}) });

  // The live 2026-09-04 day: six marks inside three morning hours, then a gap to the evening.
  const DAY = [
    mark("a:dream", "02:00", 120, "dream", "past"),
    mark("a:speculate", "03:00", 180, "speculate", "past"),
    mark("a:standup", "07:15", 435, "standup", "past"),
    mark("a:morning", "07:30", 450, "morning", "past"),
    mark("r:1", "07:30", 450, "daily brief", "past"),
    mark("rem:8", "09:00", 540, shortLabel(HUGE), "past", HUGE),
    mark("rem:9", "09:00", 540, "OCA demos its sovereign cloud marketplace…", "past", HUGE),
    mark("r:5", "10:00", 600, "OCA & sovereign cloud NL watch", "past"),
    mark("a:evening", "21:00", 1260, "evening", "next"),
  ];

  it("puts every mark on the axis as a pin, and names it on hover", () => {
    const { container } = render(<Clock marks={DAY} nowMinutes={960} live={false} />);
    expect(container.querySelectorAll("[data-mark]")).toHaveLength(DAY.length);
    expect(container.querySelector("[data-mark='rem:8']")!.getAttribute("title")).toBe(`09:00 ${HUGE}`);
  });

  it("carries no label text on the axis — that is what made it stack", () => {
    const { container } = render(<Clock marks={DAY} nowMinutes={960} live={false} />);
    for (const pin of container.querySelectorAll("[data-mark]")) {
      expect(pin.textContent).toBe("");
    }
  });

  it("lists the names in one wrapping agenda, in time order", () => {
    const { container } = render(<Clock marks={DAY} nowMinutes={960} live={false} />);
    const agenda = container.querySelector("[data-agenda]") as HTMLElement;
    expect(agenda.className).toContain("flex-wrap");
    const chips = [...container.querySelectorAll("[data-chip]")];
    expect(chips).toHaveLength(DAY.length);
    expect(chips[0].textContent).toContain("dream");
    expect(chips.at(-1)!.textContent).toContain("evening");
  });

  it("marks where now falls, between what is done and what is coming", () => {
    const { container } = render(<Clock marks={DAY} nowMinutes={960} live={false} />); // 16:00
    const kids = [...(container.querySelector("[data-agenda]") as HTMLElement).children];
    const divider = kids.findIndex((k) => k.querySelector("[data-now-divider]"));
    // Everything before the divider is in the past, everything after is ahead.
    expect(divider).toBe(8); // the eight morning marks, then now, then the evening
  });

  it("keeps the agenda to a bounded number of chips and links the rest to Schedule", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      mark(`m${i}`, "08:00", 480 + i, `thing number ${i}`, "future"));
    const { container } = render(<Clock marks={many} nowMinutes={100} live={false} />);
    expect(container.querySelectorAll("[data-chip]")).toHaveLength(12);
    const more = container.querySelector("a[href*='schedule']") as HTMLAnchorElement;
    expect(more.textContent).toBe("+8 more");
    // The SHAPE is never what gets truncated — every mark is still a pin.
    expect(container.querySelectorAll("[data-mark]")).toHaveLength(20);
  });

  it("says so when the day is empty", () => {
    render(<Clock marks={[]} nowMinutes={600} live={false} />);
    expect(screen.getByText("Nothing scheduled today")).toBeTruthy();
  });
});
