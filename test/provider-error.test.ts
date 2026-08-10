// test/provider-error.test.ts — an outage must not be mistaken for an answer.
//
// Ground truth: on 2026-08-05 the SDK returned subtype "success" with the quota sentence as
// the whole result. Six nodes were marked `done`, ten artifacts contained only that sentence,
// and the next morning's brief reported the window as "genuinely quiet — no failures".
import { describe, it, expect } from "vitest";
import { isProviderError } from "../src/agents/provider-error.js";

describe("isProviderError", () => {
  it("catches the exact string that was written into ten node artifacts", () => {
    expect(isProviderError("You've hit your weekly limit · resets Aug 10 at 3am (Europe/Paris)")).toBe(true);
    // The later variant, after the reset date dropped out.
    expect(isProviderError("You've hit your weekly limit · resets 3am (Europe/Paris)")).toBe(true);
    expect(isProviderError("You've hit your session limit · resets 6:30pm (Europe/Paris)")).toBe(true);
  });

  it("catches the other shapes a provider failure arrives in", () => {
    for (const t of [
      "Usage limit reached",
      "rate limit exceeded",
      "quota exhausted",
      "Insufficient credit",
      "overloaded_error",
      "Claude Code returned an error result: something",
      "Your credit balance is too low to run this request",
    ]) {
      expect(isProviderError(t), t).toBe(true);
    }
  });

  it("does NOT fail a real answer that merely discusses limits", () => {
    // The false positive that would matter: failing legitimate research about rate limiting.
    const report = `# Rate limiting in agent runtimes

Most providers return a 429 when a quota is exhausted, and well-behaved clients back off
exponentially. Anthropic's API surfaces an overloaded_error under load; OpenAI reports
"rate limit exceeded". A daemon should treat these as retryable rather than terminal,
because the usual cause is burst concurrency rather than a hard cap. We recommend a token
bucket sized to the published limit, with jitter, and a circuit breaker after repeated
failures. See also the section on quota exhausted conditions and credit balance alerts.`;
    expect(isProviderError(report)).toBe(false);
  });

  it("does not fire on ordinary output, empty text, or a near-miss phrase", () => {
    expect(isProviderError("")).toBe(false);
    expect(isProviderError("The report is attached.")).toBe(false);
    expect(isProviderError("There is no limit on how many sources you may cite.")).toBe(false);
  });

  it("uses length as the safety margin — the same sentence inside a long answer passes", () => {
    // A short bare error fails the run; the identical sentence quoted inside real work does not.
    const bare = "You've hit your weekly limit";
    expect(isProviderError(bare)).toBe(true);
    expect(isProviderError(`${bare}${" — as the log showed.".repeat(30)}`)).toBe(false);
  });
});
