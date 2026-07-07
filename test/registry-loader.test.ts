import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, dropDepartment, disabledDepartments } from "../src/agents/registry/loader.js";

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "aios-reg-"));
  const agents = join(root, "agents");
  const pbs = join(root, "playbooks");
  mkdirSync(join(agents, "engineering"), { recursive: true });
  mkdirSync(pbs, { recursive: true });
  writeFileSync(join(pbs, "echo.yaml"),
    "name: echo\ndescription: smoke\nstages:\n  - type: single\n    id: echo\n    role: ziad\n");
  writeFileSync(join(pbs, "eng-build.yaml"),
    "name: eng-build\ndescription: build\nstages:\n  - type: single\n    id: impl\n    role: maya\n");
  writeFileSync(join(agents, "engineering", "department.yaml"),
    "department: engineering\nmission: Build software.\nmemoDomain: code\nplaybooks: [eng-build]\n");
  writeFileSync(join(agents, "engineering", "maya.yaml"),
    "name: maya\ntitle: Senior Engineer\ndepartment: engineering\ncharter: Owns code changes.\npersona: Terse.\nprompt: You are an engineer.\ntools: [Read, Edit]\npermissionMode: bypassPermissions\nmaxTurns: 80\naliases: [developer]\n");
  writeFileSync(join(agents, "engineering", "ziad.yaml"),
    "name: ziad\ntitle: Eng Researcher\ndepartment: engineering\ncharter: Investigates.\npersona: Fast.\nprompt: You research.\ntools: [Read, Grep]\n");
  return { root, agents, pbs };
}

describe("loadRegistry", () => {
  let t: ReturnType<typeof scaffold>;
  beforeEach(() => { t = scaffold(); });

  it("loads agents, departments, aliases, playbook ownership, tools union", () => {
    const reg = loadRegistry(t.agents, t.pbs);
    expect([...reg.agents.keys()].sort()).toEqual(["maya", "ziad"]);
    expect(reg.agentOf.get("developer")).toBe("maya");
    expect(reg.ownerOfPlaybook.get("eng-build")).toBe("engineering");
    expect(reg.ownerOfPlaybook.has("echo")).toBe(false);        // packless
    expect(reg.playbooks.has("echo")).toBe(true);
    expect(reg.departments.get("engineering")!.toolsUnion).toEqual(["Read", "Edit", "Grep"]);
    const maya = reg.agents.get("maya")!;
    expect(maya.role.permissionMode).toBe("bypassPermissions");
    expect(maya.role.systemPrompt).toContain("Terse.");
    expect(maya.role.systemPrompt).toContain("You are an engineer.");
  });

  it("skips an agent whose department field mismatches its directory", () => {
    writeFileSync(join(t.agents, "engineering", "imp.yaml"),
      "name: imp\ntitle: T\ndepartment: research\ncharter: c\npersona: p\nprompt: s\n");
    const reg = loadRegistry(t.agents, t.pbs);
    expect(reg.agents.has("imp")).toBe(false);
  });

  it("skips duplicate names and colliding aliases, keeps first", () => {
    writeFileSync(join(t.agents, "engineering", "zz-dup.yaml"),
      "name: maya\ntitle: T\ndepartment: engineering\ncharter: c\npersona: p\nprompt: s\n");
    writeFileSync(join(t.agents, "engineering", "zz-alias.yaml"),
      "name: newbie\ntitle: T\ndepartment: engineering\ncharter: c\npersona: p\nprompt: s\naliases: [developer]\n");
    const reg = loadRegistry(t.agents, t.pbs);
    expect(reg.agents.get("maya")!.manifest.title).toBe("Senior Engineer");
    expect(reg.agentOf.get("developer")).toBe("maya");
    expect(reg.agents.has("newbie")).toBe(true);                 // agent loads, alias dropped
  });

  it("skips a department referencing a missing playbook", () => {
    mkdirSync(join(t.agents, "ghost"));
    writeFileSync(join(t.agents, "ghost", "department.yaml"),
      "department: ghost\nmission: m\nmemoDomain: general\nplaybooks: [nope]\n");
    const reg = loadRegistry(t.agents, t.pbs);
    expect(reg.departments.has("ghost")).toBe(false);
  });

  it("applies extras (guards, cwd, promptSuffix)", () => {
    const reg = loadRegistry(t.agents, t.pbs, {
      maya: { cwd: "/x", promptSuffix: "\n\nEXTRA", toolCheckFallback: "deny" },
    });
    const maya = reg.agents.get("maya")!;
    expect(maya.role.cwd).toBe("/x");
    expect(maya.role.systemPrompt.endsWith("EXTRA")).toBe(true);
    expect(maya.role.toolCheckFallback).toBe("deny");
  });

  it("rejects the reserved name/alias \"user\" (workspace-gate identity)", () => {
    writeFileSync(join(t.agents, "engineering", "evil.yaml"),
      "name: user\ntitle: T\ndepartment: engineering\ncharter: c\npersona: p\nprompt: s\n");
    writeFileSync(join(t.agents, "engineering", "sneaky.yaml"),
      "name: sneaky\ntitle: T\ndepartment: engineering\ncharter: c\npersona: p\nprompt: s\naliases: [user]\n");
    const reg = loadRegistry(t.agents, t.pbs);
    expect(reg.agents.has("user")).toBe(false);
    expect(reg.agentOf.has("user")).toBe(false);
    expect(reg.agents.has("sneaky")).toBe(true); // agent loads, reserved alias dropped
  });

  it("dropDepartment removes agents, aliases, playbooks", () => {
    const reg = loadRegistry(t.agents, t.pbs);
    dropDepartment(reg, "engineering");
    expect(reg.agents.size).toBe(0);
    expect(reg.agentOf.has("developer")).toBe(false);
    expect(reg.playbooks.has("eng-build")).toBe(false);
    expect(reg.playbooks.has("echo")).toBe(true);
  });

  it("disabledDepartments honors new + legacy env names", () => {
    const out = disabledDepartments(
      { AIOS_ENGINEERING_DISABLED: "1", AIOS_MONEY_DISABLED: "1" } as NodeJS.ProcessEnv,
      ["engineering", "finance", "research"],
    );
    expect(out).toEqual(new Set(["engineering", "finance"]));
  });

  it("tolerates a missing playbooks directory", () => {
    const reg = loadRegistry(t.agents, join(t.root, "no-such-playbooks"));
    expect(reg.playbooks.size).toBe(0);
    expect(reg.departments.size).toBe(0);
    expect(reg.agents.size).toBe(0);
  });
});
