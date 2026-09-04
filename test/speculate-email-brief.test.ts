import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { assembleBrief, isEmptyBrief, renderBriefNote, runBrief } from "../src/heartbeat/briefs.js";
import { VaultWriter } from "../src/vault/writer.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ActionRow } from "../src/kernel/actions.js";

const NOW = "2026-06-19T06:30:00.000Z";

function proposed(id: string, type: string, preview: string): ActionRow {
  return {
    id, type, payload: "{}", preview, status: "proposed",
    origin_channel: "system", origin_chat_id: "speculate-email",
    trust_state: "supervised", verdict_by: null, reject_reason: null, result: null,
    created_at: NOW, resolved_at: null, expires_at: "2026-06-20T06:30:00.000Z",
  };
}

describe("brief email-draft wall (Vector B)", () => {
  it("excludes email.* from pendingApprovals and counts them generically (morning)", () => {
    const s = new Store(":memory:");
    s.insertAction(proposed("v1", "vault.write", "Wrote note Foo"));
    s.insertAction(proposed("e1", "email.draft", 'Draft to secret@example.com: "SecretSubject"'));
    const d = assembleBrief(s, "morning", NOW, null);
    expect(d.pendingApprovals.map((a) => a.type)).toEqual(["vault.write"]);
    expect(d.emailDraftsPending).toBe(1);
  });

  it("the vaulted note carries only a generic count — no recipient/subject (PII pinned)", () => {
    const s = new Store(":memory:");
    s.insertAction(proposed("e1", "email.draft", 'Draft to secret@example.com: "SecretSubject"'));
    const d = assembleBrief(s, "morning", NOW, null);
    const note = renderBriefNote(d, "morning brief");
    expect(note).not.toContain("secret@example.com");
    expect(note).not.toContain("SecretSubject");
    expect(note).toContain("1 reply draft(s) await approval");
  });

  it("isEmptyBrief is false when only email drafts are pending", () => {
    const s = new Store(":memory:");
    s.insertAction(proposed("e1", "email.draft", 'Draft to a@b.com: "x"'));
    const d = assembleBrief(s, "morning", NOW, null);
    expect(isEmptyBrief(d)).toBe(false);
  });

  it("evening brief excludes email.* from pending and shows no count", () => {
    const s = new Store(":memory:");
    s.insertAction(proposed("e1", "email.draft", 'Draft to a@b.com: "x"'));
    const d = assembleBrief(s, "evening", NOW, null);
    expect(d.pendingApprovals).toHaveLength(0);
    expect(d.emailDraftsPending ?? 0).toBe(0);
  });
});

describe("brief private detail send (Vector C)", () => {
  it("sends draft detail privately and keeps it out of the vaulted note", async () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const s = new Store(":memory:");
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    s.insertAction(proposed("e1", "email.draft", 'Draft to secret@example.com: "SecretSubject"'));

    const sent: Array<{ chatId: string; text: string }> = [];
    await runBrief({ coordinator: "neo",
      store: s,
      bus: { emit: () => {} } as never,
      vault,
      narrate: async () => "morning narration",
      send: async (_c, chatId, text) => { sent.push({ chatId, text }); },
      primary: { channel: "telegram", chatId: "123" },
      nowFn: () => new Date(NOW),
    }, "morning");

    // one of the sends is the private detail (preview + /approve id)
    const detail = sent.find((m) => m.text.includes("/approve e1"));
    expect(detail).toBeDefined();
    expect(detail!.text).toContain("secret@example.com");

    // the vaulted note must NOT contain the PII
    const note = vault.readNote("briefs/2026-06-19-morning.md") ?? "";
    expect(note).not.toContain("secret@example.com");
    expect(note).not.toContain("SecretSubject");
    rmSync(root, { recursive: true, force: true });
  });

  it("no email drafts → no extra send", async () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const s = new Store(":memory:");
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    const sent: string[] = [];
    await runBrief({ coordinator: "neo",
      store: s, bus: { emit: () => {} } as never, vault,
      narrate: async () => "n", send: async (_c, _id, t) => { sent.push(t); },
      primary: { channel: "telegram", chatId: "123" }, nowFn: () => new Date(NOW),
    }, "morning");
    expect(sent.every((t) => !t.includes("/approve"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
