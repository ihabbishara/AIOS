// test/code-runner-clamp.test.ts
import { describe, it, expect } from "vitest";
import { clampTools, packRunOptions } from "../src/agents/runner.js";
import { roles } from "../src/agents/roles/index.js";

describe("clampTools", () => {
  it("clamps built-ins to the role's allowlist, passes all mcp__ through", () => {
    const role = ["Read", "Grep", "Glob"];
    const pack = ["Read", "Edit", "Write", "Grep", "Glob", "mcp__code__sh", "mcp__aios-pack__recall"];
    expect(clampTools(role, pack).sort()).toEqual(
      ["Grep", "Glob", "Read", "mcp__aios-pack__recall", "mcp__code__sh"].sort(),
    );
  });
  it("a write role keeps Edit/Write", () => {
    expect(clampTools(["Read", "Edit", "Write", "Bash"], ["Read", "Edit", "Write", "mcp__code__sh"]))
      .toEqual(expect.arrayContaining(["Edit", "Write", "mcp__code__sh"]));
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

describe("money pack regression — cfo tools unchanged", () => {
  it("cfo ([] built-ins) keeps all mcp__ pack tools after clamp", () => {
    const cfoTools = roles.cfo.allowedTools; // []
    const moneyPackTools = ["mcp__money__spending_summary", "mcp__aios-pack__recall", "mcp__aios-pack__vault_read"];
    expect(clampTools(cfoTools, moneyPackTools).sort()).toEqual([...moneyPackTools].sort());
  });
});
