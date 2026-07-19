# Session Surface Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resumed SDK sessions auto-invalidate when the agent's resolved tool surface changes, instead of latching stale surfaces until someone hand-deletes kv rows.

**Architecture:** `surfaceHash(options)` (sha256 of sorted allowedTools + sorted MCP server names + permissionMode) lives in `src/agents/resumable.ts` beside the resume machinery. `resumableTurn` gains an optional `surfaceHash` param: stored hash mismatch **or absence** → skip the stored resume id, run fresh, persist the new hash on success under the existing reset-epoch gate. Both resume seams (direct chats, moderator) compute the hash from the final per-turn options — after every widening — and pass it.

**Tech Stack:** TypeScript (Node 23), `node:crypto`, vitest, `Store(":memory:")` for kv tests.

## Global Constraints

- Tools-only scope (user-locked): hash covers `allowedTools`, `mcpServers` keys, `permissionMode` — never systemPrompt or model.
- Absent-stored-hash means fresh (fail-closed, one-time fleet reset at first deploy — user-approved).
- Callers passing no `surfaceHash` keep today's behavior exactly.
- No new bus event types; no config/schema changes; engine one-shots untouched.
- Tests in root `test/` (vitest). Suite baseline before this plan: 1315 pass + 2 skip.

---

### Task 1: surfaceHash + resume gate (resumable.ts)

**Files:**
- Modify: `src/agents/resumable.ts`
- Test: `test/session-surface.test.ts` (create)

**Interfaces:**
- Produces: `surfaceHash(options: Options): string` (16 hex chars); `resumeFor(store: Store, sessionKey: string, hash?: string): string | undefined` (stored resume id, or undefined when it must not be used); `ResumableTurnParams.surfaceHash?: string`. Task 2 consumes `surfaceHash` + the new param.

- [ ] **Step 1: Write the failing tests**

```ts
// test/session-surface.test.ts
import { describe, it, expect } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Store } from "../src/store/db.js";
import { surfaceHash, resumeFor } from "../src/agents/resumable.js";

const opts = (o: Partial<Options>): Options => o as Options;

describe("surfaceHash", () => {
  it("is stable and order-insensitive", () => {
    const a = surfaceHash(opts({ allowedTools: ["B", "A"], mcpServers: { m1: {} as never, m2: {} as never }, permissionMode: "dontAsk" }));
    const b = surfaceHash(opts({ allowedTools: ["A", "B"], mcpServers: { m2: {} as never, m1: {} as never }, permissionMode: "dontAsk" }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes on tool add, server add, and mode change", () => {
    const base = opts({ allowedTools: ["A"], mcpServers: { m1: {} as never }, permissionMode: "dontAsk" });
    const h = surfaceHash(base);
    expect(surfaceHash(opts({ ...base, allowedTools: ["A", "B"] }))).not.toBe(h);
    expect(surfaceHash(opts({ ...base, mcpServers: { m1: {} as never, m2: {} as never } }))).not.toBe(h);
    expect(surfaceHash(opts({ ...base, permissionMode: "default" }))).not.toBe(h);
  });

  it("ignores systemPrompt and model", () => {
    const base = opts({ allowedTools: ["A"], permissionMode: "dontAsk" });
    const h = surfaceHash(base);
    expect(surfaceHash(opts({ ...base, systemPrompt: "different", model: "other" }))).toBe(h);
  });
});

describe("resumeFor", () => {
  const key = "direct-session:test:web:ui";

  it("no hash param → stored id returned (legacy behavior)", () => {
    const store = new Store(":memory:");
    store.kvSet(key, "sess-1");
    expect(resumeFor(store, key, undefined)).toBe("sess-1");
  });

  it("hash param + no stored hash → undefined (fail-closed fresh)", () => {
    const store = new Store(":memory:");
    store.kvSet(key, "sess-1");
    expect(resumeFor(store, key, "abc")).toBeUndefined();
  });

  it("hash param matches stored hash → stored id returned", () => {
    const store = new Store(":memory:");
    store.kvSet(key, "sess-1");
    store.kvSet(`surface:${key}`, "abc");
    expect(resumeFor(store, key, "abc")).toBe("sess-1");
  });

  it("hash param differs from stored hash → undefined", () => {
    const store = new Store(":memory:");
    store.kvSet(key, "sess-1");
    store.kvSet(`surface:${key}`, "abc");
    expect(resumeFor(store, key, "def")).toBeUndefined();
  });

  it("no stored session id → undefined regardless of hash", () => {
    const store = new Store(":memory:");
    expect(resumeFor(store, key, "abc")).toBeUndefined();
    expect(resumeFor(store, key, undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/session-surface.test.ts`
Expected: FAIL — `surfaceHash` / `resumeFor` not exported

- [ ] **Step 3: Implement in src/agents/resumable.ts**

Add imports at the top:

```ts
import { createHash } from "node:crypto";
```

Add below `LOCKDOWN_RE`:

```ts
/** Hash of the resolved tool surface — tools-only scope (spec 2026-07-19): a resumed
 *  session whose surface changed must NOT resume (it would keep the stale surface). */
export function surfaceHash(options: Options): string {
  const payload = JSON.stringify({
    tools: [...(options.allowedTools ?? [])].sort(),
    servers: Object.keys(options.mcpServers ?? {}).sort(),
    mode: options.permissionMode ?? null,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

const surfaceKey = (sessionKey: string) => `surface:${sessionKey}`;

/** Stored resume id, or undefined when it must not be used. With a hash param, an absent
 *  stored hash is a mismatch (fail-closed): pre-feature sessions reset once at first turn. */
export function resumeFor(store: Store, sessionKey: string, hash?: string): string | undefined {
  const id = store.kvGet(sessionKey);
  if (!id) return undefined;
  if (hash !== undefined && store.kvGet(surfaceKey(sessionKey)) !== hash) return undefined;
  return id;
}
```

Add `surfaceHash?: string;` to `ResumableTurnParams`:

```ts
  /** Resolved tool-surface hash — when provided, a stored-hash mismatch (or absence)
   *  starts a fresh session instead of resuming a stale surface. */
  surfaceHash?: string;
```

Replace the body of `resumableTurn`'s resume lookup (the first two lines) so it uses the gate:

```ts
export async function resumableTurn(params: ResumableTurnParams): Promise<string> {
  const stored = params.store.kvGet(params.sessionKey);
  const resume = resumeFor(params.store, params.sessionKey, params.surfaceHash);
  if (stored && !resume && params.surfaceHash !== undefined) {
    params.log?.(`tool surface changed for ${params.sessionKey} — starting fresh session`);
  }
  try {
    return await runOnce(params, resume);
  } catch (err) {
    if (err instanceof Error && LOCKDOWN_RE.test(err.message)) {
      params.log?.(`stale/locked session for ${params.sessionKey}, starting fresh`);
      params.store.kvSet(params.sessionKey, "");
      return await runOnce(params, undefined);
    }
    throw err;
  }
}
```

In `runOnce`, persist the hash beside the session id (inside the epoch-unchanged branch):

```ts
        if (params.store.kvGet(epochKey(params.sessionKey)) === epochAtStart) {
          params.store.kvSet(params.sessionKey, msg.session_id);
          if (params.surfaceHash !== undefined) {
            params.store.kvSet(`surface:${params.sessionKey}`, params.surfaceHash);
          }
        } else {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/session-surface.test.ts && npx tsc --noEmit`
Expected: PASS (8 tests) + clean tsc

- [ ] **Step 5: Commit**

```bash
git add src/agents/resumable.ts test/session-surface.test.ts
git commit -m "feat(sessions): surfaceHash + resume gate — stale tool surfaces stop resuming"
```

---

### Task 2: Seams pass the hash

**Files:**
- Modify: `src/agents/direct.ts` (the `resumableTurn` call, ~line 130)
- Modify: `src/moderator/session.ts` (the `resumableTurn` call at the end of `turn`)

**Interfaces:**
- Consumes: `surfaceHash(options)` and `ResumableTurnParams.surfaceHash` from Task 1.

- [ ] **Step 1: direct.ts — hash the final per-turn options**

Import: extend the existing resumable import (currently `resumableTurn`) —

```ts
import { resumableTurn, surfaceHash } from "./resumable.js";
```

(Check the actual current import line with `grep -n "resumable" src/agents/direct.ts` and extend it.)

Replace the `resumableTurn` call so the final options are built once, hashed, and passed:

```ts
      const finalOptions = {
        ...observed,
        mcpServers: { ...(observed.mcpServers ?? {}), ...mailServers, aios_attachments: attachmentServer },
      };
      const text = await resumableTurn({
        store: this.deps.store,
        sessionKey: key,
        prompt,
        log: this.deps.log,
        // Commit mail ONLY on a successful turn. An SDK error-reply (no throw) does NOT fire this,
        // so the mail re-surfaces next @mention — intended: re-deliver beats losing it (durability
        // favours the safe side; the ≤5-cap block just reappears until a turn succeeds).
        onSuccess: () => this.deps.mailbox?.markDelivered(deliveredIds),
        surfaceHash: surfaceHash(finalOptions),
        options: finalOptions,
      });
```

(The existing call spreads `observed` and merges mcpServers inline in the `options:` field — lift that object into `finalOptions` so the hash covers exactly what runs, including the attachment server and mail widenings.)

- [ ] **Step 2: session.ts — hash the final moderator options**

Import: extend the existing import —

```ts
import { resumableTurn, clearSession, surfaceHash } from "../agents/resumable.js";
```

Replace the tail of `turn`:

```ts
    const finalOptions = withDenialObserver(moderatorOptions, resolved.canonical, (e) => this.deps.bus.emit({ type: "tool.denied", ...e }));
    return resumableTurn({
      store,
      sessionKey: `moderator-session:${chatKey}`,
      prompt,
      log: this.deps.log,
      surfaceHash: surfaceHash(finalOptions),
      options: finalOptions,
    });
```

- [ ] **Step 3: Full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: ≥1323 pass (baseline 1315 + 8 new) + clean tsc

- [ ] **Step 4: Commit**

```bash
git add src/agents/direct.ts src/moderator/session.ts
git commit -m "feat(sessions): both resume seams pass the tool-surface hash"
```

---

### Task 3: Ship — build, deploy, live smoke

**Files:** none (operational)

- [ ] **Step 1: Build + deploy**

Run: `npm run build && launchctl kickstart -k gui/501/com.ihab.aios && sleep 6`

- [ ] **Step 2: Live smoke — one-time fresh + subsequent resume**

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
curl -s -m 240 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/chat -d '{"target":"","text":"Quick ping — one line back."}'
grep "tool surface changed" data/aios.log | tail -2
```
Expected: reply arrives; log shows `tool surface changed for moderator-session:web:ui — starting fresh session` (one-time reset).

```bash
curl -s -m 240 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/chat -d '{"target":"","text":"Second ping — do you remember the first?"}'
grep -c "tool surface changed for moderator-session:web:ui" data/aios.log
```
Expected: reply references the first ping (session resumed); the grep count did NOT increase.

```bash
python3 -c "
import sqlite3
db = sqlite3.connect('file:data/aios.sqlite?mode=ro', uri=True)
for k, in db.execute(\"select key from kv where key like 'surface:%'\").fetchall(): print(k)"
```
Expected: a `surface:moderator-session:web:ui` row exists.

- [ ] **Step 3: Push + memory update**

```bash
git fetch origin && git push origin main
```
Update `~/.claude/projects/-Users-ihabbishara-projects-AIOS/memory/aios-project.md` (newest-on-top).

---

## Self-Review Notes

- Spec §1 → Task 1; §2 → Task 2; error handling (total hash, LOCKDOWN_RE composition) embedded in Task 1's code; testing per spec §Testing (pure-fn + resumeFor with `Store(":memory:")`; resumableTurn itself untested per thin-seam convention). No gaps.
- The one-time fleet reset is observable in Task 3 Step 2's first log line — that IS the deploy-time behavior the user approved.
