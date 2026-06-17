import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { collectObservations } from "../src/heartbeat/dream.js";

const NOW = new Date("2026-06-17T02:00:00.000Z");

describe("collectObservations", () => {
  it("returns empty string when there is nothing to observe", () => {
    expect(collectObservations(new Store(":memory:"), NOW)).toBe("");
  });

  it("includes overdue and upcoming reminders", () => {
    const s = new Store(":memory:");
    s.addReminder({ text: "call dentist", dueAt: "2026-06-10T09:00:00.000Z", originChannel: "telegram", originChatId: "1" }); // overdue
    s.addReminder({ text: "submit report", dueAt: "2026-06-20T09:00:00.000Z", originChannel: "telegram", originChatId: "1" }); // upcoming (<7d)
    s.addReminder({ text: "far future", dueAt: "2026-09-01T09:00:00.000Z", originChannel: "telegram", originChatId: "1" }); // outside 7d → excluded
    const d = collectObservations(s, NOW);
    expect(d).toMatch(/REMINDERS:/);
    expect(d).toMatch(/OVERDUE.*call dentist/);
    expect(d).toMatch(/upcoming.*submit report/);
    expect(d).not.toMatch(/far future/);
  });

  it("includes next-7d meetings from gcal snapshots", () => {
    const s = new Store(":memory:");
    s.kvSet("gcal:work:snapshot", JSON.stringify({
      e1: { summary: "Standup", start: "2026-06-18T09:00:00.000Z", end: "2026-06-18T09:30:00.000Z", link: null },
      e2: { summary: "Old", start: "2026-01-01T09:00:00.000Z", end: "2026-01-01T10:00:00.000Z", link: null }, // past → excluded
    }));
    const d = collectObservations(s, NOW);
    expect(d).toMatch(/CALENDAR/);
    expect(d).toMatch(/Standup/);
    expect(d).not.toMatch(/Old/);
  });

  it("flags recurring rejections in the decision journal", () => {
    const s = new Store(":memory:");
    for (let i = 0; i < 2; i++) {
      s.insertAction({
        id: `r${i}`, type: "email.send", payload: "{}", preview: "send X", status: "rejected",
        origin_channel: "cli", origin_chat_id: "local", trust_state: "supervised", verdict_by: null,
        reject_reason: "no", result: null, created_at: "2026-06-16T10:00:00.000Z",
        resolved_at: "2026-06-16T10:01:00.000Z", expires_at: "2026-06-17T10:00:00.000Z",
      });
    }
    const d = collectObservations(s, NOW);
    expect(d).toMatch(/DECISIONS:/);
    expect(d).toMatch(/rejected 2×: email\.send/);
  });

  it("includes failed jobs from recent events", () => {
    const s = new Store(":memory:");
    s.addEvent(JSON.stringify({ type: "job.status", jobId: "j1", status: "failed", error: "timeout" }));
    const d = collectObservations(s, NOW);
    expect(d).toMatch(/JOBS:/);
    expect(d).toMatch(/failed:.*timeout/);
  });
});
