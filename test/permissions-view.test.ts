import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { buildPermissionsView, isWellFormedToolName, BUILTIN_TOOLS } from "../src/web/permissions-view.js";
import { testRegistry } from "./fixtures/registry.js";

const reg = testRegistry();

describe("buildPermissionsView", () => {
  it("includes every registry agent (canonical names) plus the neo pseudo-role", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const view = buildPermissionsView(store, bus, reg);
    const names = view.map((r) => r.role);
    expect(names).toContain("neo");
    expect(names).toContain("odin"); // a canonical registry agent
    expect(names).toContain("juno");
    // aliases are NOT catalog keys — only canonical names + the neo pseudo-role
    expect(names).not.toContain("researcher"); // odin's alias
    expect(names).not.toContain("finance");    // juno's alias
    // neo appears exactly once (pseudo-role, not its empty manifest)
    expect(names.filter((n) => n === "neo")).toHaveLength(1);
  });

  it("tags base tools 'default', grants 'granted', and revoked defaults 'revoked'", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    store.setRolePermission("neo", "Bash", 1, "ihab"); // grant a non-default
    store.setRolePermission("neo", "mcp__aios__recall", 0, "ihab"); // revoke a default
    const neo = buildPermissionsView(store, bus, reg).find((r) => r.role === "neo")!;
    const byName = Object.fromEntries(neo.tools.map((t) => [t.name, t.source]));
    expect(byName["Bash"]).toBe("granted");
    expect(byName["mcp__aios__recall"]).toBeUndefined(); // revoked → not in effective list
    expect(neo.revoked).toContainEqual({ name: "mcp__aios__recall", source: "revoked" });
  });

  it("aggregates tool.denied events per role+tool with count and last ts", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    bus.emit({ type: "tool.denied", role: "odin", tool: "Bash" });
    bus.emit({ type: "tool.denied", role: "odin", tool: "Bash" });
    const odin = buildPermissionsView(store, bus, reg).find((r) => r.role === "odin")!;
    const denial = odin.denials.find((d) => d.tool === "Bash")!;
    expect(denial.count).toBe(2);
    expect(typeof denial.lastTs).toBe("string");
  });

  it("exposes knownTools = built-ins ∪ the role's own tools (for grant autocomplete)", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const neo = buildPermissionsView(store, bus, reg).find((r) => r.role === "neo")!;
    // built-ins neo does NOT have are still suggested (so you can grant them)
    expect(neo.knownTools).toContain("Bash");
    expect(neo.knownTools).toContain("Edit");
    expect(neo.knownTools).toContain("Skill");
    // the role's own MCP tools are suggested too
    expect(neo.knownTools).toContain("mcp__aios__recall");
    // no duplicates (Read is both a built-in and a neo default)
    expect(neo.knownTools.filter((t) => t === "Read")).toHaveLength(1);
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
