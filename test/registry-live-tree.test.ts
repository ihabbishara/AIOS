import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { makeResolveDeptFor } from "../src/packs/resolve.js";
import { clampTools } from "../src/agents/runner.js";

const reg = loadRegistry(
  join(process.cwd(), "agents"),
  join(process.cwd(), "playbooks"),
  buildExtras({ vaultPath: "/tmp/v", vaultSubdir: "AIOS", financeCompany: "IDAMA", financeMembers: [{ name: "Ihab" }] }),
);

function makeDeps() {
  const vaultRoot = mkdtempSync(join(tmpdir(), "vault-"));
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const vault = new VaultWriter(vaultRoot, "AIOS");
  const gate = new ActionGate({ store, registry: new ExecutorRegistry(), policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
  return { store, vault, gate };
}

describe("live agents/ tree", () => {
  it("loads 6 departments and 15 agents", () => {
    expect([...reg.departments.keys()].sort()).toEqual(
      ["clients", "engineering", "finance", "life", "operations", "research"]);
    expect(reg.agents.size).toBe(15);
  });

  it("legacy @role aliases resolve to mythic canonical names", () => {
    for (const [alias, name] of Object.entries({
      // legacy role aliases
      developer: "vulcan", architect: "athena", tester: "argus", "code-reviewer": "themis",
      devops: "atlas", researcher: "odin", analyst: "clio", "market-researcher": "janus",
      "ui-ux-designer": "venus", reviewer: "minos", cfo: "midas", finance: "juno",
      // arabic name aliases also resolve
      maya: "vulcan", kai: "athena", tarek: "argus", nadia: "themis",
      omar: "atlas", ziad: "odin", lina: "clio", sami: "janus",
      dalia: "venus", yara: "minos", faris: "midas", salim: "juno",
      // chief-of-staff aliases
      rami: "hermes", moderator: "hermes",
    })) expect(reg.agentOf.get(alias), alias).toBe(name);
  });

  it("halalo extras wire the deterministic guard", () => {
    const h = reg.agents.get("halalo")!.role;
    expect(h.toolCheckFallback).toBe("deny");
    expect(h.toolChecks?.Bash).toBeDefined();
    expect(h.systemPrompt).toContain("Exports directory");
    expect(h.systemPrompt).not.toMatch(/ABSOLUTE path under data\/downloads/);
  });

  it("jasmine prompt has unbroken tool chain", () => {
    expect(reg.agents.get("jasmine")!.role.systemPrompt).toContain("update_task/complete_task/dismiss_task");
  });

  it("private agents are midas and jasmine only", () => {
    const priv = [...reg.agents.values()].filter((a) => a.role.privateOnly).map((a) => a.manifest.name).sort();
    expect(priv).toEqual(["jasmine", "midas"]);
  });
});

// SECURITY: the effective-surface pins in this block are the security guard; they
// must stay green.
describe("tool ownership pins (regression guard against pack.yaml deletion)", () => {
  const MONEY_TOOLS = [
    "mcp__money__spending_summary", "mcp__money__list_transactions", "mcp__money__list_subscriptions",
    "mcp__money__confirm_subscription", "mcp__money__dismiss_subscription", "mcp__money__add_subscription",
    "mcp__money__set_budget", "mcp__money__list_budgets", "mcp__money__budget_status",
    "mcp__money__set_category_rule",
  ];

  it("cfo capability pin: midas resolved pack + clamp contains all 10 money tools + aios-pack recall/vault_read", () => {
    const deps = makeDeps();
    const resolve = makeResolveDeptFor(reg, deps);
    const pack = resolve("midas", { channel: "cli", chatId: "x" }, true)!;
    expect(pack).toBeDefined();
    const midas = reg.agents.get("midas")!;
    const clamped = clampTools(midas.role.allowedTools, pack.tools);
    for (const t of MONEY_TOOLS) expect(clamped, `cfo must have ${t}`).toContain(t);
    expect(clamped).toContain("mcp__aios-pack__recall");
    expect(clamped).toContain("mcp__aios-pack__vault_read");
  });

  it("bookkeeper privacy pin: juno clamped tools include ledger tools but NOT mcp__money__* nor the aios-pack memo tools", () => {
    const deps = makeDeps();
    const resolve = makeResolveDeptFor(reg, deps);
    const pack = resolve("juno", { channel: "cli", chatId: "x" }, true)!;
    expect(pack).toBeDefined();
    const juno = reg.agents.get("juno")!;
    const clamped = clampTools(juno.role.allowedTools, pack.tools);
    expect(clamped).toContain("mcp__ledger__add_expense");
    for (const t of MONEY_TOOLS) expect(clamped, `bookkeeper must NOT see ${t}`).not.toContain(t);
    // juno does not own bare recall/vault_read → the finance union's aios-pack memo tools
    // (carried by midas) must NOT leak to the shared bookkeeper.
    expect(clamped, "bookkeeper must NOT get midas's recall").not.toContain("mcp__aios-pack__recall");
    expect(clamped, "bookkeeper must NOT get midas's vault_read").not.toContain("mcp__aios-pack__vault_read");
  });

  it("engineering shell pin: vulcan clamped tools contain mcp__code__sh + vault_write; athena does NOT get Edit/Write/Bash", () => {
    const deps = makeDeps();
    const resolve = makeResolveDeptFor(reg, deps);
    const vulcanPack = resolve("vulcan", { channel: "cli", chatId: "x" }, true)!;
    const athenaPack = resolve("athena", { channel: "cli", chatId: "x" }, true)!;
    expect(vulcanPack).toBeDefined();
    expect(athenaPack).toBeDefined();

    const vulcan = reg.agents.get("vulcan")!;
    const athena = reg.agents.get("athena")!;
    const vulcanClamped = clampTools(vulcan.role.allowedTools, vulcanPack.tools);
    const athenaClamped = clampTools(athena.role.allowedTools, athenaPack.tools);

    expect(vulcanClamped).toContain("mcp__code__sh");
    expect(vulcanClamped).toContain("mcp__aios-pack__vault_write");

    expect(athenaClamped).toContain("mcp__code__sh");
    expect(athenaClamped).toContain("mcp__aios-pack__recall");
    expect(athenaClamped).not.toContain("Edit");
    expect(athenaClamped).not.toContain("Write");
    expect(athenaClamped).not.toContain("Bash");
  });
});
