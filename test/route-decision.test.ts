// test/route-decision.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus, type StoredEvent } from "../src/events.js";
import { MessageRouter } from "../src/router.js";

function setup() {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const events: StoredEvent[] = [];
  bus.on((e) => events.push(e));

  // Stub directChats: supports names(), canonical(), handle(), resetSession()
  const directChats = {
    names: () => ["maya", "developer", "rami"],
    canonical: (nameOrAlias: string) => {
      const map: Record<string, string> = {
        maya: "maya",
        developer: "maya", // alias -> canonical
        rami: "rami",
      };
      return map[nameOrAlias];
    },
    handle: async (_role: string, _channel: string, _chatId: string, _text: string) =>
      ({ text: "direct-reply", attachments: [] }),
    resetSession: (_role: string, _channel: string, _chatId: string) => {},
  };

  const moderator = {
    handle: async () => "moderator-reply",
    resetSession: () => {},
  };

  const finance = {
    handle: async () => "finance-reply",
  };

  const router = new MessageRouter({
    moderator: moderator as never,
    directChats: directChats as never,
    finance: finance as never,
    chatBindings: new Map(),
    bus,
  });

  // Router with a binding that is mention-only (silence on unaddressed messages)
  const chatBindings = new Map([
    ["tg:g", { agents: ["maya"], mentionOnly: true }],
  ]);
  const routerWithMentionOnlyBinding = new MessageRouter({
    moderator: moderator as never,
    directChats: directChats as never,
    finance: finance as never,
    chatBindings,
    bus,
  });

  return { router, routerWithMentionOnlyBinding, events, bus };
}

describe("route.decision", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("emits mention routing with agent name", async () => {
    const { router, events } = ctx;
    await router.handle({ channel: "cli", chatId: "c", text: "@maya fix the bug" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.to).toBe("maya");
    expect(ev.via).toBe("mention");
    expect(ev.channel).toBe("cli");
    expect(ev.chatId).toBe("c");
  });

  it("emits default routing to the chief of staff", async () => {
    const { router, events } = ctx;
    await router.handle({ channel: "cli", chatId: "c", text: "hello" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.to).toBe("rami");
    expect(ev.via).toBe("default");
    expect(ev.reason).toBe("no mention — chief of staff");
  });

  it("emits verdict routing for /approve", async () => {
    const { router, events } = ctx;
    await router.handle({ channel: "cli", chatId: "c", text: "/approve abc123" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.via).toBe("verdict");
    expect(ev.to).toBe("gate");
    expect(ev.reason).toBe("/approve|/reject intercept");
  });

  it("emits verdict routing for /reject", async () => {
    const { router, events } = ctx;
    await router.handle({ channel: "cli", chatId: "c", text: "/reject abc123 too noisy" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.via).toBe("verdict");
    expect(ev.to).toBe("gate");
  });

  it("emits reset routing for /reset", async () => {
    const { router, events } = ctx;
    await router.handle({ channel: "cli", chatId: "c", text: "/reset" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.via).toBe("reset");
    expect(ev.reason).toBe("session reset");
  });

  it("mention-only silence emits nothing", async () => {
    const { routerWithMentionOnlyBinding, events } = ctx;
    await routerWithMentionOnlyBinding.handle({ channel: "tg", chatId: "g", text: "morning all" });
    expect(events.some((e) => e.event.type === "route.decision")).toBe(false);
  });

  it("emits binding routing via mention in a bound chat", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const events: StoredEvent[] = [];
    bus.on((e) => events.push(e));

    const directChats = {
      names: () => ["maya"],
      canonical: (n: string) => (n === "maya" ? "maya" : undefined),
      handle: async () => ({ text: "reply", attachments: [] }),
      resetSession: () => {},
    };
    const chatBindings = new Map([
      ["tg:g", { agents: ["maya", "rami"], mentionOnly: false }],
    ]);
    const router = new MessageRouter({
      moderator: { handle: async () => "mod", resetSession: () => {} } as never,
      directChats: directChats as never,
      finance: { handle: async () => "fin" } as never,
      chatBindings,
      bus,
    });

    await router.handle({ channel: "tg", chatId: "g", text: "@maya help me" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.via).toBe("mention");
    expect(ev.to).toBe("maya");
    expect(ev.reason).toContain("mention of maya");
  });

  it("emits binding routing via first bound agent when no mention", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const events: StoredEvent[] = [];
    bus.on((e) => events.push(e));

    const directChats = {
      names: () => ["maya"],
      canonical: (n: string) => (n === "maya" ? "maya" : undefined),
      handle: async () => ({ text: "reply", attachments: [] }),
      resetSession: () => {},
    };
    const chatBindings = new Map([
      ["tg:g", { agents: ["maya"], mentionOnly: false }],
    ]);
    const router = new MessageRouter({
      moderator: { handle: async () => "mod", resetSession: () => {} } as never,
      directChats: directChats as never,
      finance: { handle: async () => "fin" } as never,
      chatBindings,
      bus,
    });

    await router.handle({ channel: "tg", chatId: "g", text: "help me" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.via).toBe("binding");
    expect(ev.to).toBe("maya");
    expect(ev.reason).toBe("first bound agent");
  });
});
