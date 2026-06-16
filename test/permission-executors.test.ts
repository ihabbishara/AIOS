import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { permissionGrantExecutor, permissionRevokeExecutor } from "../src/kernel/executors.js";

describe("permission executors", () => {
  it("grant writes an allow=1 row stamped with ctx.by and emits permission.changed", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const ex = permissionGrantExecutor(store, bus);
    const result = await ex.execute({ role: "finance", tool: "Bash" }, { by: "ihab", auto: false });

    expect(result).toBe("Granted Bash to finance");
    const rows = store.listRolePermissions("finance");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "Bash", allow: 1, granted_by: "ihab" });

    // permission.changed was emitted (read it from event history)
    const events = bus.history(0, 100).map((e) => e.event);
    expect(events).toContainEqual({ type: "permission.changed", role: "finance", tool: "Bash", allow: true, by: "ihab" });
  });

  it("revoke writes an allow=0 row", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const ex = permissionRevokeExecutor(store, bus);
    await ex.execute({ role: "halalo", tool: "Write" }, { by: "ops", auto: false });
    expect(store.listRolePermissions("halalo")[0]).toMatchObject({ tool: "Write", allow: 0, granted_by: "ops" });
  });

  it("a null approver falls back to 'unknown'", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    await permissionGrantExecutor(store, bus).execute({ role: "finance", tool: "Bash" }, { by: null, auto: true });
    expect(store.listRolePermissions("finance")[0].granted_by).toBe("unknown");
  });
});
