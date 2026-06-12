// test/briefs.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { assembleBrief, isEmptyBrief, renderBriefNote, type BriefData } from "../src/heartbeat/briefs.js";
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
