# Media surfacing — design spec (①, web cockpit + goal/narrate)

Cycle ① follow-on to ⑤d (media generation). ⑤d made agents *produce* charts/diagrams/voice
(`src/media/server.ts`) and *deliver* them on telegram + the moderator seam. This cycle makes
that media reach the **web cockpit (ui2)** and re-opens the goal-completion / narrate() TEXT-lock
so pushed media lands too.

## Problem

Media attachments (`RouterResult.attachments`) already flow to the web chat route — and get
dropped. `src/web/server.ts:298` does `router.handle(...)?.text ?? null`, discarding the array.
Three surfaces are affected:

1. **Interactive web chat** — `/api/chat` returns `{ reply }` only. ui2 never sees agent-generated
   charts/diagrams/voice.
2. **Goal-completion** (`index.ts:289-299`) — deliberately TEXT-locked in ⑤d (`// attachments
   dropped here`). For telegram-origin goals this drops media; for **web-origin** goals the
   completion is *invisible in the cockpit today* regardless (see below).
3. **narrate() / briefs** (`src/heartbeat/briefs.ts`, `index.ts:603-611`) — TEXT-by-design.

Two facts de-risk the "all surfaces" scope:

- **The web already has a live push channel.** ui2's `useEvents` (`ui2/src/hooks.ts:6`) runs an
  `EventSource` on `/api/stream` (one-time-ticket auth, auto-reconnect, dedup). Goal-completion
  **already emits a `chat.out` event** (`index.ts:298`) that streams to the browser live. ui2's
  Chat component simply never renders pushed events as messages — it only mines `route.decision`
  for a trail. So web-push media is *rendering an event that already arrives*, not new plumbing.
- **Telegram already dispatches attachments** via the `onMessage` loop (`index.ts:414-423`:
  `kind === "voice" ? sendVoice : sendFile`). Telegram-origin goal media reuses that pattern.

## Decision

Serve attachment files through a new **authed GET route with capability-token auth**, and render
media on all three surfaces:

- **Transport:** `GET /api/attachment/:token`. An in-memory registry maps an unguessable random
  token → a pre-validated absolute file path. The token *is* the capability (an `<img src>` cannot
  send a bearer header, so the token in the URL carries auth — same shape as the SSE stream-ticket).
  The route never accepts a caller-supplied path, only a token it minted, so path traversal is
  structurally impossible.
- **Interactive chat:** `/api/chat` registers each attachment and returns
  `{ reply, attachments: [{token, name, mime, caption, kind?}] }`; ui2 renders inline.
- **Goal/narrate (drop the TEXT-lock):** telegram-origin → existing sendVoice/sendFile loop;
  web-origin → register attachments and extend the **existing** `chat.out` event with optional
  `attachmentTokens` (no new bus type — honors the "no new bus event types without triage
  defaultVerdict" rule). ui2 Chat renders pushed `chat.out` events (filtered to `web`/`ui`).

Rejected: **base64 inline in JSON.** Simpler for the request/response chat path, but the pushed
goal-completion case has no HTTP response to inline into — it rides an SSE event — so the route is
needed regardless. One transport for all three surfaces beats two. (User-selected.)

## Components

### 1. Attachment registry + serving route (`src/web/server.ts`)

In-memory `Map<token, { path: string; mime: string; name: string; expires: number }>`.

- `register(path): string` — resolve `path` with `realpathSync`; **reject** unless it resolves
  under `AIOS_TMP_PREFIX` or the vault root (reuse the `isSafe` realpath rule from
  `src/agents/attachment-server.ts`). Derive `mime` from extension: `.png`→`image/png`,
  `.ogg`→`audio/ogg`, `.svg`→`image/svg+xml`, else `application/octet-stream`. `name` =
  `basename(path)`. `token` = `randomUUID()` (or 32 hex). `expires` = now + TTL (1h). Returns token.
- `GET /api/attachment/:token` — look up token; 404 if absent or `expires < now`. Stream the file
  with `Content-Type: mime`, `Content-Disposition: inline; filename="name"`. No auth header needed
  (token is the capability); still behind the same server (localhost/bearer-gated origin).
- Lazy sweep: on each `register`, drop entries with `expires < now`. Bounds memory without a timer.

Ceiling (ponytail): capability tokens in URLs can leak via referrer/proxy logs. Acceptable for a
single-user localhost cockpit; documented, not defended. Upgrade path if it ever matters: swap the
opaque token for a short-TTL HMAC-signed URL.

### 2. Interactive web chat (`src/web/server.ts` `/api/chat`, `ui2/src/api.ts`, `ui2/src/components/Chat.tsx`)

- Route: `const r = await router.handle(...)`. Register each `r.attachments` entry → token. Return
  `{ reply: r?.text ?? null, attachments: (r?.attachments ?? []).map(a => ({ token, name, mime,
  caption: a.caption, kind: a.kind })) }`. Absent/failed → `attachments: []`.
- `api.ts`: `api.chat` return type gains `attachments: WebAttachment[]`; export the type.
- `Chat.tsx`: `Msg` gains `attachments?: WebAttachment[]`. Render per attachment:
  - `mime` starts `image/` → `<img src={/api/attachment/${token}} alt={caption} />` (max-width bounded).
  - `kind === "voice"` or `mime` starts `audio/` → reuse the existing ▶ replay button, sourced from
    the route URL instead of a base64 data URI.
  - otherwise → download `<a href={...} download={name}>{name}</a>`.
  - `caption` rendered under the media when present.
- localStorage persist (`Chat.tsx:36`) already strips `audio`; strip `attachments` the same way so
  tokens (which expire) aren't resurrected stale on reload.

### 3. Goal-completion / narrate media (`src/index.ts`, `src/heartbeat/briefs.ts`)

- **Telegram-origin goal-completion** (`onGoalComplete`, `index.ts:289-299`): after
  `moderator.handle(...)` returns `{ text, attachments }`, send the text (as today), then dispatch
  `attachments` via the same `kind === "voice" ? ch.sendVoice : ch.sendFile` loop used in
  `onMessage`. Extract that loop into a small local helper `dispatchAttachments(ch, chatId, atts)`
  reused by both call sites (removes the duplication rather than copy-pasting).
- **Web-origin goal-completion**: `channels.get("web")` is `undefined` (web is not a
  `ChannelAdapter`), so the `send`/dispatch is a no-op. Instead: register each attachment → token,
  and emit the completion via the extended `chat.out` event carrying `attachmentTokens: string[]`
  (see §4). This also fixes the pre-existing gap where web-origin goal completions never appeared
  in the cockpit at all.
- **narrate()/briefs**: briefs deliver to `config.primaryChat` (telegram) via `sendVia`. If a brief
  ever carries attachments, they dispatch through the same telegram helper. No web-brief path today,
  so no web work here — narrate stays text on web (out of scope, no surface).

### 4. `chat.out` event extension + ui2 rendering (`src/kernel/bus` type, `ui2/src/components/Chat.tsx`)

- Extend the `chat.out` event payload with optional `attachmentTokens?: string[]`. No new event
  type. (Triage/defaultVerdict rules apply to *new types*; extending an existing one is exempt.)
- `Chat.tsx`: derive inbound pushed messages from `events` where `event.type === "chat.out"` and
  `event.channel === "web"` and `event.chatId === "ui"`, rendered as `who = <agent/coordinator>`
  bubbles with any `attachmentTokens` shown as media (image/audio/download, same switch as §2).
  Dedup: interactive replies return over HTTP and do **not** emit `chat.out` (only goal-completion
  and planner-preview push it), so pushed bubbles don't double the locally-echoed send. Merge pushed
  `chat.out` bubbles into the log by event `id` to avoid re-adding on re-render.

## Untouched

- Agent tool surface — no new tools, no capability change → **no golden regen**, no session
  surfaceHash impact.
- No new npm deps. No new bus event *type*. `src/media/server.ts` unchanged.
- Moderator seam (`src/moderator/session.ts`) unchanged — it already returns `{text, attachments}`.
- Telegram inbound/download paths unchanged.
- Briefs/narrate web delivery — no web-brief surface exists; left as-is.

## Error handling

- `register` on an unsafe/nonexistent path → throws; the caller (chat route / goal-complete) logs
  and delivers text-only (media best-effort, never blocks the reply). Matches ⑤d's
  attachment-failure posture.
- `GET /api/attachment/:token` unknown/expired token → 404. Missing file on disk at fetch time →
  404 (file may have been reaped after TTL). ui2 `<img>`/audio failure → silent (no broken-image
  UX beyond the browser default; caption still shows).
- SSE reconnect already replays recent events; a pushed `chat.out` with an expired token after a
  long disconnect renders text + a dead media link — acceptable, bounded by TTL.

## Testing

Root `test/` (vitest), registry + route wiring carry tests; ui2 render is thin/untested per
convention.

- Registry: `register` returns distinct tokens; mime derived per extension; path outside
  `AIOS_TMP_PREFIX`/vault rejected; expired entry 404s; lazy sweep drops expired.
- Path safety: a traversal-y or symlinked path resolving outside the safe roots is rejected at
  register time (never reaches the route).
- `/api/chat` response shape: attachments mapped to `{token,name,mime,caption,kind}`; empty when
  the result has none; text-only still works.
- `dispatchAttachments` helper: voice→sendVoice, other→sendFile, failure logged not thrown.
- Manual/live smoke (post-build, per house practice): ask an agent for a chart in the web cockpit →
  see it inline; run a web-origin goal that emits media → see the pushed completion bubble with the
  chart; telegram goal media still delivers (regression check).
