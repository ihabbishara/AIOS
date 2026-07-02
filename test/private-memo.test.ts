import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { makeResolveDeptFor } from "../src/packs/resolve.js";
import { testRegistry } from "./fixtures/registry.js";

// finance/department.yaml has privateMemo: true — so the money memo must reach the private CFO
// (midas) but NOT the shared, group-facing bookkeeper (juno).
const MEMO_MARKER = "APPROVE_INVOICES_UNDER_FIFTY_ZZZ";

describe("privateMemo gating in resolveDeptFor", () => {
  const reg = testRegistry();

  function deps() {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    vault.writeNote("memos/money.md", `# Money\n${MEMO_MARKER}`);
    const gate = new ActionGate({ store, registry: new ExecutorRegistry(), policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
    return { root, store, vault, gate };
  }

  it("midas (private) receives the memo; juno (shared) does not — both keep mission/persona", () => {
    const { root, store, vault, gate } = deps();
    const resolve = makeResolveDeptFor(reg, { store, vault, gate });
    const origin = { channel: "cli", chatId: "x" };

    const midas = resolve("midas", origin, true)!;
    const juno = resolve("juno", origin, true)!;

    expect(midas.contextBlock).toContain(MEMO_MARKER);
    expect(juno.contextBlock).not.toContain(MEMO_MARKER);

    // Mission/persona survives for both (the finance dept mission).
    expect(midas.contextBlock).toContain("group expense ledger");
    expect(juno.contextBlock).toContain("group expense ledger");

    rmSync(root, { recursive: true, force: true });
  });
});
