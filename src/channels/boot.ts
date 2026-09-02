// src/channels/boot.ts — fail-soft channel startup (spec 2026-07-21).
// One bad channel must never take down web, anchors, or memory. A start() that throws or does
// not settle in time is reported, its adapter leaves the map (no sends/approvals to a channel
// that is not there), and the daemon lives.
//
// Two earlier shapes of this file each fixed one failure and left another:
//
// - Sequential, unbounded awaits: a start() that never settled held the whole boot, and with it
//   the cockpit (web starts far later in bootNormal). Observed 2026-08-11: a slow Slack
//   handshake put :4280 37 seconds behind.
// - Concurrent, bounded, and PERMANENT: a channel that missed the 60s bound was stop()ped and
//   disabled for the whole session. Two problems. A boot with no network (a laptop waking away
//   from home, 2026-08-30) lost Telegram AND Slack for three days, until someone restarted the
//   daemon by hand. And stop()ping Slack mid-reconnect crashed the process: @slack/socket-mode
//   fires its reconnect attempts as unawaited promises, and a disconnect() during one rejects
//   it with `undefined` — three crash-restarts (2026-08-25 ×2, 2026-09-02), each exactly one
//   second after "channel FAILED: slack — did not start within 60000ms".
//
// So now: starts run concurrently, each is bounded so boot proceeds, and a channel that missed
// the bound or threw KEEPS TRYING in the background. A timed-out start is still running (Slack's
// client reconnects on its own), so it is awaited rather than restarted — a second start() would
// open a second socket and deliver every message twice. A thrown start never got going, so it is
// retried with backoff. Either way the adapter rejoins the map the moment it connects, and its
// entry leaves the failure list the briefs read. Nothing is ever stop()ped here.
//
// Still not simply moved off the boot path: `sendVia` reaches adapters through
// `channels.get(name)?.send(...)`, so a channel must be OUT of the map while it is not
// connected, or a send would land on a socket that cannot service it.
import type { ChannelAdapter, MessageHandler } from "./types.js";

/** Well past the slowest handshake seen in the wild (37s). Being wrong in one direction only
 *  delays the channel's arrival (it keeps trying); in the other it costs a bounded wait during
 *  a failure that is already rare. */
const DEFAULT_START_TIMEOUT_MS = 60_000;
/** Background retry backoff for a start that threw: 1m, 2m, 4m, 8m, then every 10m. */
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_RETRY_MAX_MS = 10 * 60_000;

function startTimeoutMs(env: NodeJS.ProcessEnv, override?: number): number {
  if (override !== undefined) return override;
  const raw = Number(env.AIOS_CHANNEL_START_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_START_TIMEOUT_MS;
}

/** Distinguishable on purpose: a start that THREW never got going and can be called again,
 *  while one that timed out is still running and must be awaited, not duplicated. */
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

/** unref'd so a retry that is merely waiting never holds the process open at shutdown. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref(); });
}

export interface ChannelFailure { name: string; reason: string }

export interface StartChannelsOptions {
  timeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

/**
 * Start every adapter. Resolves once each has connected, failed, or hit the bound — never
 * throws. The returned list is LIVE: a channel that connects later is removed from it (and put
 * back in `channels`), so a caller that reads it on every brief sees the recovery without being
 * told. Hold the array, not a copy.
 */
export async function startChannels(
  channels: Map<string, ChannelAdapter>,
  onMessage: MessageHandler,
  log: (line: string) => void,
  opts: StartChannelsOptions = {},
): Promise<ChannelFailure[]> {
  const ms = startTimeoutMs(process.env, opts.timeoutMs);
  const backoff = { base: opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, max: opts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS };

  const settled = await Promise.all([...channels].map(async ([name, ch]) => {
    let started: Promise<void> | undefined;
    try {
      started = ch.start(onMessage);
      await withTimeout(started, ms);
      return { name, ch, reason: null as string | null, pending: null as Promise<void> | null };
    } catch (err) {
      // Only a TIMEOUT leaves a live start to wait on; a throw has nothing running.
      const pending = err instanceof ChannelStartTimeout ? started! : null;
      return { name, ch, reason: (err as Error).message, pending };
    }
  }));

  // Mutated and logged after the race rather than inside it, so the log reads in map order
  // however the starts happened to interleave.
  const failures: ChannelFailure[] = [];
  for (const { name, ch, reason, pending } of settled) {
    if (reason === null) { log(`channel up: ${name}`); continue; }
    channels.delete(name);
    const entry: ChannelFailure = { name, reason };
    failures.push(entry);
    log(`channel FAILED: ${name} — ${reason} (daemon continues; keeps trying in the background)`);
    void keepTrying(entry, ch, pending, { channels, onMessage, log, failures, backoff })
      .catch((err) => log(`channel retry loop died: ${name} — ${(err as Error).message}`));
  }
  return failures;
}

interface RetryCtx {
  channels: Map<string, ChannelAdapter>;
  onMessage: MessageHandler;
  log: (line: string) => void;
  failures: ChannelFailure[];
  backoff: { base: number; max: number };
}

/** Wait for a still-running start, or retry a failed one, until the channel connects. Then it
 *  rejoins the map and its failure entry is dropped. Never resolves for an adapter that never
 *  connects — that is fine, nothing waits on this. */
async function keepTrying(
  entry: ChannelFailure, ch: ChannelAdapter, pending: Promise<void> | null, ctx: RetryCtx,
): Promise<void> {
  let attempt = pending;
  for (let n = 0; ; n++) {
    if (attempt) {
      try {
        await attempt;
        ctx.channels.set(entry.name, ch);
        const i = ctx.failures.indexOf(entry);
        if (i >= 0) ctx.failures.splice(i, 1);
        ctx.log(`channel up (late): ${entry.name}${n ? ` after ${n} retr${n === 1 ? "y" : "ies"}` : ""}`);
        return;
      } catch (err) {
        entry.reason = (err as Error).message;
        // A dead token would otherwise write a line every ten minutes forever; the brief's
        // degraded list carries the standing state, the log only needs the shape of it.
        if (n < 3 || n % 10 === 0) ctx.log(`channel retry ${n} failed: ${entry.name} — ${entry.reason}`);
      }
    }
    await sleep(Math.min(ctx.backoff.max, ctx.backoff.base * 2 ** n));
    // Adapters are async, but a synchronous throw must land in the catch above, not here.
    attempt = Promise.resolve().then(() => ch.start(ctx.onMessage));
  }
}
