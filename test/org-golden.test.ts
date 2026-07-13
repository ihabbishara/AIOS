// test/org-golden.test.ts — the migration's acceptance bar. The fixture pins the resolved
// tool surface per agent; capability migration must reproduce it exactly. Regenerate ONLY
// at documented delta points: npx tsx scripts/gen-org-golden.ts
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
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

const golden = JSON.parse(readFileSync("test/fixtures/org-golden.json", "utf8")) as
  Record<string, { tools: string[]; permissionMode: string; maxTurns: number; guarded: boolean }>;

describe("org golden surface", () => {
  const config = loadConfig(process.cwd());
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "golden-")), "AIOS");
  const gate = { propose: async () => ({}) } as unknown as ActionGate;
  const registry = loadRegistry("agents", "playbooks", buildExtras(config), () => {});
  const resolveDeptFor = makeResolveDeptFor(registry, { store, vault, gate, toolServers: {} });
  const origin = { channel: "web", chatId: "ui" };

  it("fixture covers exactly the live registry", () => {
    expect(Object.keys(golden).sort()).toEqual([...registry.agents.keys()].sort());
  });

  for (const name of Object.keys(golden)) {
    it(`${name} resolves to the pinned surface`, () => {
      const def = registry.agents.get(name)!;
      if (name === "hermes") {
        expect([...MODERATOR_ALLOWED_TOOLS].sort()).toEqual(golden[name].tools);
        return;
      }
      const opts = specialistOptions(def.role, name, { cwd: "/tmp", pack: resolveDeptFor(name, origin, true) }, store);
      expect([...(opts.allowedTools ?? [])].sort()).toEqual(golden[name].tools);
      expect(def.role.permissionMode).toBe(golden[name].permissionMode);
      expect(def.role.maxTurns).toBe(golden[name].maxTurns);
      expect(!!def.role.toolChecks).toBe(golden[name].guarded);
    });
  }
});
