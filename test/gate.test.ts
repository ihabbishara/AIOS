// test/gate.test.ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Store } from "../src/store/db.js";
import { EventBus, type StoredEvent } from "../src/events.js";
import { ExecutorRegistry, type Executor } from "../src/kernel/actions.js";
import { trustPromoteExecutor } from "../src/kernel/executors.js";
import { newRecord, promote, type TrustPolicy } from "../src/kernel/trust.js";
import { ActionGate } from "../src/kernel/gate.js";

const ORIGIN = { channel: "cli", chatId: "local" };
const NOW = "2026-06-12T10:00:00.000Z";

function setup(opts: { expiryMs?: number; streak?: number; ageDays?: number } = {}) {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const events: StoredEvent[] = [];
  bus.on((e) => events.push(e));
  const calls: unknown[] = [];
  const registry = new ExecutorRegistry();
  const fake: Executor = {
    type: "fake.op",
    schema: z.object({ v: z.string() }),
    async execute(p) { calls.push(p); return `did ${(p as { v: string }).v}`; },
  };
  const failing: Executor = {
    type: "fake.fail",
    schema: z.object({}),
    async execute() { throw new Error("boom"); },
  };
  registry.register(fake);
  registry.register(failing);
  registry.register(trustPromoteExecutor(store, bus));
  const policy: TrustPolicy = {
    graduationStreak: opts.streak ?? 3,
    graduationAgeDays: opts.ageDays ?? 0,
    alwaysSupervised: new Set(["trust.promote"]),
  };
  const gate = new ActionGate({ store, registry, policy, bus, expiryMs: opts.expiryMs ?? 60_000 });
  return { store, bus, events, calls, gate, registry };
}

describe("ActionGate.propose", () => {
  it("queues unknown-trust types as supervised (fail closed)", async () => {
    const { gate, store, calls, events } = setup();
    const row = await gate.propose({ type: "fake.op", payload: { v: "x" }, preview: "do x" }, ORIGIN);
    expect(row.status).toBe("proposed");
    expect(calls).toHaveLength(0);
    expect(store.getTrust("fake.op")?.state).toBe("supervised");
    expect(events.some((e) => e.event.type === "action.proposed")).toBe(true);
  });

  it("executes autonomous types immediately and audits them", async () => {
    const { gate, store, calls } = setup();
    store.upsertTrust(promote(newRecord("fake.op", NOW), NOW));
    const row = await gate.propose({ type: "fake.op", payload: { v: "x" }, preview: "do x" }, ORIGIN);
    expect(row.status).toBe("executed");
    expect(row.result).toBe("did x");
    expect(calls).toHaveLength(1);
    expect(store.getAction(row.id)?.status).toBe("executed");
  });

  it("rejects unregistered action types", async () => {
    const { gate } = setup();
    await expect(gate.propose({ type: "nope", payload: {}, preview: "?" }, ORIGIN))
      .rejects.toThrow("no executor registered");
  });

  it("rejects payloads that fail the executor schema", async () => {
    const { gate } = setup();
    await expect(gate.propose({ type: "fake.op", payload: { wrong: 1 }, preview: "?" }, ORIGIN))
      .rejects.toThrow();
  });

  it("gate authors trust.promote previews, ignoring caller-supplied text", async () => {
    const { gate, store } = setup();
    const row = await gate.propose(
      { type: "trust.promote", payload: { action_type: "fake.op" }, preview: "Echo hello" },
      ORIGIN,
    );
    expect(row.preview.startsWith("Promote ")).toBe(true);
    expect(row.preview).toContain("fake.op");
    expect(row.preview).not.toContain("Echo hello");
    expect(store.getAction(row.id)?.preview).toBe(row.preview);
  });
});

describe("ActionGate.resolve", () => {
  it("approve executes, records verdict, and trains trust", async () => {
    const { gate, store, calls } = setup();
    const row = await gate.propose({ type: "fake.op", payload: { v: "x" }, preview: "do x" }, ORIGIN);
    const done = await gate.resolve(row.id, "approve", { by: "ihab" });
    expect(done.status).toBe("executed");
    expect(done.verdict_by).toBe("ihab");
    expect(calls).toHaveLength(1);
    expect(store.getTrust("fake.op")?.approvals).toBe(1);
    expect(store.getTrust("fake.op")?.streak).toBe(1);
  });

  it("reject records reason and resets trust streak", async () => {
    const { gate, store } = setup();
    const row = await gate.propose({ type: "fake.op", payload: { v: "x" }, preview: "do x" }, ORIGIN);
    const done = await gate.resolve(row.id, "reject", { by: "ihab", reason: "not now" });
    expect(done.status).toBe("rejected");
    expect(done.reject_reason).toBe("not now");
    expect(store.getTrust("fake.op")?.rejections).toBe(1);
    expect(store.getTrust("fake.op")?.streak).toBe(0);
  });

  it("approve counts even when execution fails (status=failed)", async () => {
    const { gate, store } = setup();
    const row = await gate.propose({ type: "fake.fail", payload: {}, preview: "will fail" }, ORIGIN);
    const done = await gate.resolve(row.id, "approve", { by: "ihab" });
    expect(done.status).toBe("failed");
    expect(done.result).toBe("boom");
    expect(store.getTrust("fake.fail")?.approvals).toBe(1);
  });

  it("cannot resolve twice", async () => {
    const { gate } = setup();
    const row = await gate.propose({ type: "fake.op", payload: { v: "x" }, preview: "do x" }, ORIGIN);
    await gate.resolve(row.id, "approve", { by: "ihab" });
    await expect(gate.resolve(row.id, "approve", { by: "ihab" })).rejects.toThrow("already");
  });

  it("expired actions cannot be resolved and get marked expired", async () => {
    const { gate, store } = setup({ expiryMs: -1000 }); // born expired
    const row = await gate.propose({ type: "fake.op", payload: { v: "x" }, preview: "do x" }, ORIGIN);
    await expect(gate.resolve(row.id, "approve", { by: "ihab" })).rejects.toThrow("expired");
    expect(store.getAction(row.id)?.status).toBe("expired");
  });

  it("concurrent approvals execute exactly once", async () => {
    const { gate, store, calls, registry } = setup();
    const slow: Executor = {
      type: "slow.op",
      schema: z.object({}),
      async execute() {
        await new Promise((r) => setTimeout(r, 50));
        calls.push("slow");
        return "slow done";
      },
    };
    registry.register(slow);
    const row = await gate.propose({ type: "slow.op", payload: {}, preview: "slow run" }, ORIGIN);
    const results = await Promise.allSettled([
      gate.resolve(row.id, "approve", { by: "a" }),
      gate.resolve(row.id, "approve", { by: "b" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(calls.filter((c) => c === "slow")).toHaveLength(1);
    expect(store.getAction(row.id)?.status).toBe("executed");
    expect(store.getTrust("slow.op")?.approvals).toBe(1);
  });
});

describe("graduation loop", () => {
  it("streak threshold proposes a trust.promote action; approving it makes the type autonomous", async () => {
    const { gate, store, calls } = setup({ streak: 3, ageDays: 0 });
    for (let i = 0; i < 3; i++) {
      const row = await gate.propose({ type: "fake.op", payload: { v: `r${i}` }, preview: `run ${i}` }, ORIGIN);
      await gate.resolve(row.id, "approve", { by: "ihab" });
    }
    expect(store.getTrust("fake.op")?.state).toBe("graduating");
    const pending = store.listActions("proposed");
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe("trust.promote");

    await gate.resolve(pending[0].id, "approve", { by: "ihab" });
    expect(store.getTrust("fake.op")?.state).toBe("autonomous");

    // Next proposal of fake.op executes without approval.
    const auto = await gate.propose({ type: "fake.op", payload: { v: "free" }, preview: "free run" }, ORIGIN);
    expect(auto.status).toBe("executed");
    expect(calls).toHaveLength(4); // 3 approved + 1 autonomous
  });

  it("rejecting the promotion sends the target type back to supervised", async () => {
    const { gate, store } = setup({ streak: 3, ageDays: 0 });
    for (let i = 0; i < 3; i++) {
      const row = await gate.propose({ type: "fake.op", payload: { v: `r${i}` }, preview: `run ${i}` }, ORIGIN);
      await gate.resolve(row.id, "approve", { by: "ihab" });
    }
    const promo = store.listActions("proposed")[0];
    await gate.resolve(promo.id, "reject", { by: "ihab" });
    const trust = store.getTrust("fake.op")!;
    expect(trust.state).toBe("supervised");
    expect(trust.streak).toBe(0);
    // promotion rejection must not pollute the trust.promote type's own ledger
    expect(store.getTrust("trust.promote")?.rejections ?? 0).toBe(0);
  });
});

describe("manual demote + sweep", () => {
  it("demoteType drops an autonomous type to supervised", async () => {
    const { gate, store } = setup();
    store.upsertTrust(promote(newRecord("fake.op", NOW), NOW));
    gate.demoteType("fake.op");
    expect(store.getTrust("fake.op")?.state).toBe("supervised");
  });

  it("sweepExpired marks overdue proposals", async () => {
    const { gate, store } = setup({ expiryMs: -1000 });
    await gate.propose({ type: "fake.op", payload: { v: "x" }, preview: "do x" }, ORIGIN);
    expect(gate.sweepExpired()).toBe(1);
    expect(store.listActions("expired")).toHaveLength(1);
  });
});
