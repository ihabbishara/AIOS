// scripts/gen-org-golden.ts — regenerate test/fixtures/org-golden.json from resolveAgent
// (the ONE resolution path). Run with: npx tsx scripts/gen-org-golden.ts
// The fixture pins each agent's resolved tool surface; regenerate ONLY at documented
// delta points and diff-review the result.
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry, isGuarded } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { loadConfig } from "../src/config.js";
import { makeResolveAgent } from "../src/agents/resolve.js";
import { useClientFixtureDir } from "../test/fixtures/client-env.js";
import type { ActionGate } from "../src/kernel/gate.js";

// The client agent's surface depends on AIOS_CLIENT_AGENT/AIOS_CLIENT_DIR, and neither this
// script nor vitest loads .env — so generating with an ambient shell produced a golden the suite
// could not reproduce (or threw outright, since aws-readonly refuses to build without the dir).
// Share ONE definition with the tests that read the fixture, so regeneration is deterministic.
useClientFixtureDir();

const config = loadConfig(process.cwd());
const store = new Store(":memory:");
const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "golden-")), "AIOS");
const gate = { propose: async () => ({}) } as unknown as ActionGate;
const registry = loadRegistry("agents", "playbooks", buildExtras(config), () => {});
const resolve = makeResolveAgent({ registry, store, vault, gate, config, categorize: async () => "other" as const });

const origin = { channel: "web", chatId: "ui" };
const golden: Record<string, { tools: string[]; permissionMode: string; maxTurns: number; guarded: boolean }> = {};

for (const name of [...registry.agents.keys()].sort()) {
  const def = registry.agents.get(name)!;
  const r = resolve(name, origin)!;
  golden[name] = {
    tools: [...(r.options.allowedTools ?? [])].sort(),
    permissionMode: def.role.permissionMode,
    maxTurns: def.role.maxTurns,
    guarded: isGuarded(registry, name),
  };
}

writeFileSync("test/fixtures/org-golden.json", JSON.stringify(golden, null, 2) + "\n");
console.log(`wrote ${Object.keys(golden).length} agents to test/fixtures/org-golden.json`);
