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

function deps(extra: object = {}) {
  const vaultRoot = mkdtempSync(join(tmpdir(), "vault-"));
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const vault = new VaultWriter(vaultRoot, "AIOS");
  const gate = new ActionGate({ store, registry: new ExecutorRegistry(), policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
  return { store, vault, gate, origin: { channel: "x", chatId: "y" }, ...extra };
}

const codePack = packSchema.parse({
  pillar: "code", persona: "p", memoDomain: "code", sandbox: true,
  tools: ["Read", "Write", "mcp__code__sh", "recall"], actions: ["vault.write"], roles: ["developer"],
});

describe("resolvePack confinement", () => {
  it("with a workspace → jailed guard + code server", () => {
    const taskDir = mkdtempSync(join(tmpdir(), "ws-"));
    const r = resolvePack(codePack, deps({ workspace: { taskDir, mode: "build" } }) as any);
    expect(r.confinement?.permissionMode).toBe("default");
    expect(r.confinement?.guard.Write).toBeTypeOf("function");
    expect(Object.keys(r.mcpServers)).toContain("code");
  });

  it("without a workspace → advisory guard, no code server", () => {
    const r = resolvePack(codePack, deps() as any);
    expect(r.confinement?.guard.Write({ file_path: "/ws/t/x" }).ok).toBe(false);
    expect(Object.keys(r.mcpServers)).not.toContain("code");
  });

  it("a non-sandbox pack has no confinement (unchanged)", () => {
    const money = packSchema.parse({ pillar: "money", persona: "p", memoDomain: "money", roles: ["cfo"] });
    const r = resolvePack(money, deps() as any);
    expect(r.confinement).toBeUndefined();
  });
});
