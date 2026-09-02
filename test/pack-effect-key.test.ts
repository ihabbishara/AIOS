// test/pack-effect-key.test.ts — one goal attempt may land MANY gated effects.
//
// Pins the 2026-09-02 fix: the pack server used the bare attempt key (goalId:node:attempt#)
// as the gate's idempotency key, so the unique index let ONE effect through per attempt and
// every later vault_write came back as "Executed: Saved: <the first file>". Research reports
// landed in knowledge/ while the goals/ copy vanished without a trace in the ledger.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { vaultWriteExecutor } from "../src/kernel/executors.js";
import { newRecord, promote, type TrustPolicy } from "../src/kernel/trust.js";
import { ActionGate } from "../src/kernel/gate.js";
import { VaultWriter } from "../src/vault/writer.js";
import { proposeThroughCeiling, effectKey } from "../src/packs/server.js";

const ORIGIN = { channel: "t", chatId: "1" };
const NOW = "2026-09-02T10:00:00.000Z";
const ATTEMPT = "440d8217:report:3";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const vault = new VaultWriter(root, "AIOS");
  vault.init();
  const registry = new ExecutorRegistry();
  registry.register(vaultWriteExecutor(vault));
  const policy: TrustPolicy = { graduationStreak: 3, graduationAgeDays: 0, shadowMatches: 99, alwaysSupervised: new Set() };
  const gate = new ActionGate({ store, registry, policy, bus, expiryMs: 60_000 });
  // autonomous so execute() runs immediately — the bug was invisible precisely because it did
  store.upsertTrust(promote(newRecord("vault.write", NOW), NOW));
  const deps = { gate, actions: ["vault.write"], origin: ORIGIN, idempotencyKey: ATTEMPT };
  const write = (path: string, content: string) =>
    proposeThroughCeiling(deps, { type: "vault.write", payload: { path, content }, preview: `Write vault note ${path}` });
  const rows = () => store.listActions("executed", 50).filter((a) => a.type === "vault.write");
  const file = (rel: string) => join(vault.root, rel);
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { store, vault, write, rows, file, cleanup };
}

describe("pack gate key is per effect, not per attempt", () => {
  it("two different files written in one attempt BOTH land, and each result names its own file", async () => {
    const { write, rows, file, cleanup } = setup();
    const first = await write("knowledge/hard-blocking.md", "# synthesis");
    const second = await write("goals/2026-08-24-hard-blocking/report.md", "# report");
    expect(first).toBe("Executed: Saved: knowledge/hard-blocking.md");
    expect(second).toBe("Executed: Saved: goals/2026-08-24-hard-blocking/report.md");
    expect(existsSync(file("knowledge/hard-blocking.md"))).toBe(true);
    expect(existsSync(file("goals/2026-08-24-hard-blocking/report.md"))).toBe(true);
    expect(rows()).toHaveLength(2);
    cleanup();
  });

  it("re-proposing the identical effect in the same attempt still dedupes to one row", async () => {
    const { write, rows, cleanup } = setup();
    const a = await write("goals/g/report.md", "same");
    const b = await write("goals/g/report.md", "same");
    expect(b).toBe(a);
    expect(rows()).toHaveLength(1);
    cleanup();
  });

  it("revising the same file within one attempt lands the revision", async () => {
    const { write, rows, file, cleanup } = setup();
    await write("goals/g/report.md", "v1");
    await write("goals/g/report.md", "v2");
    expect(readFileSync(file("goals/g/report.md"), "utf8")).toBe("v2");
    expect(rows()).toHaveLength(2);
    cleanup();
  });

  it("the ledger row carries the effect-scoped key under the attempt namespace", async () => {
    const { write, rows, cleanup } = setup();
    await write("goals/g/report.md", "x");
    const [row] = rows();
    expect(row.idempotency_key).toBe(effectKey(ATTEMPT, "vault.write", { path: "goals/g/report.md", content: "x" }));
    expect(row.idempotency_key!.startsWith(`${ATTEMPT}:vault.write:`)).toBe(true);
    cleanup();
  });
});

describe("effectKey", () => {
  it("is the same key regardless of payload field order", () => {
    expect(effectKey("g:n:1", "vault.write", { path: "a", content: "b" }))
      .toBe(effectKey("g:n:1", "vault.write", { content: "b", path: "a" }));
  });

  it("differs across payload, type, and attempt", () => {
    const base = effectKey("g:n:1", "vault.write", { path: "a", content: "b" });
    expect(effectKey("g:n:1", "vault.write", { path: "a", content: "c" })).not.toBe(base);
    expect(effectKey("g:n:1", "email.send", { path: "a", content: "b" })).not.toBe(base);
    expect(effectKey("g:n:2", "vault.write", { path: "a", content: "b" })).not.toBe(base);
  });
});
