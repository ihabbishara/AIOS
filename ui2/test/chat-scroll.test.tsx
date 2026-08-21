// ui2/test/chat-scroll.test.tsx — the chat lands on the NEWEST message. The log mounts once at
// app boot behind a closed drawer with a localStorage backlog at scrollTop 0; nothing used to
// scroll on open or on SSE-pushed appends (only send-paths did).
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Chat } from "../src/components/Chat.js";
import { stubApi } from "./stubs.js";
import type { StoredEvent } from "../src/api.js";

afterEach(cleanup);

const BACKLOG = Array.from({ length: 30 }, (_, i) => ({
  who: i % 2 ? "neo" : "you", text: `msg ${i}`, ts: new Date(2026, 7, 20, 10, i).toISOString(),
}));

function push(id: number, text: string): StoredEvent {
  return {
    id, ts: new Date().toISOString(),
    event: { type: "chat.out", channel: "web", chatId: "ui", pushed: true, text } as never,
  };
}

/** jsdom has no layout: give the scroller a fake content height and force the
 *  scrollTop fallback path by removing Element#scrollTo. */
function primeScroller(): HTMLElement {
  const el = screen.getByTestId("chat-scroller");
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 500 });
  Object.defineProperty(el, "scrollTo", { configurable: true, value: undefined });
  el.scrollTop = 0;
  return el;
}

beforeEach(() => {
  stubApi({ "/api/org": [], "/api/mail/unread": { total: 0, byAgent: {} } });
  localStorage.setItem("aios_chat_log", JSON.stringify(BACKLOG));
});

describe("chat scroll", () => {
  it("scrolls to the bottom when the drawer opens on a backlog", () => {
    const { rerender } = render(
      <Chat open={false} state={undefined} events={[]} target="neo" setTarget={() => {}} />,
    );
    const el = primeScroller();
    expect(el.scrollTop).toBe(0); // closed: untouched
    rerender(<Chat open={true} state={undefined} events={[]} target="neo" setTarget={() => {}} />);
    expect(el.scrollTop).toBe(500);
  });

  it("follows SSE-pushed messages while open", () => {
    const { rerender } = render(
      <Chat open={true} state={undefined} events={[]} target="neo" setTarget={() => {}} />,
    );
    const el = primeScroller();
    el.scrollTop = 0; // pretend the open-scroll happened at an older height
    rerender(<Chat open={true} state={undefined} events={[push(1, "done!")]} target="neo" setTarget={() => {}} />);
    expect(screen.getByText("done!")).toBeTruthy();
    expect(el.scrollTop).toBe(500);
  });

  it("stays quiet while closed, then lands at the bottom on the next open", () => {
    const { rerender } = render(
      <Chat open={false} state={undefined} events={[]} target="neo" setTarget={() => {}} />,
    );
    const el = primeScroller();
    rerender(<Chat open={false} state={undefined} events={[push(2, "while away")]} target="neo" setTarget={() => {}} />);
    expect(el.scrollTop).toBe(0); // closed: no scroll writes
    rerender(<Chat open={true} state={undefined} events={[push(2, "while away")]} target="neo" setTarget={() => {}} />);
    expect(el.scrollTop).toBe(500);
  });
});
