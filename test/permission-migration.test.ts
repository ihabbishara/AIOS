import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";

// The role-rename migration runs in the Store constructor, so we seed rows on disk with one
// Store, then reopen the same file with a second Store to trigger the migration on real data.
function withReopen(seed: (s: Store) => void): Store {
  const dir = mkdtempSync(join(tmpdir(), "perm-migrate-"));
  const dbPath = join(dir, "test.db");
  const s1 = new Store(dbPath);
  seed(s1);
  s1.close();
  const s2 = new Store(dbPath); // migration fires here
  // best-effort cleanup registration
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return s2;
}

describe("legacy role_permissions rename migration", () => {
  it("renames a legacy alias with NO canonical conflict (architect → kai)", () => {
    const s = withReopen((s1) => s1.setRolePermission("architect", "Read", 1, "legacy"));
    expect(s.listRolePermissions("architect")).toEqual([]);
    expect(s.listRolePermissions("kai").map((r) => r.tool)).toContain("Read");
    s.close();
  });

  it("on a UNIQUE(role,tool) conflict the legacy row wins and the canonical row is dropped", () => {
    const s = withReopen((s1) => {
      s1.setRolePermission("developer", "Bash", 1, "legacy"); // legacy grant
      s1.setRolePermission("maya", "Bash", 0, "canonical");   // conflicting canonical revoke
    });
    expect(s.listRolePermissions("developer")).toEqual([]);
    const maya = s.listRolePermissions("maya");
    // Exactly one maya/Bash row survives, carrying the legacy value (allow=1).
    const bashRows = maya.filter((r) => r.tool === "Bash");
    expect(bashRows).toHaveLength(1);
    expect(bashRows[0].allow).toBe(1);
    s.close();
  });

  it("covers finance→salim and cfo→faris", () => {
    const s = withReopen((s1) => {
      s1.setRolePermission("finance", "Read", 0, "legacy");
      s1.setRolePermission("cfo", "mcp__money__list_transactions", 1, "legacy");
    });
    expect(s.listRolePermissions("finance")).toEqual([]);
    expect(s.listRolePermissions("cfo")).toEqual([]);
    expect(s.listRolePermissions("salim").map((r) => r.tool)).toContain("Read");
    expect(s.listRolePermissions("faris").map((r) => r.tool)).toContain("mcp__money__list_transactions");
    s.close();
  });

  it("still renames moderator → rami (pre-existing migration)", () => {
    const s = withReopen((s1) => s1.setRolePermission("moderator", "Bash", 1, "legacy"));
    expect(s.listRolePermissions("moderator")).toEqual([]);
    expect(s.listRolePermissions("rami").map((r) => r.tool)).toContain("Bash");
    s.close();
  });
});
