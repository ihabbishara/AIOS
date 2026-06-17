import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { assembleBrief, renderBriefNote, isEmptyBrief } from "../src/heartbeat/briefs.js";
import { localParts } from "../src/heartbeat/clock.js";

const NOW = "2026-06-17T07:30:00.000Z"; // morning; same local date as the dream stamp below
function dreamDateForNow(): string {
  // the dream stamp uses local date; derive it the same way the brief does
  return localParts(new Date(NOW)).date; // YYYY-MM-DD in local tz, matches localDateOf(NOW)
}
function seedDream(s: Store, date: string) {
  s.kvSet("dream:latest", JSON.stringify({ date, initiatives: [{ title: "Book dentist", why: "10 days overdue", suggestion: "call today" }] }));
}

describe("dream section in the morning brief", () => {
  it("morning brief includes dreamInitiatives when dream:latest is from the current local date", () => {
    const s = new Store(":memory:");
    seedDream(s, dreamDateForNow());
    const data = assembleBrief(s, "morning", NOW, null);
    expect(data.dreamInitiatives).toHaveLength(1);
    expect(data.dreamInitiatives![0].title).toBe("Book dentist");
    const note = renderBriefNote(data, "narration");
    expect(note).toMatch(/## Dream/);
    expect(note).toMatch(/Book dentist — call today/);
  });

  it("evening brief never includes the dream section", () => {
    const s = new Store(":memory:");
    seedDream(s, dreamDateForNow());
    const data = assembleBrief(s, "evening", NOW, null);
    expect(data.dreamInitiatives).toBeUndefined();
    expect(renderBriefNote(data, "n")).not.toMatch(/## Dream/);
  });

  it("a stale-dated dream:latest is omitted", () => {
    const s = new Store(":memory:");
    seedDream(s, "2020-01-01"); // definitely not today
    const data = assembleBrief(s, "morning", NOW, null);
    expect(data.dreamInitiatives).toBeUndefined();
  });

  it("a morning with only dream initiatives is not 'empty' (so it narrates)", () => {
    const s = new Store(":memory:");
    seedDream(s, dreamDateForNow());
    const data = assembleBrief(s, "morning", NOW, null);
    expect(isEmptyBrief(data)).toBe(false);
  });
});
