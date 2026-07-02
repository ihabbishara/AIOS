import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { makeResolveDeptFor } from "../src/packs/resolve.js";

/** Minimal fixture: engineering (with eng-build playbook) + finance (with money toolServer). */
function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "aios-rr-"));
  const agents = join(root, "agents");
  const pbs = join(root, "playbooks");
  mkdirSync(join(agents, "engineering"), { recursive: true });
  mkdirSync(join(agents, "finance"), { recursive: true });
  mkdirSync(pbs, { recursive: true });
  // eng-build playbook
  writeFileSync(join(pbs, "eng-build.yaml"),
    "name: eng-build\ndescription: build\nstages:\n  - type: single\n    id: impl\n    role: maya\n");
  // engineering department
  writeFileSync(join(agents, "engineering", "department.yaml"),
    "department: engineering\nmission: Build software.\nmemoDomain: code\nplaybooks: [eng-build]\n");
  // maya agent (alias: developer)
  writeFileSync(join(agents, "engineering", "maya.yaml"),
    "name: maya\ntitle: Senior Engineer\ndepartment: engineering\ncharter: Owns code changes.\npersona: Terse.\nprompt: You are an engineer.\ntools: [Read, Edit]\npermissionMode: bypassPermissions\nmaxTurns: 80\naliases: [developer]\n");
  // finance department (toolServer: money, empty playbooks)
  writeFileSync(join(agents, "finance", "department.yaml"),
    "department: finance\nmission: Money visibility.\nmemoDomain: money\ntoolServer: money\nplaybooks: []\n");
  // faris agent (alias: cfo) with recall tool so we can test MCP mapping
  writeFileSync(join(agents, "finance", "faris.yaml"),
    "name: faris\ntitle: CFO\ndepartment: finance\ncharter: CFO.\npersona: Precise.\nprompt: You are the CFO.\ntools: [mcp__money__spending_summary, recall]\nmaxTurns: 20\naliases: [cfo]\n");
  return { agents, pbs };
}

function makeDeps(extra: { toolServers?: Record<string, () => unknown> } = {}) {
  const vaultRoot = mkdtempSync(join(tmpdir(), "vault-"));
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const vault = new VaultWriter(vaultRoot, "AIOS");
  const gate = new ActionGate({ store, registry: new ExecutorRegistry(), policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
  return { store, vault, gate, ...extra };
}

const { agents, pbs } = scaffold();
const reg = loadRegistry(agents, pbs);
const deps = makeDeps();
const depsWithMoneyBuilder = makeDeps({
  toolServers: { money: () => ({ __fake: true }) },
});

describe("makeResolveDeptFor", () => {
  it("resolves a playbook to its owning department (tools = union, mapped)", () => {
    const resolve = makeResolveDeptFor(reg, deps);
    const r = resolve("eng-build", { channel: "cli", chatId: "x" })!;
    expect(r.pillar).toBe("engineering");
    expect(r.tools).toContain("Read");
  });

  it("resolves an agent (and its alias) to its department", () => {
    const resolve = makeResolveDeptFor(reg, deps);
    expect(resolve("maya", { channel: "cli", chatId: "x" }, true)!.pillar).toBe("engineering");
    expect(resolve("developer", { channel: "cli", chatId: "x" }, true)!.pillar).toBe("engineering");
  });

  it("maps bare MCP names to the scoped pack server and builds the named toolServer", () => {
    const resolve = makeResolveDeptFor(reg, depsWithMoneyBuilder);
    const r = resolve("faris", { channel: "cli", chatId: "x" }, true)!;
    expect(r.tools).toContain("mcp__aios-pack__recall");
    expect(Object.keys(r.mcpServers)).toContain("money");
  });

  it("returns undefined for unknown keys", () => {
    const resolve = makeResolveDeptFor(reg, deps);
    expect(resolve("nope", { channel: "cli", chatId: "x" })).toBeUndefined();
    expect(resolve("nope", { channel: "cli", chatId: "x" }, true)).toBeUndefined();
  });
});
