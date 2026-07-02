import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { buildPermissionsView, isWellFormedToolName, BUILTIN_TOOLS } from "../src/web/permissions-view.js";
import { testRegistry } from "./fixtures/registry.js";

const reg = testRegistry();

describe("buildPermissionsView", () => {
  it("includes every registry agent (canonical names) plus the hermes pseudo-role", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const view = buildPermissionsView(store, bus, reg);
    const names = view.map((r) => r.role);
    expect(names).toContain("hermes");
    expect(names).toContain("odin"); // a canonical registry agent
    expect(names).toContain("juno");
    // aliases are NOT catalog keys — only canonical names + the hermes pseudo-role
    expect(names).not.toContain("researcher"); // odin's alias
    expect(names).not.toContain("finance");    // juno's alias
    // hermes appears exactly once (pseudo-role, not its empty manifest)
    expect(names.filter((n) => n === "hermes")).toHaveLength(1);
  });

  it("tags base tools 'default', grants 'granted', and revoked defaults 'revoked'", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    store.setRolePermission("hermes", "Bash", 1, "ihab"); // grant a non-default
    store.setRolePermission("hermes", "mcp__aios__recall", 0, "ihab"); // revoke a default
    const hermes = buildPermissionsView(store, bus, reg).find((r) => r.role === "hermes")!;
    const byName = Object.fromEntries(hermes.tools.map((t) => [t.name, t.source]));
    expect(byName["Bash"]).toBe("granted");
    expect(byName["mcp__aios__recall"]).toBeUndefined(); // revoked → not in effective list
    expect(hermes.revoked).toContainEqual({ name: "mcp__aios__recall", source: "revoked" });
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
    const hermes = buildPermissionsView(store, bus, reg).find((r) => r.role === "hermes")!;
    // built-ins hermes does NOT have are still suggested (so you can grant them)
    expect(hermes.knownTools).toContain("Bash");
    expect(hermes.knownTools).toContain("Edit");
    expect(hermes.knownTools).toContain("Skill");
    // the role's own MCP tools are suggested too
    expect(hermes.knownTools).toContain("mcp__aios__recall");
    // no duplicates (Read is both a built-in and a hermes default)
    expect(hermes.knownTools.filter((t) => t === "Read")).toHaveLength(1);
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
