// src/senses/google/executors.ts
import { z } from "zod";
import type { Executor } from "../../kernel/actions.js";
import type { GoogleAccounts } from "./auth.js";

/** Structural slice used by the executors (subset of gmail_v1.Gmail). */
export interface GmailSendLike {
  users: {
    messages: {
      send(p: { userId: string; requestBody: { raw: string; threadId?: string } }): Promise<{ data: { id?: string | null } }>;
      batchModify(p: { userId: string; requestBody: { ids: string[]; addLabelIds?: string[]; removeLabelIds?: string[] } }): Promise<unknown>;
    };
    drafts: {
      create(p: { userId: string; requestBody: { message: { raw: string; threadId?: string } } }): Promise<{ data: { id?: string | null } }>;
    };
  };
}

/** RFC2822 → base64url, with RFC2047 UTF-8 subject encoding. */
export function buildRawEmail(p: { to: string; subject: string; body: string }): string {
  // Strip CR/LF from the recipient — a raw newline here would let a
  // prompt-injected payload smuggle extra headers (e.g. Bcc:) into the message.
  const safeTo = p.to.replace(/[\r\n]+/g, " ").trim();
  const subject = `=?UTF-8?B?${Buffer.from(p.subject, "utf8").toString("base64")}?=`;
  const mime = [
    `To: ${safeTo}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    p.body,
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

function account(accounts: GoogleAccounts, name: string): { gmail: GmailSendLike } {
  const acc = accounts.get(name);
  if (!acc) throw new Error(`unknown google account "${name}"`);
  return acc as unknown as { gmail: GmailSendLike };
}

const sendSchema = z.object({
  account: z.string(),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  threadId: z.string().optional(),
});

/** The four gated mailbox mutations. All start supervised; gate audits everything. */
export function emailExecutors(accounts: GoogleAccounts): Executor[] {
  return [
    {
      type: "email.send",
      schema: sendSchema,
      async execute(payload) {
        const p = payload as z.infer<typeof sendSchema>;
        const { gmail } = account(accounts, p.account);
        await gmail.users.messages.send({
          userId: "me",
          requestBody: { raw: buildRawEmail(p), ...(p.threadId ? { threadId: p.threadId } : {}) },
        });
        return `Sent to ${p.to}: "${p.subject}" (${p.account})`;
      },
    },
    {
      type: "email.draft",
      schema: sendSchema,
      async execute(payload) {
        const p = payload as z.infer<typeof sendSchema>;
        const { gmail } = account(accounts, p.account);
        await gmail.users.drafts.create({
          userId: "me",
          requestBody: { message: { raw: buildRawEmail(p), ...(p.threadId ? { threadId: p.threadId } : {}) } },
        });
        return `Draft created for ${p.to}: "${p.subject}" (${p.account})`;
      },
    },
    {
      type: "email.archive",
      schema: z.object({ account: z.string(), messageIds: z.array(z.string()).min(1) }),
      async execute(payload) {
        const p = payload as { account: string; messageIds: string[] };
        const { gmail } = account(accounts, p.account);
        await gmail.users.messages.batchModify({
          userId: "me",
          requestBody: { ids: p.messageIds, removeLabelIds: ["INBOX"] },
        });
        return `Archived ${p.messageIds.length} message(s) (${p.account})`;
      },
    },
    // NOTE: Gmail expects label IDs (STARRED, IMPORTANT, …); custom labels need their Label_<id>, not display names.
    {
      type: "email.label",
      schema: z.object({
        account: z.string(),
        messageIds: z.array(z.string()),
        add: z.array(z.string()),
        remove: z.array(z.string()),
      }),
      async execute(payload) {
        const p = payload as { account: string; messageIds: string[]; add: string[]; remove: string[] };
        const { gmail } = account(accounts, p.account);
        await gmail.users.messages.batchModify({
          userId: "me",
          requestBody: { ids: p.messageIds, addLabelIds: p.add, removeLabelIds: p.remove },
        });
        return `Labeled ${p.messageIds.length} message(s) +[${p.add.join(",")}] -[${p.remove.join(",")}] (${p.account})`;
      },
    },
  ];
}
