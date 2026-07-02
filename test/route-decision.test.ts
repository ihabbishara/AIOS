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
  const resetCalls: Array<{ role: string; channel: string; chatId: string }> = [];
  const directChats = {
    names: () => ["vulcan", "developer", "hermes"],
    canonical: (nameOrAlias: string) => {
      const map: Record<string, string> = {
        vulcan: "vulcan",
        developer: "vulcan", // alias -> canonical
        hermes: "hermes",
      };
      return map[nameOrAlias];
    },
    handle: async (_role: string, _channel: string, _chatId: string, _text: string) =>
      ({ text: "direct-reply", attachments: [] }),
    resetSession: (role: string, channel: string, chatId: string) => {
      resetCalls.push({ role, channel, chatId });
    },
  };

  const moderator = {
    handle: async () => "moderator-reply",
    resetSession: () => {},
  };

  const router = new MessageRouter({
    moderator: moderator as never,
    directChats: directChats as never,
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
    chatBindings,
    bus,
  });

  return { router, routerWithMentionOnlyBinding, events, bus, resetCalls };
}

describe("route.decision", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("emits mention routing with agent name", async () => {
    const { router, events } = ctx;
    await router.handle({ channel: "cli", chatId: "c", text: "@vulcan fix the bug" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.to).toBe("vulcan");
    expect(ev.via).toBe("mention");
    expect(ev.channel).toBe("cli");
    expect(ev.chatId).toBe("c");
  });

  it("emits default routing to the chief of staff", async () => {
    const { router, events } = ctx;
    await router.handle({ channel: "cli", chatId: "c", text: "hello" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.to).toBe("hermes");
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
      names: () => ["vulcan"],
      canonical: (n: string) => (n === "vulcan" ? "vulcan" : undefined),
      handle: async () => ({ text: "reply", attachments: [] }),
      resetSession: () => {},
    };
    const chatBindings = new Map([
      ["tg:g", { agents: ["vulcan", "hermes"], mentionOnly: false }],
    ]);
    const router = new MessageRouter({
      moderator: { handle: async () => "mod", resetSession: () => {} } as never,
      directChats: directChats as never,
      chatBindings,
      bus,
    });

    await router.handle({ channel: "tg", chatId: "g", text: "@vulcan help me" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.via).toBe("mention");
    expect(ev.to).toBe("vulcan");
    expect(ev.reason).toContain("mention of vulcan");
  });

  it("emits binding routing via first bound agent when no mention", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const events: StoredEvent[] = [];
    bus.on((e) => events.push(e));

    const directChats = {
      names: () => ["vulcan"],
      canonical: (n: string) => (n === "vulcan" ? "vulcan" : undefined),
      handle: async () => ({ text: "reply", attachments: [] }),
      resetSession: () => {},
    };
    const chatBindings = new Map([
      ["tg:g", { agents: ["vulcan"], mentionOnly: false }],
    ]);
    const router = new MessageRouter({
      moderator: { handle: async () => "mod", resetSession: () => {} } as never,
      directChats: directChats as never,
      chatBindings,
      bus,
    });

    await router.handle({ channel: "tg", chatId: "g", text: "help me" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.via).toBe("binding");
    expect(ev.to).toBe("vulcan");
    expect(ev.reason).toBe("first bound agent");
  });

  it("resolves alias in unbound mention: @developer → vulcan canonical", async () => {
    const { router, events } = ctx;
    await router.handle({ channel: "cli", chatId: "c", text: "@developer fix this" });
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.to).toBe("vulcan");
    expect(ev.via).toBe("mention");
  });

  it("/reset @developer emits to canonical target and calls resetSession", async () => {
    const { router, events, resetCalls } = ctx;
    await router.handle({ channel: "cli", chatId: "c", text: "/reset @developer" });
    // route.decision resolves the alias to canonical "vulcan"
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.to).toBe("vulcan");
    expect(ev.via).toBe("reset");
    // resetSession was called (with the alias — real DirectChats.resetSession canonicalizes internally)
    expect(resetCalls).toHaveLength(1);
    expect(resetCalls[0].role).toBe("developer");
  });

  it("/reset @nonexistent emits NO route.decision", async () => {
    const { router, events } = ctx;
    await router.handle({ channel: "cli", chatId: "c", text: "/reset @nonexistent" });
    expect(events.some((e) => e.event.type === "route.decision")).toBe(false);
  });

  it("@finance in bound group resolves to juno (canonical) and passes sender", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const events: StoredEvent[] = [];
    bus.on((e) => events.push(e));

    let capturedRole: string | undefined;
    let capturedSender: unknown;

    const directChats = {
      names: () => ["juno", "finance"],
      canonical: (n: string) => n === "finance" ? "juno" : n === "juno" ? "juno" : undefined,
      handle: async (role: string, _ch: string, _cid: string, _text: string, sender: unknown) => {
        capturedRole = role;
        capturedSender = sender;
        return { text: "ledger reply", attachments: [] };
      },
      resetSession: () => {},
    };

    const chatBindings = new Map([
      ["tg:group-42", { agents: ["finance"], mentionOnly: false }],
    ]);

    const router = new MessageRouter({
      moderator: { handle: async () => "mod", resetSession: () => {} } as never,
      directChats: directChats as never,
      chatBindings,
      bus,
    });

    const sender = { name: "Alice", username: "alice" };
    await router.handle({ channel: "tg", chatId: "group-42", text: "@finance paid 40 for domain", sender });

    // handle was called with alias "finance"; canonical("finance") === "juno"
    expect(capturedRole).toBe("finance");
    expect(directChats.canonical(capturedRole!)).toBe("juno");
    // sender forwarded so juno can prepend [from: Alice (@alice)]
    expect(capturedSender).toEqual(sender);

    // route.decision emits the canonical name
    const ev = events.find((e) => e.event.type === "route.decision")!.event as any;
    expect(ev.to).toBe("juno");
    expect(ev.via).toBe("mention");
  });
});

// ── router forwards attachments to directChats.handle ────────────────────────
describe("router attachment forwarding", () => {
  it("passes msg.attachments to directChats.handle for direct address", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    let capturedAttachments: unknown;

    const directChats = {
      names: () => ["vulcan"],
      canonical: (n: string) => (n === "vulcan" ? "vulcan" : undefined),
      handle: async (
        _role: string,
        _channel: string,
        _chatId: string,
        _text: string,
        _sender: unknown,
        attachments: unknown,
      ) => {
        capturedAttachments = attachments;
        return { text: "reply", attachments: [] };
      },
      resetSession: () => {},
    };

    const router = new MessageRouter({
      moderator: { handle: async () => "mod", resetSession: () => {} } as never,
      directChats: directChats as never,
      chatBindings: new Map(),
      bus,
    });

    const fakeAttachments = [{ path: "/vault/inv.pdf", fileName: "inv.pdf" }];
    await router.handle({
      channel: "cli",
      chatId: "c",
      text: "@vulcan here is my invoice",
      attachments: fakeAttachments,
    });

    expect(capturedAttachments).toEqual(fakeAttachments);
  });

  it("passes msg.attachments to directChats.handle for binding route", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    let capturedAttachments: unknown;

    const directChats = {
      names: () => ["vulcan"],
      canonical: (n: string) => (n === "vulcan" ? "vulcan" : undefined),
      handle: async (
        _role: string,
        _channel: string,
        _chatId: string,
        _text: string,
        _sender: unknown,
        attachments: unknown,
      ) => {
        capturedAttachments = attachments;
        return { text: "reply", attachments: [] };
      },
      resetSession: () => {},
    };

    const chatBindings = new Map([["tg:g", { agents: ["vulcan"], mentionOnly: false }]]);
    const router = new MessageRouter({
      moderator: { handle: async () => "mod", resetSession: () => {} } as never,
      directChats: directChats as never,
      chatBindings,
      bus,
    });

    const fakeAttachments = [{ path: "/vault/receipt.pdf", fileName: "receipt.pdf" }];
    await router.handle({
      channel: "tg",
      chatId: "g",
      text: "here is the receipt",
      attachments: fakeAttachments,
    });

    expect(capturedAttachments).toEqual(fakeAttachments);
  });
});
