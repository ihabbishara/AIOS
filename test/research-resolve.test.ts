// test/research-resolve.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { loadPacks } from "../src/packs/loader.js";
import { makeResolvePackFor } from "../src/packs/resolve.js";
import { buildResearchServer } from "../src/research/server.js";
import { buildPacksView } from "../src/web/packs-view.js";
import { reindexVault } from "../src/memory/indexer.js";
import { recall } from "../src/memory/recall.js";

const PB = join(process.cwd(), "playbooks");

function makeDeps() {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const gate = new ActionGate({ store, registry: new ExecutorRegistry(), policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
  const vaultRoot = mkdtempSync(join(tmpdir(), "rv-"));
  const vault = new VaultWriter(vaultRoot, "test");
  return { store, vault, gate };
}

describe("research pack resolve + recall + view", () => {
  it("resolvePack builds the research mcp server, persona, and replaced tools", () => {
    const reg = loadPacks(PB);
    const { store, vault, gate } = makeDeps();
    const resolve = makeResolvePackFor(reg, {
      store,
      vault,
      gate,
      toolServers: { research: (d) => buildResearchServer({ store: d.store }) },
    });
    const origin = { channel: "web", chatId: "t" };
    const resolved = resolve("research-report", origin)!;
    expect(resolved).toBeTruthy();
    expect(resolved.contextBlock).toMatch(/research analyst/i);
    const serverNames = Object.keys(resolved.mcpServers);
    expect(serverNames).toContain("research");
    expect(serverNames).toContain("aios-pack");
  });

  it("a knowledge/ note is recallable in the research domain (KB read path)", () => {
    const { store, vault } = makeDeps();
    vault.writeNote("knowledge/vector-search", "Vector search uses embeddings and ANN indexes for recall.");
    reindexVault(store, vault);
    const hits = recall(store, "embeddings ANN", { domain: "research" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].ref).toBe("knowledge/vector-search.md");
  });

  it("buildPacksView returns a research card", () => {
    const view = buildPacksView(
      { playbooksDir: PB, workspaceRoot: join(tmpdir(), "ws"), projectsRoot: tmpdir() } as any,
      new Store(":memory:"),
    );
    const research = view.find((p) => p.pillar === "research")!;
    expect(research).toBeTruthy();
    expect(research.toolServer).toBe("research");
    expect(research.actions).toEqual(["vault.write"]);
    expect(research.playbooks.map((p) => p.name).sort()).toEqual(["market-research", "product-design", "research-report"]);
    expect(research.roles.map((r) => r.name)).toContain("analyst");
  });
});
