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
import { makeReminderFire } from "../src/heartbeat/routines.js";
import type { ActionRow } from "../src/kernel/actions.js";

describe("heartbeat end-to-end (no LLM)", () => {
  it("anchor fires brief; reminder flows clock → bus → kernel injection at its origin", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "aios-hb-")), "AIOS");
    vault.init();
    const sent: Array<{ channel: string; chatId: string; text: string }> = [];
    const send = async (channel: string, chatId: string, text: string) => {
      sent.push({ channel, chatId, text });
    };
    const primary = { channel: "cli", chatId: "local" };

    // index.ts-style notify routing: everything notifiable → primary.
    // reminder.due is verdict "ignore" now — it injects a kernel message instead of notifying.
    const notify = async (e: AiosEvent): Promise<void> => {
      return send(primary.channel, primary.chatId, `🔔 ${e.type}`);
    };

    const triage = new Triage({
      store, bus, notify,
      classify: async () => { throw new Error("model must not be called in this test"); },
    });
    triage.start();

    // index.ts-style reminder wiring: fires inject an inbound message (spec 2026-07-25)
    const injected: Array<{ channel: string; chatId: string; text: string }> = [];
    const reminderFire = makeReminderFire({
      onMessage: async (m) => { injected.push({ channel: m.channel, chatId: m.chatId, text: m.text }); },
      log: () => {},
    });
    bus.on((e) => { if (e.event.type === "reminder.due") reminderFire(e.event); });

    let fakeNow = new Date(2026, 5, 12, 7, 31); // 07:31 local
    const clock = new Clock({
      store,
      anchors: [{ name: "morning", hhmm: "07:30" }, { name: "evening", hhmm: "21:00" }],
      onAnchor: (name) =>
        runBrief({ store, bus, vault, narrate: async () => "Narrated.", send, primary, nowFn: () => fakeNow }, name as "morning" | "evening"),
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
    // dueAt relative to fakeNow (instant math) so firing is TZ-independent — a hardcoded
    // UTC dueAt vs a local-wall-clock fakeNow only lines up at UTC+2. See handoff.
    store.addReminder({ text: "stretch", dueAt: new Date(fakeNow.getTime() - 6 * 60_000).toISOString(), originChannel: "telegram", originChatId: "42" });

    await clock.tick();
    // allow the async bus → triage chain to settle
    await new Promise((r) => setTimeout(r, 10));

    // morning brief delivered to primary + archived
    const briefMsgs = sent.filter((s) => s.text === "Narrated.");
    expect(briefMsgs).toHaveLength(1);
    expect(briefMsgs[0].chatId).toBe("local");
    expect(vault.readNote("briefs/2026-06-12-morning.md")).toContain("Echo hi");

    // reminder injected as a framed prompt at its ORIGIN chat (not a ping)
    expect(injected).toHaveLength(1);
    expect(injected[0]).toMatchObject({ channel: "telegram", chatId: "42" });
    expect(injected[0].text).toContain("stretch");
    expect(sent.filter((s) => s.text.startsWith("⏰"))).toHaveLength(0);
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
