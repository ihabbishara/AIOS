import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { buildPermissionsView } from "../src/web/permissions-view.js";

describe("buildPermissionsView", () => {
  it("includes every code role plus the moderator and finance pseudo-roles", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const view = buildPermissionsView(store, bus);
    const names = view.map((r) => r.role);
    expect(names).toContain("moderator");
    expect(names).toContain("finance");
    expect(names).toContain("researcher"); // a code role
  });

  it("tags base tools 'default', grants 'granted', and revoked defaults 'revoked'", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    store.setRolePermission("finance", "Bash", 1, "ihab"); // grant a non-default
    store.setRolePermission("finance", "Read", 0, "ihab"); // revoke a default
    const finance = buildPermissionsView(store, bus).find((r) => r.role === "finance")!;
    const byName = Object.fromEntries(finance.tools.map((t) => [t.name, t.source]));
    expect(byName["Bash"]).toBe("granted");
    expect(byName["Read"]).toBeUndefined(); // revoked → not in effective list
    expect(finance.revoked).toContainEqual({ name: "Read", source: "revoked" });
  });

  it("aggregates tool.denied events per role+tool with count and last ts", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    bus.emit({ type: "tool.denied", role: "finance", tool: "Bash" });
    bus.emit({ type: "tool.denied", role: "finance", tool: "Bash" });
    const finance = buildPermissionsView(store, bus).find((r) => r.role === "finance")!;
    const denial = finance.denials.find((d) => d.tool === "Bash")!;
    expect(denial.count).toBe(2);
    expect(typeof denial.lastTs).toBe("string");
  });
});
