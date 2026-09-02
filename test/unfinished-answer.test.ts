// test/unfinished-answer.test.ts — a status update must not be mistaken for a deliverable.
//
// Ground truth: the OCA sovereign-cloud sweep fired daily 2026-08-30 → 2026-09-02 and delivered
// nothing. clio's turns ended with the three strings below, the SDK reported them as `success`,
// and the user received a progress report instead of a news brief four days running.
import { describe, it, expect } from "vitest";
import { isUnfinishedAnswer } from "../src/agents/unfinished-answer.js";

const OBSERVED = [
  "Seven parallel tracks are sweeping the 30 Aug–2 Sep window. I'll assemble the brief once they report back.",
  "Holding until the four tracks land, then the brief goes out in one piece.",
  "Holding for the four remaining sweeps (OCA members, EU regulation, competitors/decentral gov, standards ecosystems) before I write the brief.",
];

describe("isUnfinishedAnswer", () => {
  it("catches the three replies that cost four days of briefs", () => {
    for (const t of OBSERVED) expect(isUnfinishedAnswer(t), t).toBe(true);
  });

  it("catches the other shapes a promise-to-continue arrives in", () => {
    for (const t of [
      "The searches are still running; I'll send the summary when the results come in.",
      "I'll compile the findings and get them to you shortly.",
      "Holding off on the write-up until the last two queries finish.",
      "Three sweeps are in flight.",
    ]) expect(isUnfinishedAnswer(t), t).toBe(true);
  });

  it("does NOT fail the legitimate short answer this very routine asks for", () => {
    // The prompt says: if it was a quiet day, say "nothing material" in one line and stop.
    for (const t of [
      "Nothing material today.",
      "Nothing material. I checked OCA, the member companies, and the Rijksoverheid feed — no movement since 29 Aug.",
      "Nothing material today. Next sweep runs tomorrow at 10:00.",
      "No news. I will check again tomorrow.",
      "Done — the brief is in knowledge/sovereign-cloud-nl/2026-09-02-daily-sweep.md.",
    ]) expect(isUnfinishedAnswer(t), t).toBe(false);
  });

  it("does NOT fail a real brief that describes work in progress elsewhere", () => {
    const brief = `OCA published a working-group note on 1 Sep confirming the portability
"stekker" is still a design sketch: their own tracks are running until Q4 and nothing ships
before the CADA deadline. Source: opencloudalliantie.nl/nieuws. Why it matters: the plan
assumed OCA would not ship it themselves this year, and that assumption holds.

STACKIT announced a KPN-hosted region on 31 Aug. Their migration searches are still running
with two pilot ministries, so treat the "winning ground" risk as live rather than realised.
I'll assemble a deeper competitor read into the next weekly if you want one.`;
    expect(brief.length).toBeGreaterThan(400);
    expect(isUnfinishedAnswer(brief)).toBe(false);
  });

  it("is empty-safe", () => {
    expect(isUnfinishedAnswer("")).toBe(false);
    expect(isUnfinishedAnswer("   ")).toBe(false);
  });
});
