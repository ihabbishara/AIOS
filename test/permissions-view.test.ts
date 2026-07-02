import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { buildPermissionsView, isWellFormedToolName, BUILTIN_TOOLS } from "../src/web/permissions-view.js";

describe("buildPermissionsView", () => {
  it("includes every code role plus the rami pseudo-role", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const view = buildPermissionsView(store, bus);
    const names = view.map((r) => r.role);
    expect(names).toContain("rami");
    expect(names).toContain("researcher"); // a code role
    // salim/finance is now a registry agent — not in the permissions pseudo-role catalog
    expect(names).not.toContain("finance");
  });

  it("tags base tools 'default', grants 'granted', and revoked defaults 'revoked'", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    store.setRolePermission("rami", "Bash", 1, "ihab"); // grant a non-default
    store.setRolePermission("rami", "mcp__aios__recall", 0, "ihab"); // revoke a default
    const rami = buildPermissionsView(store, bus).find((r) => r.role === "rami")!;
    const byName = Object.fromEntries(rami.tools.map((t) => [t.name, t.source]));
    expect(byName["Bash"]).toBe("granted");
    expect(byName["mcp__aios__recall"]).toBeUndefined(); // revoked → not in effective list
    expect(rami.revoked).toContainEqual({ name: "mcp__aios__recall", source: "revoked" });
  });

  it("aggregates tool.denied events per role+tool with count and last ts", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    bus.emit({ type: "tool.denied", role: "researcher", tool: "Bash" });
    bus.emit({ type: "tool.denied", role: "researcher", tool: "Bash" });
    const researcher = buildPermissionsView(store, bus).find((r) => r.role === "researcher")!;
    const denial = researcher.denials.find((d) => d.tool === "Bash")!;
    expect(denial.count).toBe(2);
    expect(typeof denial.lastTs).toBe("string");
  });

  it("exposes knownTools = built-ins ∪ the role's own tools (for grant autocomplete)", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const rami = buildPermissionsView(store, bus).find((r) => r.role === "rami")!;
    // built-ins rami does NOT have are still suggested (so you can grant them)
    expect(rami.knownTools).toContain("Bash");
    expect(rami.knownTools).toContain("Edit");
    expect(rami.knownTools).toContain("Skill");
    // the role's own MCP tools are suggested too
    expect(rami.knownTools).toContain("mcp__aios__recall");
    // no duplicates (Read is both a built-in and a rami default)
    expect(rami.knownTools.filter((t) => t === "Read")).toHaveLength(1);
  });
});

describe("isWellFormedToolName", () => {
  it("accepts non-empty whitespace-free names (incl. unknown ones — forward-compat)", () => {
    expect(isWellFormedToolName("Bash")).toBe(true);
    expect(isWellFormedToolName("mcp__aios__recall")).toBe(true);
    expect(isWellFormedToolName("SomeFutureTool")).toBe(true);
  });
  it("rejects empty or whitespace-containing names", () => {
    expect(isWellFormedToolName("")).toBe(false);
    expect(isWellFormedToolName("two words")).toBe(false);
    expect(isWellFormedToolName("tab\there")).toBe(false);
  });
  it("BUILTIN_TOOLS are all well-formed and include the common ones", () => {
    expect(BUILTIN_TOOLS.every(isWellFormedToolName)).toBe(true);
    for (const t of ["Bash", "Edit", "Read", "Write", "Skill", "Task"]) expect(BUILTIN_TOOLS).toContain(t);
  });
});
