// test/memory-v2-recall.test.ts — memory-v2 retrieval layers: decay, usage penalty, entities (spec §3, §6).
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { indexDoc, recall } from "../src/memory/recall.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-14T00:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("recency decay (spec §3)", () => {
  it("same content, different ages: newer doc ranks first", () => {
    const s = new Store(":memory:");
    indexDoc(s, { source: "vault", ref: "old.md", domain: "general", title: "t", body: "alpha beta gamma", ts: iso(300 * DAY), fingerprint: "1" });
    indexDoc(s, { source: "vault", ref: "new.md", domain: "general", title: "t", body: "alpha beta gamma", ts: iso(1 * DAY), fingerprint: "1" });
    const hits = recall(s, "alpha gamma", { nowMs: NOW });
    expect(hits.map((h) => h.ref)).toEqual(["new.md", "old.md"]);
  });

  it("half-life is configurable: huge half-life ≈ no decay (scores converge), default decays hard", () => {
    const s = new Store(":memory:");
    indexDoc(s, { source: "vault", ref: "old.md", domain: "general", title: "t", body: "alpha beta", ts: iso(300 * DAY), fingerprint: "1" });
    indexDoc(s, { source: "vault", ref: "new.md", domain: "general", title: "t", body: "alpha beta", ts: iso(1 * DAY), fingerprint: "1" });
    const huge = recall(s, "alpha", { nowMs: NOW, halfLifeDays: 1_000_000 });
    expect(huge[1].score / huge[0].score).toBeGreaterThan(0.999); // ≈ equal
    const dflt = recall(s, "alpha", { nowMs: NOW });
    expect(dflt[0].ref).toBe("new.md");
    expect(dflt[1].score / dflt[0].score).toBeLessThan(0.2); // 300d @ 90d half-life ≈ e^-3.3
  });

  it("unparseable ts → no decay (factor 1), no crash", () => {
    const s = new Store(":memory:");
    indexDoc(s, { source: "vault", ref: "bad.md", domain: "general", title: "t", body: "alpha", ts: "not-a-date", fingerprint: "1" });
    expect(recall(s, "alpha", { nowMs: NOW })).toHaveLength(1);
  });
});
