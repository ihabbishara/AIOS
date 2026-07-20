// test/router-gate.test.ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { ExecutorRegistry, type Executor } from "../src/kernel/actions.js";
import { ActionGate } from "../src/kernel/gate.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { MessageRouter } from "../src/router.js";
import { toCoordinator } from "../src/web/server.js";
import { testRegistry } from "./fixtures/registry.js";

function setup() {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const registry = new ExecutorRegistry();
  const echo: Executor = {
    type: "test.echo",
    schema: z.object({ text: z.string() }),
    async execute(p) { return `echo: ${(p as { text: string }).text}`; },
  };
  registry.register(echo);
  const gate = new ActionGate({ store, registry, policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
  // Stubs: gate commands must short-circuit before any agent is consulted.
  const router = new MessageRouter({
    moderator: { handle: async () => ({ text: "rami-reply", attachments: [] }) } as never,
    directChats: { handle: async () => ({ text: "direct-reply", attachments: [] }), names: () => [] } as never,
    chatBindings: new Map(),
    gate,
  });
  return { store, gate, router };
}

describe("router gate commands", () => {
  it("/approve executes the queued action", async () => {
    const { gate, router, store } = setup();
    const row = await gate.propose(
      { type: "test.echo", payload: { text: "hi" }, preview: "Echo hi" },
      { channel: "cli", chatId: "local" },
    );
    const reply = await router.handle({ channel: "cli", chatId: "local", text: `/approve ${row.id}` });
    expect(reply?.text).toContain("Executed");
    expect(reply?.text).toContain("echo: hi");
    expect(store.getAction(row.id)?.status).toBe("executed");
  });

  it("/reject records the reason", async () => {
    const { gate, router, store } = setup();
    const row = await gate.propose(
      { type: "test.echo", payload: { text: "hi" }, preview: "Echo hi" },
      { channel: "cli", chatId: "local" },
    );
    const reply = await router.handle({ channel: "cli", chatId: "local", text: `/reject ${row.id} too noisy` });
    expect(reply?.text).toContain("Rejected");
    expect(store.getAction(row.id)?.reject_reason).toBe("too noisy");
  });

  it("unknown id returns a gate error, not a crash", async () => {
    const { router } = setup();
    const reply = await router.handle({ channel: "cli", chatId: "local", text: "/approve zzzzzzzz" });
    expect(reply?.text).toContain("no action");
  });

  it("normal messages still reach the moderator", async () => {
    const { router } = setup();
    const reply = await router.handle({ channel: "cli", chatId: "local", text: "hello there" });
    expect(reply?.text).toBe("rami-reply");
  });
});

describe("toCoordinator predicate (web sentinel, registry-derived)", () => {
  const reg = testRegistry();

  it("returns true for missing / empty target — default coordinator path", () => {
    expect(toCoordinator(reg)).toBe(true);
    expect(toCoordinator(reg, undefined)).toBe(true);
  });

  it("returns true for the coordinator's name and every alias (moderator/rami are neo aliases)", () => {
    expect(toCoordinator(reg, "neo")).toBe(true);
    expect(toCoordinator(reg, "moderator")).toBe(true);
    expect(toCoordinator(reg, "rami")).toBe(true);
  });

  it("returns false for specialist names — they get routed as @-mentions", () => {
    expect(toCoordinator(reg, "vulcan")).toBe(false);
    expect(toCoordinator(reg, "finance")).toBe(false);
    expect(toCoordinator(reg, "architect")).toBe(false);
  });
});
