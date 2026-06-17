import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { reconcile } from "../src/memory/indexer.js";
import { recall } from "../src/memory/recall.js";
import { makeCategorizer } from "../src/money/categorize.js";
import { spendingSummary } from "../src/money/ops.js";

describe("money privacy — bank data never reaches recall", () => {
  it("after categorize/summary, recall finds no transaction counterparties/descriptions", async () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const store = new Store(":memory:");
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    store.upsertPersonalTransaction({
      account_id: "acc1", account_label: "Main", bunq_id: 1, amount_cents: -4200, currency: "EUR",
      description: "SecretClinicVisit", counterparty: "PrivateClinicXYZ", counterparty_iban: null, type: "CARD",
      bunq_created: "2026-06-10T08:00:00.000Z",
    });
    const cat = makeCategorizer(store, async () => "health");
    await spendingSummary(store, cat, "2026-06"); // exercises categorize → personal_tx_category

    reconcile(store, vault); // boot indexing pass over vault + decisions + events
    expect(recall(store, "PrivateClinicXYZ")).toEqual([]);
    expect(recall(store, "SecretClinicVisit")).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
