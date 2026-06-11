import bolt from "@slack/bolt";
import type { ChannelAdapter, MessageHandler } from "./types.js";
import { mdToSlackMrkdwn } from "./format.js";

export class SlackChannel implements ChannelAdapter {
  readonly name = "slack";
  private app: bolt.App;
  private nameCache = new Map<string, string>();

  constructor(botToken: string, appToken: string) {
    this.app = new bolt.App({
      token: botToken,
      appToken,
      socketMode: true, // outbound websocket — no public URL needed
    });
  }

  async start(onMessage: MessageHandler): Promise<void> {
    this.app.message(async ({ message }) => {
      // Only plain user messages (not bot echoes, edits, etc.)
      if (message.subtype !== undefined) return;
      const m = message as { channel: string; text?: string; bot_id?: string; user?: string };
      if (m.bot_id || !m.text) return;
      await onMessage({
        channel: this.name,
        chatId: m.channel,
        text: m.text,
        sender: { name: m.user ? await this.displayName(m.user) : undefined, username: m.user },
      });
    });
    await this.app.start();
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.app.client.chat.postMessage({ channel: chatId, text: mdToSlackMrkdwn(text) });
  }

  /** Resolve a Slack user id to a display name (needs users:read scope; falls back to the id). */
  private async displayName(userId: string): Promise<string> {
    const cached = this.nameCache.get(userId);
    if (cached) return cached;
    try {
      const res = await this.app.client.users.info({ user: userId });
      const name = res.user?.profile?.display_name || res.user?.real_name || userId;
      this.nameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}
