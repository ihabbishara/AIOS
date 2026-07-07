// test/compose-cold-mail.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { Mailbox, isUserReportEvent } from "../src/mail/mailbox.js";
import type { AiosEvent } from "../src/events.js";

/** engineering (code): athena lead, vulcan (alias developer) — shared. finance: midas private. */
function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "cc-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  const fin = join(agentsDir, "finance");
  mkdirSync(eng, { recursive: true });
  mkdirSync(fin, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  const agent = (name: string, dept: string, extra = "") =>
    `name: ${name}\ntitle: T\ndepartment: ${dept}\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n${extra}`;
  writeFileSync(join(eng, "athena.yaml"), agent("athena", "engineering"));
  writeFileSync(join(eng, "vulcan.yaml"), agent("vulcan", "engineering", "aliases: [developer]\n"));
  writeFileSync(join(fin, "department.yaml"),
    "department: finance\nmission: Money.\nlead: midas\nmemoDomain: money\nplaybooks: []\nprivateMemo: true\n");
  writeFileSync(join(fin, "midas.yaml"), agent("midas", "finance", "visibility: private\n"));
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();
const PRIMARY = { channel: "telegram", chatId: "1" };

function harness(over: Partial<ConstructorParameters<typeof Mailbox>[0]> = {}) {
  const store = new Store(":memory:");
  const events: AiosEvent[] = [];
  let queued = 0;
  const mb = new Mailbox({
    store, registry, maxDepth: 2, disabled: false, primaryChat: PRIMARY,
    onEvent: (e) => events.push(e), onQueued: () => queued++, ...over,
  });
  return { store, mb, events, queuedCount: () => queued };
}

describe("Mailbox.sendFromUser", () => {
  it("queues a depth-0 request from 'user' with web/ui origin; emits mail.sent; pumps", () => {
    const { store, mb, events, queuedCount } = harness();
    const r = mb.sendFromUser({ to: "developer", body: "audit the deploy scripts" });
    expect(r.ok).toBe(true);
    const m = store.getMail((r as { ok: true; id: string }).id)!;
    expect(m).toMatchObject({
      from_agent: "user", to_agent: "vulcan", kind: "request", status: "queued",
      chain_depth: 0, origin_channel: "web", origin_chat_id: "ui", in_reply_to: null,
    });
    expect(m.thread_id).toBe(m.id); // fresh thread defaults to own id
    expect(events.some((e) => e.type === "mail.sent" && e.to === "vulcan" && e.from === "user")).toBe(true);
    expect(queuedCount()).toBe(1);
  });

  it("threads a reply: threadId + inReplyTo stored verbatim", () => {
    const { store, mb } = harness();
    const r = mb.sendFromUser({ to: "vulcan", body: "follow-up", threadId: "t0", inReplyTo: "rep1" });
    const m = store.getMail((r as { ok: true; id: string }).id)!;
    expect(m.thread_id).toBe("t0");
    expect(m.in_reply_to).toBe("rep1");
  });

  it("private recipient ACCEPTED — web/ui is a private origin (pinned)", () => {
    const { mb } = harness();
    expect(mb.sendFromUser({ to: "midas", body: "runway question" }).ok).toBe(true);
  });

  it("refuses unknown recipient, user-target, and disabled mailbox", () => {
    const { mb } = harness();
    const unknown = mb.sendFromUser({ to: "nobody", body: "x" });
    expect(unknown.ok).toBe(false);
    expect((unknown as { ok: false; refusal: string }).refusal).toContain("Unknown");
    const self = mb.sendFromUser({ to: "me", body: "x" });
    expect(self.ok).toBe(false);
    const { mb: dead } = harness({ disabled: true });
    expect(dead.sendFromUser({ to: "vulcan", body: "x" }).ok).toBe(false);
  });

  it("refusals insert nothing and emit nothing", () => {
    const { store, mb, events, queuedCount } = harness();
    mb.sendFromUser({ to: "nobody", body: "x" });
    expect(store.listMail(undefined, 10)).toEqual([]);
    expect(events).toEqual([]);
    expect(queuedCount()).toBe(0);
  });
});

describe("isUserReportEvent", () => {
  it("true only for mail.sent report to user", () => {
    expect(isUserReportEvent({ type: "mail.sent", id: "a", from: "vulcan", to: "user", kind: "report" })).toBe(true);
    expect(isUserReportEvent({ type: "mail.sent", id: "a", from: "vulcan", to: "user", kind: "request" })).toBe(false);
    expect(isUserReportEvent({ type: "mail.sent", id: "a", from: "user", to: "vulcan", kind: "report" })).toBe(false);
    expect(isUserReportEvent({ type: "mail.sent", id: "a", from: "athena", to: "hermes", kind: "standup" })).toBe(false);
    expect(isUserReportEvent({ type: "mail.read", ids: ["a"] })).toBe(false);
  });
});
