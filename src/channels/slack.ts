import bolt from "@slack/bolt";
import type { ChannelAdapter, MessageHandler } from "./types.js";

export class SlackChannel implements ChannelAdapter {
  readonly name = "slack";
  private app: bolt.App;

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
      const m = message as { channel: string; text?: string; bot_id?: string };
      if (m.bot_id || !m.text) return;
      await onMessage({ channel: this.name, chatId: m.channel, text: m.text });
    });
    await this.app.start();
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.app.client.chat.postMessage({ channel: chatId, text });
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}
