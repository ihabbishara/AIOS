import { describe, it, expect } from "vitest";
import { deliverReply } from "../src/voice/mirror.js";
import type { ChannelAdapter, InboundMessage } from "../src/channels/types.js";

function fakeChannel(withVoice: boolean) {
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  const ch: ChannelAdapter = {
    name: "fake",
    start: async () => {},
    stop: async () => {},
    send: async (...args) => { calls.push({ kind: "send", args }); },
    sendFile: async () => {},
    ...(withVoice
      ? { sendVoice: async (...args: unknown[]) => { calls.push({ kind: "voice", args }); } }
      : {}),
  };
  return { ch, calls };
}

function voiceStub(opts: { available?: boolean; fail?: boolean } = {}) {
  return {
    available: () => opts.available ?? true,
    synthesize: async (text: string) => {
      if (opts.fail) throw new Error("tts down");
      return `/tmp/${text.length}.ogg`;
    },
  };
}

const msg = (voiceIn: boolean): InboundMessage => ({ channel: "fake", chatId: "c1", text: "q", voiceIn });

describe("deliverReply", () => {
  it("text message → plain send", async () => {
    const { ch, calls } = fakeChannel(true);
    await deliverReply({ voice: voiceStub() }, ch, msg(false), "answer");
    expect(calls).toEqual([{ kind: "send", args: ["c1", "answer"] }]);
  });

  it("voice in + short reply → single voice note with caption", async () => {
    const { ch, calls } = fakeChannel(true);
    await deliverReply({ voice: voiceStub() }, ch, msg(true), "short answer");
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe("voice");
    expect(calls[0].args[2]).toBe("short answer"); // caption
  });

  it("voice in + long reply → voice note then separate text", async () => {
    const { ch, calls } = fakeChannel(true);
    const long = "x".repeat(1500);
    await deliverReply({ voice: voiceStub() }, ch, msg(true), long);
    expect(calls.map((c) => c.kind)).toEqual(["voice", "send"]);
    expect(calls[0].args[2]).toBeUndefined(); // no caption over the limit
  });

  it("synthesis failure → text fallback, never lost", async () => {
    const { ch, calls } = fakeChannel(true);
    await deliverReply({ voice: voiceStub({ fail: true }) }, ch, msg(true), "answer");
    expect(calls).toEqual([{ kind: "send", args: ["c1", "answer"] }]);
  });

  it("channel without sendVoice → text", async () => {
    const { ch, calls } = fakeChannel(false);
    await deliverReply({ voice: voiceStub() }, ch, msg(true), "answer");
    expect(calls[0].kind).toBe("send");
  });

  it("voice unavailable → text", async () => {
    const { ch, calls } = fakeChannel(true);
    await deliverReply({ voice: voiceStub({ available: false }) }, ch, msg(true), "answer");
    expect(calls[0].kind).toBe("send");
  });

  it("missing channel → no crash", async () => {
    await expect(deliverReply({ voice: voiceStub() }, undefined, msg(true), "x")).resolves.toBeUndefined();
  });
});
