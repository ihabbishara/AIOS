# Mail-tab UX polish — design

**Date:** 2026-07-08
**Status:** approved, pre-implementation
**Builds on:** `2026-07-07-compose-ui-cold-mail-design.md` (the Mail tab this polishes). Pure UX;
no wall, quota, or privacy change.

## Problem

Four papercuts in the shipped Mail tab (`ui/src/views/Mail.tsx`), all noted as accepted-deferred
in the compose cycle:

1. **No refused signal in the thread list.** A sweep-refused cold mail only shows its `· refused`
   marker once the thread is opened (`UserThreadView` carries no status). A user glancing at the
   list can't tell a request died.
2. **Reply/answer drafts leak across threads.** `ThreadDetail` is re-rendered (not remounted) when
   the selected thread changes, so `ReplyBox`/`AnswerBox` local `text` state — and the previous
   thread's messages, briefly — carry over into the newly-opened thread.
3. **`sentRead` set grows unbounded** for the session, and re-marks nothing but is never released.
4. **Compose friction.** After sending cold mail the `to` select stays populated and the new
   thread isn't opened, so the user can't see the mail they just sent land.

## Decisions

- **Refused is a per-thread count**, surfaced as a small marker in `ThreadRow`, mirroring the
  existing `unread`/`pendingAsk` count columns. Only user-origin requests are refused within a
  user thread, so `SUM(status = 'refused')` over the thread is the right signal — no sender filter
  needed.
- **Remount `ThreadDetail` per thread** via `key={open}`. This single change fixes items 2 and 3
  at once: a fresh mount resets `sentRead`, drops the stale-message flash (fresh `usePoll` →
  `data` undefined until the new fetch), and remounts `ReplyBox`/`AnswerBox` with empty drafts. No
  separate keys on the child boxes needed.
- **Compose returns the new thread id up** so `Mail` opens it. `composeMail` already returns
  `{ ok: true, id }`; a fresh cold mail's `thread_id` equals that `id` (`sendFromUser` defaults
  `thread_id ?? id`), so `setOpen(id)` opens the just-created thread. `to` is cleared on success.

## Architecture

### 1. Store (`src/store/db.ts`)

`UserThreadRow` gains `refused: number`. `userThreads()` adds to the inner aggregate:

```sql
SUM(CASE WHEN status = 'refused' THEN 1 ELSE 0 END) AS refused
```

selected through to the outer row alongside `unread`/`pending_ask`. No new scan — same grouped
subquery.

### 2. View (`src/web/goals-view.ts`)

`UserThreadView` gains `refused: number`; `buildUserThreads` maps `t.refused`.

### 3. UI types (`ui/src/api.ts`)

`UserThreadView` interface gains `refused: number`.

### 4. Mail tab (`ui/src/views/Mail.tsx`)

- `ThreadRow`: when `t.refused > 0`, render a marker (`⚠` in `text-alert`) after the pendingAsk
  glyph. Purely additive.
- `Mail`: `<ThreadDetail key={open} threadId={open} … />`.
- `Compose`: `send()` uses the resolved `{ ok, id }` — on success `setBody("")`, `setTo("")`,
  `setMsg("sent ✓")`, and calls `onSent(id)`. `Mail` passes `onSent={(id) => { reload(); if (id) setOpen(id); }}`.
  `reload` currently takes no arg; widen the prop to `(id?: string) => void`.

## Error handling

No new failure modes. Refused count is display-only. Compose errors keep the existing refusal/catch
paths (no auto-open on failure — `id` only returned on `ok`).

## Testing

- **Store (`test/compose-cold-mail.test.ts`):** extend the `userThreads` test — a thread whose
  user cold mail was refused reports `refused: 1`; a clean thread reports `refused: 0`.
- **View:** `buildUserThreads` surfaces `refused` (fold into the existing endpoint/store assertion
  rather than a new file if one already covers `buildUserThreads`; otherwise add a focused case).
- **UI:** no component test harness exists for the Mail tab (consistent with the compose cycle,
  which pinned behavior server-side and relied on `tsc`/build for the view). The remount, draft
  reset, and auto-open are verified by `ui` build + `tsc` clean; the load-bearing new data
  (`refused`) is pinned at the store layer above.
- Baseline **933 pass + 1 skip** stays green; backend `tsc`, `ui` `tsc`, `ui` build all clean;
  zero dependency drift.

## Locks

None touched. No mail semantics, quotas, walls, or recall behavior change — this is presentation
plus one additive aggregate column in an existing query.
