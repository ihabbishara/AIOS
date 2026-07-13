import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { ActionGate } from "../src/kernel/gate.js";
import { EventBus } from "../src/events.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { z } from "zod";

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

describe("teachings + decisions", () => {
  it("captures teachings and consolidates them", () => {
    const s = new Store(":memory:");
    const id = s.addTeaching({ text: "always CC Sara", domain: "money", kind: "preference" });
    const fact = s.addTeaching({ text: "Sara is my partner", domain: null, kind: "fact" });
    expect(s.listUnconsolidatedTeachings().length).toBe(2);
    expect(s.listUnconsolidatedTeachings("money").map((t) => t.id)).toEqual([id]);
    expect(s.listUnconsolidatedTeachings(null).map((t) => t.id)).toEqual([fact]); // profile (domain IS NULL)
    s.markTeachingsConsolidated([id]);
    expect(s.listUnconsolidatedTeachings("money").length).toBe(0);
    expect(s.listUnconsolidatedTeachings().length).toBe(1);
  });

  it("listDecisions derives verdict from status + verdict_by", async () => {
    const s = new Store(":memory:");
    const bus = new EventBus(s);
    const registry = new ExecutorRegistry();
    registry.register({ type: "finance.pay", schema: z.object({}), async execute() { return "ok"; } });
    const gate = new ActionGate({ store: s, registry, policy: { graduationStreak: 99, graduationAgeDays: 0, shadowMatches: 99, alwaysSupervised: new Set() }, bus, expiryMs: 60000 });
    const a = await gate.propose({ type: "finance.pay", payload: {}, preview: "pay rent" }, { channel: "cli", chatId: "x" });
    await gate.resolve(a.id, "approve", { by: "ihab" });
    const b = await gate.propose({ type: "finance.pay", payload: {}, preview: "pay gym" }, { channel: "cli", chatId: "x" });
    await gate.resolve(b.id, "reject", { by: "ihab", reason: "cancel it" });
    const decs = s.listDecisions();
    const pay = decs.find((d) => d.preview === "pay rent")!;
    const gym = decs.find((d) => d.preview === "pay gym")!;
    expect(pay.verdict).toBe("approved");
    expect(gym.verdict).toBe("rejected");
    expect(gym.reason).toBe("cancel it");
  });

  it("listDecisions(since) returns only decisions resolved after the timestamp", async () => {
    const s = new Store(":memory:");
    const bus = new EventBus(s);
    const registry = new ExecutorRegistry();
    registry.register({ type: "finance.pay", schema: z.object({}), async execute() { return "ok"; } });
    const gate = new ActionGate({ store: s, registry, policy: { graduationStreak: 99, graduationAgeDays: 0, shadowMatches: 99, alwaysSupervised: new Set() }, bus, expiryMs: 60000 });
    const first = await gate.propose({ type: "finance.pay", payload: {}, preview: "pay first" }, { channel: "cli", chatId: "x" });
    await gate.resolve(first.id, "approve", { by: "ihab" });
    await new Promise((r) => setTimeout(r, 5)); // ensure resolved_at timestamps differ
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const second = await gate.propose({ type: "finance.pay", payload: {}, preview: "pay second" }, { channel: "cli", chatId: "x" });
    await gate.resolve(second.id, "approve", { by: "ihab" });
    const decs = s.listDecisions(since);
    expect(decs.map((d) => d.preview)).toEqual(["pay second"]);
  });
});
