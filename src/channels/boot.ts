// src/channels/boot.ts — fail-soft channel startup (spec 2026-07-21).
// One bad channel token must never take down web, anchors, or memory: a
// throwing start() removes the adapter (no sends/approvals to a dead channel),
// logs, and reports — the daemon lives.
//
// It was only ever fail-soft against a THROW. A start() that simply never settles held the whole
// boot, and since the web server does not start until far later in bootNormal, the cockpit went
// with it — permanently, with no error anywhere to say why. Observed 2026-08-11: a slow Slack
// handshake put :4280 37 seconds behind, which is the same failure with a finite end.
//
// So starts now run concurrently and each one is bounded. Concurrency is what fixes the 37s —
// the cost of channels becomes the slowest one rather than the sum. The timeout is what fixes
// "forever", and it is deliberately generous: that 37s handshake was a channel working
// correctly, and a timeout tight enough to feel responsive would disable it on every boot.
//
// Not simply moved off the boot path, which would fix both outright: `sendVia` reaches adapters
// through `channels.get(name)?.send(...)`, so a channel still starting is IN the map and would
// take a send it cannot service. Trading a rare hang for a routine race is not an improvement.
import type { ChannelAdapter, MessageHandler } from "./types.js";

/** Well past the slowest handshake seen in the wild (37s). Being wrong in one direction disables
 *  a working channel for the whole session; in the other it costs a bounded wait during a
 *  failure that is already rare. */
const DEFAULT_START_TIMEOUT_MS = 60_000;

function startTimeoutMs(env: NodeJS.ProcessEnv, override?: number): number {
  if (override !== undefined) return override;
  const raw = Number(env.AIOS_CHANNEL_START_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_START_TIMEOUT_MS;
}

/** Distinguishable on purpose: a start that THREW never got going and has nothing to tear down,
 *  while one that timed out is still running and does. */
class ChannelStartTimeout extends Error {}

/** Reject if `p` has not settled within `ms`. The timer is always cleared — a pending one holds
 *  the event loop open and turns a clean shutdown into a hang of its own. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ChannelStartTimeout(`did not start within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function startChannels(
  channels: Map<string, ChannelAdapter>,
  onMessage: MessageHandler,
  log: (line: string) => void,
  opts: { timeoutMs?: number } = {},
): Promise<Array<{ name: string; reason: string }>> {
  const ms = startTimeoutMs(process.env, opts.timeoutMs);
  const settled = await Promise.all([...channels].map(async ([name, ch]) => {
    try {
      await withTimeout(ch.start(onMessage), ms);
      return { name, reason: null as string | null };
    } catch (err) {
      const reason = (err as Error).message;
      // Only after a TIMEOUT. That start is still running, and disowning the adapter without
      // telling it to stop leaves a channel that connects moments later holding a live socket
      // and feeding messages into a daemon that believes it is gone. A start that threw never
      // got going, so stopping it would be asking an adapter to undo something it never did.
      // Bounded too, and its own failure is swallowed: the reason the user needs is why the
      // channel did not START.
      if (err instanceof ChannelStartTimeout) {
        try { await withTimeout(Promise.resolve(ch.stop()), ms); } catch { /* nothing left to try */ }
      }
      return { name, reason };
    }
  }));

  // Mutated and logged after the race rather than inside it, so the log reads in map order
  // however the starts happened to interleave.
  const failures: Array<{ name: string; reason: string }> = [];
  for (const { name, reason } of settled) {
    if (reason === null) { log(`channel up: ${name}`); continue; }
    channels.delete(name);
    failures.push({ name, reason });
    log(`channel FAILED: ${name} — ${reason} (disabled; daemon continues)`);
  }
  return failures;
}
