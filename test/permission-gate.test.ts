import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { permissionGrantExecutor, permissionRevokeExecutor } from "../src/kernel/executors.js";
import { DEFAULT_POLICY, newRecord } from "../src/kernel/trust.js";

function wire() {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const registry = new ExecutorRegistry();
  registry.register(permissionGrantExecutor(store, bus));
  registry.register(permissionRevokeExecutor(store, bus));
  const gate = new ActionGate({ store, registry, policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
  return { store, bus, gate };
}

describe("permission gate", () => {
  it("gate authors the preview from the payload, ignoring caller text", async () => {
    const { gate } = wire();
    const row = await gate.propose(
      { type: "permission.grant", payload: { role: "finance", tool: "Bash" }, preview: "totally innocent" },
      { channel: "web", chatId: "mission-control" },
    );
    expect(row.preview).toBe("Grant Bash to finance");
    expect(row.status).toBe("proposed");
  });

  it("revoke authors its own preview", async () => {
    const { gate } = wire();
    const row = await gate.propose(
      { type: "permission.revoke", payload: { role: "halalo", tool: "Write" }, preview: "x" },
      { channel: "web", chatId: "mission-control" },
    );
    expect(row.preview).toBe("Revoke Write from halalo");
  });

  it("is always-supervised: never executes autonomously even if the trust record is seeded autonomous", async () => {
    const { store, gate } = wire();
    // Seed an autonomous trust record for the type — the ceiling must still force a queue.
    store.upsertTrust({ ...newRecord("permission.grant", "2026-06-16T00:00:00.000Z"), state: "autonomous" });
    const row = await gate.propose(
      { type: "permission.grant", payload: { role: "finance", tool: "Bash" }, preview: "x" },
      { channel: "web", chatId: "mission-control" },
    );
    expect(row.status).toBe("proposed"); // queued, NOT executed
    expect(store.listRolePermissions("finance")).toHaveLength(0); // nothing written pre-approval
  });

  it("approval applies the grant with granted_by = approver", async () => {
    const { store, gate } = wire();
    const row = await gate.propose(
      { type: "permission.grant", payload: { role: "finance", tool: "Bash" }, preview: "x" },
      { channel: "web", chatId: "mission-control" },
    );
    await gate.resolve(row.id, "approve", { by: "ihab" });
    expect(store.listRolePermissions("finance")[0]).toMatchObject({ tool: "Bash", allow: 1, granted_by: "ihab" });
  });
});
