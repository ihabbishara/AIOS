// test/gate-idempotency.test.ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { ExecutorRegistry, type Executor } from "../src/kernel/actions.js";
import { newRecord, promote, type TrustPolicy } from "../src/kernel/trust.js";
import { ActionGate } from "../src/kernel/gate.js";

const ORIGIN = { channel: "t", chatId: "1" };
const NOW = "2026-07-13T10:00:00.000Z";

function setup() {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  let executions = 0;
  const registry = new ExecutorRegistry();
  const noteAdd: Executor = {
    type: "note.add",
    schema: z.object({ text: z.string() }),
    async execute() { executions++; return "added"; },
  };
  registry.register(noteAdd);
  const policy: TrustPolicy = { graduationStreak: 3, graduationAgeDays: 0, alwaysSupervised: new Set() };
  const gate = new ActionGate({ store, registry, policy, bus, expiryMs: 60_000 });
  // autonomous so execute() runs immediately — dedupe must prevent double effects
  store.upsertTrust(promote(newRecord("note.add", NOW), NOW));
  return { store, gate, executions: () => executions };
}

describe("gate idempotency", () => {
  it("same idempotencyKey → second propose returns the first row, executor runs once", async () => {
    const { gate, store, executions } = setup();
    const a = await gate.propose({ type: "note.add", payload: { text: "x" }, preview: "p", idempotencyKey: "g1:task:1" }, ORIGIN);
    const b = await gate.propose({ type: "note.add", payload: { text: "x" }, preview: "p", idempotencyKey: "g1:task:1" }, ORIGIN);
    expect(b.id).toBe(a.id);
    expect(executions()).toBe(1);
    expect(store.actionByIdempotencyKey("g1:task:1")!.id).toBe(a.id);
  });

  it("different keys and keyless proposals are independent", async () => {
    const { gate } = setup();
    const a = await gate.propose({ type: "note.add", payload: { text: "x" }, preview: "p", idempotencyKey: "g1:task:1" }, ORIGIN);
    const b = await gate.propose({ type: "note.add", payload: { text: "x" }, preview: "p", idempotencyKey: "g1:task:2" }, ORIGIN);
    const c = await gate.propose({ type: "note.add", payload: { text: "x" }, preview: "p" }, ORIGIN);
    const d = await gate.propose({ type: "note.add", payload: { text: "x" }, preview: "p" }, ORIGIN);
    expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(4); // NULL keys never collide
  });
});
