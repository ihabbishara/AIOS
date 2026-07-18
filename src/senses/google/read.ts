// src/senses/google/read.ts
import type { GoogleAccounts } from "./auth.js";
import { processAttachment, type MediaDeps } from "../../attachments.js";
import type { VaultWriter } from "../../vault/writer.js";

export interface GmailPayload {
  mimeType?: string | null;
  body?: { data?: string | null; attachmentId?: string | null } | null;
  parts?: GmailPayload[] | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
  filename?: string | null;
}

export interface GmailReadLike {
  users: {
    messages: {
      list(p: { userId: string; q?: string; maxResults?: number; labelIds?: string[] }): Promise<{ data: { messages?: Array<{ id?: string | null }> | null } }>;
      get(p: { userId: string; id: string; format?: string }): Promise<{ data: { id?: string | null; threadId?: string | null; snippet?: string | null; labelIds?: string[] | null; payload?: GmailPayload | null } }>;
      attachments: {
        get(p: { userId: string; messageId: string; id: string }): Promise<{ data: { data?: string | null } }>;
      };
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

// ── Attachment extraction ────────────────────────────────────────────────────

interface AttachmentPart {
  fileName: string;
  mimeType: string;
  attachmentId: string;
}

/**
 * Recursively walk a MIME payload tree and collect parts that represent
 * file attachments (non-empty attachmentId + non-empty filename).
 */
function collectAttachmentParts(payload: GmailPayload | null | undefined): AttachmentPart[] {
  if (!payload) return [];
  const results: AttachmentPart[] = [];

  const walk = (p: GmailPayload) => {
    const attachmentId = p.body?.attachmentId;
    const fileName = p.filename?.trim();
    if (attachmentId && fileName) {
      // m4: skip inline parts (logos, tracking pixels in HTML emails).
      // Only explicit attachments (Content-Disposition: attachment) are stored to vault.
      const disposition = header(p.headers ?? [], "Content-Disposition");
      if (!disposition.toLowerCase().startsWith("inline")) {
        results.push({
          fileName,
          mimeType: p.mimeType ?? "application/octet-stream",
          attachmentId,
        });
      }
    }
    for (const child of p.parts ?? []) {
      walk(child);
    }
  };

  walk(payload);
  return results;
}

/**
 * Fetch one Gmail attachment part's data, decode from base64url, and run it
 * through the shared processAttachment() pipeline (image → vault, PDF → text,
 * etc.).
 */
async function fetchAndProcessAttachment(
  gmail: GmailReadLike,
  messageId: string,
  part: AttachmentPart,
  vault: VaultWriter,
  log?: (line: string) => void,
  media?: MediaDeps,
): Promise<string> {
  const safeName = part.fileName.replace(/[\r\n\[\]]/g, "_");
  try {
    const { data } = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: part.attachmentId,
    });
    if (!data.data) {
      return `[Attachment: ${safeName} — empty data from Gmail API]`;
    }
    const buf = Buffer.from(data.data, "base64url");
    return processAttachment(
      { kind: "buffer", buf, fileName: part.fileName, mimeType: part.mimeType },
      vault,
      log,
      media,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`[attachments] failed to fetch Gmail attachment ${safeName}: ${msg}`);
    return `[Attachment: ${safeName} — fetch failed: ${msg}]`;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

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
  vault?: VaultWriter,
  log?: (line: string) => void,
  media?: MediaDeps,
): Promise<string> {
  const gmail = gmailOf(accounts, opts.account);
  if (typeof gmail === "string") return gmail;
  const { data } = await gmail.users.messages.get({ userId: "me", id: opts.messageId, format: "full" });
  const h = data.payload?.headers ?? [];

  const bodyLines = [
    `From: ${header(h, "From")}`,
    `To: ${header(h, "To")}`,
    `Date: ${header(h, "Date")}`,
    `Subject: ${header(h, "Subject")}`,
    `ThreadId: ${data.threadId ?? ""}`,
    "",
    extractBody(data.payload) || "(no readable body)",
  ];

  // Attachment processing — only when vault is provided.
  // Skipped gracefully when called from contexts without vault access.
  if (vault) {
    const parts = collectAttachmentParts(data.payload);
    if (parts.length) {
      // M4: sequential processing avoids Gmail quota exhaustion (250 units/s;
      // 5 units per attachments.get call — 20+ attachments would saturate quota).
      const notes: string[] = [];
      for (const p of parts) {
        notes.push(await fetchAndProcessAttachment(gmail, opts.messageId, p, vault, log, media));
      }
      bodyLines.push("", ...notes);
    }
  }

  return bodyLines.join("\n");
}
