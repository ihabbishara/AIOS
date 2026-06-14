import { describe, it, expect } from "vitest";
import { withinCeiling, proposeThroughCeiling } from "../src/packs/server.js";

describe("withinCeiling", () => {
  it("permits action types in the ceiling and refuses the rest", () => {
    const actions = ["vault.write", "email.draft"];
    expect(withinCeiling("vault.write", actions)).toBe(true);
    expect(withinCeiling("email.draft", actions)).toBe(true);
    expect(withinCeiling("finance.pay_bill", actions)).toBe(false);
    expect(withinCeiling("email.send", actions)).toBe(false);
  });
  it("refuses everything when the ceiling is empty", () => {
    expect(withinCeiling("vault.write", [])).toBe(false);
  });
});

describe("proposeThroughCeiling", () => {
  it("refuses an out-of-ceiling type WITHOUT calling the gate", async () => {
    let called = false;
    const gate = { propose: async () => { called = true; return {} as never; } };
    const out = await proposeThroughCeiling({ gate: gate as never, actions: ["vault.write"], origin: { channel: "x", chatId: "y" } }, { type: "email.send", payload: {}, preview: "p" });
    expect(out).toMatch(/Refused/);
    expect(called).toBe(false); // never reached the gate
  });
  it("calls the gate for an in-ceiling type and reports the result", async () => {
    let called = false;
    const gate = { propose: async () => { called = true; return { status: "executed", result: "ok", id: "1", type: "vault.write", preview: "p" }; } };
    const out = await proposeThroughCeiling({ gate: gate as never, actions: ["vault.write"], origin: { channel: "x", chatId: "y" } }, { type: "vault.write", payload: {}, preview: "p" });
    expect(called).toBe(true);
    expect(out).toMatch(/Executed/);
  });
  it("returns a graceful message when the gate throws (no unhandled rejection)", async () => {
    const gate = { propose: async () => { throw new Error("schema fail"); } };
    const out = await proposeThroughCeiling({ gate: gate as never, actions: ["vault.write"], origin: { channel: "x", chatId: "y" } }, { type: "vault.write", payload: {}, preview: "p" });
    expect(out).toMatch(/Gate refused: schema fail/);
  });
});
