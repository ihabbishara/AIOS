import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { runDreamCycle, type Initiative } from "../src/heartbeat/dream.js";
import { localParts } from "../src/heartbeat/clock.js";

const NOW = new Date("2026-06-17T02:00:00.000Z");
function seedReminder(s: Store) {
  s.addReminder({ text: "call dentist", dueAt: "2026-06-10T09:00:00.000Z", originChannel: "telegram", originChatId: "1" });
}
const RANKED: Initiative[] = [
  { title: "Overdue: dentist", why: "10 days late", suggestion: "book today" },
  { title: "B", why: "y", suggestion: "z" },
  { title: "C", why: "y", suggestion: "z" },
  { title: "D", why: "y", suggestion: "z" },
];

describe("runDreamCycle", () => {
  it("stores ranked initiatives (capped at topN) with today's local date when there are observations", async () => {
    const s = new Store(":memory:"); seedReminder(s);
    await runDreamCycle({ store: s, rank: async () => RANKED, topN: 3, nowFn: () => NOW });
    const saved = JSON.parse(s.kvGet("dream:latest")!);
    expect(saved.date).toBe(localParts(NOW).date);
    expect(saved.initiatives).toHaveLength(3); // capped
    expect(saved.initiatives[0].title).toBe("Overdue: dentist");
  });

  it("does nothing when there are no observations (no kv write)", async () => {
    const s = new Store(":memory:");
    await runDreamCycle({ store: s, rank: async () => RANKED, topN: 3, nowFn: () => NOW });
    expect(s.kvGet("dream:latest")).toBeUndefined();
  });

  it("is fail-silent: a throwing ranker writes nothing", async () => {
    const s = new Store(":memory:"); seedReminder(s);
    await runDreamCycle({ store: s, rank: async () => { throw new Error("llm down"); }, topN: 3, nowFn: () => NOW });
    expect(s.kvGet("dream:latest")).toBeUndefined();
  });

  it("passes last night's initiatives to the ranker as anti-repeat context", async () => {
    const s = new Store(":memory:"); seedReminder(s);
    s.kvSet("dream:latest", JSON.stringify({ date: "2026-06-16", initiatives: [{ title: "yesterday", why: "", suggestion: "" }] }));
    let seenLast: Initiative[] = [];
    await runDreamCycle({ store: s, rank: async (_digest, last) => { seenLast = last; return RANKED; }, topN: 3, nowFn: () => NOW });
    expect(seenLast.map((i) => i.title)).toEqual(["yesterday"]);
  });
});
