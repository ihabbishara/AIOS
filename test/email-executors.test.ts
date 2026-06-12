// test/email-executors.test.ts
import { describe, it, expect } from "vitest";
import { buildRawEmail, emailExecutors, type GmailSendLike } from "../src/senses/google/executors.js";
import { GoogleAccounts } from "../src/senses/google/auth.js";

describe("buildRawEmail", () => {
  it("builds base64url RFC2822 with utf-8 subject and body", () => {
    const raw = buildRawEmail({ to: "x@y.com", subject: "Héllo", body: "Grüße\nzeile 2" });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: x@y.com");
    expect(decoded).toContain("Subject: =?UTF-8?B?");
    expect(decoded).toContain("Grüße");
    expect(raw).not.toContain("+"); // base64url, not base64
    expect(raw).not.toContain("/");
  });
});

function fakeAccounts(calls: Array<{ method: string; args: unknown }>): GoogleAccounts {
  const gmail: GmailSendLike = {
    users: {
      messages: {
        send: async (p) => { calls.push({ method: "send", args: p }); return { data: { id: "sent1" } }; },
        batchModify: async (p) => { calls.push({ method: "batchModify", args: p }); return { data: {} }; },
      },
      drafts: {
        create: async (p) => { calls.push({ method: "draftCreate", args: p }); return { data: { id: "d1" } }; },
      },
    },
  };
  return {
    get: (name: string) => (name === "personal" ? { name, email: "p@x.com", gmail } : undefined),
  } as unknown as GoogleAccounts;
}

describe("emailExecutors", () => {
  it("registers four executors with namespaced types", () => {
    const list = emailExecutors(fakeAccounts([]));
    expect(list.map((e) => e.type).sort()).toEqual(["email.archive", "email.draft", "email.label", "email.send"]);
  });

  it("email.send routes to the right account with threadId", async () => {
    const calls: Array<{ method: string; args: unknown }> = [];
    const send = emailExecutors(fakeAccounts(calls)).find((e) => e.type === "email.send")!;
    const result = await send.execute({ account: "personal", to: "x@y.com", subject: "s", body: "b", threadId: "t9" });
    expect(calls[0].method).toBe("send");
    expect((calls[0].args as { requestBody: { threadId?: string } }).requestBody.threadId).toBe("t9");
    expect(result).toContain("x@y.com");
  });

  it("email.draft creates a draft", async () => {
    const calls: Array<{ method: string; args: unknown }> = [];
    const draft = emailExecutors(fakeAccounts(calls)).find((e) => e.type === "email.draft")!;
    await draft.execute({ account: "personal", to: "x@y.com", subject: "s", body: "b" });
    expect(calls[0].method).toBe("draftCreate");
  });

  it("email.archive removes INBOX label via batchModify", async () => {
    const calls: Array<{ method: string; args: unknown }> = [];
    const archive = emailExecutors(fakeAccounts(calls)).find((e) => e.type === "email.archive")!;
    const result = await archive.execute({ account: "personal", messageIds: ["a", "b"] });
    expect(calls[0].method).toBe("batchModify");
    expect((calls[0].args as { requestBody: { removeLabelIds: string[] } }).requestBody.removeLabelIds).toEqual(["INBOX"]);
    expect(result).toContain("2");
  });

  it("unknown account throws (gate records failed)", async () => {
    const send = emailExecutors(fakeAccounts([])).find((e) => e.type === "email.send")!;
    await expect(send.execute({ account: "nope", to: "x@y.com", subject: "s", body: "b" })).rejects.toThrow("unknown google account");
  });

  it("schemas reject malformed payloads at the gate boundary", () => {
    const send = emailExecutors(fakeAccounts([])).find((e) => e.type === "email.send")!;
    expect(() => send.schema.parse({ account: "p" })).toThrow();
    const label = emailExecutors(fakeAccounts([])).find((e) => e.type === "email.label")!;
    expect(() => label.schema.parse({ account: "p", messageIds: [], add: [], remove: [] })).not.toThrow();
  });
});
