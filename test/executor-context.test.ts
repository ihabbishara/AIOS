import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry, type Executor, type ExecutorContext } from "../src/kernel/actions.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";

describe("executor context", () => {
  it("passes the approver (verdict_by) to the executor as ctx.by on approval", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const registry = new ExecutorRegistry();
    let seen: ExecutorContext | undefined;
    const probe: Executor = {
      type: "test.ctxprobe",
      schema: z.object({ x: z.string() }),
      async execute(_payload, ctx) {
        seen = ctx;
        return "ok";
      },
    };
    registry.register(probe);
    const gate = new ActionGate({ store, registry, policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });

    const row = await gate.propose({ type: "test.ctxprobe", payload: { x: "hi" }, preview: "probe" }, { channel: "cli", chatId: "local" });
    await gate.resolve(row.id, "approve", { by: "ihab" });

    expect(seen).toEqual({ by: "ihab", auto: false });
  });
});
