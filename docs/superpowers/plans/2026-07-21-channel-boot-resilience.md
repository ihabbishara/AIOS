# Channel-Boot Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bad channel token at boot disables that channel and surfaces in the brief's degraded section instead of crash-looping the whole daemon.

**Architecture:** New `startChannels` helper (src/channels/boot.ts) runs each adapter's `start()` fail-soft — throw → remove from map, log, collect `{name, reason}`. Telegram's `start()` awaits `bot.init()` before launching the grammY runner so a bad token throws inside `start()`, and the runner handle's task promise gets a `.catch` so a mid-run revocation can't float an uncaught rejection. index.ts wires the failure list into the existing brief `degraded()` seam.

**Tech Stack:** TypeScript, vitest, grammY/@grammyjs/runner (existing deps).

**Spec:** `docs/superpowers/specs/2026-07-21-channel-boot-resilience-design.md`

## Global Constraints

- No new npm dependencies.
- Trunk-based: commit on main, EXPLICIT file paths only in `git add` (parallel session shares checkout).
- `startChannels` never throws; a dead adapter must be deleted from the map (it must not receive sends/approvals).
- Log lines exactly: success `channel up: <name>` (existing wording), failure `channel FAILED: <name> — <reason> (disabled; daemon continues)`.
- Degraded entries shape: `{ name: "channel:<name>", reason: <reason> }` appended after google/bunq entries.
- grammY note: `RunnerHandle.task()` returns `Promise<void> | undefined` — guard with `?.`.
- Read vitest's "Tests" summary line, not exit codes.
- Deploy: `npm run build && launchctl kickstart -k gui/501/com.ihab.aios`, poll `/api/state`.

---

### Task 1: `startChannels` + tests

**Files:**
- Create: `src/channels/boot.ts`
- Test: `test/channel-boot.test.ts` (new)

**Interfaces:**
- Consumes: `ChannelAdapter`, `MessageHandler` from `./types.js` (`start(onMessage: MessageHandler): Promise<void>` is the only member used).
- Produces: `startChannels(channels: Map<string, ChannelAdapter>, onMessage: MessageHandler, log: (line: string) => void): Promise<Array<{ name: string; reason: string }>>`. Task 2 calls it from index.ts.

- [ ] **Step 1: Write the failing tests**

Create `test/channel-boot.test.ts`:

```ts
// test/channel-boot.test.ts
import { describe, it, expect } from "vitest";
import { startChannels } from "../src/channels/boot.js";
import type { ChannelAdapter, MessageHandler } from "../src/channels/types.js";

const noop: MessageHandler = async () => {};

function fake(started: string[], name: string, failWith?: string): ChannelAdapter {
  return {
    name,
    start: async () => {
      if (failWith) throw new Error(failWith);
      started.push(name);
    },
    send: async () => {},
  } as unknown as ChannelAdapter;
}

describe("startChannels", () => {
  it("starts good channels, removes and reports the bad one, never throws", async () => {
    const started: string[] = [];
    const lines: string[] = [];
    const channels = new Map<string, ChannelAdapter>([
      ["bad", fake(started, "bad", "getMe failed (401: Unauthorized)")],
      ["good", fake(started, "good")],
    ]);
    const failures = await startChannels(channels, noop, (l) => lines.push(l));
    expect(failures).toEqual([{ name: "bad", reason: "getMe failed (401: Unauthorized)" }]);
    expect(channels.has("bad")).toBe(false);
    expect(channels.has("good")).toBe(true);
    expect(started).toEqual(["good"]);
    expect(lines.some((l) => l.includes("channel up: good"))).toBe(true);
    expect(lines.some((l) => l.includes("channel FAILED: bad") && l.includes("disabled; daemon continues"))).toBe(true);
  });
  it("all succeed → empty failure list", async () => {
    const started: string[] = [];
    const channels = new Map<string, ChannelAdapter>([["a", fake(started, "a")], ["b", fake(started, "b")]]);
    expect(await startChannels(channels, noop, () => {})).toEqual([]);
    expect(started).toEqual(["a", "b"]);
  });
  it("all fail → all removed, all reported, resolves", async () => {
    const channels = new Map<string, ChannelAdapter>([
      ["x", fake([], "x", "boom-x")],
      ["y", fake([], "y", "boom-y")],
    ]);
    const failures = await startChannels(channels, noop, () => {});
    expect(failures.map((f) => f.name)).toEqual(["x", "y"]);
    expect(channels.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/channel-boot.test.ts`
Expected: FAIL — cannot resolve `../src/channels/boot.js`.

- [ ] **Step 3: Implement**

Create `src/channels/boot.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/channel-boot.test.ts && npx tsc --noEmit`
Expected: 3 passed, tsc clean. (Deleting from a Map during for..of iteration is safe for already-visited entries — the test's all-fail case pins it.)

- [ ] **Step 5: Commit**

```bash
git add src/channels/boot.ts test/channel-boot.test.ts
git commit -m "feat(channels): startChannels — fail-soft boot, dead adapters removed and reported"
```

---

### Task 2: Telegram init-at-seam + index wiring

**Files:**
- Modify: `src/channels/telegram.ts:224-229` (the `run(this.bot)` tail of `start()`)
- Modify: `src/index.ts:477-480` (boot loop) and `src/index.ts:693` (degraded wiring)

**Interfaces:**
- Consumes: `startChannels` from Task 1 (exact signature above); grammY `run()` already imported in telegram.ts.
- Produces: `channelFailures: Array<{ name: string; reason: string }>` const in index.ts scope, read by the `degraded` closure.

- [ ] **Step 1: Telegram — await init, guard the runner task**

In `src/channels/telegram.ts`, replace the end of `start()`:

```ts
    // Concurrent long-polling via @grammyjs/runner: fetches and dispatches updates
    // in parallel (sequentialize above keeps per-chat order). Replaces bot.start(),
    // whose sequential loop blocked the whole bot for the duration of each turn.
    // Outbound only, works behind NAT; returns a handle, runs forever.
    run(this.bot);
  }
```

with:

```ts
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
```

- [ ] **Step 2: index.ts — wire startChannels + degraded**

Add to the channel imports region (next to the other `./channels/` imports):

```ts
import { startChannels } from "./channels/boot.js";
```

Replace the boot loop (index.ts:477-480):

```ts
  for (const [name, ch] of channels) {
    await ch.start(onMessage);
    log(`channel up: ${name}`);
  }
```

with:

```ts
  const channelFailures = await startChannels(channels, onMessage, log);
```

Replace the degraded line (index.ts:693):

```ts
          degraded: () => [...google.degraded(), ...bunq.degraded()],
```

with:

```ts
          degraded: () => [...google.degraded(), ...bunq.degraded(),
            ...channelFailures.map((f) => ({ name: `channel:${f.name}`, reason: f.reason }))],
```

- [ ] **Step 3: Typecheck + focused suite**

Run: `npx tsc --noEmit && npx vitest run test/channel-boot.test.ts test/briefs.test.ts`
Expected: clean + green (briefs tests pin the degraded section's rendering shape — they must not care about the new entries' source).

- [ ] **Step 4: Commit**

```bash
git add src/channels/telegram.ts src/index.ts
git commit -m "feat(channels): telegram init at the boot seam + runner-task guard; failures feed brief degraded"
```

---

### Task 3: Full suite + deploy + push

**Files:** none (verification and shipping only).

- [ ] **Step 1: Typecheck both roots + full suite**

Run: `npx tsc --noEmit && (cd ui2 && npx tsc --noEmit); npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: 187 files (186 + channel-boot), 1392 passed | 2 skipped (1389 + 3). Unrelated failures → STOP and report.

- [ ] **Step 2: Deploy + verify healthy path**

```bash
npm run build && launchctl kickstart -k gui/501/com.ihab.aios
```

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 10 -H "Authorization: Bearer $TOKEN" http://localhost:4280/api/state | head -c 120
grep "channel up" data/aios.log | tail -3
tail -5 data/aios.err.log
```

Expected: JSON state; fresh `channel up: telegram` (and slack) lines with valid tokens; no new err.log entries. Do NOT live-test the bad-token path (would require breaking the real token and crash-cycling the daemon) — the unit tests and the awaited-init type change carry it.

- [ ] **Step 3: Push**

```bash
git push origin main
```
