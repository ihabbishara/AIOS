// ui2/test/setup-scroll.test.tsx — the wizard's shell must be able to scroll to its own top.
//
// Ground truth (2026-09-04, measured in Chrome on the connect step at a 687px viewport):
// the shell was ONE box carrying both `overflow-y-auto` and `justify-center`. Content taller
// than the viewport was therefore centred, which puts its top ABOVE scrollTop 0 — a position no
// scroll can reach. scrollHeight was 1213 against a clientHeight of 687, and the step rail sat
// at -501px with the scrollbar already at the top. On screen the connect card began mid-sentence
// ("everything here is editable later in System → Config.") and its heading was simply gone.
//
// jsdom does no layout, so this pins the STRUCTURE that made the geometry impossible rather than
// the geometry itself: centring and scrolling may not share a box, and the inner box must be at
// least full height or short steps stop being centred.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Setup } from "../src/views/Setup.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function shell(step: string) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
  const { container } = render(<Setup step={step} onStepChange={() => {}} />);
  const scroller = container.firstElementChild as HTMLElement;
  return { scroller, inner: scroller.firstElementChild as HTMLElement };
}

describe("the wizard shell can reach its own top", () => {
  it("does not centre and scroll on the same box", () => {
    const { scroller } = shell("welcome");
    const cls = scroller.className;
    expect(cls).toContain("overflow-y-auto");
    // The exact pairing that made the top unreachable.
    expect(cls).not.toContain("justify-center");
  });

  it("centres on an inner box that is at least full height", () => {
    const { inner } = shell("welcome");
    expect(inner.className).toContain("min-h-full");
    expect(inner.className).toContain("justify-center");
    // min-h-full, not h-full: a fixed full height would clip tall steps just as badly.
    // Token-wise, because "h-full" is a substring of "min-h-full".
    expect([...inner.classList]).not.toContain("h-full");
  });

  it("keeps the whole wizard inside the scroller on every step", () => {
    // Each step's content must be a descendant of the scrolling box — a sibling would be
    // unreachable in exactly the way this fix exists to prevent.
    for (const step of ["welcome", "auth", "workspace", "connect", "interview", "review", "provision", "first-job", "done"]) {
      const { scroller, inner } = shell(step);
      expect(scroller.children).toHaveLength(1);
      expect(inner.querySelector("ol")).not.toBeNull(); // the step rail
      cleanup();
    }
  });
});
