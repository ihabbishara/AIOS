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

function setup(opts: { expiryMs?: number; streak?: number; ageDays?: number; shadowMatches?: number } = {}) {
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
    shadowMatches: opts.shadowMatches ?? 2,
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
    expect(row.preview).toContain("consecutive shadow matches"); // evidence-carrying preview (spec §6)
    expect(row.preview).not.toContain("Echo hello");
    expect(store.getAction(row.id)?.preview).toBe(row.preview);
  });

  it("gate authors email previews — caller text ignored", async () => {
    const { gate, store, registry } = setup();
    registry.register({
      type: "email.send",
      schema: z.object({ account: z.string(), to: z.string(), subject: z.string(), body: z.string() }),
      async execute() { return "ok"; },
    });
    const row = await gate.propose(
      { type: "email.send", payload: { account: "personal", to: "evil@x.com", subject: "secrets", body: "..." }, preview: "Echo hi — totally harmless" },
      ORIGIN,
    );
    expect(row.preview).toBe('Send to evil@x.com: "secrets" (personal)');
    expect(row.preview).not.toContain("harmless");
    expect(store.getAction(row.id)?.preview).toBe(row.preview);
  });

  it("gate authors email.draft, email.archive, and email.label previews", async () => {
    const { gate, registry } = setup();
    registry.register({
      type: "email.draft",
      schema: z.object({ account: z.string(), to: z.string(), subject: z.string(), body: z.string() }),
      async execute() { return "ok"; },
    });
    registry.register({
      type: "email.archive",
      schema: z.object({ account: z.string(), messageIds: z.array(z.string()).min(1) }),
      async execute() { return "ok"; },
    });
    registry.register({
      type: "email.label",
      schema: z.object({ account: z.string(), messageIds: z.array(z.string()), add: z.array(z.string()), remove: z.array(z.string()) }),
      async execute() { return "ok"; },
    });
    const draft = await gate.propose(
      { type: "email.draft", payload: { account: "work", to: "a@b.com", subject: "hi", body: "x" }, preview: "lies" },
      ORIGIN,
    );
    expect(draft.preview).toBe('Draft to a@b.com: "hi" (work)');
    const archive = await gate.propose(
      { type: "email.archive", payload: { account: "work", messageIds: ["m1", "m2"] }, preview: "lies" },
      ORIGIN,
    );
    expect(archive.preview).toBe("Archive 2 message(s) (work)");
    const label = await gate.propose(
      { type: "email.label", payload: { account: "work", messageIds: ["m1"], add: ["Keep"], remove: ["INBOX"] }, preview: "lies" },
      ORIGIN,
    );
    expect(label.preview).toBe("Label 1 message(s) +[Keep] -[INBOX] (work)");
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

describe("graduation loop (shadow-mode, spec §6)", () => {
  /** Drive n propose+approve cycles of fake.op. */
  async function approveN(gate: ActionGate, n: number) {
    for (let i = 0; i < n; i++) {
      const row = await gate.propose({ type: "fake.op", payload: { v: `r${i}` }, preview: `run ${i}` }, ORIGIN);
      await gate.resolve(row.id, "approve", { by: "ihab" });
    }
  }

  it("streak flips to graduating WITHOUT proposing a promotion", async () => {
    const { gate, store } = setup({ streak: 3, ageDays: 0, shadowMatches: 2 });
    await approveN(gate, 3);
    expect(store.getTrust("fake.op")?.state).toBe("graduating");
    expect(store.listActions("proposed")).toHaveLength(0); // no promote yet — evidence first
  });

  it("graduating actions carry shadow_decision=execute; N consecutive matches propose promotion with evidence", async () => {
    const { gate, store } = setup({ streak: 3, ageDays: 0, shadowMatches: 2 });
    await approveN(gate, 3); // now graduating
    await approveN(gate, 2); // two shadowed approvals = two matches
    const shadowed = store.listActions().filter((a) => a.shadow_decision === "execute");
    expect(shadowed.length).toBe(2);
    expect(store.getTrust("fake.op")?.shadowMatches).toBe(2);
    const pending = store.listActions("proposed");
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe("trust.promote");
    expect(pending[0].preview).toContain("2/2 consecutive shadow matches");

    await gate.resolve(pending[0].id, "approve", { by: "ihab" });
    expect(store.getTrust("fake.op")?.state).toBe("autonomous");
    const auto = await gate.propose({ type: "fake.op", payload: { v: "free" }, preview: "free" }, ORIGIN);
    expect(auto.status).toBe("executed");
    expect(auto.shadow_decision ?? null).toBeNull(); // autonomous runs are not shadowed
  });

  it("a mismatch (reject while graduating) resets the counter AND demotes to supervised", async () => {
    const { gate, store } = setup({ streak: 3, ageDays: 0, shadowMatches: 3 });
    await approveN(gate, 3); // graduating
    await approveN(gate, 2); // 2 matches
    const row = await gate.propose({ type: "fake.op", payload: { v: "bad" }, preview: "bad" }, ORIGIN);
    await gate.resolve(row.id, "reject", { by: "ihab" });
    const trust = store.getTrust("fake.op")!;
    expect(trust.state).toBe("supervised");
    expect(trust.shadowMatches).toBe(0);
    expect(store.listActions("proposed")).toHaveLength(0);
  });

  it("no duplicate promotion proposal while one is already pending", async () => {
    const { gate, store } = setup({ streak: 3, ageDays: 0, shadowMatches: 1 });
    await approveN(gate, 3); // graduating
    await approveN(gate, 2); // 1st match proposes; 2nd must not duplicate
    expect(store.listActions("proposed").filter((a) => a.type === "trust.promote")).toHaveLength(1);
  });

  it("rejecting the promotion sends the target type back to supervised", async () => {
    const { gate, store } = setup({ streak: 3, ageDays: 0, shadowMatches: 1 });
    await approveN(gate, 4); // graduating after 3, 4th is the shadow match → promote proposed
    const promo = store.listActions("proposed").find((a) => a.type === "trust.promote")!;
    await gate.resolve(promo.id, "reject", { by: "ihab" });
    const trust = store.getTrust("fake.op")!;
    expect(trust.state).toBe("supervised");
    expect(trust.streak).toBe(0);
    expect(trust.shadowMatches).toBe(0);
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
