// test/gmail-watcher.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus, type AiosEvent } from "../src/events.js";
import { GmailWatcher, type GmailLike } from "../src/senses/google/gmail.js";

function msg(id: string, labels: string[] = ["INBOX"], headers: Record<string, string> = {}) {
  return {
    id, threadId: `t-${id}`, labelIds: labels, snippet: `snippet ${id}`,
    internalDate: "1765900000000",
    payload: {
      headers: Object.entries({ From: "a@b.com", To: "me@x.com", Subject: `subj ${id}`, ...headers })
        .map(([name, value]) => ({ name, value })),
    },
  };
}

function stubGmail(opts: {
  profileHistoryId?: string;
  history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
  newHistoryId?: string;
  messages?: Record<string, ReturnType<typeof msg>>;
  historyError?: { code: number };
}): GmailLike {
  return {
    users: {
      getProfile: async () => ({ data: { historyId: opts.profileHistoryId ?? "1000" } }),
      history: {
        list: async () => {
          if (opts.historyError) throw Object.assign(new Error("history error"), opts.historyError);
          return { data: { history: opts.history ?? [], historyId: opts.newHistoryId ?? "1001" } };
        },
      },
      messages: {
        get: async ({ id }: { id: string }) => ({ data: opts.messages?.[id] ?? msg(id) }),
      },
    },
  } as unknown as GmailLike;
}

function setup(gmail: GmailLike, skip = ["promotions", "social"]) {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const events: AiosEvent[] = [];
  bus.on((e) => events.push(e.event));
  const watcher = new GmailWatcher({ account: "personal", gmail, store, bus, skipCategories: skip });
  return { store, events, watcher };
}

describe("GmailWatcher", () => {
  it("bootstrap stamps historyId and emits nothing", async () => {
    const { store, events, watcher } = setup(stubGmail({ profileHistoryId: "500" }));
    await watcher.poll();
    expect(store.kvGet("gmail:personal:historyId")).toBe("500");
    expect(events.filter((e) => e.type === "mail.received")).toHaveLength(0);
  });

  it("incremental poll emits mail.received with metadata", async () => {
    const gmail = stubGmail({
      history: [{ messagesAdded: [{ message: { id: "m1" } }, { message: { id: "m2" } }] }],
      newHistoryId: "600",
    });
    const { store, events, watcher } = setup(gmail);
    store.kvSet("gmail:personal:historyId", "500");
    await watcher.poll();
    const mails = events.filter((e) => e.type === "mail.received") as Extract<AiosEvent, { type: "mail.received" }>[];
    expect(mails).toHaveLength(2);
    expect(mails[0]).toMatchObject({
      account: "personal", messageId: "m1", threadId: "t-m1",
      from: "a@b.com", subject: "subj m1", labels: ["INBOX"],
    });
    expect(store.kvGet("gmail:personal:historyId")).toBe("600");
  });

  it("skips non-INBOX and skip-category messages", async () => {
    const gmail = stubGmail({
      history: [{ messagesAdded: [{ message: { id: "spam" } }, { message: { id: "promo" } }, { message: { id: "ok" } }] }],
      messages: {
        spam: msg("spam", ["SPAM"]),
        promo: msg("promo", ["INBOX", "CATEGORY_PROMOTIONS"]),
        ok: msg("ok", ["INBOX"]),
      },
    });
    const { events, watcher, store } = setup(gmail);
    store.kvSet("gmail:personal:historyId", "1");
    await watcher.poll();
    const mails = events.filter((e) => e.type === "mail.received");
    expect(mails).toHaveLength(1);
    expect((mails[0] as { messageId: string }).messageId).toBe("ok");
  });

  it("expired historyId (404) re-bootstraps silently", async () => {
    const gmail = stubGmail({ historyError: { code: 404 }, profileHistoryId: "900" });
    const { events, watcher, store } = setup(gmail);
    store.kvSet("gmail:personal:historyId", "1");
    await watcher.poll();
    expect(store.kvGet("gmail:personal:historyId")).toBe("900");
    expect(events.filter((e) => e.type === "mail.received")).toHaveLength(0);
  });

  it("API errors propagate (caller backoff handles them)", async () => {
    const gmail = stubGmail({ historyError: { code: 500 } });
    const { watcher, store } = setup(gmail);
    store.kvSet("gmail:personal:historyId", "1");
    await expect(watcher.poll()).rejects.toThrow("history error");
  });
});
