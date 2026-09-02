import { Bot, InputFile, InlineKeyboard, type Context } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
  private verdictHandler?: (v: { actionId: string; verdict: "approve" | "reject"; by: string }) => Promise<string>;
  /** Kept for handlers registered after start() (voice). Existing handlers use the start() closure param — keep both in sync when refactoring. */
  private wired = false;
  private onMessageHandler?: MessageHandler;

  constructor(
    private token: string,
    private allowedUserIds: number[] = [],
    /** Chat ids bound to dedicated agents (e.g. a team's finance group) — members allowed. */
    private boundChatIds: string[] = [],
    private downloadsDir: string = "data/downloads",
    /** Voice facade — when absent or unavailable, voice notes get a polite refusal. */
    private voice?: { available(): boolean; transcribe(path: string): Promise<string> },
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
    this.onMessageHandler = onMessage;
    mkdirSync(this.downloadsDir, { recursive: true });

    // Registered once. channels/boot.ts retries a failed start() in the background; a second
    // registration would stack every handler and deliver each update twice.
    if (!this.wired) {
      this.wired = true;
      // Process updates concurrently across chats but serially within one chat —
      // matches the moderator's per-chat session lock, so a slow turn in one chat
      // no longer freezes every other chat. Must precede the handlers below.
      this.bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

      this.bot.on("message:text", async (ctx) => {
        console.log(`[telegram] message from user id ${ctx.from.id} (@${ctx.from.username ?? "?"}) in chat ${ctx.chat.id}`);
        if (!(await this.authorized(ctx))) return;
        // "typing..." indicator while the agent works (auto-expires after ~5s, so repeat).
        const typing = setInterval(() => {
          this.bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
        }, 4500);
        this.bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
        try {
          await onMessage({
            channel: this.name,
            chatId: String(ctx.chat.id),
            text: ctx.message.text,
            sender: this.sender(ctx),
          });
        } finally {
          clearInterval(typing);
        }
      });

      // Documents and photos (invoices, receipts) — download, hand over as attachments.
      this.bot.on(["message:document", "message:photo"], async (ctx) => {
        console.log(`[telegram] file from user id ${ctx.from.id} in chat ${ctx.chat.id}`);
        if (!(await this.authorized(ctx))) return;
        const typing = setInterval(() => {
          ctx.replyWithChatAction("typing").catch(() => {});
        }, 4500);
        try {
          const file = await ctx.getFile();
          if (!file.file_path) throw new Error("no file_path from Telegram");
          const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
          if (!res.ok) throw new Error(`download failed: ${res.status}`);
          const fileName =
            ctx.message.document?.file_name ??
            `photo-${Date.now()}.${file.file_path.split(".").pop() ?? "jpg"}`;
          const local = join(this.downloadsDir, `${randomUUID()}-${fileName}`);
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
        } finally {
          clearInterval(typing);
        }
      });
      // Video messages — download and forward as an attachment.
      this.bot.on("message:video", async (ctx) => {
        console.log(`[telegram] video from user id ${ctx.from.id} in chat ${ctx.chat.id}`);
        if (!(await this.authorized(ctx))) return;
        // m5: typing indicator during download + agent turn, matching document/text handlers.
        const typing = setInterval(() => {
          this.bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
        }, 4500);
        this.bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
        try {
          const file = await ctx.getFile();
          if (!file.file_path) throw new Error("no file_path from Telegram");
          const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
          if (!res.ok) throw new Error(`download failed: ${res.status}`);
          const fileName =
            ctx.message.video.file_name ?? `video-${Date.now()}.mp4`;
          const local = join(this.downloadsDir, `${randomUUID()}-${fileName}`);
          writeFileSync(local, Buffer.from(await res.arrayBuffer()));
          await onMessage({
            channel: this.name,
            chatId: String(ctx.chat.id),
            text: ctx.message.caption ?? "",
            sender: this.sender(ctx),
            attachments: [{ path: local, fileName }],
          });
        } catch (err) {
          console.log(`[telegram] video handling failed: ${(err as Error).message}`);
          await ctx.reply("Couldn't download that video — try again?");
        } finally {
          clearInterval(typing);
        }
      });
      // Voice notes: download OGG → transcribe → echo transcript → route as text.
      this.bot.on("message:voice", async (ctx) => {
        console.log(`[telegram] voice note from user id ${ctx.from.id} in chat ${ctx.chat.id}`);
        if (!(await this.authorized(ctx))) return;
        if (!this.voice?.available()) {
          await ctx.reply("Voice processing is unavailable right now — type it instead?");
          return;
        }
        // "recording..." indicator over the whole flow — transcription + agent turn (auto-expires ~5s, so repeat).
        const typing = setInterval(() => {
          this.bot.api.sendChatAction(ctx.chat.id, "record_voice").catch(() => {});
        }, 4500);
        this.bot.api.sendChatAction(ctx.chat.id, "record_voice").catch(() => {});
        try {
          let transcript: string;
          try {
            const file = await ctx.getFile();
            if (!file.file_path) throw new Error("no file_path from Telegram");
            const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
            if (!res.ok) throw new Error(`download failed: ${res.status}`);
            const local = join(this.downloadsDir, `${randomUUID()}-voice.ogg`);
            writeFileSync(local, Buffer.from(await res.arrayBuffer()));
            transcript = await this.voice.transcribe(local);
          } catch (err) {
            console.log(`[telegram] voice handling failed: ${(err as Error).message}`);
            await ctx.reply("Couldn't transcribe that — try again?").catch(() => {});
            return;
          }
          if (!transcript.trim()) {
            await ctx.reply("I couldn't hear anything in that — try again?").catch(() => {});
            return;
          }
          // Echo is best-effort — a rate-limited echo must never drop the message.
          await ctx.reply(`🎙 "${transcript}"`).catch((err) =>
            console.log(`[telegram] transcript echo failed: ${(err as Error).message}`),
          );
          await this.onMessageHandler?.({
            channel: this.name,
            chatId: String(ctx.chat.id),
            text: transcript,
            sender: this.sender(ctx),
            voiceIn: true,
          });
        } finally {
          clearInterval(typing);
        }
      });

      this.bot.on("callback_query:data", async (ctx) => {
        const m = /^act:([\w-]+):(approve|reject)$/.exec(ctx.callbackQuery.data);
        if (!m || !this.verdictHandler) return void (await ctx.answerCallbackQuery());
        // Same guard as the text path: unbound groups blocked, bound-chat members allowed.
        if (!(await this.authorized(ctx))) {
          return void (await ctx.answerCallbackQuery({ text: "Not authorized" }));
        }
        try {
          const outcome = await this.verdictHandler({
            actionId: m[1],
            verdict: m[2] as "approve" | "reject",
            by: ctx.from.username ?? String(ctx.from.id),
          });
          await ctx.answerCallbackQuery({ text: outcome.slice(0, 190) });
          // Append the outcome to the original message and drop the buttons.
          const original = ctx.callbackQuery.message?.text ?? "";
          await ctx.editMessageText(`${original}\n\n→ ${outcome}`).catch(() => {});
        } catch (err) {
          await ctx.answerCallbackQuery({ text: `Error: ${(err as Error).message}`.slice(0, 190) }).catch(() => {});
        }
      });
    }

    // Concurrent long-polling via @grammyjs/runner: fetches and dispatches updates
    // in parallel (sequentialize above keeps per-chat order). Replaces bot.start(),
    // whose sequential loop blocked the whole bot for the duration of each turn.
    // Outbound only, works behind NAT; returns a handle, runs forever.
    // init() (getMe) BEFORE run(): a bad token throws here, inside start(), where
    // the boot loop can disable just this channel — not as an uncaught rejection
    // that kills the process (86-crash launchd loop, spec 2026-07-21).
    await this.bot.init();
    const handle = run(this.bot);
    void handle.task()?.catch((err) => {
      console.error(`[telegram] runner died: ${(err as Error).message}`);
    });
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

  async sendVoice(chatId: string, audioPath: string, caption?: string): Promise<void> {
    await this.bot.api.sendVoice(Number(chatId), new InputFile(audioPath), caption ? { caption } : {});
  }

  setVerdictHandler(
    handler: (v: { actionId: string; verdict: "approve" | "reject"; by: string }) => Promise<string>,
  ): void {
    this.verdictHandler = handler;
  }

  async sendApprovalRequest(chatId: string, a: { id: string; type: string; preview: string }): Promise<void> {
    const kb = new InlineKeyboard()
      .text("✓ Approve", `act:${a.id}:approve`)
      .text("✗ Reject", `act:${a.id}:reject`);
    await this.bot.api.sendMessage(
      Number(chatId),
      `⚖ Approval needed [${a.type}]\n${a.preview}\n\nOr reply: /approve ${a.id} · /reject ${a.id} <reason>`,
      { reply_markup: kb },
    );
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
