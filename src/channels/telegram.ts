import { Bot } from "grammy";
import type { ChannelAdapter, MessageHandler } from "./types.js";

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

  constructor(token: string, private allowedUserIds: number[] = []) {
    this.bot = new Bot(token);
  }

  async start(onMessage: MessageHandler): Promise<void> {
    this.bot.on("message:text", async (ctx) => {
      console.log(`[telegram] message from user id ${ctx.from.id} (@${ctx.from.username ?? "?"})`);
      if (this.allowedUserIds.length && !this.allowedUserIds.includes(ctx.from.id)) {
        await ctx.reply("Not authorized.");
        return;
      }
      await onMessage({
        channel: this.name,
        chatId: String(ctx.chat.id),
        text: ctx.message.text,
      });
    });
    // Long-polling: outbound only, works behind NAT. Don't await — runs forever.
    void this.bot.start({ drop_pending_updates: true });
  }

  async send(chatId: string, text: string): Promise<void> {
    for (const part of chunk(text)) {
      await this.bot.api.sendMessage(Number(chatId), part);
    }
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
