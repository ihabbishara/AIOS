// ui2/test/home-queue-prominence.test.tsx — the rows that BLOCK an agent must be hard to miss.
//
// Reported 2026-09-04: "the Queue part at the bottom of the page is pretty hidden, sometimes i
// miss the items". It was one quiet strip in surface grey at the foot of a dark page, and these
// are the rows that stall work — a grant to approve, a node parked for review. The headline
// already said how many, in the largest type on screen, and was inert.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Dock } from "../src/views/home/Dock.js";
import type { AttentionItem } from "../src/api.js";

afterEach(cleanup);

const item = (id: string, severity: number, title: string): AttentionItem =>
  ({ id, severity, title, ts: "2026-09-04T10:00:00.000Z" } as AttentionItem);

const dock = (items: AttentionItem[]) => {
  const opened: number[] = [];
  const { container } = render(<Dock items={items} onOpenQueue={() => opened.push(1)} />);
  return { bar: container.firstElementChild as HTMLElement, opened };
};

describe("the dock when something is waiting", () => {
  it("takes an accent rule and a tinted ground, instead of reading as chrome", () => {
    const { bar } = dock([item("a", 1, "Grant Bash to clio")]);
    expect(bar.className).toContain("border-accent");
    expect(bar.className).toContain("bg-accent/[0.08]");
    expect(bar.className).not.toContain("bg-surface");
  });

  it("says how many, so the count is legible without opening anything", () => {
    dock([item("a", 1, "Grant Bash to clio"), item("b", 2, "Review report")]);
    expect(screen.getByText("Needs you · 2")).toBeTruthy();
  });

  it("still opens the queue from a chip", () => {
    const { opened } = dock([item("a", 1, "Grant Bash to clio")]);
    fireEvent.click(screen.getByText("Grant Bash to clio"));
    expect(opened).toHaveLength(1);
  });
});

describe("the dock when nothing is waiting", () => {
  it("goes back to furniture — a bar that always shouts teaches you to stop looking", () => {
    const { bar } = dock([]);
    expect(bar.className).toContain("bg-surface");
    expect(bar.className).not.toContain("border-accent");
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByText("Nothing. Inbox clear.")).toBeTruthy();
  });

  it("records the count on the element, so the two states are distinguishable in a walk", () => {
    expect(dock([]).bar.getAttribute("data-waiting")).toBe("0");
    expect(dock([item("a", 1, "x")]).bar.getAttribute("data-waiting")).toBe("1");
  });
});
