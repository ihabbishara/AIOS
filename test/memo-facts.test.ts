// test/memo-facts.test.ts — fact-granular memos: store CRUD + render projection (spec §4).
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { renderMemo } from "../src/memory/facts.js";

describe("memo_facts store", () => {
  it("addMemoFact/activeMemoFacts round-trip; supersede keeps history", () => {
    const s = new Store(":memory:");
    const a = s.addMemoFact({ domain: "general", subject: "coffee", fact: "prefers oat milk", origin: "user-stated", sourceRef: "teaching:1" });
    const b = s.addMemoFact({ domain: "general", subject: "coffee", fact: "prefers black coffee", origin: "user-stated", sourceRef: "teaching:2" });
    s.supersedeMemoFact(a, b);
    const active = s.activeMemoFacts("general");
    expect(active.map((f) => f.id)).toEqual([b]);
    const all = s.activeMemoFacts();
    expect(all).toHaveLength(1); // superseded rows excluded from active everywhere
  });

  it("teachings carry origin (default user-stated)", () => {
    const s = new Store(":memory:");
    s.addTeaching({ text: "x", domain: null, kind: "fact" });
    s.addTeaching({ text: "y", domain: null, kind: "fact", origin: "agent-inferred" });
    const rows = s.listUnconsolidatedTeachings(null);
    expect(rows.map((t) => t.origin)).toEqual(["user-stated", "agent-inferred"]);
  });
});

describe("renderMemo (spec §4: prose is a projection of active facts)", () => {
  it("groups by subject, dates each fact, and excludes untrusted-origin facts (prompt.system rule)", () => {
    const facts = [
      { id: 1, domain: "general", subject: "coffee", fact: "prefers oat milk", ts: "2026-07-01T00:00:00Z", source_ref: null, status: "active" as const, origin: "user-stated" as const, superseded_by: null },
      { id: 2, domain: "general", subject: "coffee", fact: "no sugar", ts: "2026-07-02T00:00:00Z", source_ref: null, status: "active" as const, origin: "agent-inferred" as const, superseded_by: null },
      { id: 3, domain: "general", subject: "travel", fact: "hates red-eyes", ts: "2026-07-03T00:00:00Z", source_ref: null, status: "active" as const, origin: "untrusted" as const, superseded_by: null },
    ];
    const md = renderMemo("general", facts);
    expect(md).toContain("## coffee");
    expect(md).toContain("- prefers oat milk (2026-07-01)");
    expect(md).toContain("- no sugar (2026-07-02)");
    expect(md).not.toContain("red-eyes"); // untrusted never reaches a prompt.system surface
    expect(md).not.toContain("## travel");
  });

  it("empty active set renders an empty string (distiller keeps the prior memo)", () => {
    expect(renderMemo("general", [])).toBe("");
  });
});
