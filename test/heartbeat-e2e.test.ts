// test/heartbeat-e2e.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { EventBus, type AiosEvent } from "../src/events.js";
import { VaultWriter } from "../src/vault/writer.js";
import { Clock } from "../src/heartbeat/clock.js";
import { Triage } from "../src/heartbeat/triage.js";
import { runBrief } from "../src/heartbeat/briefs.js";
import type { ActionRow } from "../src/kernel/actions.js";

describe("heartbeat end-to-end (no LLM)", () => {
  it("anchor fires brief; reminder flows clock → bus → triage → origin ping", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "aios-hb-")), "AIOS");
    vault.init();
    const sent: Array<{ channel: string; chatId: string; text: string }> = [];
    const send = async (channel: string, chatId: string, text: string) => {
      sent.push({ channel, chatId, text });
    };
    const primary = { channel: "cli", chatId: "local" };

    // index.ts-style notify routing: reminders → origin chat; everything else → primary
    const notify = async (e: AiosEvent): Promise<void> => {
      if (e.type === "reminder.due") return send(e.channel, e.chatId, `⏰ Reminder: ${e.text}`);
      return send(primary.channel, primary.chatId, `🔔 ${e.type}`);
    };

    const triage = new Triage({
      store, bus, notify,
      classify: async () => { throw new Error("model must not be called in this test"); },
    });
    triage.start();

    let fakeNow = new Date(2026, 5, 12, 7, 31); // 07:31 local
    const clock = new Clock({
      store,
      anchors: [{ name: "morning", hhmm: "07:30" }, { name: "evening", hhmm: "21:00" }],
      onAnchor: (name) =>
        runBrief({ store, bus, vault, narrate: async () => "Narrated.", send, primary, nowFn: () => fakeNow }, name),
      onReminderDue: (r) =>
        bus.emit({ type: "reminder.due", id: r.id, text: r.text, channel: r.origin_channel, chatId: r.origin_chat_id }),
      nowFn: () => fakeNow,
    });

    // seed: one pending approval + one due reminder (origin = telegram chat 42)
    const action: ActionRow = {
      id: "e2e11111", type: "test.echo", payload: "{}", preview: "Echo hi",
      status: "proposed", origin_channel: "cli", origin_chat_id: "local",
      trust_state: "supervised", verdict_by: null, reject_reason: null, result: null,
      created_at: "2026-06-12T05:00:00.000Z", resolved_at: null, expires_at: "2026-06-13T05:00:00.000Z",
    };
    store.insertAction(action);
    store.addReminder({ text: "stretch", dueAt: "2026-06-12T05:25:00.000Z", originChannel: "telegram", originChatId: "42" });

    await clock.tick();
    // allow the async bus → triage chain to settle
    await new Promise((r) => setTimeout(r, 10));

    // morning brief delivered to primary + archived
    const briefMsgs = sent.filter((s) => s.text === "Narrated.");
    expect(briefMsgs).toHaveLength(1);
    expect(briefMsgs[0].chatId).toBe("local");
    expect(vault.readNote("briefs/2026-06-12-morning.md")).toContain("Echo hi");

    // reminder pinged at its ORIGIN chat
    const pings = sent.filter((s) => s.text.startsWith("⏰"));
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({ channel: "telegram", chatId: "42" });
    expect(store.listReminders("fired")).toHaveLength(1);

    // second tick same minute: nothing new fires
    const before = sent.length;
    await clock.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.length).toBe(before);

    // evening: advance to 21:01 — brief includes the brief.sent/triage noise? No: those are
    // ignore/batch; evening brief still has the pending approval → delivered
    fakeNow = new Date(2026, 5, 12, 21, 1);
    await clock.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.filter((s) => s.text === "Narrated.")).toHaveLength(2);
    expect(vault.readNote("briefs/2026-06-12-evening.md")).toBeTruthy();

    triage.stop();
    clock.stop();
  });
});
