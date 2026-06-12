// test/triage.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus, type AiosEvent } from "../src/events.js";
import { matchRule, defaultVerdict, Triage, type TriageVerdict } from "../src/heartbeat/triage.js";

describe("matchRule", () => {
  const rules = [
    { id: 1, event_type: "action.*", verdict: "batch" as const, source: "manual" as const, created_at: "" },
    { id: 2, event_type: "action.executed", verdict: "notify_now" as const, source: "correction" as const, created_at: "" },
  ];
  it("exact match beats glob", () => {
    expect(matchRule(rules, "action.executed")?.verdict).toBe("notify_now");
  });
  it("glob prefix matches", () => {
    expect(matchRule(rules, "action.proposed")?.verdict).toBe("batch");
  });
  it("no match returns undefined", () => {
    expect(matchRule(rules, "job.status")).toBeUndefined();
  });
});

describe("defaultVerdict", () => {
  it("reminder.due → notify_now", () => {
    expect(defaultVerdict({ type: "reminder.due", id: 1, text: "x", channel: "cli", chatId: "l" })).toBe("notify_now");
  });
  it("autonomous executions batch; approved ones are ignored (already confirmed in chat)", () => {
    expect(defaultVerdict({ type: "action.executed", actionId: "a", actionType: "t", auto: true, ok: true })).toBe("batch");
    expect(defaultVerdict({ type: "action.executed", actionId: "a", actionType: "t", auto: false, ok: true })).toBe("ignore");
  });
  it("failed jobs interrupt; other job statuses are ignored", () => {
    expect(defaultVerdict({ type: "job.status", jobId: "j", status: "failed" })).toBe("notify_now");
    expect(defaultVerdict({ type: "job.status", jobId: "j", status: "done" })).toBe("ignore");
  });
  it("trust changes batch; chat/agent/proposal noise is ignored", () => {
    expect(defaultVerdict({ type: "trust.changed", actionType: "t", state: "supervised" })).toBe("batch");
    expect(defaultVerdict({ type: "chat.in", channel: "cli", chatId: "l", text: "hi" })).toBe("ignore");
    expect(defaultVerdict({ type: "agent.start", agent: "m", context: "c" })).toBe("ignore");
    expect(defaultVerdict({ type: "action.proposed", actionId: "a", actionType: "t", preview: "p" })).toBe("ignore");
  });
  it("its own outputs are ignored (no feedback loop)", () => {
    expect(defaultVerdict({ type: "triage.decision", eventType: "x", verdict: "batch", via: "rule" })).toBe("ignore");
    expect(defaultVerdict({ type: "brief.sent", anchor: "morning", chatKey: null })).toBe("ignore");
  });
});

describe("Triage.handle", () => {
  function setup(classify?: (e: AiosEvent) => Promise<TriageVerdict>) {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const notified: AiosEvent[] = [];
    const classified: AiosEvent[] = [];
    const triage = new Triage({
      store,
      bus,
      classify: classify ?? (async (e) => { classified.push(e); return "notify_now"; }),
      notify: async (e) => { notified.push(e); },
    });
    return { store, bus, triage, notified, classified };
  }

  it("DB rule wins over default", async () => {
    const { store, triage, notified } = setup();
    store.addTriageRule({ eventType: "trust.changed", verdict: "notify_now", source: "correction" });
    await triage.handle({ type: "trust.changed", actionType: "t", state: "supervised" });
    expect(notified).toHaveLength(1);
  });

  it("default verdict used when no rule; notify_now calls notify", async () => {
    const { triage, notified, classified } = setup();
    await triage.handle({ type: "reminder.due", id: 1, text: "x", channel: "cli", chatId: "l" });
    expect(notified).toHaveLength(1);
    expect(classified).toHaveLength(0); // model never called for known types
  });

  it("emits triage.decision for non-ignored events only", async () => {
    const { triage, bus, store } = setup();
    const events: string[] = [];
    bus.on((e) => events.push(e.event.type));
    await triage.handle({ type: "trust.changed", actionType: "t", state: "supervised" }); // batch
    await triage.handle({ type: "chat.in", channel: "cli", chatId: "l", text: "hi" });   // ignore
    expect(events.filter((t) => t === "triage.decision")).toHaveLength(1);
  });

  it("classifier failure falls back to batch (fail-quiet)", async () => {
    const { triage, notified, bus } = setup(async () => { throw new Error("model down"); });
    const decisions: Array<Record<string, unknown>> = [];
    bus.on((e) => { if (e.event.type === "triage.decision") decisions.push(e.event as never); });
    // unknown future event type → no default → model → throws → batch
    await triage.handle({ type: "mail.received" } as never);
    expect(notified).toHaveLength(0);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].verdict).toBe("batch");
    expect(decisions[0].via).toBe("model");
  });

  it("malformed classifier output falls back to batch", async () => {
    const { triage, notified } = setup(async () => "panic!!!" as never);
    await triage.handle({ type: "mail.received" } as never);
    expect(notified).toHaveLength(0);
  });

  it("a throwing notify never propagates", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const triage = new Triage({
      store, bus,
      classify: async () => "batch",
      notify: async () => { throw new Error("channel down"); },
    });
    await expect(
      triage.handle({ type: "reminder.due", id: 1, text: "x", channel: "cli", chatId: "l" }),
    ).resolves.toBeUndefined();
  });
});
