import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { permissionGrantExecutor, permissionRevokeExecutor } from "../src/kernel/executors.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";

describe("permission propose is proposal-only", () => {
  it("proposing a grant queues an action but writes NO role_permissions row pre-approval", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const registry = new ExecutorRegistry();
    registry.register(permissionGrantExecutor(store, bus));
    registry.register(permissionRevokeExecutor(store, bus));
    const gate = new ActionGate({ store, registry, policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });

    // This is exactly what POST /api/permissions/propose does.
    const row = await gate.propose(
      { type: "permission.grant", payload: { role: "finance", tool: "Bash" }, preview: "" },
      { channel: "web", chatId: "mission-control" },
    );

    expect(row.status).toBe("proposed");
    expect(store.listRolePermissions()).toHaveLength(0); // <-- the whole security model
    expect(store.listActions("proposed", 10).some((a) => a.id === row.id)).toBe(true);
  });
});
