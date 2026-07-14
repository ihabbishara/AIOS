// test/memory-capture.test.ts — post-turn conversational capture (spec §5).
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { captureTurn } from "../src/memory/capture.js";

describe("captureTurn", () => {
  it("extracted candidates land as agent-inferred teachings (pending pipeline)", async () => {
    const s = new Store(":memory:");
    const n = await captureTurn(
      { store: s, extract: async () => [{ text: "user's sister is called Mira", kind: "fact", domain: null }] },
      "my sister Mira visits tomorrow", "Noted — enjoy the visit!",
    );
    expect(n).toBe(1);
    const t = s.listUnconsolidatedTeachings(null)[0];
    expect(t.origin).toBe("agent-inferred");
    expect(t.kind).toBe("fact");
  });

  it("dedup guard: a candidate matching an existing pending teaching is skipped (spec §5)", async () => {
    const s = new Store(":memory:");
    s.addTeaching({ text: "Prefers oat milk!", domain: "general", kind: "preference" });
    const n = await captureTurn(
      { store: s, extract: async () => [{ text: "prefers oat milk", kind: "preference", domain: "general" }] },
      "u", "r",
    );
    expect(n).toBe(0);
  });

  it("extractor failure is silent (no throw, no rows)", async () => {
    const s = new Store(":memory:");
    await expect(captureTurn(
      { store: s, extract: async () => { throw new Error("model down"); } }, "u", "r",
    )).resolves.toBe(0);
    expect(s.listUnconsolidatedTeachings()).toHaveLength(0);
  });

  it("extractor sees pending + active facts as known context (dedup input)", async () => {
    const s = new Store(":memory:");
    s.addTeaching({ text: "likes jazz", domain: "general", kind: "preference" });
    s.addMemoFact({ domain: "general", subject: "music", fact: "collects vinyl", origin: "user-stated" });
    let seenKnown = "";
    await captureTurn({ store: s, extract: async ({ known }) => { seenKnown = known; return []; } }, "u", "r");
    expect(seenKnown).toContain("likes jazz");
    expect(seenKnown).toContain("collects vinyl");
  });

  it("invalid kinds/empty texts from the extractor are dropped", async () => {
    const s = new Store(":memory:");
    const n = await captureTurn(
      { store: s, extract: async () => [
        { text: "", kind: "fact", domain: null },
        { text: "x", kind: "banana" as never, domain: null },
      ] }, "u", "r",
    );
    expect(n).toBe(0);
  });
});
