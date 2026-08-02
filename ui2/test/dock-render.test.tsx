// ui2/test/dock-render.test.tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Dock } from "../src/views/home/Dock.js";
import type { AttentionItem } from "../src/api.js";

afterEach(cleanup);

const item = (id: string, severity: AttentionItem["severity"]): AttentionItem => ({
  kind: "approval", id, title: `Task ${id}`, meta: "", severity,
  ts: "2026-08-02T09:00:00.000Z", actions: [], ref: {},
});

describe("Dock", () => {
  it("shows three chips and the remainder", () => {
    render(<Dock items={["a", "b", "c", "d", "e"].map((i) => item(i, 2))} onOpenQueue={() => {}} />);
    expect(screen.getAllByRole("button", { name: /^Task/ })).toHaveLength(3);
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("says the inbox is clear rather than rendering an empty strip", () => {
    render(<Dock items={[]} onOpenQueue={() => {}} />);
    expect(screen.getByText("Nothing. Inbox clear.")).toBeTruthy();
  });

  it("opens the queue when a chip is clicked", () => {
    const onOpenQueue = vi.fn();
    render(<Dock items={[item("a", 1)]} onOpenQueue={onOpenQueue} />);
    fireEvent.click(screen.getByRole("button", { name: "Task a" }));
    expect(onOpenQueue).toHaveBeenCalledOnce();
  });

  it("fills the severity-1 chip and outlines the rest", () => {
    const { container } = render(<Dock items={[item("a", 1), item("b", 3)]} onOpenQueue={() => {}} />);
    expect(container.querySelectorAll(".bg-accent")).toHaveLength(1);
  });
});
