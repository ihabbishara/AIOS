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
