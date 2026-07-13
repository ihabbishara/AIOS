// scripts/gen-org-golden.ts — regenerate test/fixtures/org-golden.json from the CURRENT
// resolution path. Run with: npx tsx scripts/gen-org-golden.ts
// The fixture is the acceptance bar for the capability migration: resolveAgent must
// reproduce this surface exactly (documented deltas edit the fixture explicitly).
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { loadConfig } from "../src/config.js";
import { makeResolveDeptFor } from "../src/packs/resolve.js";
import { specialistOptions } from "../src/agents/runner.js";
import { MODERATOR_ALLOWED_TOOLS } from "../src/moderator/session.js";
import type { ActionGate } from "../src/kernel/gate.js";

const config = loadConfig(process.cwd());
const store = new Store(":memory:");
const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "golden-")), "AIOS");
const gate = { propose: async () => ({}) } as unknown as ActionGate;
const registry = loadRegistry("agents", "playbooks", buildExtras(config), () => {});
const resolveDeptFor = makeResolveDeptFor(registry, { store, vault, gate, toolServers: {} });

const origin = { channel: "web", chatId: "ui" };
const golden: Record<string, { tools: string[]; permissionMode: string; maxTurns: number; guarded: boolean }> = {};

for (const name of [...registry.agents.keys()].sort()) {
  const def = registry.agents.get(name)!;
  if (name === "hermes") {
    golden[name] = {
      tools: [...MODERATOR_ALLOWED_TOOLS].sort(),
      permissionMode: "dontAsk", maxTurns: 40, guarded: false,
    };
    continue;
  }
  const pack = resolveDeptFor(name, origin, true);
  const opts = specialistOptions(def.role, name, { cwd: "/tmp", pack }, store);
  golden[name] = {
    tools: [...(opts.allowedTools ?? [])].sort(),
    permissionMode: def.role.permissionMode,
    maxTurns: def.role.maxTurns,
    guarded: !!def.role.toolChecks,
  };
}

writeFileSync("test/fixtures/org-golden.json", JSON.stringify(golden, null, 2) + "\n");
console.log(`wrote ${Object.keys(golden).length} agents to test/fixtures/org-golden.json`);
