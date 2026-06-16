import { describe, it, expect } from "vitest";
import { effectiveAllowedTools, withEffectiveTools } from "../src/agents/permissions.js";
import type { RolePermissionRow } from "../src/store/db.js";

function fakeStore(rows: RolePermissionRow[]) {
  return {
    listRolePermissions(role?: string): RolePermissionRow[] {
      return role ? rows.filter((r) => r.role === role) : rows;
    },
  };
}
function override(role: string, tool: string, allow: 0 | 1): RolePermissionRow {
  return { id: 1, role, tool, allow, granted_by: "ihab", created_at: "2026-06-16T00:00:00.000Z" };
}

describe("effectiveAllowedTools", () => {
  it("with zero overrides returns the base unchanged (zero regression)", () => {
    const base = ["Read", "Grep", "Glob"];
    expect(effectiveAllowedTools("researcher", base, fakeStore([]))).toEqual(base);
  });

  it("adds granted tools (allow=1) not already in base", () => {
    const out = effectiveAllowedTools("finance", ["Read"], fakeStore([override("finance", "Bash", 1)]));
    expect(out).toContain("Read");
    expect(out).toContain("Bash");
  });

  it("removes revoked tools (allow=0) that were defaults", () => {
    const out = effectiveAllowedTools("halalo", ["Read", "Write"], fakeStore([override("halalo", "Write", 0)]));
    expect(out).toContain("Read");
    expect(out).not.toContain("Write");
  });

  it("does not double-add a granted tool already in base (dedup)", () => {
    const out = effectiveAllowedTools("finance", ["Read", "Bash"], fakeStore([override("finance", "Bash", 1)]));
    expect(out.filter((t) => t === "Bash")).toHaveLength(1);
  });

  it("only applies the named role's overrides", () => {
    const rows = [override("developer", "Bash", 1)];
    expect(effectiveAllowedTools("finance", ["Read"], fakeStore(rows))).toEqual(["Read"]);
  });

  it("FAIL-CLOSED: a store read error returns the base, never wider", () => {
    const throwing = { listRolePermissions() { throw new Error("db down"); } };
    const base = ["Read", "Grep"];
    expect(effectiveAllowedTools("finance", base, throwing)).toEqual(base);
  });

  it("withEffectiveTools merges into an Options-shaped object's allowedTools", () => {
    const opts = { allowedTools: ["Read"], permissionMode: "dontAsk" as const };
    const out = withEffectiveTools(opts, "finance", fakeStore([override("finance", "Bash", 1)]));
    expect(out.allowedTools).toContain("Bash");
    expect(out.permissionMode).toBe("dontAsk");
    expect(opts.allowedTools).toEqual(["Read"]); // input not mutated
  });
});
