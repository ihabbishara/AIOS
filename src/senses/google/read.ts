// src/senses/google/read.ts
import type { GoogleAccounts } from "./auth.js";

export interface GmailPayload {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPayload[] | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
}

export interface GmailReadLike {
  users: {
    messages: {
      list(p: { userId: string; q?: string; maxResults?: number; labelIds?: string[] }): Promise<{ data: { messages?: Array<{ id?: string | null }> | null } }>;
      get(p: { userId: string; id: string; format?: string }): Promise<{ data: { id?: string | null; threadId?: string | null; snippet?: string | null; labelIds?: string[] | null; payload?: GmailPayload | null } }>;
    };
  };
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/** Walk the MIME tree: prefer text/plain, fall back to converted text/html. */
export function extractBody(payload: GmailPayload | null | undefined): string {
  if (!payload) return "";
  const decode = (data?: string | null) => (data ? Buffer.from(data, "base64url").toString("utf8") : "");
  const find = (p: GmailPayload, mime: string): string => {
    if (p.mimeType === mime && p.body?.data) return decode(p.body.data);
    for (const part of p.parts ?? []) {
      const found = find(part, mime);
      if (found) return found;
    }
    return "";
  };
  const plain = find(payload, "text/plain");
  if (plain) return plain.trim();
  const html = find(payload, "text/html");
  if (html) return htmlToText(html);
  return "";
}

function header(headers: Array<{ name?: string | null; value?: string | null }> | null | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function gmailOf(accounts: GoogleAccounts, name: string): GmailReadLike | string {
  const acc = accounts.get(name);
  if (!acc) return `unknown google account "${name}" — accounts: ${accounts.accounts().map((a) => a.name).join(", ") || "(none)"}`;
  return acc.gmail as unknown as GmailReadLike;
}

export async function listInbox(
  accounts: GoogleAccounts,
  opts: { account: string; query?: string; limit?: number },
): Promise<string> {
  const gmail = gmailOf(accounts, opts.account);
  if (typeof gmail === "string") return gmail;
  const list = await gmail.users.messages.list({
    userId: "me",
    q: opts.query ?? "in:inbox",
    maxResults: Math.min(opts.limit ?? 10, 25),
  });
  const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);
  if (!ids.length) return "No messages.";
  const lines: string[] = [];
  for (const id of ids) {
    const { data } = await gmail.users.messages.get({ userId: "me", id, format: "metadata" });
    const h = data.payload?.headers ?? [];
    const unread = (data.labelIds ?? []).includes("UNREAD") ? "● " : "  ";
    lines.push(`${unread}[${id}] ${header(h, "From")} — ${header(h, "Subject")} (${data.snippet ?? ""})`);
  }
  return lines.join("\n");
}

export async function readEmail(
  accounts: GoogleAccounts,
  opts: { account: string; messageId: string },
): Promise<string> {
  const gmail = gmailOf(accounts, opts.account);
  if (typeof gmail === "string") return gmail;
  const { data } = await gmail.users.messages.get({ userId: "me", id: opts.messageId, format: "full" });
  const h = data.payload?.headers ?? [];
  return [
    `From: ${header(h, "From")}`,
    `To: ${header(h, "To")}`,
    `Date: ${header(h, "Date")}`,
    `Subject: ${header(h, "Subject")}`,
    `ThreadId: ${data.threadId ?? ""}`,
    "",
    extractBody(data.payload) || "(no readable body)",
  ].join("\n");
}
