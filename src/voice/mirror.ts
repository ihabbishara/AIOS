import type { ChannelAdapter, InboundMessage } from "../channels/types.js";

/** Telegram caption hard limit. */
const CAPTION_MAX = 1024;

export interface MirrorDeps {
  voice: {
    available(): boolean;
    synthesize(text: string): Promise<string>;
  };
  log?: (line: string) => void;
}

/**
 * Mirror policy: voice in → voice note reply (+ text), text in → text.
 * Any voice failure silently downgrades to text — a reply is never lost.
 */
export async function deliverReply(
  deps: MirrorDeps,
  channel: ChannelAdapter | undefined,
  msg: InboundMessage,
  reply: string,
): Promise<void> {
  if (!channel) return;
  if (msg.voiceIn && channel.sendVoice && deps.voice.available()) {
    try {
      const audio = await deps.voice.synthesize(reply);
      if (reply.length <= CAPTION_MAX) {
        await channel.sendVoice(msg.chatId, audio, reply);
      } else {
        await channel.sendVoice(msg.chatId, audio, undefined);
        await channel.send(msg.chatId, reply);
      }
      return;
    } catch (err) {
      deps.log?.(`voice mirror failed, falling back to text: ${(err as Error).message}`);
    }
  }
  await channel.send(msg.chatId, reply);
}
