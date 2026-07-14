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

describe("usage feedback (spec §6)", () => {
  it("recall logs the query + returned doc ids and touches last_retrieved_at", () => {
    const s = new Store(":memory:");
    indexDoc(s, { source: "vault", ref: "a.md", domain: "general", title: "t", body: "alpha", ts: iso(DAY), fingerprint: "1" });
    recall(s, "alpha", { nowMs: NOW });
    const metaRows = s.memoryDocsMeta([1]);
    expect(metaRows[0].last_retrieved_at).toBeTruthy();
    expect(s.pruneMemoryUse(new Date(NOW + DAY).toISOString())).toBe(1); // one use row existed
  });

  it("a doc never retrieved in 180d ranks below an equal fresh-retrieved doc", () => {
    const s = new Store(":memory:");
    // Same ts (no decay difference); stale.md indexed long ago and never retrieved.
    indexDoc(s, { source: "vault", ref: "stale.md", domain: "general", title: "t", body: "alpha beta", ts: iso(DAY), fingerprint: "1" });
    indexDoc(s, { source: "vault", ref: "fresh.md", domain: "general", title: "t", body: "alpha beta", ts: iso(DAY), fingerprint: "1" });
    s.backdateMemoryDocForTest("vault", "stale.md", new Date(NOW - 200 * DAY).toISOString());
    s.touchMemoryDocs([2], new Date(NOW - DAY).toISOString()); // fresh.md retrieved yesterday
    const hits = recall(s, "alpha", { nowMs: NOW });
    expect(hits.map((h) => h.ref)).toEqual(["fresh.md", "stale.md"]);
  });

  it("a freshly indexed doc is NOT penalized just because it was never retrieved", () => {
    const s = new Store(":memory:");
    indexDoc(s, { source: "vault", ref: "old-station.md", domain: "general", title: "t", body: "alpha beta", ts: iso(DAY), fingerprint: "1" });
    indexDoc(s, { source: "vault", ref: "brand-new.md", domain: "general", title: "t", body: "alpha beta", ts: iso(DAY), fingerprint: "1" });
    s.backdateMemoryDocForTest("vault", "old-station.md", new Date(NOW - 200 * DAY).toISOString());
    const hits = recall(s, "alpha", { nowMs: NOW });
    expect(hits[0].ref).toBe("brand-new.md"); // only the 200d-indexed never-retrieved doc is penalized
  });
});
