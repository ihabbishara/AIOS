// test/memory-entities.test.ts — entity seeding, query expansion, link boost (spec §3).
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { indexDoc, recall } from "../src/memory/recall.js";
import { matchEntities, expandTokens, linkedEntityIds, extractNewEntities } from "../src/memory/entities.js";
import { tokenize } from "../src/memory/tokenize.js";

const TS = "2026-07-13T00:00:00.000Z";
const NOW = Date.parse("2026-07-14T00:00:00.000Z");

describe("entity store", () => {
  it("upsertEntity merges aliases on re-seed (idempotent)", () => {
    const s = new Store(":memory:");
    const id1 = s.upsertEntity({ name: "bunq", kind: "merchant", aliases: ["the bank"] });
    const id2 = s.upsertEntity({ name: "bunq", kind: "merchant", aliases: ["bank app"] });
    expect(id2).toBe(id1);
    const e = s.listEntities().find((x) => x.name === "bunq")!;
    expect(new Set(e.aliases)).toEqual(new Set(["the bank", "bank app"]));
  });
});

describe("query expansion + linking", () => {
  it("query mentioning an entity alias expands to the canonical name and vice versa", () => {
    const s = new Store(":memory:");
    s.upsertEntity({ name: "bunq", kind: "merchant", aliases: ["the bank"] });
    const ents = s.listEntities();
    const matched = matchEntities(ents, tokenize("bunq transfer"));
    expect(matched.map((e) => e.name)).toEqual(["bunq"]);
    expect(expandTokens(tokenize("bunq transfer"), matched)).toContain("bank");
  });

  it("'bunq' finds a doc that only said 'the bank' (spec §3 golden — misses on pure BM25)", () => {
    const s = new Store(":memory:");
    indexDoc(s, { source: "vault", ref: "note.md", domain: "money", title: "", body: "the bank rejected the transfer yesterday", ts: TS, fingerprint: "1" });
    expect(recall(s, "bunq", { nowMs: NOW })).toHaveLength(0); // pure lexical: no such token
    s.upsertEntity({ name: "bunq", kind: "merchant", aliases: ["the bank"] });
    const hits = recall(s, "bunq", { nowMs: NOW });
    expect(hits).toHaveLength(1);
    expect(hits[0].ref).toBe("note.md");
  });

  it("indexDoc links docs to entities; linked docs get a rank boost on entity queries", () => {
    const s = new Store(":memory:");
    s.upsertEntity({ name: "halalo", kind: "project", aliases: [] });
    indexDoc(s, { source: "vault", ref: "linked.md", domain: "code", title: "halalo deploy", body: "deploy pipeline notes", ts: TS, fingerprint: "1" });
    indexDoc(s, { source: "vault", ref: "plain.md", domain: "code", title: "deploy", body: "deploy pipeline notes", ts: TS, fingerprint: "1" });
    expect(linkedEntityIds(s.listEntities(), new Set(tokenize("halalo deploy pipeline")))).toHaveLength(1);
    const hits = recall(s, "halalo pipeline", { nowMs: NOW });
    expect(hits[0].ref).toBe("linked.md");
  });
});

describe("extractNewEntities (evening, fail-silent)", () => {
  it("upserts extracted entities, watermarks via kv, and swallows extractor failures", async () => {
    const s = new Store(":memory:");
    indexDoc(s, { source: "vault", ref: "a.md", domain: "general", title: "Meeting with Jasmine", body: "x", ts: TS, fingerprint: "1" });
    const n = await extractNewEntities({ store: s, extract: async () => [{ name: "Jasmine", kind: "person", aliases: [] }] });
    expect(n).toBe(1);
    expect(s.listEntities().map((e) => e.name)).toContain("Jasmine");
    // second run: watermark advanced, no new titles → extractor not called
    let called = 0;
    await extractNewEntities({ store: s, extract: async () => { called++; return []; } });
    expect(called).toBe(0);
    // failure is silent
    indexDoc(s, { source: "vault", ref: "b.md", domain: "general", title: "New note", body: "y", ts: TS, fingerprint: "1" });
    await expect(extractNewEntities({ store: s, extract: async () => { throw new Error("boom"); } })).resolves.toBe(0);
  });
});
