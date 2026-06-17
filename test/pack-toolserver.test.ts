import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { resolvePack } from "../src/packs/resolve.js";
import { packSchema } from "../src/packs/types.js";

function deps(extra: Record<string, unknown> = {}) {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const gate = new ActionGate({ store, registry: new ExecutorRegistry(), policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
  const vaultRoot = mkdtempSync(join(tmpdir(), "vault-"));
  return { store, vault: new VaultWriter(vaultRoot, "test"), gate, origin: { channel: "web", chatId: "x" }, ...extra };
}
const base = { pillar: "money", persona: "p", memoDomain: "money" };

describe("pack-specific tool-server", () => {
  it("a pack with no toolServer resolves to only the shared aios-pack server (zero regression)", () => {
    const pack = packSchema.parse(base);
    const r = resolvePack(pack, deps());
    expect(Object.keys(r.mcpServers)).toEqual(["aios-pack"]);
  });

  it("a pack with toolServer pointing at a registered builder adds that named server", () => {
    const pack = packSchema.parse({ ...base, toolServer: "money" });
    const built: string[] = [];
    const r = resolvePack(pack, deps({ toolServers: { money: () => { built.push("money"); return { __server: "money" }; } } }));
    expect(Object.keys(r.mcpServers).sort()).toEqual(["aios-pack", "money"]);
    expect(built).toEqual(["money"]); // builder invoked once
  });

  it("an unknown toolServer is fail-soft: pack still loads with only the shared server", () => {
    const pack = packSchema.parse({ ...base, toolServer: "nope" });
    const r = resolvePack(pack, deps({ toolServers: {} }));
    expect(Object.keys(r.mcpServers)).toEqual(["aios-pack"]);
  });
});
