# Session surface refresh — design spec

Date: 2026-07-19
Status: approved

## Problem

Resumed SDK sessions (moderator + direct chats) latch the tool surface they were created with.
Capability and seam changes never reach existing sessions: observed live twice on 2026-07-18/19 —
odin's sessions kept a pre-ToolSearch surface (WebFetch dead behind a denied schema load), and
hermes' probe session kept a pre-attach_file surface. Each required manual kv deletes, and the
rest of the fleet (e.g. hermes' telegram session) is still stale. Every future capability cycle
hits this again.

## Decision

Hash the resolved tool surface and invalidate the stored session when it changes. Tools-only
scope (user-locked): persona/prompt latching is out of scope — prompts embed dynamic memo blocks
that re-render nightly, and hashing them would reset hermes' continuity daily.

## Components

### 1. surfaceHash + resume gate (src/agents/resumable.ts)

- `surfaceHash(options: Options): string` — sha256 (node:crypto), first 16 hex chars, of
  `JSON.stringify({ tools: [...allowedTools].sort(), servers: Object.keys(mcpServers ?? {}).sort(),
  mode: permissionMode ?? null })`. Pure, never throws.
- `ResumableTurnParams` gains optional `surfaceHash?: string`.
- `resumableTurn` reads kv `surface:<sessionKey>`. When a `surfaceHash` param is provided and the
  stored value is **different or absent**, the turn skips the stored resume id and runs fresh,
  logging `tool surface changed for <key> — starting fresh session`. On a successful turn the
  hash is persisted beside the session id, under the same reset-epoch gate.
- Absent-stored-hash-means-fresh is deliberate fail-closed: the first message after deploy resets
  every existing session once, flushing the remaining stale fleet (only 5 sessions were
  hand-cleared on 07-19). Thereafter resets occur only on real surface changes.
- Callers that pass no `surfaceHash` (none after this spec, but the param is optional) keep
  today's behavior.

### 2. Seams pass the hash (src/agents/direct.ts, src/moderator/session.ts)

Both seams compute `surfaceHash(<final options>)` **after** every widening — MAIL_TOOL/ASK_TOOL,
ATTACH_TOOL, mounted servers — and pass it to `resumableTurn`. Seam-level additions are part of
the real surface: the 07-19 attach_file gap was introduced at the seam, not in resolve, and a
resolve-only hash would have missed it.

## Untouched

Engine one-shot runs (no resume), reset-epoch mechanics (`clearSession` unchanged), `/reset`
command, no new bus event types, no config or schema changes.

## Error handling

Hash computation is total over the options shapes used (arrays of strings, string enums). A
surface mismatch is not an error — it is a logged, intentional fresh start. The existing
LOCKDOWN_RE stale-session healing path is unchanged and composes: a fresh-due-to-surface run that
also hits a lockdown error retries fresh as before.

## Trade-off accepted

A surface change costs that chat's conversation continuity. User-approved, including the one-time
fleet-wide reset at first deploy. Stale surfaces proved worse than lost continuity twice in one
day.

## Testing

- `surfaceHash` pure-fn: stable across calls; insensitive to input ordering of allowedTools /
  server keys; changes when a tool is added, a server is added, or permissionMode differs;
  ignores unrelated option fields (systemPrompt, model).
- Resume-gate decision: extract a small helper (stored-vs-param compare + kv read) exercised with
  a real `Store(":memory:")` — `resumableTurn` itself needs the live SDK and stays untested, per
  the thin-seam convention.
- Live smoke after deploy: message hermes (fresh session line in log, reply works); verify kv
  `surface:moderator-session:*` rows appear; second message resumes (no fresh-session log);
  then confirm hermes' telegram session gained attach_file by asking it to attach a rendered
  chart from telegram (user-side check, optional).
