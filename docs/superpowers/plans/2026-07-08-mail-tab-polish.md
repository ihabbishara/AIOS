# Mail-tab UX polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a refused-count marker in the Mail thread list and remove four Mail-tab papercuts (draft leak across threads, unbounded `sentRead`, stale-message flash, compose friction).

**Architecture:** One additive aggregate column (`refused`) flows Store → view → UI type → `ThreadRow`. The draft-leak, `sentRead`-growth, and flash issues collapse into a single `key={open}` remount of `ThreadDetail`. Compose returns the created thread id up so `Mail` opens it and clears `to`.

**Tech Stack:** TypeScript, node:sqlite, React (Vite), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-08-mail-tab-polish-design.md`

## Global Constraints

- No new npm dependencies. No new tables — one `SUM(...)` column added to the existing `userThreads()` grouped subquery.
- Suite baseline **933 pass + 1 skip** stays green. Backend `npx tsc --noEmit` clean; `cd ui && npx tsc --noEmit && npm run build` clean; `git diff origin/main -- package.json package-lock.json ui/package.json ui/package-lock.json` empty.
- Purely additive: no mail semantics, quota, wall, or recall change. `refused` count is display-only.
- Build cycle (session-locked): worktree off `origin/main`; per-task commits; whole-branch review before FF-merge; deploy `npm run build && (cd ui && npm run build) && launchctl kickstart -k gui/$(id -u)/com.ihab.aios`; READ-ONLY smoke.

---

### Task 1: Store + view — `refused` per-thread count

**Files:**
- Modify: `src/store/db.ts:62-65` (`UserThreadRow`), `src/store/db.ts:763-784` (`userThreads()`)
- Modify: `src/web/goals-view.ts:93-103` (`UserThreadView` + `buildUserThreads`)
- Test: `test/compose-cold-mail.test.ts`

**Interfaces:**
- Consumes: existing `Store.userThreads(limit?)`, `buildUserThreads(store)`.
- Produces: `UserThreadRow.refused: number`, `UserThreadView.refused: number`. Task 2 (UI) relies on `refused` being present on the `/api/mail/mine` thread objects.

- [ ] **Step 1: Write the failing test**

In `test/compose-cold-mail.test.ts`, add `buildUserThreads` to the imports:

```ts
import { buildUserThreads } from "../src/web/goals-view.js";
```

Then add a test inside `describe("store user-inbox queries")`:

```ts
  it("userThreads: refused count surfaces per thread (store + view)", () => {
    const store = new Store(":memory:");
    // thread R: user cold mail that the sweep refused
    rawMail(store, { id: "r1", from_agent: "user", to_agent: "vulcan", status: "refused", thread_id: "tr", error: "unknown recipient" });
    // thread A: clean cold mail + report
    rawMail(store, { id: "a1", from_agent: "user", to_agent: "vulcan", status: "spawned", thread_id: "ta" });
    rawMail(store, { id: "a2", from_agent: "vulcan", to_agent: "user", kind: "report", status: "unread", thread_id: "ta", in_reply_to: "a1", body: "done" });
    const byId = Object.fromEntries(store.userThreads().map((t) => [t.thread_id, t]));
    expect(byId["tr"].refused).toBe(1);
    expect(byId["ta"].refused).toBe(0);
    // view carries it through
    const view = Object.fromEntries(buildUserThreads(store).map((t) => [t.threadId, t]));
    expect(view["tr"].refused).toBe(1);
    expect(view["ta"].refused).toBe(0);
  });
```

Note: `rawMail`'s helper (defined at the top of this file) sets `error: null` unconditionally — confirm it forwards `over.error`. If it hard-codes `error: null`, change that line to `error: over.error ?? null` as part of this step (the refused-status row needs a non-null error only cosmetically; the `refused` count keys on `status`, so the test passes regardless, but forwarding `error` keeps the fixture honest).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compose-cold-mail.test.ts -t "refused count surfaces"`
Expected: FAIL — `refused` is `undefined` on both the row and the view (TypeScript may also error that `refused` is not on `UserThreadRow`; if so the file won't compile — that is still a red).

- [ ] **Step 3: Implement**

`src/store/db.ts` — `UserThreadRow`:

```ts
export interface UserThreadRow {
  thread_id: string; last_ts: string; last_from: string; last_body: string;
  unread: number; pending_ask: number; refused: number;
}
```

`userThreads()` inner aggregate — add the `refused` sum and select it on the outer row:

```ts
  userThreads(limit = 100): UserThreadRow[] {
    return this.db.prepare(`
      SELECT t.thread_id,
             l.created_at AS last_ts, l.from_agent AS last_from, substr(l.body, 1, 160) AS last_body,
             t.unread, t.pending_ask, t.refused
      FROM (
        SELECT thread_id,
               SUM(CASE WHEN status = 'unread' AND to_agent = 'user' THEN 1 ELSE 0 END) AS unread,
               SUM(CASE WHEN kind = 'request' AND to_agent = 'user' AND status = 'awaiting-human'
                         AND id NOT IN (SELECT in_reply_to FROM mail WHERE in_reply_to IS NOT NULL)
                        THEN 1 ELSE 0 END) AS pending_ask,
               SUM(CASE WHEN status = 'refused' THEN 1 ELSE 0 END) AS refused
        FROM mail
        WHERE thread_id IN (SELECT DISTINCT thread_id FROM mail WHERE from_agent = 'user' OR to_agent = 'user')
        GROUP BY thread_id
      ) t
      JOIN mail l ON l.rowid = (
        SELECT rowid FROM mail WHERE thread_id = t.thread_id ORDER BY created_at DESC, rowid DESC LIMIT 1
      )
      ORDER BY l.created_at DESC, l.rowid DESC
      LIMIT ?
    `).all(limit) as unknown as UserThreadRow[];
  }
```

`src/web/goals-view.ts` — `UserThreadView` + `buildUserThreads`:

```ts
export interface UserThreadView {
  threadId: string; lastTs: string; lastFrom: string; lastBody: string; unread: number; pendingAsk: number; refused: number;
}

/** The human's correspondence — thread summaries for the Mail tab (spec §6). */
export function buildUserThreads(store: Store): UserThreadView[] {
  return store.userThreads().map((t) => ({
    threadId: t.thread_id, lastTs: t.last_ts, lastFrom: t.last_from, lastBody: t.last_body,
    unread: t.unread, pendingAsk: t.pending_ask, refused: t.refused,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/compose-cold-mail.test.ts && npx tsc --noEmit`
Expected: ALL PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts src/web/goals-view.ts test/compose-cold-mail.test.ts
git commit -m "feat(mail): per-thread refused count in userThreads + view"
```

---

### Task 2: Mail tab — refused marker, per-thread remount, compose auto-open

**Files:**
- Modify: `ui/src/api.ts:145-147` (`UserThreadView` interface)
- Modify: `ui/src/views/Mail.tsx` (Mail, ThreadRow, Compose)
- Test: none (no Mail-tab component harness — verified by `tsc` + build; the load-bearing `refused` data is pinned in Task 1)

**Interfaces:**
- Consumes: Task 1's `refused` field on `/api/mail/mine` thread objects; existing `api.composeMail(...)` returning `{ ok: true; id: string } | { ok: false; refusal: string }`.
- Produces: nothing downstream.

- [ ] **Step 1: Add `refused` to the UI type**

`ui/src/api.ts`:

```ts
export interface UserThreadView {
  threadId: string; lastTs: string; lastFrom: string; lastBody: string; unread: number; pendingAsk: number; refused: number;
}
```

- [ ] **Step 2: Refused marker in `ThreadRow`**

`ui/src/views/Mail.tsx` — in `ThreadRow`, after the pendingAsk glyph line, add a refused marker:

```tsx
        {t.pendingAsk > 0 && <span className="text-[10px]">🙋</span>}
        {t.refused > 0 && <span className="text-alert text-[10px]" title="a request in this thread was refused">⚠</span>}
        <span className="ml-auto text-dim text-[10px]">{t.lastTs.slice(5, 16)}</span>
```

- [ ] **Step 3: Remount `ThreadDetail` per thread**

In `Mail`, key the detail by the open thread id so a switch remounts it fresh (resets `sentRead`, drops the stale-message flash, clears `ReplyBox`/`AnswerBox` drafts):

```tsx
        {open
          ? <ThreadDetail key={open} threadId={open} lastMailEvt={lastMailEvt} onChanged={reload} />
          : <div className="text-dim text-[11px] pt-8 text-center">Select a thread — or compose cold mail to any agent.</div>}
```

- [ ] **Step 4: Compose returns the new thread id; Mail opens it**

Widen `Compose`'s `onSent` to carry the id, clear `to` on success, and open the thread from `Mail`.

`Compose` signature + `send()`:

```tsx
function Compose({ agents, onSent }: { agents: Array<{ name: string; dept: string }>; onSent: (id?: string) => void }) {
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const send = () => {
    if (busy || !to || !body.trim()) return;
    setBusy(true);
    setMsg(null);
    api.composeMail({ to, body })
      .then((r) => {
        if (!r.ok) setMsg(r.refusal);
        else { setBody(""); setTo(""); setMsg("sent ✓"); onSent(r.id); }
      })
      .catch((e) => setMsg((e as Error).message))
      .finally(() => setBusy(false));
  };
```

`Mail` — the `<Compose>` call site opens the created thread (a fresh cold mail's `thread_id === id`):

```tsx
        <Compose agents={agents} onSent={(id) => { reload(); if (id) setOpen(id); }} />
```

Leave the other `onSent={reload}`-style callbacks (`ReplyBox`, `AnswerBox` via `onChanged`) untouched — they pass no id and `reload` ignores extra args.

- [ ] **Step 5: Verify build + typecheck**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean, zero errors. `git -C .. diff origin/main -- ui/package.json ui/package-lock.json` empty.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api.ts ui/src/views/Mail.tsx
git commit -m "feat(ui): mail-tab polish — refused marker, per-thread remount, compose auto-open"
```

---

### Task 3: Full verification

**Files:** none

- [ ] **Step 1: Full suite + typecheck + builds + drift**

Run:
```bash
npx vitest run && npx tsc --noEmit && npm run build && (cd ui && npx tsc --noEmit && npm run build) && git diff origin/main -- package.json package-lock.json ui/package.json ui/package-lock.json
```
Expected: **≥ 934 pass + 1 skip** (933 baseline + 1 new), tsc clean both sides, both builds green, empty drift output.

---

## Post-merge (session build cycle, not plan tasks)

Whole-branch review → fix findings → FF-merge → push → build both → `launchctl kickstart -k gui/$(id -u)/com.ihab.aios` → READ-ONLY smoke (`/api/mail/unread`, `/api/mail/mine`, UI root 200) → ExitWorktree remove → memory update (mail-tab polish shipped; §13 backlog empty).
