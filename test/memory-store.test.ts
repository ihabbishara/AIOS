import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

describe("memory index store", () => {
  it("upserts a doc with postings and reads them back", () => {
    const s = new Store(":memory:");
    s.upsertMemoryDoc(
      { source: "vault", ref: "notes/a.md", domain: "general", title: "LNG", body: "spot price dropped", ts: "2026-06-01T00:00:00.000Z", len: 4, fingerprint: "100" },
      [["lng", 3], ["spot", 1], ["price", 1], ["drop", 1]],
    );
    expect(s.memoryFingerprint("vault", "notes/a.md")).toBe("100");
    expect(s.memoryStats().count).toBe(1);
    expect(s.memoryStats().avgLen).toBe(4);
    const rows = s.memoryPostings(["price", "spot"]);
    expect(rows.map((r) => r.token).sort()).toEqual(["price", "spot"]);
    expect(rows[0].ref).toBe("notes/a.md");
  });

  it("re-upsert replaces postings (no duplicates) and deletes prune both tables", () => {
    const s = new Store(":memory:");
    s.upsertMemoryDoc({ source: "vault", ref: "n.md", domain: "general", title: "x", body: "y", ts: "t", len: 2, fingerprint: "1" }, [["x", 1], ["y", 1]]);
    s.upsertMemoryDoc({ source: "vault", ref: "n.md", domain: "general", title: "x", body: "z", ts: "t", len: 2, fingerprint: "2" }, [["x", 1], ["z", 1]]);
    expect(s.memoryFingerprint("vault", "n.md")).toBe("2");
    expect(s.memoryPostings(["y"]).length).toBe(0);
    expect(s.memoryPostings(["z"]).length).toBe(1);
    expect(s.memoryStats().count).toBe(1);
    s.deleteMemoryDoc("vault", "n.md");
    expect(s.memoryStats().count).toBe(0);
    expect(s.memoryPostings(["z"]).length).toBe(0);
    expect(s.listMemoryRefs("vault")).toEqual([]);
  });

  it("memoryPostings filters by domain; memoryDocsByIds returns bodies", () => {
    const s = new Store(":memory:");
    s.upsertMemoryDoc({ source: "decision", ref: "a1", domain: "money", title: "", body: "invoice", ts: "t", len: 1, fingerprint: "1" }, [["invoice", 1]]);
    s.upsertMemoryDoc({ source: "decision", ref: "a2", domain: "code", title: "", body: "invoice", ts: "t", len: 1, fingerprint: "1" }, [["invoice", 1]]);
    expect(s.memoryPostings(["invoice"]).length).toBe(2);
    expect(s.memoryPostings(["invoice"], "money").length).toBe(1);
    const id = s.memoryPostings(["invoice"], "money")[0].doc_id;
    expect(s.memoryDocsByIds([id])[0].body).toBe("invoice");
  });
});
