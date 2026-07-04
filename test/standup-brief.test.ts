// test/standup-brief.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { assembleBrief, isEmptyBrief, renderBriefNote } from "../src/heartbeat/briefs.js";

function hermesMail(store: Store, over: Record<string, unknown> = {}) {
  store.insertMail({
    id: (over.id as string) ?? "s1", from_agent: (over.from as string) ?? "athena", to_agent: "hermes",
    kind: (over.kind as never) ?? "standup", body: (over.body as string) ?? "done: X / today: Y / blockers: none",
    goal_id: null, origin_channel: "system", origin_chat_id: "standup",
    chain_depth: 1, status: "unread", error: null,
  });
}

describe("brief standups + mailroom", () => {
  it("morning brief carries standups and hermes mail lines; counts as non-empty", () => {
    const store = new Store(":memory:");
    hermesMail(store);
    hermesMail(store, { id: "r1", from: "vulcan", kind: "report", body: "Done: mail goal X\nArtifacts: ..." });
    const d = assembleBrief(store, "morning", new Date().toISOString(), null);
    expect(d.standups).toEqual([{ lead: "athena", text: "done: X / today: Y / blockers: none" }]);
    expect(d.hermesMail).toEqual([{ from: "vulcan", kind: "report", line: "Done: mail goal X" }]);
    expect(isEmptyBrief(d)).toBe(false);
    const note = renderBriefNote(d, "narration");
    expect(note).toContain("## Standups");
    expect(note).toContain("athena: done: X / today: Y / blockers: none");
    expect(note).toContain("## Mailroom");
  });

  it("evening brief ignores hermes mail; empty morning stays empty", () => {
    const store = new Store(":memory:");
    hermesMail(store);
    const evening = assembleBrief(store, "evening", new Date().toISOString(), null);
    expect(evening.standups).toBeUndefined();
    const emptyStore = new Store(":memory:");
    const d = assembleBrief(emptyStore, "morning", new Date().toISOString(), null);
    expect(isEmptyBrief(d)).toBe(true);
  });
});
