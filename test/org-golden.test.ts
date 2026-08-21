// test/org-golden.test.ts — pins every agent's resolved surface (tools sorted, permissionMode,
// maxTurns, guard presence) through resolveAgent, the ONE resolution path. Regenerate ONLY at
// documented delta points: npx tsx scripts/gen-org-golden.ts (then diff-review).
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { loadConfig } from "../src/config.js";
import { makeResolveAgent } from "../src/agents/resolve.js";
import { FIXTURE_AGENTS_DIR, FIXTURE_PLAYBOOKS_DIR } from "./fixtures/org.js";
import type { ActionGate } from "../src/kernel/gate.js";

const golden = JSON.parse(readFileSync("test/fixtures/org-golden.json", "utf8")) as
  Record<string, { tools: string[]; permissionMode: string; maxTurns: number; guarded: boolean }>;

describe("org golden surface", () => {
  const config = { ...loadConfig(process.cwd()), fullAutonomy: false }; // golden pins granular mode
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "golden-")), "AIOS");
  const gate = { propose: async () => ({}) } as unknown as ActionGate;
  const registry = loadRegistry(FIXTURE_AGENTS_DIR, FIXTURE_PLAYBOOKS_DIR, buildExtras(config), () => {});
  const resolve = makeResolveAgent({ registry, store, vault, gate, config, categorize: async () => "other" as const });
  const origin = { channel: "web", chatId: "ui" };

  it("fixture covers exactly the live registry", () => {
    expect(Object.keys(golden).sort()).toEqual([...registry.agents.keys()].sort());
  });

  for (const name of Object.keys(golden)) {
    it(`${name} resolves to the pinned surface`, () => {
      const def = registry.agents.get(name)!;
      const r = resolve(name, origin)!;
      expect([...(r.options.allowedTools ?? [])].sort()).toEqual(golden[name].tools);
      expect(def.role.permissionMode).toBe(golden[name].permissionMode);
      expect(def.role.maxTurns).toBe(golden[name].maxTurns);
      expect(def.capabilities.some((c) => registry.capabilities.get(c)?.guard !== undefined))
        .toBe(golden[name].guarded);
    });
  }
});
