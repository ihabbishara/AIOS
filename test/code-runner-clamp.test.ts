// test/code-runner-clamp.test.ts
import { describe, it, expect } from "vitest";
import { clampTools, packRunOptions } from "../src/agents/runner.js";
import { roleOf } from "./fixtures/registry.js";

describe("clampTools", () => {
  it("aios-pack tools require ownership of the bare name — no free passthrough", () => {
    const role = ["Read", "Grep", "Glob"]; // does NOT own bare recall
    const pack = ["Read", "Edit", "Write", "Grep", "Glob", "mcp__code__sh", "mcp__aios-pack__recall"];
    // mcp__code__sh not owned → dropped; mcp__aios-pack__recall not owned (no bare recall) → dropped
    expect(clampTools(role, pack).sort()).toEqual(["Glob", "Grep", "Read"].sort());
  });
  it("a role owning the bare name keeps the aios-pack tool after clamp", () => {
    const role = ["Read", "recall", "vault_read"]; // owns bare recall + vault_read
    const pack = ["Read", "mcp__aios-pack__recall", "mcp__aios-pack__vault_read", "mcp__aios-pack__vault_write"];
    expect(clampTools(role, pack).sort()).toEqual(
      ["Read", "mcp__aios-pack__recall", "mcp__aios-pack__vault_read"].sort(),
    );
  });
  it("a write role keeps Edit/Write; non-owned mcp__ tools are dropped", () => {
    const result = clampTools(["Read", "Edit", "Write", "Bash"], ["Read", "Edit", "Write", "mcp__code__sh"]);
    expect(result).toEqual(expect.arrayContaining(["Edit", "Write"]));
    expect(result).not.toContain("mcp__code__sh");
  });
  it("a role that explicitly owns mcp__code__sh keeps it after clamp", () => {
    const result = clampTools(
      ["Read", "Edit", "Write", "Bash", "mcp__code__sh"],
      ["Read", "Edit", "Write", "mcp__code__sh"],
    );
    expect(result).toContain("mcp__code__sh");
  });
});

describe("packRunOptions confinement", () => {
  const base = { systemPrompt: "s", allowedTools: ["Read", "Edit", "Write", "Bash"], permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } as any;
  const pack = {
    pillar: "code", contextBlock: "ctx", tools: ["Read", "Edit", "Write", "mcp__code__sh"], mcpServers: {},
    confinement: { permissionMode: "default", guard: { Write: () => ({ ok: false }) }, fallback: "deny" },
  } as any;

  it("overrides permissionMode and drops the skip flag", () => {
    const o = packRunOptions(base, pack);
    expect(o.permissionMode).toBe("default");
    expect((o as any).allowDangerouslySkipPermissions).toBeUndefined();
  });
  it("installs the guard hooks (PreToolUse present)", () => {
    const o = packRunOptions(base, pack) as any;
    expect(o.hooks?.PreToolUse?.length).toBeGreaterThan(0);
    expect(typeof o.canUseTool).toBe("function");
  });
  it("clamps raw Bash out", () => {
    expect(packRunOptions(base, pack).allowedTools).not.toContain("Bash");
  });
});

describe("money pack regression — cfo must own money tools explicitly (no free mcp__ passthrough)", () => {
  it("an empty role gets NOTHING from the pack — not even aios-pack tools", () => {
    const emptyRoleTools: string[] = [];
    const moneyPackTools = ["mcp__money__spending_summary", "mcp__aios-pack__recall", "mcp__aios-pack__vault_read"];
    // ownership-based clamp: unowned aios-pack tools are dropped just like money-specific ones
    expect(clampTools(emptyRoleTools, moneyPackTools)).toEqual([]);
  });
  it("cfo with explicit money + memo-tool ownership passes them through clamp", () => {
    const cfoTools = roleOf("cfo").allowedTools; // 10 mcp__money__* tools + bare recall/vault_read
    const moneyPackTools = ["mcp__money__spending_summary", "mcp__aios-pack__recall", "mcp__aios-pack__vault_read"];
    const result = clampTools(cfoTools, moneyPackTools);
    expect(result).toContain("mcp__money__spending_summary");
    expect(result).toContain("mcp__aios-pack__recall");
    expect(result).toContain("mcp__aios-pack__vault_read");
  });
});
