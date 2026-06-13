import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { indexDoc, recall, formatHits } from "../src/memory/recall.js";

function seed(s: Store) {
  indexDoc(s, { source: "vault", ref: "knowledge/lng.md", domain: "research", title: "LNG prices", body: "the spot price of lng dropped twelve percent this week", ts: "2026-05-30T00:00:00.000Z", fingerprint: "1" });
  indexDoc(s, { source: "decision", ref: "a7", domain: "money", title: "", body: "rejected invoice want to check the meter first", ts: "2026-06-02T00:00:00.000Z", fingerprint: "1" });
  indexDoc(s, { source: "vault", ref: "notes/cooking.md", domain: "general", title: "Pasta", body: "boil water add salt", ts: "2026-06-01T00:00:00.000Z", fingerprint: "1" });
}

describe("recall", () => {
  it("ranks the most relevant doc first", () => {
    const s = new Store(":memory:"); seed(s);
    const hits = recall(s, "lng price");
    expect(hits[0].ref).toBe("knowledge/lng.md");
    expect(hits[0].snippet).toContain("price");
  });
  it("filters by domain", () => {
    const s = new Store(":memory:"); seed(s);
    const hits = recall(s, "invoice meter", { domain: "money" });
    expect(hits).toHaveLength(1);
    expect(hits[0].ref).toBe("a7");
  });
  it("returns [] for no-token / no-match queries (no throw)", () => {
    const s = new Store(":memory:"); seed(s);
    expect(recall(s, "!!! ???")).toEqual([]);
    expect(recall(s, "nonexistentword")).toEqual([]);
  });
  it("re-index with same fingerprint is a no-op; changed fingerprint re-tokenizes", () => {
    const s = new Store(":memory:"); seed(s);
    indexDoc(s, { source: "vault", ref: "knowledge/lng.md", domain: "research", title: "LNG prices", body: "REPLACED", ts: "t", fingerprint: "1" });
    expect(recall(s, "spot").length).toBe(1); // unchanged (fingerprint same)
    indexDoc(s, { source: "vault", ref: "knowledge/lng.md", domain: "research", title: "LNG prices", body: "REPLACED gas content", ts: "t", fingerprint: "2" });
    expect(recall(s, "spot").length).toBe(0); // old body gone
    expect(recall(s, "gas").length).toBe(1);
  });
  it("respects the limit cap", () => {
    const s = new Store(":memory:");
    for (let i = 0; i < 30; i++) indexDoc(s, { source: "vault", ref: `n${i}.md`, domain: "general", title: "t", body: "alpha beta", ts: "t", fingerprint: "1" });
    expect(recall(s, "alpha", { limit: 100 }).length).toBe(20); // hard cap
  });
  it("formatHits renders provenance lines", () => {
    const s = new Store(":memory:"); seed(s);
    const out = formatHits(recall(s, "lng"));
    expect(out).toMatch(/\[vault\/research\] knowledge\/lng\.md \(2026-05-30\)/);
  });
  it("title-boost: a title-only match outranks a body-only match", () => {
    const s = new Store(":memory:");
    indexDoc(s, { source: "vault", ref: "A.md", domain: "general", title: "zephyr engine", body: "filler words here about machines", ts: "t", fingerprint: "1" });
    indexDoc(s, { source: "vault", ref: "B.md", domain: "general", title: "machines", body: "zephyr appears once in this longer body of text here", ts: "t", fingerprint: "1" });
    const hits = recall(s, "zephyr");
    expect(hits[0].ref).toBe("A.md");
  });
  it("single-doc index yields a positive score (idf never negative)", () => {
    const s = new Store(":memory:");
    indexDoc(s, { source: "vault", ref: "only.md", domain: "general", title: "solo", body: "unique content", ts: "t", fingerprint: "1" });
    const hits = recall(s, "unique");
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeGreaterThan(0);
  });
  it("snippet wraps the matched term in guillemets", () => {
    const s = new Store(":memory:");
    indexDoc(s, { source: "vault", ref: "x.md", domain: "general", title: "t", body: "the spot price moved", ts: "t", fingerprint: "1" });
    expect(recall(s, "price")[0].snippet).toContain("«price»");
  });
  it("length normalization: a short doc outranks a long doc with the same term", () => {
    const s = new Store(":memory:");
    indexDoc(s, { source: "vault", ref: "short.md", domain: "general", title: "", body: "alpha", ts: "t", fingerprint: "1" });
    indexDoc(s, { source: "vault", ref: "long.md", domain: "general", title: "", body: "alpha " + "filler ".repeat(40), ts: "t", fingerprint: "1" });
    const hits = recall(s, "alpha");
    expect(hits[0].ref).toBe("short.md");
  });
});
