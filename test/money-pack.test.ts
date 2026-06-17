import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { resolvePack } from "../src/packs/resolve.js";
import { packSchema } from "../src/packs/types.js";
import { buildMoneyServer } from "../src/money/server.js";
import { makeCategorizer } from "../src/money/categorize.js";

describe("money pack resolves with the money server", () => {
  it("a money manifest (toolServer: money) yields both aios-pack and money servers + fq tools", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const gate = new ActionGate({ store, registry: new ExecutorRegistry(), policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
    const categorize = makeCategorizer(store, async () => "other");
    const pack = packSchema.parse({
      pillar: "money", persona: "CFO", memoDomain: "money", toolServer: "money", roles: ["cfo"],
      tools: ["mcp__money__spending_summary", "recall", "vault_read"],
    });
    const r = resolvePack(pack, {
      store, vault: new VaultWriter("/tmp/aios-test-vault", "test"), gate, origin: { channel: "telegram", chatId: "1" },
      toolServers: { money: (d) => buildMoneyServer({ store: d.store, categorize }) },
    });
    expect(Object.keys(r.mcpServers).sort()).toEqual(["aios-pack", "money"]);
    expect(r.tools).toContain("mcp__money__spending_summary");      // already fq → passes through
    expect(r.tools).toContain("mcp__aios-pack__recall");            // shared tool rewritten
  });
});
