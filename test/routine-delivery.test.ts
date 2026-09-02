// test/routine-delivery.test.ts — a fired routine must run where its answer can be READ.
//
// Ground truth: the OCA sweep was created in Mission Control, so its origin is `web:ui`. `web`
// has no channel adapter, boot's reply path is `channels.get(msg.channel)?.send(...)`, and the
// optional chain dropped every answer silently. The routine fired on time for four days and the
// user saw none of it — the daily-brief routine, created from Telegram, worked the whole time.
import { describe, it, expect } from "vitest";
import { makeRoutineFire, makeReminderFire, deliveryChat } from "../src/heartbeat/routines.js";
import type { InboundMessage } from "../src/channels/types.js";

const PRIMARY = { channel: "telegram", chatId: "1951581144" };
const ROUTINE = { id: 5, name: "OCA & sovereign cloud NL watch", prompt: "Run a daily news sweep." };

function harness(canDeliver?: (c: string) => boolean, primaryChat = PRIMARY as { channel: string; chatId: string } | undefined) {
  const sent: InboundMessage[] = [];
  const lines: string[] = [];
  const deps = {
    onMessage: async (m: InboundMessage) => { sent.push(m); },
    primaryChat, canDeliver, log: (l: string) => lines.push(l),
  };
  return { deps, sent, lines };
}

describe("routine delivery", () => {
  it("runs in the origin chat when that channel can be pushed to", async () => {
    const { deps, sent } = harness((c) => c === "telegram");
    makeRoutineFire(deps)({ ...ROUTINE, channel: "telegram", chatId: "42" });
    await Promise.resolve();
    expect(sent).toEqual([{ channel: "telegram", chatId: "42", text: ROUTINE.prompt }]);
  });

  it("redirects to the primary chat when the origin channel has no adapter", async () => {
    // The bug, exactly: origin web:ui, no `web` adapter, reply dropped by the optional chain.
    const { deps, sent, lines } = harness((c) => c === "telegram");
    makeRoutineFire(deps)({ ...ROUTINE, channel: "web", chatId: "ui" });
    await Promise.resolve();
    expect(sent).toEqual([{ channel: "telegram", chatId: "1951581144", text: ROUTINE.prompt }]);
    expect(lines.some((l) => l.includes("redirected") && l.includes("web"))).toBe(true);
  });

  it("redirects when the origin channel exists but is disconnected right now", async () => {
    const { deps, sent } = harness((c) => c === "telegram"); // slack mid-outage
    makeRoutineFire(deps)({ ...ROUTINE, channel: "slack", chatId: "C123" });
    await Promise.resolve();
    expect(sent[0]!.channel).toBe("telegram");
  });

  it("drops the fire, with a reason, when nothing can receive it", async () => {
    const { deps, sent, lines } = harness(() => false);
    makeRoutineFire(deps)({ ...ROUTINE, channel: "web", chatId: "ui" });
    await Promise.resolve();
    expect(sent).toEqual([]);
    expect(lines.some((l) => l.includes("skipped") && l.includes("no deliverable origin chat"))).toBe(true);
  });

  it("still falls back for an origin-less fire, and honours every channel when unwired", async () => {
    const { deps, sent } = harness(undefined);
    makeRoutineFire(deps)({ ...ROUTINE, channel: "", chatId: "" });
    makeRoutineFire(deps)({ ...ROUTINE, channel: "web", chatId: "ui" });
    await Promise.resolve();
    // No canDeliver wired (tests, CLI): every channel is honoured, as before.
    expect(sent.map((m) => m.channel)).toEqual(["telegram", "web"]);
  });

  it("applies to reminders too", async () => {
    const { deps, sent } = harness((c) => c === "telegram");
    makeReminderFire(deps)({ id: 9, text: "call the notary", channel: "web", chatId: "ui" });
    await Promise.resolve();
    expect(sent[0]!.channel).toBe("telegram");
    expect(sent[0]!.text).toContain("call the notary");
  });
});

describe("deliveryChat", () => {
  it("reports a redirect only when an origin was actually overridden", () => {
    const deps = { onMessage: async () => {}, primaryChat: PRIMARY, canDeliver: (c: string) => c === "telegram", log: () => {} };
    expect(deliveryChat({ channel: "web", chatId: "ui" }, deps)!.redirected).toBe(true);
    expect(deliveryChat({ channel: "", chatId: "" }, deps)!.redirected).toBe(false);
    expect(deliveryChat({ channel: "telegram", chatId: "7" }, deps)!.redirected).toBe(false);
  });

  it("returns null when there is no primary chat to fall back to", () => {
    const deps = { onMessage: async () => {}, primaryChat: undefined, canDeliver: () => false, log: () => {} };
    expect(deliveryChat({ channel: "web", chatId: "ui" }, deps)).toBeNull();
  });
});
