// test/google-read.test.ts
import { describe, it, expect } from "vitest";
import { htmlToText, extractBody, type GmailReadLike, listInbox, readEmail } from "../src/senses/google/read.js";
import type { GoogleAccounts } from "../src/senses/google/auth.js";

describe("htmlToText", () => {
  it("strips tags, decodes entities, keeps line structure", () => {
    expect(htmlToText("<p>Hello <b>world</b></p><br><div>line&nbsp;2 &amp; more</div>"))
      .toBe("Hello world\nline 2 & more");
  });
  it("drops style and script blocks entirely", () => {
    expect(htmlToText("<style>.a{}</style><script>x()</script>ok")).toBe("ok");
  });
});

describe("extractBody", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  it("prefers text/plain part", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64("plain body") } },
        { mimeType: "text/html", body: { data: b64("<p>html body</p>") } },
      ],
    };
    expect(extractBody(payload)).toBe("plain body");
  });
  it("falls back to html converted", () => {
    const payload = { mimeType: "text/html", body: { data: b64("<p>only html</p>") } };
    expect(extractBody(payload)).toBe("only html");
  });
  it("recurses nested multiparts", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("deep") } }] }],
    };
    expect(extractBody(payload)).toBe("deep");
  });
});

function fakeAccounts(): GoogleAccounts {
  const gmail: GmailReadLike = {
    users: {
      messages: {
        list: async () => ({ data: { messages: [{ id: "m1" }, { id: "m2" }] } }),
        get: async ({ id }) => ({
          data: {
            id, threadId: `t-${id}`, snippet: `snip ${id}`, labelIds: ["INBOX", "UNREAD"],
            payload: {
              headers: [
                { name: "From", value: "a@b.com" }, { name: "Subject", value: `s ${id}` },
                { name: "Date", value: "Fri, 12 Jun 2026 10:00:00 +0000" },
              ],
              mimeType: "text/plain",
              body: { data: Buffer.from(`body of ${id}`, "utf8").toString("base64url") },
            },
          },
        }),
        attachments: {
          get: async () => ({ data: { data: null } }),
        },
      },
    },
  };
  return {
    get: (name: string) => (name === "personal" ? { name, email: "p@x.com", gmail } : undefined),
    accounts: () => [{ name: "personal", email: "p@x.com", gmail }],
  } as unknown as GoogleAccounts;
}

describe("listInbox / readEmail", () => {
  it("lists with metadata lines", async () => {
    const out = await listInbox(fakeAccounts(), { account: "personal", query: "is:unread", limit: 5 });
    expect(out).toContain("m1");
    expect(out).toContain("a@b.com");
    expect(out).toContain("s m1");
  });
  it("reads full body", async () => {
    const out = await readEmail(fakeAccounts(), { account: "personal", messageId: "m1" });
    expect(out).toContain("body of m1");
    expect(out).toContain("From: a@b.com");
  });
  it("unknown account → clear error string", async () => {
    const out = await listInbox(fakeAccounts(), { account: "nope" });
    expect(out).toContain("unknown google account");
  });
});
