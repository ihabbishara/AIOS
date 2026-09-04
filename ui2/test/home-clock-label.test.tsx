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
  const marks = [
    { key: "reminder:1", label: shortLabel(HUGE), full: HUGE, hhmm: "10:00", minutes: 600, kind: "future" as const },
  ];

  it("prints the short label, never the paragraph", () => {
    render(<Clock marks={marks} nowMinutes={540} live={false} />);
    expect(screen.getByText(marks[0].label)).toBeTruthy();
    expect(screen.queryByText(HUGE)).toBeNull();
  });

  it("clamps the label box, so an unshortened label still cannot widen the page", () => {
    const { container } = render(<Clock marks={marks} nowMinutes={540} live={false} />);
    const box = container.querySelector("[data-mark='reminder:1'] > div:last-child") as HTMLElement;
    // 52ch, not 30: clockLanes already reserves room for the full label, so a tighter clamp
    // truncated text the layout had budgeted for. The CSS is the backstop, shortLabel is the rule.
    expect(box.className).toContain("max-w-[52ch]");
    expect(box.className).toContain("overflow-hidden");
    expect(box.getAttribute("title")).toBe(HUGE);
  });

  it("anchors labels near the day's edges inward instead of centring them off-page", () => {
    const at = (minutes: number) => {
      const { container } = render(
        <Clock marks={[{ key: "k", label: "x", hhmm: "00:00", minutes, kind: "future" as const }]} nowMinutes={1} live={false} />,
      );
      const box = container.querySelector("[data-mark='k'] > div:last-child") as HTMLElement;
      const t = box.style.transform;
      cleanup();
      return t;
    };
    expect(at(10)).toBe("translateX(0)");       // 00:10 — hangs right off its pin
    expect(at(720)).toBe("translateX(-50%)");   // midday — centred, as before
    expect(at(1430)).toBe("translateX(-100%)"); // 23:50 — hangs left
  });
});
