import { describe, it, expect, vi } from "vitest";
import { dispatchAttachments } from "../src/channels/dispatch.js";
import type { ChannelAdapter } from "../src/channels/types.js";

function fakeChannel() {
  return {
    name: "fake",
    start: vi.fn(), send: vi.fn(), stop: vi.fn(),
    sendFile: vi.fn(async () => {}),
    sendVoice: vi.fn(async () => {}),
  } as unknown as ChannelAdapter & { sendFile: ReturnType<typeof vi.fn>; sendVoice: ReturnType<typeof vi.fn> };
}

describe("dispatchAttachments", () => {
  it("routes voice to sendVoice and other files to sendFile", async () => {
    const ch = fakeChannel();
    await dispatchAttachments(ch, "42", [
      { path: "/tmp/aios-x/a.ogg", kind: "voice", caption: "hi" },
      { path: "/tmp/aios-x/b.png", caption: "chart" },
    ]);
    expect(ch.sendVoice).toHaveBeenCalledWith("42", "/tmp/aios-x/a.ogg", "hi");
    expect(ch.sendFile).toHaveBeenCalledWith("42", "/tmp/aios-x/b.png", "chart");
  });

  it("falls back to sendFile when the channel has no sendVoice", async () => {
    const ch = fakeChannel();
    (ch as unknown as { sendVoice?: unknown }).sendVoice = undefined;
    await dispatchAttachments(ch, "1", [{ path: "/tmp/aios-x/v.ogg", kind: "voice" }]);
    expect(ch.sendFile).toHaveBeenCalledWith("1", "/tmp/aios-x/v.ogg", undefined);
  });

  it("logs and swallows a delivery error instead of throwing", async () => {
    const ch = fakeChannel();
    ch.sendFile = vi.fn(async () => { throw new Error("boom"); });
    const log = vi.fn();
    await expect(dispatchAttachments(ch, "1", [{ path: "/tmp/aios-x/b.png" }], log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("no-ops on an undefined channel", async () => {
    await expect(dispatchAttachments(undefined, "1", [{ path: "/tmp/aios-x/b.png" }])).resolves.toBeUndefined();
  });
});
