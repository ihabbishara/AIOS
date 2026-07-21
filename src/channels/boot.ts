// src/channels/boot.ts — fail-soft channel startup (spec 2026-07-21).
// One bad channel token must never take down web, anchors, or memory: a
// throwing start() removes the adapter (no sends/approvals to a dead channel),
// logs, and reports — the daemon lives.
import type { ChannelAdapter, MessageHandler } from "./types.js";

export async function startChannels(
  channels: Map<string, ChannelAdapter>,
  onMessage: MessageHandler,
  log: (line: string) => void,
): Promise<Array<{ name: string; reason: string }>> {
  const failures: Array<{ name: string; reason: string }> = [];
  for (const [name, ch] of channels) {
    try {
      await ch.start(onMessage);
      log(`channel up: ${name}`);
    } catch (err) {
      const reason = (err as Error).message;
      channels.delete(name);
      failures.push({ name, reason });
      log(`channel FAILED: ${name} — ${reason} (disabled; daemon continues)`);
    }
  }
  return failures;
}
