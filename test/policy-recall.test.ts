// test/policy-recall.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { indexDoc, recall } from "../src/memory/recall.js";
import { Policy } from "../src/kernel/policy.js";

function seed(store: Store) {
  indexDoc(store, { source: "memo", ref: "memos/money.md", domain: "money", labels: ["personal.finance"],
    title: "Money", body: "PrivateClinic invoice reconciled", ts: "2026-07-14T00:00:00Z", fingerprint: "1" });
  indexDoc(store, { source: "memo", ref: "memos/code.md", domain: "code", labels: ["org.internal"],
    title: "Code", body: "PrivateClinic build note refactor", ts: "2026-07-14T00:00:00Z", fingerprint: "1" });
}

describe("recall clearance filter (spec §7.8)", () => {
  it("enforce: a shared-clearance agent gets NO personal.finance doc even with domain:money", () => {
    const store = new Store(":memory:");
    seed(store);
    const policy = new Policy({ mode: "enforce", report: () => {} });
    const hits = recall(store, "PrivateClinic", { domain: "money", clearance: ["org.internal"], policy });
    expect(hits.every((h) => h.domain !== "money")).toBe(true);
  });
  it("enforce: a finance-cleared agent DOES see the money doc", () => {
    const store = new Store(":memory:");
    seed(store);
    const policy = new Policy({ mode: "enforce", report: () => {} });
    const hits = recall(store, "PrivateClinic", { clearance: ["personal.finance", "org.internal"], policy });
    expect(hits.some((h) => h.domain === "money")).toBe(true);
  });
  it("audit: the hole stays open (money doc returned) but a violation is reported", () => {
    const store = new Store(":memory:");
    seed(store);
    const seen: unknown[] = [];
    const policy = new Policy({ mode: "audit", report: (v) => seen.push(v) });
    const hits = recall(store, "PrivateClinic", { domain: "money", clearance: ["org.internal"], policy });
    expect(hits.some((h) => h.domain === "money")).toBe(true); // not blocked in audit
    expect(seen.length).toBeGreaterThan(0);                     // but observed
  });
  it("no clearance passed → no filter (moderator/legacy callers unaffected)", () => {
    const store = new Store(":memory:");
    seed(store);
    expect(recall(store, "PrivateClinic").length).toBeGreaterThan(0);
  });
});
