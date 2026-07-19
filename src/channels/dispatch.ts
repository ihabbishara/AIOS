import type { ChannelAdapter } from "./types.js";
import type { Attachment } from "../agents/attachment.js";

/** Deliver collected attachments over a push channel: voice notes via sendVoice, everything else via sendFile. */
export async function dispatchAttachments(
  ch: ChannelAdapter | undefined,
  chatId: string,
  atts: Attachment[],
  log?: (line: string) => void,
): Promise<void> {
  if (!ch) return;
  for (const att of atts) {
    const deliver =
      att.kind === "voice" && ch.sendVoice
        ? ch.sendVoice(chatId, att.path, att.caption)
        : ch.sendFile(chatId, att.path, att.caption);
    await deliver?.catch((err: unknown) =>
      log?.(`attachment delivery failed (${att.path}): ${(err as Error).message}`),
    );
  }
}
