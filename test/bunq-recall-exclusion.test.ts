import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { reconcile } from "../src/memory/indexer.js";
import { recall } from "../src/memory/recall.js";

describe("bank data is excluded from recall", () => {
  it("a synced transaction is never indexed / recallable", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const store = new Store(":memory:");
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    store.upsertPersonalTransaction({
      account_id: "acc1", account_label: "Main", bunq_id: 1, amount_cents: -4200, currency: "EUR",
      description: "SecretPharmacyPurchase", counterparty: "Pharmacy", counterparty_iban: null, type: "CARD",
      bunq_created: "2026-06-10T08:00:00.000Z",
    });
    reconcile(store, vault); // boot indexing pass over vault + decisions + events
    expect(recall(store, "SecretPharmacyPurchase")).toEqual([]); // bank data not indexed
    expect(recall(store, "Pharmacy")).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
