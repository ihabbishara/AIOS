import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

describe("role_permissions store", () => {
  it("grants a tool (allow=1) and reads it back with granted_by", () => {
    const s = new Store(":memory:");
    s.setRolePermission("finance", "Bash", 1, "ihab");
    const rows = s.listRolePermissions("finance");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "finance", tool: "Bash", allow: 1, granted_by: "ihab" });
    expect(typeof rows[0].created_at).toBe("string");
  });

  it("upserts on (role, tool) — re-setting flips the allow flag, no duplicate row", () => {
    const s = new Store(":memory:");
    s.setRolePermission("finance", "Bash", 1, "ihab");
    s.setRolePermission("finance", "Bash", 0, "ops");
    const rows = s.listRolePermissions("finance");
    expect(rows).toHaveLength(1);
    expect(rows[0].allow).toBe(0);
    expect(rows[0].granted_by).toBe("ops");
  });

  it("listRolePermissions() with no arg returns every row; filtered returns one role's", () => {
    const s = new Store(":memory:");
    s.setRolePermission("finance", "Bash", 1, "ihab");
    s.setRolePermission("halalo", "Write", 0, "ihab");
    expect(s.listRolePermissions()).toHaveLength(2);
    expect(s.listRolePermissions("halalo")).toHaveLength(1);
    expect(s.listRolePermissions("halalo")[0].tool).toBe("Write");
  });

  it("same tool under different roles are distinct rows", () => {
    const s = new Store(":memory:");
    s.setRolePermission("finance", "Bash", 1, "ihab");
    s.setRolePermission("developer", "Bash", 1, "ihab");
    expect(s.listRolePermissions().length).toBe(2);
  });
});
