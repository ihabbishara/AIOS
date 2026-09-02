// src/agents/unfinished-answer.ts — tell a status update apart from a deliverable.
//
// Observed 2026-08-30 → 2026-09-02: the OCA sovereign-cloud sweep fired on schedule for four
// days and delivered nothing. clio's turns ended with, verbatim:
//
//   "Seven parallel tracks are sweeping the 30 Aug–2 Sep window. I'll assemble the brief once
//    they report back."
//   "Holding until the four tracks land, then the brief goes out in one piece."
//
// The SDK returns those as `subtype: "success"`, so the runner passed them through as the
// answer, hand_off relayed them to the chief of staff, and the user got a progress report
// instead of a news brief — with nothing anywhere marked failed. A specialist run is one
// turn: there is no "later" for the work to land in, and no second turn ever comes.
//
// Sibling of provider-error.ts. Same shape, same reasoning: a reply that is nothing but a
// promise to continue is a failure wearing a success's clothes.

/**
 * A whole reply that promises future work instead of carrying it.
 * Deliberately narrow: each alternative describes work that is supposedly IN FLIGHT RIGHT NOW,
 * which is only ever false at the moment a one-shot run returns.
 */
const UNFINISHED = new RegExp(
  [
    // "Holding for the four remaining sweeps...", "Holding until the four tracks land..."
    String.raw`^holding (for|until|off|on|while|pending)\b`,
    // "...once they report back", "...when the searches come in"
    String.raw`\b(once|when|after|as soon as) (they|these|those|the \w+) (report back|land|come in|are in|finish|complete)\b`,
    // "Seven parallel tracks are sweeping...", "the searches are still running"
    String.raw`\b(tracks?|sweeps?|searches|queries|runs|threads) (are|is) (still |now )?(sweeping|running|in flight|underway|pending|out)\b`,
    // "I'll assemble/write the brief and send it over", said INSTEAD of doing it
    String.raw`^(i'?ll|i am going to|i will) (assemble|compile|write|draft|put together|pull together) (the|a|this|it)\b`,
  ].join("|"),
  "i",
);

/**
 * True when the WHOLE reply is a progress report rather than work product.
 *
 * The length ceiling is the entire safety margin, exactly as in isProviderError. A real brief
 * that happens to mention its own follow-ups is legitimate output and must never be failed —
 * so only a reply short enough to be nothing *but* the status line qualifies. The three
 * observed were 106, 108 and 137 characters.
 */
export function isUnfinishedAnswer(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 400) return false;
  return UNFINISHED.test(t);
}
