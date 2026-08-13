// test/channel-boot.test.ts
import { describe, it, expect } from "vitest";
import { startChannels } from "../src/channels/boot.js";
import type { ChannelAdapter, MessageHandler } from "../src/channels/types.js";

const noop: MessageHandler = async () => {};

function fake(started: string[], name: string, failWith?: string): ChannelAdapter {
  return {
    name,
    start: async () => {
      if (failWith) throw new Error(failWith);
      started.push(name);
    },
    send: async () => {},
  } as unknown as ChannelAdapter;
}

describe("startChannels", () => {
  it("starts good channels, removes and reports the bad one, never throws", async () => {
    const started: string[] = [];
    const lines: string[] = [];
    const channels = new Map<string, ChannelAdapter>([
      ["bad", fake(started, "bad", "getMe failed (401: Unauthorized)")],
      ["good", fake(started, "good")],
    ]);
    const failures = await startChannels(channels, noop, (l) => lines.push(l));
    expect(failures).toEqual([{ name: "bad", reason: "getMe failed (401: Unauthorized)" }]);
    expect(channels.has("bad")).toBe(false);
    expect(channels.has("good")).toBe(true);
    expect(started).toEqual(["good"]);
    expect(lines.some((l) => l.includes("channel up: good"))).toBe(true);
    expect(lines.some((l) => l.includes("channel FAILED: bad") && l.includes("disabled; daemon continues"))).toBe(true);
  });
  it("all succeed → empty failure list", async () => {
    const started: string[] = [];
    const channels = new Map<string, ChannelAdapter>([["a", fake(started, "a")], ["b", fake(started, "b")]]);
    expect(await startChannels(channels, noop, () => {})).toEqual([]);
    expect(started).toEqual(["a", "b"]);
  });
  it("all fail → all removed, all reported, resolves", async () => {
    const channels = new Map<string, ChannelAdapter>([
      ["x", fake([], "x", "boom-x")],
      ["y", fake([], "y", "boom-y")],
    ]);
    const failures = await startChannels(channels, noop, () => {});
    expect(failures.map((f) => f.name)).toEqual(["x", "y"]);
    expect(channels.size).toBe(0);
  });
});

/** An adapter whose start() never settles, plus a record of whether it was asked to stop. */
function hung(name: string): ChannelAdapter & { stopped: boolean } {
  const ch = {
    name,
    start: () => new Promise<void>(() => {}), // never settles — the whole point
    stop: async () => { ch.stopped = true; },
    send: async () => {},
    stopped: false,
  };
  return ch as unknown as ChannelAdapter & { stopped: boolean };
}

describe("a channel that hangs instead of failing", () => {
  // The parked bug: start() was awaited with no bound, and bootNormal does not start the web
  // server until long after this call — so a channel that never settled took the cockpit with
  // it, permanently, with nothing in the log to say why.
  it("is bounded, reported, and never holds the daemon", async () => {
    const lines: string[] = [];
    const stuck = hung("slack");
    const started: string[] = [];
    const channels = new Map<string, ChannelAdapter>([
      ["slack", stuck],
      ["telegram", fake(started, "telegram")],
    ]);

    const failures = await startChannels(channels, noop, (l) => lines.push(l), { timeoutMs: 30 });

    expect(failures).toEqual([{ name: "slack", reason: "did not start within 30ms" }]);
    expect(channels.has("slack")).toBe(false);
    // The whole point: the other channel is up and the daemon carried on.
    expect(channels.has("telegram")).toBe(true);
    expect(started).toEqual(["telegram"]);
    expect(lines.some((l) => l.includes("channel FAILED: slack") && l.includes("daemon continues"))).toBe(true);
  });

  it("asks the timed-out adapter to stop, so it cannot connect behind the daemon's back", async () => {
    const stuck = hung("slack");
    const channels = new Map<string, ChannelAdapter>([["slack", stuck]]);
    await startChannels(channels, noop, () => {}, { timeoutMs: 20 });
    expect(stuck.stopped).toBe(true);
  });

  it("does not stop an adapter whose start threw — it never got going", async () => {
    let stopped = false;
    const ch = {
      name: "bad", start: async () => { throw new Error("401"); },
      stop: async () => { stopped = true; }, send: async () => {},
    } as unknown as ChannelAdapter;
    const channels = new Map<string, ChannelAdapter>([["bad", ch]]);
    const failures = await startChannels(channels, noop, () => {}, { timeoutMs: 50 });
    expect(failures).toEqual([{ name: "bad", reason: "401" }]);
    expect(stopped).toBe(false);
  });

  it("starts channels concurrently, so one slow handshake does not delay the rest", async () => {
    // Deterministic rather than timed: `first` cannot finish until `second` has been ENTERED, so
    // a sequential implementation would leave it waiting until its own timeout and report a
    // failure. Both succeeding is only possible if the two starts overlap.
    let secondEntered!: () => void;
    const entered = new Promise<void>((r) => { secondEntered = r; });
    const channels = new Map<string, ChannelAdapter>([
      ["first", { name: "first", start: async () => { await entered; }, stop: async () => {}, send: async () => {} } as unknown as ChannelAdapter],
      ["second", { name: "second", start: async () => { secondEntered(); }, stop: async () => {}, send: async () => {} } as unknown as ChannelAdapter],
    ]);
    expect(await startChannels(channels, noop, () => {}, { timeoutMs: 500 })).toEqual([]);
    expect(channels.size).toBe(2);
  });

  it("takes the timeout from the environment when no override is given", async () => {
    const prev = process.env.AIOS_CHANNEL_START_TIMEOUT_MS;
    process.env.AIOS_CHANNEL_START_TIMEOUT_MS = "25";
    try {
      const channels = new Map<string, ChannelAdapter>([["slack", hung("slack")]]);
      const failures = await startChannels(channels, noop, () => {});
      expect(failures[0]!.reason).toBe("did not start within 25ms");
    } finally {
      if (prev === undefined) delete process.env.AIOS_CHANNEL_START_TIMEOUT_MS;
      else process.env.AIOS_CHANNEL_START_TIMEOUT_MS = prev;
    }
  });
});
