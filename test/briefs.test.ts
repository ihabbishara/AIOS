// test/briefs.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { VaultWriter } from "../src/vault/writer.js";
import { assembleBrief, isEmptyBrief, renderBriefNote, runBrief, type BriefData, type BriefRunnerDeps } from "../src/heartbeat/briefs.js";
import type { ActionRow } from "../src/kernel/actions.js";

const NOW = "2026-06-12T10:00:00.000Z";

function action(id: string, over: Partial<ActionRow> = {}): ActionRow {
  return {
    id, type: "test.echo", payload: "{}", preview: `preview ${id}`,
    status: "proposed", origin_channel: "cli", origin_chat_id: "local",
    trust_state: "supervised", verdict_by: null, reject_reason: null, result: null,
    created_at: NOW, resolved_at: null, expires_at: "2026-06-13T09:00:00.000Z",
    ...over,
  };
}

describe("assembleBrief", () => {
  it("collects approvals, splitting promotions, flagging expiring-soon", () => {
    const store = new Store(":memory:");
    store.insertAction(action("aaaa1111", { expires_at: "2026-06-12T15:00:00.000Z" })); // < 12h
    store.insertAction(action("bbbb2222", { type: "trust.promote", preview: "Promote test.echo" }));
    store.insertAction(action("cccc3333", { status: "executed" })); // not pending
    const data = assembleBrief(store, "morning", NOW, null);
    expect(data.pendingApprovals).toHaveLength(1);
    expect(data.pendingApprovals[0].expiringSoon).toBe(true);
    expect(data.graduationProposals).toHaveLength(1);
    expect(data.graduationProposals[0].preview).toBe("Promote test.echo");
  });

  it("digests events since the window start", () => {
    const store = new Store(":memory:");
    store.insertJob({
      id: "j1", slug: "demo", title: "Demo job", playbook: "echo", request: "r",
      project_dir: null, channel: "cli", chat_id: "local", status: "done", error: null,
    });
    store.addEvent(JSON.stringify({ type: "action.executed", actionId: "x", actionType: "vault.write", auto: true, ok: true }));
    store.addEvent(JSON.stringify({ type: "action.executed", actionId: "y", actionType: "vault.write", auto: true, ok: true }));
    store.addEvent(JSON.stringify({ type: "action.executed", actionId: "z", actionType: "vault.write", auto: false, ok: true }));
    store.addEvent(JSON.stringify({ type: "job.status", jobId: "j1", status: "done" }));
    store.addEvent(JSON.stringify({ type: "job.status", jobId: "j1", status: "failed", error: "boom" }));
    store.addEvent(JSON.stringify({ type: "trust.changed", actionType: "test.echo", state: "graduating" }));
    const data = assembleBrief(store, "evening", NOW, "2020-01-01T00:00:00.000Z");
    expect(data.autonomousDigest).toEqual([{ type: "vault.write", count: 2 }]); // auto only
    expect(data.jobsFinished).toEqual([{ title: "Demo job", status: "done" }]);
    expect(data.jobsFailed).toEqual([{ title: "Demo job", error: "boom" }]);
    expect(data.trustChanges).toEqual([{ type: "test.echo", state: "graduating" }]);
  });

  it("null window (first ever brief) digests nothing", () => {
    const store = new Store(":memory:");
    store.addEvent(JSON.stringify({ type: "trust.changed", actionType: "t", state: "supervised" }));
    const data = assembleBrief(store, "morning", NOW, null);
    expect(data.trustChanges).toHaveLength(0);
    expect(data.sinceLastBrief).toBeNull();
  });

  it("morning lists today's pending reminders; evening lists tomorrow's", () => {
    const store = new Store(":memory:");
    store.addReminder({ text: "today", dueAt: "2026-06-12T18:00:00.000Z", originChannel: "cli", originChatId: "l" });
    store.addReminder({ text: "tomorrow", dueAt: "2026-06-13T09:00:00.000Z", originChannel: "cli", originChatId: "l" });
    store.addReminder({ text: "next week", dueAt: "2026-06-19T09:00:00.000Z", originChannel: "cli", originChatId: "l" });
    const morning = assembleBrief(store, "morning", NOW, null);
    expect(morning.remindersToday.map((r) => r.text)).toEqual(["today"]);
    const evening = assembleBrief(store, "evening", NOW, null);
    expect(evening.remindersToday.map((r) => r.text)).toEqual(["tomorrow"]);
  });
});

describe("isEmptyBrief", () => {
  it("true only when every section is empty", () => {
    const store = new Store(":memory:");
    expect(isEmptyBrief(assembleBrief(store, "morning", NOW, null))).toBe(true);
    store.insertAction(action("dddd4444"));
    expect(isEmptyBrief(assembleBrief(store, "morning", NOW, null))).toBe(false);
  });
});

describe("renderBriefNote", () => {
  it("narration on top, data sections below", () => {
    const data: BriefData = {
      anchor: "morning",
      pendingApprovals: [{ id: "a", type: "test.echo", preview: "p", expires_at: NOW, expiringSoon: false }],
      graduationProposals: [], autonomousDigest: [{ type: "vault.write", count: 3 }],
      jobsFinished: [], jobsFailed: [], trustChanges: [], remindersToday: [],
      mailDigest: [], meetings: [], sensesNeedingReauth: [],
      sinceLastBrief: null,
    };
    const md = renderBriefNote(data, "Morning. One approval waiting.");
    expect(md).toContain("Morning. One approval waiting.");
    expect(md).toContain("## Pending approvals");
    expect(md).toContain("test.echo");
    expect(md).toContain("vault.write × 3");
    expect(md.indexOf("Morning. One approval")).toBeLessThan(md.indexOf("## Pending approvals"));
  });
});

describe("runBrief", () => {
  function setup(over: Partial<BriefRunnerDeps> = {}) {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "aios-brief-")), "AIOS");
    vault.init();
    const sent: Array<{ channel: string; chatId: string; text: string }> = [];
    const deps: BriefRunnerDeps = {
      store, bus, vault,
      narrate: async (_anchor, _dataJson) => "Narrated brief.",
      send: async (channel, chatId, text) => { sent.push({ channel, chatId, text }); },
      primary: { channel: "cli", chatId: "local" },
      nowFn: () => new Date(2026, 5, 12, 7, 30),
      ...over,
    };
    return { store, bus, vault, sent, deps };
  }

  it("non-empty morning: narrates, sends, archives, stamps window, emits brief.sent", async () => {
    const { store, bus, vault, sent, deps } = setup();
    store.insertAction(action("eeee5555"));
    const emitted: string[] = [];
    bus.on((e) => emitted.push(e.event.type));
    await runBrief(deps, "morning");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("Narrated brief.");
    expect(vault.readNote("briefs/2026-06-12-morning.md")).toContain("Narrated brief.");
    expect(store.kvGet("brief:last-ts")).toBeTruthy();
    expect(emitted).toContain("brief.sent");
  });

  it("empty morning sends the canned one-liner without narrating", async () => {
    let narrated = 0;
    const { sent, deps, vault } = setup({ narrate: async () => { narrated++; return "x"; } });
    await runBrief(deps, "morning");
    expect(narrated).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Quiet");
    expect(vault.readNote("briefs/2026-06-12-morning.md")).toContain("Quiet");
  });

  it("empty evening is skipped entirely (no send, no vault note)", async () => {
    const { sent, deps, vault, store } = setup();
    await runBrief(deps, "evening");
    expect(sent).toHaveLength(0);
    expect(vault.readNote("briefs/2026-06-12-evening.md")).toBeUndefined();
    expect(store.kvGet("brief:last-ts")).toBeTruthy(); // window still advances
  });

  it("narration failure: archives raw + sends fallback line", async () => {
    const { store, sent, deps, vault } = setup({ narrate: async () => { throw new Error("SDK down"); } });
    store.insertAction(action("ffff6666"));
    await runBrief(deps, "morning");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("narration failed");
    expect(vault.readNote("briefs/2026-06-12-morning.md")).toContain("Pending approvals");
  });

  it("no primary chat: vault-only, no narration call, no send", async () => {
    let narrated = 0;
    const { store, sent, deps, vault } = setup({
      primary: undefined,
      narrate: async () => { narrated++; return "x"; },
    });
    store.insertAction(action("gggg7777"));
    await runBrief(deps, "morning");
    expect(narrated).toBe(0);
    expect(sent).toHaveLength(0);
    expect(vault.readNote("briefs/2026-06-12-morning.md")).toContain("Pending approvals");
  });

  it("send failure does not throw and the archive still exists", async () => {
    const { store, deps, vault } = setup({ send: async () => { throw new Error("channel down"); } });
    store.insertAction(action("hhhh8888"));
    await expect(runBrief(deps, "morning")).resolves.toBeUndefined();
    expect(vault.readNote("briefs/2026-06-12-morning.md")).toBeTruthy();
  });

  it("degraded senses make an otherwise-empty brief non-empty and surface re-auth", async () => {
    const { sent, deps, vault } = setup({ degraded: () => [{ name: "work", reason: "invalid_grant" }] });
    await runBrief(deps, "morning"); // store is EMPTY — only the degraded sense
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("Narrated brief."); // not the quiet one-liner
    expect(sent[0].text).not.toContain("Quiet");
    const note = vault.readNote("briefs/2026-06-12-morning.md")!;
    expect(note).toContain("re-auth needed");
    expect(note).toContain("work");
    expect(note).toContain("invalid_grant");
  });
});

describe("assembleBrief senses sections", () => {
  it("mail digest groups by account and sender domain since the window", () => {
    const store = new Store(":memory:");
    const mail = (account: string, from: string, id: string) =>
      store.addEvent(JSON.stringify({ type: "mail.received", account, messageId: id, threadId: id, from, to: "", subject: `s-${id}`, snippet: "", labels: ["INBOX"], receivedAt: NOW }));
    mail("personal", "Amy <amy@acme.com>", "m1");
    mail("personal", "Bob <bob@acme.com>", "m2");
    mail("work", "Carl <c@corp.io>", "m3");
    const data = assembleBrief(store, "morning", NOW, "2020-01-01T00:00:00.000Z");
    expect(data.mailDigest).toEqual([
      { account: "personal", count: 2, senders: ["acme.com × 2"] },
      { account: "work", count: 1, senders: ["corp.io × 1"] },
    ]);
  });

  it("meetings come from the calendar snapshot kv (morning=today, evening=tomorrow)", () => {
    const store = new Store(":memory:");
    store.kvSet("gcal:personal:snapshot", JSON.stringify({
      e1: { updated: "u", summary: "Standup", start: "2026-06-12T14:00:00.000Z", end: "", status: "confirmed", organizer: "", link: "https://meet/x" },
      e2: { updated: "u", summary: "Tomorrow mtg", start: "2026-06-13T09:00:00.000Z", end: "", status: "confirmed", organizer: "", link: null },
    }));
    const morning = assembleBrief(store, "morning", NOW, null);
    expect(morning.meetings).toEqual([{ account: "personal", summary: "Standup", start: "2026-06-12T14:00:00.000Z", link: "https://meet/x" }]);
    const evening = assembleBrief(store, "evening", NOW, null);
    expect(evening.meetings).toEqual([{ account: "personal", summary: "Tomorrow mtg", start: "2026-06-13T09:00:00.000Z", link: null }]);
  });

  it("empty senses sections keep isEmptyBrief true", () => {
    const store = new Store(":memory:");
    expect(isEmptyBrief(assembleBrief(store, "morning", NOW, null))).toBe(true);
  });
});
