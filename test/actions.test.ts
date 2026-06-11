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
});
