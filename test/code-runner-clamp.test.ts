// test/code-runner-clamp.test.ts
import { describe, it, expect } from "vitest";
import { clampTools, packRunOptions } from "../src/agents/runner.js";
import { roles } from "../src/agents/roles/index.js";

describe("clampTools", () => {
  it("clamps built-ins to the role's allowlist; only mcp__aios-pack__ passes through without explicit ownership", () => {
    const role = ["Read", "Grep", "Glob"];
    const pack = ["Read", "Edit", "Write", "Grep", "Glob", "mcp__code__sh", "mcp__aios-pack__recall"];
    // mcp__code__sh is NOT mcp__aios-pack__ and role doesn't own it → dropped
    expect(clampTools(role, pack).sort()).toEqual(
      ["Glob", "Grep", "Read", "mcp__aios-pack__recall"].sort(),
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
  it("role without money tools in allowedTools does NOT get them from pack", () => {
    const emptyRoleTools: string[] = [];
    const moneyPackTools = ["mcp__money__spending_summary", "mcp__aios-pack__recall", "mcp__aios-pack__vault_read"];
    const result = clampTools(emptyRoleTools, moneyPackTools);
    // aios-pack tools pass through; money-specific tool is blocked
    expect(result).toEqual(expect.arrayContaining(["mcp__aios-pack__recall", "mcp__aios-pack__vault_read"]));
    expect(result).not.toContain("mcp__money__spending_summary");
  });
  it("cfo with explicit money tool ownership passes the money tools through clamp", () => {
    const cfoTools = roles.cfo.allowedTools; // now contains the 10 mcp__money__* tools
    const moneyPackTools = ["mcp__money__spending_summary", "mcp__aios-pack__recall", "mcp__aios-pack__vault_read"];
    const result = clampTools(cfoTools, moneyPackTools);
    expect(result).toContain("mcp__money__spending_summary");
    expect(result).toContain("mcp__aios-pack__recall");
    expect(result).toContain("mcp__aios-pack__vault_read");
  });
});
