# Media Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface agent-generated media (charts, diagrams, voice) in the web cockpit and through goal-completion, served by an authed capability-token route.

**Architecture:** A new in-memory attachment registry mints unguessable tokens for pre-validated file paths; `GET /api/attachment/:token` streams them. `/api/chat` returns attachment descriptors; ui2 renders them inline. Goal-completion drops its TEXT-lock: telegram-origin dispatches via the existing sendVoice/sendFile loop (extracted to a shared helper), web-origin registers attachments onto the existing `chat.out` SSE event, which ui2 Chat now renders as pushed bubbles.

**Tech Stack:** TypeScript (Node, `node:http`), vitest, React (ui2).

## Global Constraints

- No new npm deps. System binaries only.
- No new bus event *types* — extend the existing `chat.out` event.
- No agent tool-surface change → no golden regen, no session surfaceHash impact.
- Subscription auth only; never `ANTHROPIC_API_KEY`.
- Route wiring in `src/web/server.ts` stays thin + untested; the registry (builder/validator) carries the tests.
- Safe file roots for registration mirror the moderator attachment server: `[resolve(projectsRoot), resolve(dataDir,"downloads"), AIOS_TMP_PREFIX]`.
- TDD: failing test → run red → minimal impl → run green → commit.
- Commit messages end with the Co-Authored-By + Claude-Session trailers used in this repo.

---

## File Structure

- **Create** `src/web/attachment-registry.ts` — token↔path registry, mime derivation, safe-path validation, TTL. Pure logic, unit-tested.
- **Create** `test/attachment-registry.test.ts` — registry tests.
- **Create** `src/channels/dispatch.ts` — `dispatchAttachments(ch, chatId, atts, log)` helper. Unit-tested with a fake channel.
- **Create** `test/dispatch.test.ts` — dispatch tests.
- **Modify** `src/events.ts` — extend `chat.out` with optional `attachments` descriptors.
- **Modify** `src/web/server.ts` — add registry to `WebDeps`, `/api/attachment/:token` route, `/api/chat` attachment wiring.
- **Modify** `src/index.ts` — construct registry, share into `WebDeps`, rewire `onMessage` to the helper, add goal-completion media (telegram dispatch + web register + `chat.out` descriptors).
- **Modify** `ui2/src/api.ts` — `WebAttachment` type + `api.chat` return shape.
- **Modify** `ui2/src/components/Chat.tsx` — render interactive attachments + pushed `chat.out` bubbles.

---

## Task 1: Attachment registry

**Files:**
- Create: `src/web/attachment-registry.ts`
- Test: `test/attachment-registry.test.ts`

**Interfaces:**
- Consumes: `isSafe` (unexported in `attachment-server.ts`) — re-implement the same realpath check locally to avoid widening that module's exports; `AIOS_TMP_PREFIX` from `src/agents/attachment-server.js`.
- Produces:
  - `interface AttachmentDescriptor { token: string; name: string; mime: string; caption?: string; kind?: "voice" }`
  - `interface AttachmentRegistry { register(path: string, meta?: { caption?: string; kind?: "voice" }): AttachmentDescriptor; get(token: string): { path: string; mime: string; name: string } | undefined }`
  - `function createAttachmentRegistry(safeDirs: string[], opts?: { ttlMs?: number; now?: () => number; genToken?: () => string }): AttachmentRegistry`
  - `function mimeFor(name: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
// test/attachment-registry.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttachmentRegistry, mimeFor } from "../src/web/attachment-registry.js";

const safeRoot = realpathSync(mkdtempSync(join(tmpdir(), "aios-reg-")));
function file(name: string): string {
  const p = join(safeRoot, name);
  writeFileSync(p, "x");
  return p;
}

describe("mimeFor", () => {
  it("maps known extensions and defaults to octet-stream", () => {
    expect(mimeFor("chart.png")).toBe("image/png");
    expect(mimeFor("voice.ogg")).toBe("audio/ogg");
    expect(mimeFor("d.svg")).toBe("image/svg+xml");
    expect(mimeFor("x.bin")).toBe("application/octet-stream");
  });
});

describe("attachment registry", () => {
  it("registers a safe path and returns a descriptor resolvable by token", () => {
    const reg = createAttachmentRegistry([safeRoot]);
    const d = reg.register(file("chart.png"), { caption: "hi" });
    expect(d.token).toMatch(/.{16,}/);
    expect(d.name).toBe("chart.png");
    expect(d.mime).toBe("image/png");
    expect(d.caption).toBe("hi");
    const got = reg.get(d.token);
    expect(got?.mime).toBe("image/png");
    expect(got?.name).toBe("chart.png");
  });

  it("carries kind through and mints distinct tokens", () => {
    const reg = createAttachmentRegistry([safeRoot]);
    const a = reg.register(file("a.ogg"), { kind: "voice" });
    const b = reg.register(file("b.png"));
    expect(a.kind).toBe("voice");
    expect(a.token).not.toBe(b.token);
  });

  it("rejects a path outside the safe roots", () => {
    const reg = createAttachmentRegistry([safeRoot]);
    expect(() => reg.register("/etc/hosts")).toThrow();
  });

  it("returns undefined for unknown or expired tokens and sweeps on register", () => {
    let t = 1000;
    const reg = createAttachmentRegistry([safeRoot], { ttlMs: 100, now: () => t });
    const d = reg.register(file("c.png"));
    expect(reg.get(d.token)).toBeDefined();
    t = 1201; // past ttl
    expect(reg.get(d.token)).toBeUndefined();       // expired -> undefined
    reg.register(file("d.png"));                     // triggers sweep of expired entry
    expect(reg.get("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/attachment-registry.test.ts`
Expected: FAIL — cannot find module `../src/web/attachment-registry.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/web/attachment-registry.ts
import { realpathSync } from "node:fs";
import { basename, extname } from "node:path";
import { randomUUID } from "node:crypto";

export interface AttachmentDescriptor {
  token: string;
  name: string;
  mime: string;
  caption?: string;
  kind?: "voice";
}

export interface AttachmentRegistry {
  register(path: string, meta?: { caption?: string; kind?: "voice" }): AttachmentDescriptor;
  get(token: string): { path: string; mime: string; name: string } | undefined;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
};

export function mimeFor(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** Realpath a candidate and require it to sit under one of the safe roots. */
function isSafe(path: string, safeDirs: string[]): boolean {
  try {
    const real = realpathSync(path);
    return safeDirs.some((d) => real === d || real.startsWith(d.endsWith("/") ? d : d + "/") || real.startsWith(d));
  } catch {
    return false;
  }
}

interface Entry { path: string; mime: string; name: string; expires: number }

export function createAttachmentRegistry(
  safeDirs: string[],
  opts: { ttlMs?: number; now?: () => number; genToken?: () => string } = {},
): AttachmentRegistry {
  const ttl = opts.ttlMs ?? 60 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());
  const gen = opts.genToken ?? (() => randomUUID());
  const map = new Map<string, Entry>();

  const sweep = () => {
    const t = now();
    for (const [k, v] of map) if (v.expires < t) map.delete(k);
  };

  return {
    register(path, meta = {}) {
      if (!isSafe(path, safeDirs)) throw new Error(`refused: path outside safe roots: ${path}`);
      sweep();
      const name = basename(path);
      const mime = mimeFor(name);
      const token = gen();
      map.set(token, { path, mime, name, expires: now() + ttl });
      return { token, name, mime, caption: meta.caption, kind: meta.kind };
    },
    get(token) {
      const e = map.get(token);
      if (!e) return undefined;
      if (e.expires < now()) { map.delete(token); return undefined; }
      return { path: e.path, mime: e.mime, name: e.name };
    },
  };
}
```

Note: the `AIOS_TMP_PREFIX` realpath prefix is passed in by the caller as one of `safeDirs` (Task 4) — the registry stays pure and does not import it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/attachment-registry.test.ts`
Expected: PASS (7 assertions across 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/attachment-registry.ts test/attachment-registry.test.ts
git commit -m "feat(web): attachment registry — capability tokens for served media

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Jbb7hWYN78tUtQAEvQ7LDL"
```

---

## Task 2: Serving route + `/api/chat` attachment wiring

**Files:**
- Modify: `src/web/server.ts` (WebDeps + two route sites)

**Interfaces:**
- Consumes: `AttachmentRegistry`, `AttachmentDescriptor` from Task 1; `RouterResult.attachments` (`{ path, caption?, kind? }[]`).
- Produces: `WebDeps.attachments: AttachmentRegistry`; `/api/attachment/:token` route; `/api/chat` response `{ reply, attachments: AttachmentDescriptor[] }`.

This task is route wiring — untested per house rule. Verify with `tsc` + a live curl smoke in Task 6. No new vitest file.

- [ ] **Step 1: Add the registry to `WebDeps`**

In `src/web/server.ts`, add the import and field:

```typescript
import type { AttachmentRegistry, AttachmentDescriptor } from "./attachment-registry.js";
```

In `interface WebDeps { ... }` add:

```typescript
  /** Serves agent-generated media (charts/diagrams/voice) to the browser by capability token. */
  attachments: AttachmentRegistry;
```

- [ ] **Step 2: Wire `/api/chat` to return descriptors**

Replace the chat block (currently `src/web/server.ts:294-300`):

```typescript
        if (path === "/api/chat" && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { target: string; text: string };
          if (!body.text?.trim()) return json(res, 400, { error: "text required" });
          const text = body.target && !toCoordinator(registry, body.target) ? `@${body.target} ${body.text}` : body.text;
          const result = await router.handle({ channel: "web", chatId: "ui", text, sender: { name: "UI" } });
          const attachments: AttachmentDescriptor[] = [];
          for (const a of result?.attachments ?? []) {
            try { attachments.push(deps.attachments.register(a.path, { caption: a.caption, kind: a.kind })); }
            catch (err) { log(`attachment register failed (${a.path}): ${(err as Error).message}`); }
          }
          return json(res, 200, { reply: result?.text ?? null, attachments });
        }
```

(`registry` here is the existing agents registry used by `toCoordinator`; the attachment registry is `deps.attachments`. `log` is the existing server logger.)

- [ ] **Step 3: Add the serving route**

Add near the other GET routes (e.g. after the `/api/events` block ~line 210). `createReadStream` + `statSync` are from `node:fs` — add to the existing import if absent:

```typescript
        if (path.startsWith("/api/attachment/") && req.method === "GET") {
          const token = decodeURIComponent(path.slice("/api/attachment/".length));
          const hit = deps.attachments.get(token);
          if (!hit) return json(res, 404, { error: "not found" });
          try {
            const size = statSync(hit.path).size;
            res.writeHead(200, {
              "Content-Type": hit.mime,
              "Content-Length": String(size),
              "Content-Disposition": `inline; filename="${hit.name.replace(/"/g, "")}"`,
              "Cache-Control": "private, max-age=3600",
            });
            createReadStream(hit.path).pipe(res);
          } catch {
            return json(res, 404, { error: "not found" });
          }
          return;
        }
```

Note: this route is intentionally **not** behind the bearer check — the unguessable token is the capability, exactly like `/api/stream?ticket=`. Confirm it sits inside the same server handler but is reached before/independent of any bearer gate. If the handler has an early bearer guard that would block it, add `path.startsWith("/api/attachment/")` to that guard's allowlist (same list that exempts `/api/stream`).

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: passes once Task 4 supplies `deps.attachments` at the call site. Until then, expect one error at the `startWebServer(...)` call in `index.ts` (missing `attachments`) — that is closed in Task 4. Run tsc again after Task 4.

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts
git commit -m "feat(web): /api/attachment token route + chat returns descriptors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Jbb7hWYN78tUtQAEvQ7LDL"
```

---

## Task 3: `dispatchAttachments` helper + rewire `onMessage`

**Files:**
- Create: `src/channels/dispatch.ts`
- Test: `test/dispatch.test.ts`
- Modify: `src/index.ts:414-423` (replace inline loop with the helper)

**Interfaces:**
- Consumes: `ChannelAdapter` (`src/channels/types.js`), `Attachment` (`src/agents/attachment.js`).
- Produces: `async function dispatchAttachments(ch: ChannelAdapter | undefined, chatId: string, atts: Attachment[], log?: (s: string) => void): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/dispatch.test.ts
import { describe, it, expect, vi } from "vitest";
import { dispatchAttachments } from "../src/channels/dispatch.js";
import type { ChannelAdapter } from "../src/channels/types.js";

function fakeChannel() {
  return {
    name: "fake",
    start: vi.fn(), send: vi.fn(), stop: vi.fn(),
    sendFile: vi.fn(async () => {}),
    sendVoice: vi.fn(async () => {}),
  } as unknown as ChannelAdapter & { sendFile: ReturnType<typeof vi.fn>; sendVoice: ReturnType<typeof vi.fn> };
}

describe("dispatchAttachments", () => {
  it("routes voice to sendVoice and other files to sendFile", async () => {
    const ch = fakeChannel();
    await dispatchAttachments(ch, "42", [
      { path: "/tmp/aios-x/a.ogg", kind: "voice", caption: "hi" },
      { path: "/tmp/aios-x/b.png", caption: "chart" },
    ]);
    expect(ch.sendVoice).toHaveBeenCalledWith("42", "/tmp/aios-x/a.ogg", "hi");
    expect(ch.sendFile).toHaveBeenCalledWith("42", "/tmp/aios-x/b.png", "chart");
  });

  it("falls back to sendFile when the channel has no sendVoice", async () => {
    const ch = fakeChannel();
    (ch as unknown as { sendVoice?: unknown }).sendVoice = undefined;
    await dispatchAttachments(ch, "1", [{ path: "/tmp/aios-x/v.ogg", kind: "voice" }]);
    expect(ch.sendFile).toHaveBeenCalledWith("1", "/tmp/aios-x/v.ogg", undefined);
  });

  it("logs and swallows a delivery error instead of throwing", async () => {
    const ch = fakeChannel();
    ch.sendFile = vi.fn(async () => { throw new Error("boom"); });
    const log = vi.fn();
    await expect(dispatchAttachments(ch, "1", [{ path: "/tmp/aios-x/b.png" }], log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("no-ops on an undefined channel", async () => {
    await expect(dispatchAttachments(undefined, "1", [{ path: "/tmp/aios-x/b.png" }])).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dispatch.test.ts`
Expected: FAIL — cannot find module `../src/channels/dispatch.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/channels/dispatch.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/dispatch.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Rewire `onMessage` to use the helper**

In `src/index.ts`, add the import near the other channel imports:

```typescript
import { dispatchAttachments } from "./channels/dispatch.js";
```

Replace the inline loop (`src/index.ts:414-423`) inside `onMessage`:

```typescript
      const result = await router.handle(msg);
      if (result !== null) {
        await deliverReply({ voice, log }, channels.get(msg.channel), msg, result.text);
        await dispatchAttachments(channels.get(msg.channel), msg.chatId, result.attachments, log);
      }
```

- [ ] **Step 6: Verify the suite still passes**

Run: `npx vitest run test/dispatch.test.ts && npx tsc --noEmit`
Expected: dispatch tests PASS; tsc still shows only the pending `startWebServer` `attachments` gap (closed in Task 4).

- [ ] **Step 7: Commit**

```bash
git add src/channels/dispatch.ts test/dispatch.test.ts src/index.ts
git commit -m "refactor(channels): extract dispatchAttachments, reuse in onMessage

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Jbb7hWYN78tUtQAEvQ7LDL"
```

---

## Task 4: `chat.out` extension + goal-completion media + registry wiring

**Files:**
- Modify: `src/events.ts:8` (extend `chat.out`)
- Modify: `src/index.ts` (construct registry ~line 280; use in `onGoalComplete` ~289-299; pass into `startWebServer` ~804)

**Interfaces:**
- Consumes: `createAttachmentRegistry` (Task 1), `dispatchAttachments` (Task 3), `AIOS_TMP_PREFIX` from `src/agents/attachment-server.js`, `config.projectsRoot` / `config.dataDir`.
- Produces: `chat.out` event carries optional `attachments?: Array<{ token: string; name: string; mime: string; caption?: string; kind?: "voice" }>`; `deps.attachments` supplied to the web server.

- [ ] **Step 1: Extend the `chat.out` event type**

In `src/events.ts`, change line 8 from:

```typescript
  | { type: "chat.out"; channel: string; chatId: string; text: string }
```

to:

```typescript
  | { type: "chat.out"; channel: string; chatId: string; text: string; attachments?: Array<{ token: string; name: string; mime: string; caption?: string; kind?: "voice" }> }
```

- [ ] **Step 2: Construct the registry and share it**

In `src/index.ts`, add imports near the top:

```typescript
import { createAttachmentRegistry } from "./web/attachment-registry.js";
import { AIOS_TMP_PREFIX } from "./agents/attachment-server.js";
import { resolve } from "node:path";
```

Before `onGoalComplete` is defined (i.e. above `src/index.ts:289`), construct the registry with the same safe roots the moderator uses:

```typescript
  const attachmentRegistry = createAttachmentRegistry([
    resolve(config.projectsRoot),
    resolve(config.dataDir, "downloads"),
    AIOS_TMP_PREFIX,
  ]);
```

- [ ] **Step 3: Deliver media on goal-completion**

Replace `onGoalComplete` body (`src/index.ts:289-299`):

```typescript
  const onGoalComplete = async (outcome: GoalOutcome): Promise<void> => {
    const { goal } = outcome;
    const channel = channels.get(goal.origin_channel);
    const notice = outcome.ok
      ? `[GOAL-COMPLETE] Goal "${goal.title}" (${goal.id}) finished. Artifacts in vault under goals/${outcome.goalDirName}/: ${outcome.artifactFiles.join(", ")}. Read the key artifacts with vault_read and report the outcome to the user.`
      : `[GOAL-FAILED] Goal "${goal.title}" (${goal.id}) failed: ${outcome.error}. Partial artifacts under goals/${outcome.goalDirName}/. Tell the user what happened and suggest next steps.`;
    const { text: report, attachments } = await moderator.handle(goal.origin_channel, goal.origin_chat_id, notice);
    await channel?.send(goal.origin_chat_id, report);
    // Telegram (and any real push channel) gets media via sendVoice/sendFile; web has no
    // ChannelAdapter, so its media rides the chat.out event as descriptors (below).
    if (channel) await dispatchAttachments(channel, goal.origin_chat_id, attachments, log);
    const descriptors = channel
      ? []
      : attachments.flatMap((a) => {
          try { return [attachmentRegistry.register(a.path, { caption: a.caption, kind: a.kind })]; }
          catch (err) { log(`goal media register failed (${a.path}): ${(err as Error).message}`); return []; }
        });
    bus.emit({
      type: "chat.out",
      channel: goal.origin_channel,
      chatId: goal.origin_chat_id,
      text: report.slice(0, 300),
      ...(descriptors.length ? { attachments: descriptors } : {}),
    });
  };
```

- [ ] **Step 4: Pass the registry into the web server**

In `src/index.ts:804-807`, add `attachments: attachmentRegistry` to the `WebDeps` object literal:

```typescript
  startWebServer(
    { store, bus, goals, spendGuard, vault, config, router, gate, voice, registry, mailbox, senses: sensesStatus, reloadPacks: reloadRegistry, envPath: config.envPath, uiDist: config.uiDist, log, attachments: attachmentRegistry },
    config.uiPort,
  );
```

- [ ] **Step 5: Verify the full suite + types**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass (check the "Tests" summary line — do not trust a piped exit code); tsc clean (the `startWebServer` gap from Tasks 2–3 is now closed).

- [ ] **Step 6: Commit**

```bash
git add src/events.ts src/index.ts
git commit -m "feat(sessions): goal-completion media — telegram dispatch + web chat.out descriptors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Jbb7hWYN78tUtQAEvQ7LDL"
```

---

## Task 5: ui2 rendering — interactive attachments + pushed bubbles

**Files:**
- Modify: `ui2/src/api.ts` (type + `api.chat` shape)
- Modify: `ui2/src/components/Chat.tsx`

ui2 render is thin/untested per house rule — verified via `tsc` (ui2 root) + live smoke in Task 6.

**Interfaces:**
- Consumes: `/api/chat` returns `{ reply, attachments }`; `chat.out` events carry `attachments`.
- Produces: `WebAttachment` type; a `<MediaBlock>` renderer.

- [ ] **Step 1: Type the attachment + chat response in `api.ts`**

Add the exported type (near the other exported types) and update `api.chat`:

```typescript
export interface WebAttachment { token: string; name: string; mime: string; caption?: string; kind?: "voice" }
```

Change `api.chat` (`ui2/src/api.ts:86-87`) return type:

```typescript
  chat: (target: string, text: string) =>
    request<{ reply: string | null; attachments: WebAttachment[] }>("/api/chat", { method: "POST", body: JSON.stringify({ target, text }) }),
```

Add `WebAttachment` to the `export type { ... }` block at the top so `Chat.tsx` can import it.

- [ ] **Step 2: Render attachments + pushed bubbles in `Chat.tsx`**

Extend the `Msg` interface (`ui2/src/components/Chat.tsx:6`):

```typescript
interface Msg { who: "you" | string; text: string; pending?: boolean; pendingId?: string; audio?: string; attachments?: WebAttachment[]; srcEventId?: number }
```

Import the type (extend the existing api import on line 3):

```typescript
import { api, type StateInfo, type StoredEvent, type WebAttachment } from "../api.js";
```

Store attachments from the interactive reply — update the `send` success mapping (`Chat.tsx:58-59`):

```typescript
      const { reply, attachments } = await api.chat(target, text);
      setLog((l) => l.map((m) => (m.pendingId === pid ? { who: target, text: reply ?? "(no reply)", attachments } : m)));
```

Strip attachments before persisting (they hold expiring tokens) — update the persist map (`Chat.tsx:36`):

```typescript
    localStorage.setItem(LOG_KEY, JSON.stringify(log.filter((m) => !m.pending).slice(-200).map(({ audio, attachments, ...m }) => m)));
```

Fold pushed `chat.out` (web/ui) events into the log — add this effect after the `seed` effect (~`Chat.tsx:31`):

```typescript
  // Server-pushed cockpit messages (goal completions, planner previews) arrive over SSE as
  // chat.out events; interactive replies return over HTTP and never emit chat.out, so no double.
  useEffect(() => {
    const pushes = events.filter(
      (e) => e.event.type === "chat.out" && (e.event as { channel: string }).channel === "web" && (e.event as { chatId: string }).chatId === "ui",
    );
    if (!pushes.length) return;
    setLog((prev) => {
      const seen = new Set(prev.map((m) => m.srcEventId).filter((x): x is number => x != null));
      const add: Msg[] = pushes
        .filter((e) => !seen.has(e.id))
        .map((e) => {
          const ev = e.event as unknown as { text: string; attachments?: WebAttachment[] };
          return { who: target, text: ev.text, srcEventId: e.id, attachments: ev.attachments };
        });
      return add.length ? [...prev, ...add] : prev;
    });
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps
```

Add the media renderer component (top-level in the file, above `export function Chat`):

```typescript
function MediaBlock({ a }: { a: WebAttachment }) {
  const src = `/api/attachment/${encodeURIComponent(a.token)}`;
  const el =
    a.kind === "voice" || a.mime.startsWith("audio/") ? (
      <button
        onClick={() => new Audio(src).play().catch(() => {})}
        className="border border-line rounded text-dim hover:text-fg text-[11px] px-2 py-1 leading-none transition-colors"
      >
        ▶ {a.name}
      </button>
    ) : a.mime.startsWith("image/") ? (
      <img src={src} alt={a.caption ?? a.name} className="rounded-lg border border-line max-w-full max-h-[420px]" />
    ) : (
      <a href={src} download={a.name} className="text-accent underline text-[12px]">
        ⬇ {a.name}
      </a>
    );
  return (
    <div className="mt-2 flex flex-col gap-1">
      {el}
      {a.caption && <div className="text-dim text-[11px]">{a.caption}</div>}
    </div>
  );
}
```

Render attachments inside the message bubble — after the `{m.text}` line (`Chat.tsx:145`), still inside the bubble `<div>`:

```typescript
              {m.text}
              {m.attachments?.map((a, j) => <MediaBlock key={j} a={a} />)}
```

- [ ] **Step 3: Verify ui2 types compile**

Run: `cd ui2 && npx tsc --noEmit && cd ..`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui2/src/api.ts ui2/src/components/Chat.tsx
git commit -m "feat(ui2): render inline media in chat + pushed chat.out bubbles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Jbb7hWYN78tUtQAEvQ7LDL"
```

---

## Task 6: Build, deploy, live smoke

**Files:** none (verification only).

- [ ] **Step 1: Full build (root + ui2) and deploy**

```bash
npm run build && launchctl kickstart -k gui/501/com.ihab.aios && sleep 6
```

Expected: build succeeds; daemon restarts.

- [ ] **Step 2: Serving route sanity (token lifecycle)**

Ask an agent in the web cockpit (or via the chat API) for a chart, then confirm the response carries an attachment and the route serves it:

```bash
TOKEN=$(grep -o "AIOS_UI_TOKEN=.*" .env | cut -d= -f2)
RESP=$(curl -s -m 240 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4280/api/chat -d '{"target":"hermes","text":"Render a bar chart of sales: Jan 10, Feb 20, Mar 15. Deliver it."}')
echo "$RESP" | head -c 600
ATT=$(echo "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.attachments?.[0]?.token??"")})')
test -n "$ATT" && curl -s -o /tmp/aios-smoke.png -w "served: %{http_code} %{content_type} %{size_download}b\n" "http://localhost:4280/api/attachment/$ATT"
file /tmp/aios-smoke.png
```

Expected: response `attachments[0]` present; route returns `200 image/png` with a non-zero size; `file` reports a PNG.

- [ ] **Step 3: 404 on a bogus/expired token**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:4280/api/attachment/deadbeef-nope"
```

Expected: `404`.

- [ ] **Step 4: Visual confirmation in ui2**

Open the cockpit, send the chart prompt to hermes, confirm the chart renders inline in the chat bubble. If voice is enabled, ask `@hermes speak: "media surfacing is live"` and confirm the ▶ button plays.

- [ ] **Step 5: Telegram regression**

Confirm a telegram chart request still delivers the image (existing path, now via the extracted helper) — send the same chart prompt from the primary telegram chat and confirm the photo/file arrives.

- [ ] **Step 6: Web-origin goal media (pushed bubble)**

Start a small goal from the web cockpit whose completion emits media (e.g. a research/chart goal). When it finishes, confirm a pushed completion bubble appears in the web chat with its media rendered (SSE-delivered `chat.out` descriptors).

- [ ] **Step 7: Final state**

```bash
npx vitest run 2>&1 | grep -E "Tests|Test Files"   # confirm the Tests line, not a piped exit code
npx tsc --noEmit && (cd ui2 && npx tsc --noEmit)
git log --oneline -7
```

Expected: suite green (count grew by the new registry + dispatch tests), tsc clean both roots. Then push per house practice: `git push origin main`.

---

## Self-Review

**Spec coverage:**
- Registry + capability-token route (spec §1) → Task 1 + Task 2 ✅
- Interactive web chat media (spec §2) → Task 2 (route) + Task 5 (ui2) ✅
- Goal-completion media, telegram + web (spec §3) → Task 3 (helper) + Task 4 ✅
- `chat.out` extension + ui2 pushed rendering (spec §4) → Task 4 (event) + Task 5 (render) ✅
- narrate/briefs (spec §3) → no web-brief surface; telegram briefs use the same helper path — no task needed, documented ✅
- Testing (spec §Testing) → Task 1 (registry: token/mime/path/expiry/sweep), Task 3 (dispatch), Task 6 (live smoke) ✅
- Untouched (spec §Untouched): no golden regen, no deps, no new bus type, media server untouched — honored across all tasks ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✅

**Type consistency:** `AttachmentDescriptor {token,name,mime,caption?,kind?}` is identical in Task 1 (registry), Task 2 (`/api/chat`), Task 4 (`chat.out` inline shape), and Task 5 (`WebAttachment` — same fields). `dispatchAttachments(ch, chatId, atts, log?)` signature matches between Task 3 definition and Task 4 call site. `deps.attachments` typed in Task 2, supplied in Task 4. ✅

**Spec drift note:** spec §4 originally said `attachmentTokens?: string[]`; the plan uses full `attachments?` descriptors on `chat.out` so ui2 can pick img/audio/download without extra fetches. Same decision (no new bus type), richer field. Spec §4 wording updated to match.
