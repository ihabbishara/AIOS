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
import { capabilityTools, isGuarded } from "../src/agents/registry/loader.js";
import { FIXTURE_AGENTS_DIR, FIXTURE_PLAYBOOKS_DIR, FIXTURE_AGENT_COUNT, FIXTURE_DEPARTMENTS } from "./fixtures/org.js";

const reg = loadRegistry(
  FIXTURE_AGENTS_DIR,
  FIXTURE_PLAYBOOKS_DIR,
  buildExtras({ vaultPath: "/tmp/v", vaultSubdir: "AIOS", financeCompany: "IDAMA", financeMembers: [{ name: "Ihab" }] }),
);


describe("fixture org", () => {
  // Pinned against test/fixtures/org/, not the operator's live tree — so this count moves only
  // when someone edits the fixture, never because a human hired an agent on one machine. That
  // coupling is why this used to carry a note explaining why the number was 17 *that week*.
  it("loads the fixture's departments and agents", () => {
    expect([...reg.departments.keys()].sort()).toEqual(FIXTURE_DEPARTMENTS);
    expect(reg.agents.size).toBe(FIXTURE_AGENT_COUNT);
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

  // The cockpit asked `!!role.toolChecks`, which is false for EVERY agent here — guards arrive by
  // capability — so /api/state reported every guarded agent as unguarded. isGuarded honours both
  // routes, the way resolveAgent does. (The client agent that used to appear here carried the
  // fourth guard, aws-readonly; its verdicts are covered directly in aws-readonly-guard.test.ts
  // and its unconfigured throw in config.test.ts, so nothing lost coverage when it left.)
  it("isGuarded sees capability guards, not just the role-level shim", () => {
    const guarded = [...reg.agents.keys()].filter((n) => isGuarded(reg, n)).sort();
    expect(guarded).toEqual(["atlas", "juno", "minos"]);
    // The bug in one line: none of them carry role.toolChecks, so the old test was always false.
    expect(guarded.every((n) => !reg.agents.get(n)!.role.toolChecks)).toBe(true);
    expect(isGuarded(reg, "vulcan")).toBe(false);
    expect(isGuarded(reg, "nobody")).toBe(false);
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
