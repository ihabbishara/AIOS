// test/store-heartbeat.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

const NOW = "2026-06-12T10:00:00.000Z";
const LATER = "2026-06-12T11:00:00.000Z";

describe("Store reminders", () => {
  it("adds, lists, cancels", () => {
    const store = new Store(":memory:");
    const id = store.addReminder({
      text: "call accountant", dueAt: LATER, originChannel: "cli", originChatId: "local",
    });
    expect(id).toBeGreaterThan(0);
    const all = store.listReminders();
    expect(all).toHaveLength(1);
    expect(all[0].text).toBe("call accountant");
    expect(all[0].status).toBe("pending");
    expect(store.cancelReminder(id)).toBe(true);
    expect(store.listReminders("pending")).toHaveLength(0);
    expect(store.listReminders("cancelled")).toHaveLength(1);
  });

  it("cancel only affects pending reminders", () => {
    const store = new Store(":memory:");
    const id = store.addReminder({ text: "x", dueAt: NOW, originChannel: "cli", originChatId: "local" });
    store.claimDueReminders(LATER); // fires it
    expect(store.cancelReminder(id)).toBe(false);
    expect(store.listReminders("fired")).toHaveLength(1);
  });

  it("claimDueReminders fires due pending rows exactly once", () => {
    const store = new Store(":memory:");
    store.addReminder({ text: "due", dueAt: NOW, originChannel: "telegram", originChatId: "42" });
    store.addReminder({ text: "future", dueAt: "2026-06-13T10:00:00.000Z", originChannel: "cli", originChatId: "local" });
    const claimed = store.claimDueReminders(LATER);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].text).toBe("due");
    expect(claimed[0].origin_channel).toBe("telegram");
    // second claim: nothing (at-most-once)
    expect(store.claimDueReminders(LATER)).toHaveLength(0);
    expect(store.listReminders("fired")).toHaveLength(1);
    expect(store.listReminders("pending")).toHaveLength(1); // the future one
  });
});

describe("Store triage rules", () => {
  it("adds and lists rules; same event_type upserts", () => {
    const store = new Store(":memory:");
    store.addTriageRule({ eventType: "action.*", verdict: "batch", source: "manual" });
    store.addTriageRule({ eventType: "reminder.due", verdict: "notify_now", source: "manual" });
    expect(store.listTriageRules()).toHaveLength(2);
    store.addTriageRule({ eventType: "action.*", verdict: "ignore", source: "correction" });
    const rules = store.listTriageRules();
    expect(rules).toHaveLength(2);
    expect(rules.find((r) => r.event_type === "action.*")?.verdict).toBe("ignore");
    expect(rules.find((r) => r.event_type === "action.*")?.source).toBe("correction");
  });
});

describe("Store events window", () => {
  it("listEventsSince returns rows strictly after the timestamp", async () => {
    const store = new Store(":memory:");
    store.addEvent(JSON.stringify({ type: "chat.in", channel: "cli", chatId: "x", text: "a" }));
    await new Promise((r) => setTimeout(r, 2));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 2));
    store.addEvent(JSON.stringify({ type: "trust.changed", actionType: "t", state: "supervised" }));
    const rows = store.listEventsSince(cutoff);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload).type).toBe("trust.changed");
    expect(store.listEventsSince("2099-01-01T00:00:00.000Z")).toHaveLength(0);
  });
});
