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
  it("audit: read-side filtering closes the hole NOW (money doc dropped) AND reports it", () => {
    // Read-side clearance is decoupled from the enforce flip — it only hides docs, so it must
    // enforce immediately even in audit, closing the known domain:money hole before the flip.
    const store = new Store(":memory:");
    seed(store);
    const seen: unknown[] = [];
    const policy = new Policy({ mode: "audit", report: (v) => seen.push(v) });
    const hits = recall(store, "PrivateClinic", { domain: "money", clearance: ["org.internal"], policy });
    expect(hits.every((h) => h.domain !== "money")).toBe(true); // dropped even in audit
    expect(seen.length).toBeGreaterThan(0);                     // and observed
  });
  it("unlabeled docs fail CLOSED for a clearance-scoped caller", () => {
    const store = new Store(":memory:");
    indexDoc(store, { source: "vault", ref: "notes/legacy.md", domain: "code", labels: [],
      title: "Legacy", body: "PrivateClinic orphan note", ts: "2026-07-14T00:00:00Z", fingerprint: "9" });
    const hits = recall(store, "PrivateClinic", { clearance: ["org.internal"], policy: new Policy({ mode: "audit", report: () => {} }) });
    expect(hits.some((h) => h.ref === "notes/legacy.md")).toBe(false); // hidden from a scoped caller
  });
  it("no clearance passed → no filter (moderator/legacy callers unaffected, unlabeled visible)", () => {
    const store = new Store(":memory:");
    seed(store);
    indexDoc(store, { source: "vault", ref: "notes/legacy.md", domain: "code", labels: [],
      title: "Legacy", body: "PrivateClinic orphan note", ts: "2026-07-14T00:00:00Z", fingerprint: "9" });
    const hits = recall(store, "PrivateClinic"); // no clearance → coordinator path
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.ref === "notes/legacy.md")).toBe(true); // coordinator still sees unlabeled
  });
});
