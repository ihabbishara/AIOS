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
import { capabilityTools } from "../src/agents/registry/loader.js";
import { NAMED_GUARDS } from "../src/agents/guards/index.js";
import { useHalaloFixtureDir } from "./fixtures/halalo-env.js";

useHalaloFixtureDir();

const reg = loadRegistry(
  join(process.cwd(), "agents"),
  join(process.cwd(), "playbooks"),
  buildExtras({ vaultPath: "/tmp/v", vaultSubdir: "AIOS", financeCompany: "IDAMA", financeMembers: [{ name: "Ihab" }] }),
);


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
      rami: "neo", moderator: "neo",
    })) expect(reg.agentOf.get(alias), alias).toBe(name);
  });

  it("halalo carries the deterministic readonly guard via the halalo-aws capability", () => {
    const halalo = reg.agents.get("halalo")!;
    const guards = halalo.capabilities.map((c) => reg.capabilities.get(c)?.guard).filter(Boolean);
    expect(guards).toContain("halalo-readonly");
    const named = NAMED_GUARDS["halalo-readonly"]({ halaloDir: "/tmp/h", vaultPath: "/tmp/v", vaultSubdir: "AIOS" });
    expect(named.fallback).toBe("deny");
    expect(named.checks.Bash).toBeDefined();
    expect(halalo.role.systemPrompt).toContain("Exports directory");
  });

  it("jasmine prompt names every lifeops tool", () => {
    const prompt = reg.agents.get("jasmine")!.role.systemPrompt;
    for (const tool of ["add_task", "list_tasks", "update_task", "complete_task", "dismiss_task"]) {
      expect(prompt).toContain(tool);
    }
  });

  it("research department carries a planner doctrine and minos can fetch", () => {
    const d = reg.departments.get("research")!;
    expect(d.plannerDoctrine).toMatch(/fan out/i);
    expect(reg.agents.get("minos")!.role.allowedTools).toContain("WebFetch");
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
    const clamped = capabilityTools(reg, "midas");
    for (const t of MONEY_TOOLS) expect(clamped, `cfo must have ${t}`).toContain(t);
    expect(clamped).toContain("mcp__aios-pack__recall");
    expect(clamped).toContain("mcp__aios-pack__vault_read");
  });

  it("bookkeeper privacy pin: juno clamped tools include ledger tools but NOT mcp__money__* nor the aios-pack memo tools", () => {
    const clamped = capabilityTools(reg, "juno");
    expect(clamped).toContain("mcp__ledger__add_expense");
    for (const t of MONEY_TOOLS) expect(clamped, `bookkeeper must NOT see ${t}`).not.toContain(t);
    // juno does not own bare recall/vault_read → the finance union's aios-pack memo tools
    // (carried by midas) must NOT leak to the shared bookkeeper.
    expect(clamped, "bookkeeper must NOT get midas's recall").not.toContain("mcp__aios-pack__recall");
    expect(clamped, "bookkeeper must NOT get midas's vault_read").not.toContain("mcp__aios-pack__vault_read");
  });

  it("engineering shell pin: vulcan clamped tools contain mcp__code__sh + vault_write; athena does NOT get Edit/Write/Bash", () => {
    const vulcanClamped = capabilityTools(reg, "vulcan");
    const athenaClamped = capabilityTools(reg, "athena");

    expect(vulcanClamped).toContain("mcp__code__sh");
    expect(vulcanClamped).toContain("mcp__aios-pack__vault_write");

    expect(athenaClamped).toContain("mcp__code__sh");
    expect(athenaClamped).toContain("mcp__aios-pack__recall");
    expect(athenaClamped).not.toContain("Edit");
    expect(athenaClamped).not.toContain("Write");
    expect(athenaClamped).not.toContain("Bash");
  });
});
