// test/channel-boot.test.ts
import { describe, it, expect, vi } from "vitest";
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
    expect(lines.some((l) => l.includes("channel FAILED: bad") && l.includes("daemon continues"))).toBe(true);
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

/** An adapter whose start() settles only when the test says so, plus whether it was stopped. */
function deferred(name: string) {
  let resolve: () => void = () => {};
  let reject: (e: Error) => void = () => {};
  const ch = {
    name,
    starts: 0,
    stopped: false,
    start: () => {
      ch.starts++;
      return new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    },
    stop: async () => { ch.stopped = true; },
    send: async () => {},
    connect: () => resolve(),
    fail: (e: Error) => reject(e),
  };
  return ch;
}
const adapter = (d: ReturnType<typeof deferred>) => d as unknown as ChannelAdapter;

describe("a channel that hangs instead of failing", () => {
  // The parked bug: start() was awaited with no bound, and bootNormal does not start the web
  // server until long after this call — so a channel that never settled took the cockpit with
  // it, permanently, with nothing in the log to say why.
  it("is bounded, reported, and never holds the daemon", async () => {
    const lines: string[] = [];
    const stuck = deferred("slack");
    const started: string[] = [];
    const channels = new Map<string, ChannelAdapter>([
      ["slack", adapter(stuck)],
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

  it("never stops a timed-out adapter — stopping Slack mid-reconnect is what crashed the daemon", async () => {
    const stuck = deferred("slack");
    const channels = new Map<string, ChannelAdapter>([["slack", adapter(stuck)]]);
    await startChannels(channels, noop, () => {}, { timeoutMs: 20 });
    expect(stuck.stopped).toBe(false);
  });

  it("a timed-out start that connects later rejoins the map and clears its failure entry", async () => {
    const lines: string[] = [];
    const slow = deferred("slack");
    const channels = new Map<string, ChannelAdapter>([["slack", adapter(slow)]]);
    const failures = await startChannels(channels, noop, (l) => lines.push(l), { timeoutMs: 20 });
    expect(failures).toHaveLength(1);
    expect(channels.has("slack")).toBe(false);

    slow.connect();
    await vi.waitFor(() => expect(channels.has("slack")).toBe(true));
    // The SAME array the caller holds — bootNormal's degraded() closure reads it on every brief.
    expect(failures).toEqual([]);
    // Awaited, not restarted: a second start() would open a second socket.
    expect(slow.starts).toBe(1);
    expect(lines.some((l) => l.includes("channel up (late): slack"))).toBe(true);
  });

  it("a timed-out start that later fails is retried, and rejoins when a retry connects", async () => {
    const flaky = deferred("slack");
    const channels = new Map<string, ChannelAdapter>([["slack", adapter(flaky)]]);
    const failures = await startChannels(channels, noop, () => {}, { timeoutMs: 20, retryBaseMs: 5 });
    flaky.fail(new Error("socket closed"));
    await vi.waitFor(() => expect(flaky.starts).toBe(2));
    expect(failures[0]!.reason).toBe("socket closed");
    flaky.connect();
    await vi.waitFor(() => expect(channels.has("slack")).toBe(true));
    expect(failures).toEqual([]);
  });

  it("a start that threw is retried in the background with backoff, and rejoins when it succeeds", async () => {
    // The 2026-08-30 shape: a boot with no network. getMe throws, and the old code disabled the
    // channel for the whole session — three days, until a human restarted the daemon.
    const lines: string[] = [];
    let calls = 0;
    const ch = {
      name: "telegram",
      start: async () => { calls++; if (calls < 3) throw new Error(`getMe failed (${calls})`); },
      stop: async () => {},
      send: async () => {},
    } as unknown as ChannelAdapter;
    const channels = new Map<string, ChannelAdapter>([["telegram", ch]]);
    const failures = await startChannels(channels, noop, (l) => lines.push(l), { retryBaseMs: 5, retryMaxMs: 20 });
    expect(failures).toEqual([{ name: "telegram", reason: "getMe failed (1)" }]);
    expect(channels.has("telegram")).toBe(false);

    await vi.waitFor(() => expect(channels.has("telegram")).toBe(true), { timeout: 2000 });
    expect(calls).toBe(3);
    expect(failures).toEqual([]);
    expect(lines.some((l) => l.includes("channel up (late): telegram after 2 retries"))).toBe(true);
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
      const channels = new Map<string, ChannelAdapter>([["slack", adapter(deferred("slack"))]]);
      const failures = await startChannels(channels, noop, () => {});
      expect(failures[0]!.reason).toBe("did not start within 25ms");
    } finally {
      if (prev === undefined) delete process.env.AIOS_CHANNEL_START_TIMEOUT_MS;
      else process.env.AIOS_CHANNEL_START_TIMEOUT_MS = prev;
    }
  });
});
