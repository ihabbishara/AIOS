// test/actions.test.ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ExecutorRegistry, type Executor } from "../src/kernel/actions.js";

describe("ExecutorRegistry", () => {
  it("registers and retrieves executors by type", () => {
    const reg = new ExecutorRegistry();
    const exec: Executor = {
      type: "test.op",
      schema: z.object({ v: z.string() }),
      execute: async () => "ok",
    };
    reg.register(exec);
    expect(reg.get("test.op")).toBe(exec);
    expect(reg.get("missing")).toBeUndefined();
    expect(reg.types()).toEqual(["test.op"]);
  });

  it("throws on duplicate registration", () => {
    const reg = new ExecutorRegistry();
    const exec: Executor = { type: "dup", schema: z.object({}), execute: async () => "x" };
    reg.register(exec);
    expect(() => reg.register(exec)).toThrow('already registered for type "dup"');
  });
});
