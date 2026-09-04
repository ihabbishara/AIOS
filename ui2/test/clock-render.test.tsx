// ui2/test/clock-render.test.tsx — one pin pulses, never two, and never on dead data.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Clock } from "../src/views/home/Clock.js";
import type { ClockMark } from "../src/lib/clock.js";

afterEach(cleanup);

const marks: ClockMark[] = [
  { key: "anchor:morning", label: "morning brief", hhmm: "08:00", minutes: 480, kind: "past" },
  { key: "reminder:7", label: "renew domain", hhmm: "12:00", minutes: 720, kind: "next" },
  { key: "anchor:evening", label: "evening wrap", hhmm: "21:30", minutes: 1290, kind: "future" },
];

describe("Clock", () => {
  it("pulses exactly one pin — the approaching one", () => {
    const { container } = render(<Clock marks={marks} nowMinutes={600} live={true} />);
    expect(container.querySelectorAll(".approach")).toHaveLength(1);
  });

  it("stops the pulse when the stream is down", () => {
    const { container } = render(<Clock marks={marks} nowMinutes={600} live={false} />);
    expect(container.querySelectorAll(".approach")).toHaveLength(0);
  });

  it("hues past, next and future differently so reduced-motion still reads", () => {
    const { container } = render(<Clock marks={marks} nowMinutes={600} live={false} />);
    // Scoped to [data-mark]: the NOW line deliberately shares periwinkle with the
    // approaching pin, so an unscoped .bg-next count would be 2. The pin IS the
    // [data-mark] element now — it used to be a child of a wrapper that also held a label.
    const hue = (k: string) => container.querySelectorAll(`[data-mark].${k}`).length;
    expect(hue("bg-past")).toBe(1);
    expect(hue("bg-next")).toBe(1);
    expect(hue("bg-rest")).toBe(1);
  });

  it("marks NOW on the axis separately from any scheduled pin", () => {
    const { container } = render(<Clock marks={marks} nowMinutes={600} live={false} />);
    const nowLine = container.querySelector(".bg-next:not([data-mark])") as HTMLElement;
    expect(nowLine.style.left).toBe(`${(600 / 1440) * 100}%`);
  });

  it("positions each mark by its minute of the day", () => {
    const { container } = render(<Clock marks={marks} nowMinutes={600} live={false} />);
    // The pin carries the position, and is now the [data-mark] element itself.
    const pin = container.querySelector('[data-mark="reminder:7"]') as HTMLElement;
    expect(pin.style.left).toBe(`${(720 / 1440) * 100}%`);
  });

  it("says so plainly when nothing is scheduled, rather than drawing an empty axis", () => {
    render(<Clock marks={[]} nowMinutes={600} live={true} />);
    expect(screen.getByText("Nothing scheduled today")).toBeTruthy();
  });

  it("07:15 and 07:30 never overprint — now because neither is drawn on the axis at all", () => {
    // This used to be about lanes: labels hung off the axis at their own time and laddered
    // downward when they collided. Six of them laddered into six rows on a real day, which is
    // the failure that retired the mechanism. Two marks fifteen minutes apart are now two pins
    // and two chips in a wrapping row, so there is nothing positioned that could overlap.
    const tight: ClockMark[] = [
      { key: "a", label: "standup", hhmm: "07:15", minutes: 435, kind: "past" },
      { key: "b", label: "briefing", hhmm: "07:30", minutes: 450, kind: "past" },
    ];
    const { container } = render(<Clock marks={tight} nowMinutes={600} live={false} />);
    const chips = [...container.querySelectorAll("[data-chip]")];
    expect(chips.map((c) => c.textContent)).toEqual(["07:15standup", "07:30briefing"]);
    // No chip is absolutely positioned — the row lays them out, so they cannot collide.
    for (const c of chips) expect(getComputedStyle(c).position).not.toBe("absolute");
  });

  it("the NOW tick says what time it is", () => {
    render(<Clock marks={marks} nowMinutes={600} live={false} />);
    expect(screen.getByText("now 10:00")).toBeTruthy();
  });
});
