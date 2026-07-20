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
  it("renames a legacy alias through two waves (architect → kai → athena)", () => {
    const s = withReopen((s1) => s1.setRolePermission("architect", "Read", 1, "legacy"));
    expect(s.listRolePermissions("architect")).toEqual([]);
    expect(s.listRolePermissions("kai")).toEqual([]);       // wave 1 moved it, wave 2 moved again
    expect(s.listRolePermissions("athena").map((r) => r.tool)).toContain("Read");
    s.close();
  });

  it("on a UNIQUE(role,tool) conflict the legacy row wins and chains to mythic name", () => {
    const s = withReopen((s1) => {
      s1.setRolePermission("developer", "Bash", 1, "legacy"); // legacy grant
      s1.setRolePermission("maya", "Bash", 0, "canonical");   // conflicting canonical revoke
    });
    expect(s.listRolePermissions("developer")).toEqual([]);
    expect(s.listRolePermissions("maya")).toEqual([]);       // both waves consumed it
    const vulcan = s.listRolePermissions("vulcan");
    // Exactly one vulcan/Bash row survives, carrying the legacy value (allow=1).
    const bashRows = vulcan.filter((r) => r.tool === "Bash");
    expect(bashRows).toHaveLength(1);
    expect(bashRows[0].allow).toBe(1);
    s.close();
  });

  it("covers finance→salim→juno and cfo→faris→midas", () => {
    const s = withReopen((s1) => {
      s1.setRolePermission("finance", "Read", 0, "legacy");
      s1.setRolePermission("cfo", "mcp__money__list_transactions", 1, "legacy");
    });
    expect(s.listRolePermissions("finance")).toEqual([]);
    expect(s.listRolePermissions("cfo")).toEqual([]);
    expect(s.listRolePermissions("salim")).toEqual([]);     // wave 2 consumed it
    expect(s.listRolePermissions("faris")).toEqual([]);     // wave 2 consumed it
    expect(s.listRolePermissions("juno").map((r) => r.tool)).toContain("Read");
    expect(s.listRolePermissions("midas").map((r) => r.tool)).toContain("mcp__money__list_transactions");
    s.close();
  });

  it("chains moderator → rami → hermes → neo across all three migration waves", () => {
    const s = withReopen((s1) => s1.setRolePermission("moderator", "Bash", 1, "legacy"));
    expect(s.listRolePermissions("moderator")).toEqual([]);
    expect(s.listRolePermissions("rami")).toEqual([]);      // wave 2 consumed it
    expect(s.listRolePermissions("hermes")).toEqual([]);    // wave 3 consumed it
    expect(s.listRolePermissions("neo").map((r) => r.tool)).toContain("Bash");
    s.close();
  });

  it("wave 3 moves the coordinator's mail identity and goal leads to neo", () => {
    const s = withReopen((s1) => {
      s1.insertMail({ id: "m1", from_agent: "athena", to_agent: "hermes", kind: "standup", body: "b",
        goal_id: null, origin_channel: "web", origin_chat_id: "ui", chain_depth: 0, status: "unread", error: null });
      s1.insertGoal({ id: "g1", slug: "g1", title: "t", request: "r", department: "operations", lead: "hermes",
        origin_channel: "web", origin_chat_id: "ui", status: "done", project_dir: null, goal_dir: null,
        plan_summary: "", replans_used: 0, chain_depth: 0, error: null });
    });
    expect(s.unreadMailFor("neo").map((m) => m.id)).toContain("m1");
    expect(s.getGoal("g1")?.lead).toBe("neo");
    s.close();
  });

  it("migration chain: developer AND maya both end up on vulcan", () => {
    const s = withReopen((s1) => {
      s1.setRolePermission("developer", "Bash", 1, "legacy");   // wave1: developer→maya; wave2: maya→vulcan
      s1.setRolePermission("maya", "Read", 1, "canonical");      // wave2: maya→vulcan
    });
    expect(s.listRolePermissions("developer")).toEqual([]);
    expect(s.listRolePermissions("maya")).toEqual([]);
    const vulcan = s.listRolePermissions("vulcan");
    expect(vulcan.map((r) => r.tool)).toContain("Bash");
    expect(vulcan.map((r) => r.tool)).toContain("Read");
    s.close();
  });
});
