// test/distiller-factdiff.test.ts — factDiffLLM must THROW on a transient/unparseable LLM result
// (mirror groundLLM), not silently return []. A swallowed [] on a bootstrapPending run wrongly
// stamps distill:bootstrapped:<domain> and abandons the memo's facts (observed live 2026-07-19).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
import { query } from "@anthropic-ai/claude-agent-sdk";
import { factDiffLLM } from "../src/memory/distiller.js";

const result = (subtype: string, text: string) =>
  (async function* () { yield { type: "result", subtype, result: text }; })();

const args = { domain: "general", active: [], signals: [{ ref: "teaching:5", text: "- preference: metric units" }] } as never;

describe("factDiffLLM transient-failure handling", () => {
  beforeEach(() => vi.mocked(query).mockReset());

  it("THROWS on a non-success result instead of returning [] (the transient-stamp bug)", async () => {
    vi.mocked(query).mockReturnValueOnce(result("error_max_turns", "") as never);
    await expect(factDiffLLM()(args)).rejects.toThrow();
  });

  it("THROWS on a success result with no JSON array (unparseable)", async () => {
    vi.mocked(query).mockReturnValueOnce(result("success", "Sorry, I can't help with that.") as never);
    await expect(factDiffLLM()(args)).rejects.toThrow();
  });

  it("returns [] on a genuine successful empty array", async () => {
    vi.mocked(query).mockReturnValueOnce(result("success", "[]") as never);
    expect(await factDiffLLM()(args)).toEqual([]);
  });

  it("returns parsed candidates on a successful array result", async () => {
    vi.mocked(query).mockReturnValueOnce(
      result("success", '[{"subject":"units","fact":"metric","source_ref":"teaching:5"}]') as never,
    );
    expect(await factDiffLLM()(args)).toEqual([{ subject: "units", fact: "metric", source_ref: "teaching:5" }]);
  });
});
