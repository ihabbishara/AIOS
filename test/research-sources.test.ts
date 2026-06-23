import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

describe("research_sources Store", () => {
  it("adds and lists a source", () => {
    const s = new Store(":memory:");
    s.addResearchSource({ url: "https://a.com", title: "A", topic: "llm", note: "n" });
    const all = s.listResearchSources();
    expect(all.length).toBe(1);
    expect(all[0]).toMatchObject({ url: "https://a.com", title: "A", topic: "llm", note: "n" });
    expect(typeof all[0].created_at).toBe("string");
  });

  it("upserts by url, preserving created_at and updating title/topic/note", () => {
    const s = new Store(":memory:");
    s.addResearchSource({ url: "https://a.com", title: "A", topic: "llm" });
    const first = s.listResearchSources()[0];
    s.addResearchSource({ url: "https://a.com", title: "A2", topic: "agents", note: "added" });
    const rows = s.listResearchSources();
    expect(rows.length).toBe(1); // still one row (upsert, not insert)
    expect(rows[0].title).toBe("A2");
    expect(rows[0].topic).toBe("agents");
    expect(rows[0].note).toBe("added");
    expect(rows[0].created_at).toBe(first.created_at); // preserved
  });

  it("filters by topic, newest first", () => {
    const s = new Store(":memory:");
    s.addResearchSource({ url: "https://a.com", title: "A", topic: "llm" });
    s.addResearchSource({ url: "https://b.com", title: "B", topic: "ops" });
    s.addResearchSource({ url: "https://c.com", title: "C", topic: "llm" });
    const llm = s.listResearchSources("llm");
    expect(llm.map((r) => r.url)).toEqual(["https://c.com", "https://a.com"]); // newest (higher id) first
  });

  it("searches case-insensitively across title/url/topic/note", () => {
    const s = new Store(":memory:");
    s.addResearchSource({ url: "https://example.com/Vector", title: "Embeddings", topic: "ml", note: "BM25 vs ANN" });
    expect(s.searchResearchSources("vector").map((r) => r.title)).toEqual(["Embeddings"]); // matches url
    expect(s.searchResearchSources("BM25").map((r) => r.title)).toEqual(["Embeddings"]); // matches note
    expect(s.searchResearchSources("nope")).toEqual([]);
  });
});
