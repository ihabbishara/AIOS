// src/agents/provider-error.ts — tell a provider outage apart from real output.
//
// Observed 2026-08-05: the weekly quota ran out mid-goal and the SDK returned
// `subtype: "success"` with `result` set to
//   "You've hit your weekly limit · resets Aug 10 at 3am (Europe/Paris)"
// The runner passed that straight through as the specialist's answer, the worker wrote it
// into the node artifact, and all six nodes were marked `done`. Ten artifacts in one goal
// contain nothing but that sentence, and the morning brief then reported the window as
// "genuinely quiet — no failures".
//
// A system that cannot tell an outage from an answer will report the outage as an answer.
// This is the guard.

/**
 * Provider/platform failures that arrive as prose rather than as an error result.
 * Deliberately narrow: each alternative names a condition the model would not be
 * *writing about* in a one-line reply.
 */
const PROVIDER_ERROR = new RegExp(
  [
    String.raw`you'?ve hit your (weekly|session|daily|usage) limit`,
    String.raw`usage limit reached`,
    String.raw`rate[- ]limit(ed|s)? exceeded`,
    String.raw`quota (exceeded|exhausted)`,
    String.raw`insufficient (credit|quota|balance)`,
    String.raw`(overloaded|authentication|permission|api)_error`,
    String.raw`claude code returned an error result`,
    String.raw`credit balance is too low`,
  ].join("|"),
  "i",
);

/**
 * True when the WHOLE result is a provider failure rather than work product.
 *
 * The length ceiling is the entire safety margin. A research report that discusses rate
 * limiting, quota design or API errors is legitimate output and must never be failed —
 * so only a reply short enough to be nothing *but* the error qualifies. The real ones
 * observed were 58 characters.
 */
export function isProviderError(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 300) return false;
  return PROVIDER_ERROR.test(t);
}
