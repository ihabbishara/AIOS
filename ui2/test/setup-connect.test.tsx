// ui2/test/setup-connect.test.tsx — the Connect step: three cards over one status endpoint,
// per-channel verify, the Telegram capture → primary flow, and the two ways out (skip/continue —
// the same generic advance).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { Setup } from "../src/views/Setup.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type Reply = { status?: number; body: unknown };
function stub(routes: Record<string, Reply | (() => Reply | Promise<Reply>)>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input).split("?")[0]}`;
    calls.push(key);
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: `no stub for ${key}` }), { status: 404 });
    const r = await (typeof route === "function" ? route() : route);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
  return calls;
}

const OFF = { connected: false };
const STATUS = { telegram: OFF, slack: OFF, image: { connected: false, model: "gemini-2.5-flash-image" } };

describe("connect step", () => {
  it("renders the three cards and the rail includes Connect", async () => {
    stub({ "GET /api/onboarding/connect": { body: STATUS } });
    render(<Setup step="connect" onStepChange={() => {}} />);
    expect(await screen.findByTestId("connect-card-telegram")).toBeTruthy();
    expect(screen.getByTestId("connect-card-slack")).toBeTruthy();
    expect(screen.getByTestId("connect-card-image")).toBeTruthy();
    expect(screen.getAllByText("Connect").length).toBeGreaterThan(0); // rail label
  });

  it("telegram verify happy path shows the bot name and flips to the capture prompt", async () => {
    let status: typeof STATUS | Record<string, unknown> = STATUS;
    stub({
      "GET /api/onboarding/connect": () => ({ body: status }),
      "POST /api/onboarding/connect/telegram": () => {
        status = { ...STATUS, telegram: { connected: true, botUsername: "aios_bot" } };
        return { body: status };
      },
    });
    render(<Setup step="connect" onStepChange={() => {}} />);
    const card = await screen.findByTestId("connect-card-telegram");
    fireEvent.change(card.querySelector("input")!, { target: { value: "12:abc" } });
    fireEvent.click(within(card).getByText("Verify"));
    expect(await screen.findByText("@aios_bot")).toBeTruthy();
    expect(screen.getByText(/I sent it — listen/)).toBeTruthy();
  });

  it("capture flow: listen → captured chat → confirm posts primary", async () => {
    let primaried = "";
    let tg: Record<string, unknown> = { connected: true, botUsername: "aios_bot" };
    stub({
      "GET /api/onboarding/connect": () => ({ body: { ...STATUS, telegram: tg } }),
      "POST /api/onboarding/connect/telegram/capture": {
        body: { captured: { chatId: "12345", chatType: "private", from: "Ihab", fromId: "999", text: "hi" } },
      },
      "POST /api/onboarding/connect/telegram/primary": () => {
        primaried = "yes";
        tg = { connected: true, botUsername: "aios_bot", primaryChat: "telegram:12345" };
        return { body: { ...STATUS, telegram: tg } };
      },
    });
    render(<Setup step="connect" onStepChange={() => {}} />);
    fireEvent.click(await screen.findByText(/I sent it — listen/));
    expect(await screen.findByText("12345")).toBeTruthy();
    fireEvent.click(screen.getByText("Yes, use this chat"));
    await waitFor(() => expect(primaried).toBe("yes"));
    expect(await screen.findByText("telegram:12345")).toBeTruthy();
  });

  it("a card error renders inline on 400", async () => {
    stub({
      "GET /api/onboarding/connect": { body: STATUS },
      "POST /api/onboarding/connect/telegram": { status: 400, body: { error: "Telegram rejected the token: Unauthorized" } },
    });
    render(<Setup step="connect" onStepChange={() => {}} />);
    const card = await screen.findByTestId("connect-card-telegram");
    fireEvent.change(card.querySelector("input")!, { target: { value: "bad" } });
    fireEvent.click(within(card).getByText("Verify"));
    expect(await screen.findByText(/Unauthorized/)).toBeTruthy();
  });

  it("'Connect later' posts the generic advance and moves to interview", async () => {
    const steps: string[] = [];
    const calls = stub({
      "GET /api/onboarding/connect": { body: STATUS },
      "POST /api/onboarding/advance": { body: { step: "interview" } },
    });
    render(<Setup step="connect" onStepChange={(s) => steps.push(s)} />);
    fireEvent.click(await screen.findByText("Connect later"));
    await waitFor(() => expect(steps).toEqual(["interview"]));
    expect(calls).toContain("POST /api/onboarding/advance");
  });

  it("the footer flips to Continue once any card is connected", async () => {
    stub({ "GET /api/onboarding/connect": { body: { ...STATUS, image: { connected: true, model: "m" } } } });
    render(<Setup step="connect" onStepChange={() => {}} />);
    expect(await screen.findByText("Continue")).toBeTruthy();
    expect(screen.queryByText("Connect later")).toBeNull();
  });
});
