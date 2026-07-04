// src/mail/server.ts — per-run aios-mail MCP server; sender identity/origin/depth baked, non-spoofable.
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Mailbox, MailSendCtx } from "./mailbox.js";

export const MAIL_TOOL = "mcp__aios-mail__send_mail";

export function buildMailServer(mailbox: Mailbox, ctx: MailSendCtx) {
  const sendMail = tool(
    "send_mail",
    "Send mail to another staff agent. kind=request: they run it as a goal later and the result " +
      "reports back to you automatically. kind=note: FYI only, nothing runs.",
    { to: z.string(), kind: z.enum(["request", "note"]), body: z.string() },
    async (a) => ({ content: [{ type: "text" as const, text: mailbox.send(ctx, a) }] }),
  );
  return createSdkMcpServer({ name: "aios-mail", version: "0.1.0", tools: [sendMail] });
}
