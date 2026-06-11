import { Bot, InputFile, type Context } from "grammy";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChannelAdapter, MessageHandler } from "./types.js";
import { mdToTelegramHtml } from "./format.js";

const TELEGRAM_MAX = 4096;

function chunk(text: string, size = TELEGRAM_MAX): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    let cut = rest.length <= size ? rest.length : rest.lastIndexOf("\n", size);
    if (cut <= 0) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return out;
}

export class TelegramChannel implements ChannelAdapter {
  readonly name = "telegram";
  private bot: Bot;

  constructor(
    private token: string,
    private allowedUserIds: number[] = [],
    /** Chat ids bound to dedicated agents (e.g. a team's finance group) — members allowed. */
    private boundChatIds: string[] = [],
    private downloadsDir: string = "data/downloads",
  ) {
    this.bot = new Bot(token);
  }

  /** Returns false when the message must be ignored (unbound group / unauthorized DM). */
  private async authorized(ctx: Context & { from: NonNullable<Context["from"]> }): Promise<boolean> {
    const isBoundChat = this.boundChatIds.includes(String(ctx.chat?.id));
    const isGroup = ctx.chat?.type !== "private";
    if (isGroup && !isBoundChat) return false;
    if (!isBoundChat && this.allowedUserIds.length && !this.allowedUserIds.includes(ctx.from.id)) {
      await ctx.reply("Not authorized.");
      return false;
    }
    return true;
  }

  private sender(ctx: Context & { from: NonNullable<Context["from"]> }) {
    return {
      name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || undefined,
      username: ctx.from.username,
    };
  }

  async start(onMessage: MessageHandler): Promise<void> {
    mkdirSync(this.downloadsDir, { recursive: true });

    this.bot.on("message:text", async (ctx) => {
      console.log(`[telegram] message from user id ${ctx.from.id} (@${ctx.from.username ?? "?"}) in chat ${ctx.chat.id}`);
      if (!(await this.authorized(ctx))) return;
      await onMessage({
        channel: this.name,
        chatId: String(ctx.chat.id),
        text: ctx.message.text,
        sender: this.sender(ctx),
      });
    });

    // Documents and photos (invoices, receipts) — download, hand over as attachments.
    this.bot.on(["message:document", "message:photo"], async (ctx) => {
      console.log(`[telegram] file from user id ${ctx.from.id} in chat ${ctx.chat.id}`);
      if (!(await this.authorized(ctx))) return;
      try {
        const file = await ctx.getFile();
        if (!file.file_path) throw new Error("no file_path from Telegram");
        const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
        if (!res.ok) throw new Error(`download failed: ${res.status}`);
        const fileName =
          ctx.message.document?.file_name ??
          `photo-${Date.now()}.${file.file_path.split(".").pop() ?? "jpg"}`;
        const local = join(this.downloadsDir, `${Date.now()}-${fileName}`);
        writeFileSync(local, Buffer.from(await res.arrayBuffer()));
        await onMessage({
          channel: this.name,
          chatId: String(ctx.chat.id),
          text: ctx.message.caption ?? "",
          sender: this.sender(ctx),
          attachments: [{ path: local, fileName }],
        });
      } catch (err) {
        console.log(`[telegram] file handling failed: ${(err as Error).message}`);
        await ctx.reply("Couldn't download that file — try again?");
      }
    });
    // Long-polling: outbound only, works behind NAT. Don't await — runs forever.
    void this.bot.start({ drop_pending_updates: true });
  }

  async send(chatId: string, text: string): Promise<void> {
    for (const part of chunk(mdToTelegramHtml(text))) {
      try {
        await this.bot.api.sendMessage(Number(chatId), part, { parse_mode: "HTML" });
      } catch {
        // HTML parse error (e.g. tag split across chunks) — fall back to plain text.
        await this.bot.api.sendMessage(Number(chatId), part.replace(/<[^>]+>/g, ""));
      }
    }
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    await this.bot.api.sendDocument(Number(chatId), new InputFile(filePath), { caption });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
