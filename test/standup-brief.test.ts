// test/standup-brief.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { assembleBrief, isEmptyBrief, renderBriefNote, runBrief } from "../src/heartbeat/briefs.js";
import { EventBus } from "../src/events.js";
import { VaultWriter } from "../src/vault/writer.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function hermesMail(store: Store, over: Record<string, unknown> = {}) {
  store.insertMail({
    id: (over.id as string) ?? "s1", from_agent: (over.from as string) ?? "athena", to_agent: "hermes",
    kind: (over.kind as never) ?? "standup", body: (over.body as string) ?? "done: X / today: Y / blockers: none",
    goal_id: null, origin_channel: "system", origin_chat_id: "standup",
    chain_depth: 1, status: "unread", error: null,
  });
}

describe("brief standups + mailroom", () => {
  it("morning brief carries standups and hermes mail lines; counts as non-empty", () => {
    const store = new Store(":memory:");
    hermesMail(store);
    hermesMail(store, { id: "r1", from: "vulcan", kind: "report", body: "Done: mail goal X\nArtifacts: ..." });
    const d = assembleBrief(store, "morning", new Date().toISOString(), null);
    expect(d.standups).toEqual([{ lead: "athena", text: "done: X / today: Y / blockers: none" }]);
    expect(d.hermesMail).toEqual([{ from: "vulcan", kind: "report", line: "Done: mail goal X" }]);
    expect(isEmptyBrief(d)).toBe(false);
    const note = renderBriefNote(d, "narration");
    expect(note).toContain("## Standups");
    expect(note).toContain("athena: done: X / today: Y / blockers: none");
    expect(note).toContain("## Mailroom");
  });

  it("private-dept senders are excluded from the vaulted brief AND left unread (money wall)", async () => {
    const store = new Store(":memory:");
    hermesMail(store, { id: "pub", from: "athena", kind: "report", body: "Done: public thing" });
    hermesMail(store, { id: "priv", from: "midas", kind: "note", body: "balance 12345; paid X" });
    const priv = new Set(["midas"]);
    const d = assembleBrief(store, "morning", new Date().toISOString(), null, priv);
    expect(d.hermesMail).toEqual([{ from: "athena", kind: "report", line: "Done: public thing" }]);
    expect(renderBriefNote(d, "n")).not.toContain("12345");

    // runBrief marks briefed (public) mail read but leaves the private note unread (not consumed).
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "sb-vault-")), "AIOS");
    vault.init();
    await runBrief({
      store, bus: new EventBus(store), vault, narrate: async () => "n", send: async () => {},
      primary: { channel: "cli", chatId: "local" }, privateAgents: priv,
      nowFn: () => new Date(),
    }, "morning");
    expect(store.getMail("pub")!.status).toBe("read");
    expect(store.getMail("priv")!.status).toBe("unread"); // never surfaced, never silently dropped
  });

  it("mail arriving during narration is NOT marked read by the brief (M2)", async () => {
    const store = new Store(":memory:");
    hermesMail(store, { id: "early", from: "athena", kind: "report", body: "Done: early thing" });
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "sb-race-")), "AIOS");
    vault.init();
    await runBrief({
      store, bus: new EventBus(store), vault,
      narrate: async () => {
        // Simulates a report landing mid-narration (the race window).
        hermesMail(store, { id: "late", from: "vulcan", kind: "report", body: "Done: late thing" });
        return "n";
      },
      send: async () => {}, primary: { channel: "cli", chatId: "local" },
      nowFn: () => new Date(),
    }, "morning");
    expect(store.getMail("early")!.status).toBe("read");   // briefed → acked
    expect(store.getMail("late")!.status).toBe("unread");  // NOT briefed → must resurface tomorrow
  });

  it("evening brief ignores hermes mail; empty morning stays empty", () => {
    const store = new Store(":memory:");
    hermesMail(store);
    const evening = assembleBrief(store, "evening", new Date().toISOString(), null);
    expect(evening.standups).toBeUndefined();
    const emptyStore = new Store(":memory:");
    const d = assembleBrief(emptyStore, "morning", new Date().toISOString(), null);
    expect(isEmptyBrief(d)).toBe(true);
  });
});
