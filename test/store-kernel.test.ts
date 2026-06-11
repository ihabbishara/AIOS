// test/store-kernel.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { newRecord } from "../src/kernel/trust.js";
import type { ActionRow } from "../src/kernel/actions.js";

const NOW = "2026-06-12T10:00:00.000Z";

function row(id: string, over: Partial<ActionRow> = {}): ActionRow {
  return {
    id, type: "test.echo", payload: JSON.stringify({ text: "hi" }), preview: "Echo hi",
    status: "proposed", origin_channel: "cli", origin_chat_id: "local",
    trust_state: "supervised", verdict_by: null, reject_reason: null, result: null,
    created_at: NOW, resolved_at: null, expires_at: "2026-06-13T10:00:00.000Z",
    ...over,
  };
}

describe("Store trust", () => {
  it("upserts and reads trust records (round-trip, camelCase)", () => {
    const store = new Store(":memory:");
    expect(store.getTrust("email.send")).toBeUndefined();
    const rec = newRecord("email.send", NOW);
    store.upsertTrust(rec);
    expect(store.getTrust("email.send")).toEqual(rec);
    store.upsertTrust({ ...rec, state: "autonomous", approvals: 5, graduatedAt: NOW });
    const updated = store.getTrust("email.send")!;
    expect(updated.state).toBe("autonomous");
    expect(updated.approvals).toBe(5);
    expect(store.listTrust()).toHaveLength(1);
  });
});

describe("Store actions", () => {
  it("inserts, gets, lists by status", () => {
    const store = new Store(":memory:");
    store.insertAction(row("aaa11111"));
    store.insertAction(row("bbb22222", { status: "executed", result: "done", resolved_at: NOW }));
    expect(store.getAction("aaa11111")?.preview).toBe("Echo hi");
    expect(store.listActions("proposed")).toHaveLength(1);
    expect(store.listActions()).toHaveLength(2);
  });

  it("resolveAction updates verdict fields", () => {
    const store = new Store(":memory:");
    store.insertAction(row("ccc33333"));
    store.resolveAction("ccc33333", {
      status: "rejected", verdict_by: "ihab", reject_reason: "too pricey", result: null, resolved_at: NOW,
    });
    const a = store.getAction("ccc33333")!;
    expect(a.status).toBe("rejected");
    expect(a.verdict_by).toBe("ihab");
    expect(a.reject_reason).toBe("too pricey");
  });

  it("expireActions marks only overdue proposed rows", () => {
    const store = new Store(":memory:");
    store.insertAction(row("ddd44444", { expires_at: "2026-06-12T09:00:00.000Z" })); // overdue
    store.insertAction(row("eee55555", { expires_at: "2026-06-13T10:00:00.000Z" })); // fine
    store.insertAction(row("fff66666", { status: "executed", expires_at: "2026-06-12T09:00:00.000Z" }));
    const expired = store.expireActions(NOW);
    expect(expired).toEqual(["ddd44444"]);
    expect(store.getAction("ddd44444")?.status).toBe("expired");
    expect(store.getAction("eee55555")?.status).toBe("proposed");
    expect(store.getAction("fff66666")?.status).toBe("executed");
  });
});
