// test/memory-hybrid.test.ts — memory_vec plumbing, RRF fusion, fail-latch (spec §3, §8).
// Uses a deterministic stub embedder; the real-model golden is opt-in (AIOS_TEST_REAL_EMBED=1),
// mirroring the AIOS_TEST_REAL_VOICE precedent.
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { indexDoc, recall, hybridRecall } from "../src/memory/recall.js";
import { embedMissing, VEC_DIM, type Embedder } from "../src/memory/embeddings.js";
import { Policy } from "../src/kernel/policy.js";

const TS = "2026-07-13T00:00:00.000Z";
const NOW = Date.parse("2026-07-14T00:00:00.000Z");

/** Stub: texts sharing a keyword map to the same unit vector; everything else orthogonal. */
function stubEmbedder(groups: Record<string, number>): Embedder {
  return {
    available: () => true,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(VEC_DIM);
        const g = Object.entries(groups).find(([k]) => t.toLowerCase().includes(k));
        v[g ? g[1] : VEC_DIM - 1] = 1;
        return v;
      });
    },
  };
}

function seeded() {
  const s = new Store(":memory:");
  indexDoc(s, { source: "vault", ref: "lng.md", domain: "research", title: "LNG prices", body: "spot lng dropped twelve percent", ts: TS, fingerprint: "1" });
  indexDoc(s, { source: "vault", ref: "pasta.md", domain: "general", title: "Pasta", body: "boil water add salt", ts: TS, fingerprint: "1" });
  return s;
}

describe("memory_vec plumbing", () => {
  it("embedMissing backfills vectors only for docs without one; re-run is a no-op", async () => {
    const s = seeded();
    const e = stubEmbedder({ lng: 0, pasta: 1 });
    expect(await embedMissing(s, e)).toBe(2);
    expect(await embedMissing(s, e)).toBe(0);
    expect(s.memoryVecs()).toHaveLength(2);
  });

  it("deleting/re-indexing a doc removes its vector (privacy regression, spec §8)", async () => {
    const s = seeded();
    await embedMissing(s, stubEmbedder({ lng: 0, pasta: 1 }));
    s.deleteMemoryDoc("vault", "pasta.md");
    expect(s.memoryVecs()).toHaveLength(1);
    indexDoc(s, { source: "vault", ref: "lng.md", domain: "research", title: "LNG prices", body: "changed", ts: TS, fingerprint: "2" });
    expect(s.memoryVecs()).toHaveLength(0); // replaced doc got a new id; stale vec purged
  });
});

describe("hybridRecall", () => {
  it("semantic hit with zero lexical overlap surfaces via the vector layer", async () => {
    const s = seeded();
    const e = stubEmbedder({ lng: 0, "natural gas": 0, pasta: 1 }); // paraphrase shares the lng vector
    await embedMissing(s, e);
    expect(recall(s, "natural gas cheaper", { nowMs: NOW })).toHaveLength(0); // pure BM25 misses
    const hits = await hybridRecall(s, "natural gas cheaper", { nowMs: NOW, embedder: e });
    expect(hits.map((h) => h.ref)).toContain("lng.md");
  });

  it("RRF: a doc ranked by both layers beats single-layer docs; vector-only docs still surface", async () => {
    const s = seeded(); // lng.md (lexical-only for this query), pasta.md (neither)
    indexDoc(s, { source: "vault", ref: "both.md", domain: "research", title: "lng gas", body: "natural gas lng spot market", ts: TS, fingerprint: "1" });
    indexDoc(s, { source: "vault", ref: "veconly.md", domain: "research", title: "winter energy", body: "gasoline got cheaper this winter", ts: TS, fingerprint: "1" });
    // "gasoline" contains the substring "gas" (stub matches on substring) but shares NO token
    // with the query — vector-only. lng.md maps to an orthogonal dim ("percent").
    const e = stubEmbedder({ gas: 0, boil: 1, percent: 2 });
    await embedMissing(s, e);
    const hits = await hybridRecall(s, "lng gas", { nowMs: NOW, embedder: e });
    expect(hits[0].ref).toBe("both.md"); // in both lists → fused rank 1
    expect(hits.map((h) => h.ref)).toContain("veconly.md"); // vector-only doc surfaced
  });

  it("no embedder / latched embedder → identical to lexical recall, no crash (fail-latch, spec §8)", async () => {
    const s = seeded();
    const broken: Embedder = { available: () => false, async embed() { throw new Error("latched"); } };
    const lex = recall(s, "lng", { nowMs: NOW });
    expect(await hybridRecall(s, "lng", { nowMs: NOW })).toEqual(lex);
    expect(await hybridRecall(s, "lng", { nowMs: NOW, embedder: broken })).toEqual(lex);
  });

  it("clearance filter applies to vector-only hits too (privacy, spec §8)", async () => {
    const s = new Store(":memory:");
    indexDoc(s, { source: "memo", ref: "memos/money.md", domain: "money", labels: ["personal.finance"], title: "budget", body: "monthly budget notes", ts: TS, fingerprint: "1" });
    const e = stubEmbedder({ budget: 0, spending: 0 });
    await embedMissing(s, e);
    const hits = await hybridRecall(s, "spending plan", {
      nowMs: NOW, embedder: e, clearance: ["org.internal"], policy: new Policy({ mode: "enforce", report: () => {} }),
    });
    expect(hits).toHaveLength(0);
  });
});

(process.env.AIOS_TEST_REAL_EMBED === "1" ? describe : describe.skip)("real-model golden (opt-in)", () => {
  it("MiniLM ranks the paraphrase target first where BM25 finds nothing", async () => {
    const { LocalEmbedder } = await import("../src/memory/embeddings.js");
    const s = seeded();
    const e = new LocalEmbedder({ cacheDir: "data/models" });
    await embedMissing(s, e);
    expect(recall(s, "natural gas got cheaper this week", { nowMs: NOW }).map((h) => h.ref)).not.toContain("lng.md");
    const hits = await hybridRecall(s, "natural gas got cheaper this week", { nowMs: NOW, embedder: e });
    expect(hits[0].ref).toBe("lng.md");
  }, 120_000);
});
