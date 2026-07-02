import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { roles } from "../src/agents/roles/index.js";
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

  it("legacy @role aliases resolve", () => {
    for (const [alias, name] of Object.entries({
      developer: "maya", architect: "kai", tester: "tarek", "code-reviewer": "nadia",
      devops: "omar", researcher: "ziad", analyst: "lina", "market-researcher": "sami",
      "ui-ux-designer": "dalia", reviewer: "yara", cfo: "faris", finance: "salim",
    })) expect(reg.agentOf.get(alias), alias).toBe(name);
  });

  it("compiled roles preserve the legacy security surface", () => {
    const pin: Array<[string, string]> = [
      ["maya", "developer"], ["kai", "architect"], ["tarek", "tester"],
      ["nadia", "code-reviewer"], ["omar", "devops"], ["ziad", "researcher"],
      ["sami", "market-researcher"], ["dalia", "ui-ux-designer"], ["yara", "reviewer"],
      ["lina", "analyst"], ["faris", "cfo"], ["jasmine", "jasmine"], ["halalo", "halalo"],
    ];
    for (const [agent, legacy] of pin) {
      const compiled = reg.agents.get(agent)!.role;
      const old = roles[legacy];
      expect(compiled.permissionMode, agent).toBe(old.permissionMode);
      expect(compiled.maxTurns, agent).toBe(old.maxTurns);
      expect([...compiled.allowedTools].sort(), agent).toEqual([...old.allowedTools].sort());
      expect(!!compiled.privateOnly, agent).toBe(!!old.privateOnly);
      expect(!!compiled.outputSchema, agent).toBe(!!old.outputSchema);
    }
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

  it("private agents are faris and jasmine only", () => {
    const priv = [...reg.agents.values()].filter((a) => a.role.privateOnly).map((a) => a.manifest.name).sort();
    expect(priv).toEqual(["faris", "jasmine"]);
  });
});

describe("tool ownership pins (regression guard against pack.yaml deletion)", () => {
  const MONEY_TOOLS = [
    "mcp__money__spending_summary", "mcp__money__list_transactions", "mcp__money__list_subscriptions",
    "mcp__money__confirm_subscription", "mcp__money__dismiss_subscription", "mcp__money__add_subscription",
    "mcp__money__set_budget", "mcp__money__list_budgets", "mcp__money__budget_status",
    "mcp__money__set_category_rule",
  ];

  it("cfo capability pin: faris resolved pack + clamp contains all 10 money tools + aios-pack recall/vault_read", () => {
    const deps = makeDeps();
    const resolve = makeResolveDeptFor(reg, deps);
    const pack = resolve("faris", { channel: "cli", chatId: "x" }, true)!;
    expect(pack).toBeDefined();
    const faris = reg.agents.get("faris")!;
    const clamped = clampTools(faris.role.allowedTools, pack.tools);
    for (const t of MONEY_TOOLS) expect(clamped, `cfo must have ${t}`).toContain(t);
    expect(clamped).toContain("mcp__aios-pack__recall");
    expect(clamped).toContain("mcp__aios-pack__vault_read");
  });

  it("bookkeeper privacy pin: salim clamped tools include ledger tools but NOT any mcp__money__*", () => {
    const deps = makeDeps();
    const resolve = makeResolveDeptFor(reg, deps);
    const pack = resolve("salim", { channel: "cli", chatId: "x" }, true)!;
    expect(pack).toBeDefined();
    const salim = reg.agents.get("salim")!;
    const clamped = clampTools(salim.role.allowedTools, pack.tools);
    expect(clamped).toContain("mcp__ledger__add_expense");
    for (const t of MONEY_TOOLS) expect(clamped, `bookkeeper must NOT see ${t}`).not.toContain(t);
  });

  it("engineering shell pin: maya clamped tools contain mcp__code__sh + vault_write; kai does NOT get Edit/Write/Bash", () => {
    const deps = makeDeps();
    const resolve = makeResolveDeptFor(reg, deps);
    const mayaPack = resolve("maya", { channel: "cli", chatId: "x" }, true)!;
    const kaiPack = resolve("kai", { channel: "cli", chatId: "x" }, true)!;
    expect(mayaPack).toBeDefined();
    expect(kaiPack).toBeDefined();

    const maya = reg.agents.get("maya")!;
    const kai = reg.agents.get("kai")!;
    const mayaClamped = clampTools(maya.role.allowedTools, mayaPack.tools);
    const kaiClamped = clampTools(kai.role.allowedTools, kaiPack.tools);

    expect(mayaClamped).toContain("mcp__code__sh");
    expect(mayaClamped).toContain("mcp__aios-pack__vault_write");

    expect(kaiClamped).toContain("mcp__code__sh");
    expect(kaiClamped).toContain("mcp__aios-pack__recall");
    expect(kaiClamped).not.toContain("Edit");
    expect(kaiClamped).not.toContain("Write");
    expect(kaiClamped).not.toContain("Bash");
  });
});
