# Channel-boot resilience

**Date:** 2026-07-21
**Status:** Approved
**Cycle:** ⑧

## Problem

An invalid telegram bot token at daemon boot kills the entire daemon. Evidence: an 86-crash launchd loop in `data/aios.err.log` (`GrammyError: Call to 'getMe' failed! (401: Unauthorized)` → `triggerUncaughtException` → process exit → restart). Two seams:

1. `for (const [name, ch] of channels) { await ch.start(onMessage); ... }` in src/index.ts (~:478) — a throwing `start()` propagates uncaught.
2. Telegram's `start()` ends with `run(this.bot)` (src/channels/telegram.ts:228) — the grammY runner floats a promise; its internal `bot.init()` (`getMe`) rejection is exactly the observed uncaught path, *after* `start()` has already returned.

One bad channel token must never take down web, anchors, or memory. Slack shares seam 1 only (its `start()` awaits socket connect).

## Design

### 1. Telegram: move token failure into seam 1, guard the float

In `TelegramChannel.start()` (src/channels/telegram.ts), immediately before `run(this.bot)`:

- `await this.bot.init();` — grammY's explicit init performs `getMe`; a bad token now throws inside `start()` where the boot loop can catch it, and the runner never launches.
- Capture the runner handle and guard the remaining float: `const handle = run(this.bot); void handle.task().catch((err) => console.error("[telegram] runner died:", (err as Error).message));` — a mid-run token revocation logs and leaves the channel dead instead of killing the process. (The runner's normal polling retries — the 502/504 blips — are unaffected; they never reject the task promise.)

### 2. Fail-soft boot loop: `startChannels` (new `src/channels/boot.ts`)

```ts
export async function startChannels(
  channels: Map<string, ChannelAdapter>,
  onMessage: MessageHandler,
  log: (line: string) => void,
): Promise<Array<{ name: string; reason: string }>>
```

Iterates the map in insertion order. Per channel: `await ch.start(onMessage)` → `log("channel up: <name>")`. On throw: `channels.delete(name)` (a dead adapter must not receive sends/approvals), `log("channel FAILED: <name> — <reason> (disabled; daemon continues)")`, push `{name, reason}`. Never throws. Returns the failure list.

index.ts replaces its boot loop with:

```ts
const channelFailures = await startChannels(channels, onMessage, log);
```

### 3. Surface failures in the brief's degraded section

The brief runner already renders a re-auth/degraded section from `degraded: () => [...google.degraded(), ...bunq.degraded()]` (index.ts, runBrief deps). Extend:

```ts
degraded: () => [...google.degraded(), ...bunq.degraded(),
  ...channelFailures.map((f) => ({ name: `channel:${f.name}`, reason: f.reason }))],
```

A disabled channel shows up in the next brief instead of silently staying dead until the user notices.

## Tests (root `test/`, vitest)

- `startChannels`: two fake adapters, first throws, second succeeds → returns `[{name: "bad", reason: ...}]`, map no longer has "bad", still has "good" (started), log lines include FAILED and up markers, call resolves (never rejects).
- All-fail and all-succeed cases (empty failure list / all removed).
- Telegram `bot.init()` change: type-checked; no adapter unit harness exists — the live deploy plus the unchanged 186-file suite carry it. No new test fabricates a grammY bot.

## Not doing (YAGNI)

- Retry/backoff or auto-re-enable for failed channels — a daemon restart (launchd or deploy) re-attempts; that is enough.
- Slack socket-level float auditing — no evidence of an equivalent leak.
- UI surface for channel state beyond the brief's degraded section.
- Generalizing to senses (google/bunq already have their own degraded mechanisms).
