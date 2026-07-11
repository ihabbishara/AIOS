# Mission Control Redesign ("Ember Cockpit") — Design

**Date:** 2026-07-11
**Status:** Approved (brainstorm with user, visual companion session)
**Scope:** Full parallel rebuild of the web UI (`ui2/`) + three small additive server endpoints. No changes to engine, kernel, org, or channels.

## 1. Problem

The user rated the current Mission Control unsatisfactory on all four axes:

1. **Looks amateur/dated** — the phosphor/amber CRT terminal aesthetic reads as a hobby dashboard.
2. **Hard to find things** — the 4-zone + subnav IA doesn't match how the user thinks.
3. **Doesn't say what matters** — walls of data with no attention hierarchy.
4. **Feels dead** — a live multi-agent system rendered as static admin tables.

## 2. Decisions (locked with user)

| Decision | Choice |
|---|---|
| Primary job | **Command center**: glance & act in 10 seconds, depth on demand |
| Home shape | **Triage Cockpit** — persistent needs-you queue (left) + context canvas (right) |
| Navigation | 5 sections: **Home · Goals · Staff · Mail · System** (Inbox → Home queue; Governance + Departments → folded into Staff) |
| Aesthetic | **Ember** — calm premium (Linear-school discipline), warm near-black neutrals, amber `#e0a458` as the sole accent, reserved for needs-you items and primary actions |
| Surfaces | Desktop + phone browser (fully responsive) |
| Phone home | **Queue-first stack** — same mental model as desktop, inline actions, bottom tabs |
| Chat | Drawer (⌘J), improved: context-aware pre-targeting |
| Build path | **Full parallel rebuild** in `ui2/`, cutover when complete (user's explicit choice over incremental migration) |

## 3. Design system ("Ember")

### Tokens
Single dark theme at launch, expressed as CSS custom properties in one `tokens.css`; Tailwind v4 consumes them. Theme-swappable by construction.

- **Neutrals (warm):** `--bg #0f0e0c`, `--surface #141210`, `--raised #181510`, `--border #24211c`, text ramp `--text-dim #847e72` / `--text #cfccc4` / `--text-strong #efe9dc`.
- **Accent:** `--accent #e0a458` (amber). Usage rule: *only* items needing the user + primary action buttons. Never decorative.
- **Status:** desaturated green (running/ok), red (failed), violet (agent activity) tuned to sit quietly on the warm dark.
- Borders over shadows. No gradients, no glow. Radius 6–8px. 4px spacing grid.

### Typography
- **Inter** (variable, self-hosted — no CDN, works offline).
- Ramp: 20px page titles / 15px item titles / 13px body / 11px meta / 10px uppercase section labels (letter-spaced).
- Tabular numerals for costs and counts.
- **JetBrains Mono** (self-hosted) only for YAML, logs, and artifact content.

### Motion — the "alive" rules
Three motion classes, all driven by real SSE events. Hard rule: motion only communicates state change or liveness; zero decorative animation. `prefers-reduced-motion` honored everywhere.

1. **Presence** — working agents show a breathing dot (2s ease pulse); queue count changes tick with a 150ms scale; nothing loops when the system is idle.
2. **Arrival** — new queue items slide in over 200ms with a one-time amber left-edge flash; items never re-animate on rerender.
3. **Progress** — running goal nodes show an indeterminate hairline shimmer; costs count up numerically.

### Voice
Sentence case. Empty states are one calm line ("Nothing needs you."), never illustrations.

## 4. App shell + navigation

- **Top bar** (not a side rail — the cockpit's left column is already the queue): `AIOS · Home Goals Staff Mail System ······ budget-today · connection dot · ⌘K`.
- **Keyboard:** ⌘K palette (jump + actions), ⌘J chat drawer. Home: `j/k` queue walk, `enter` open, `a` approve, `r` reject, `d` discuss. `g` then `h/g/s/m/y` section jumps.
- **Chat drawer:** bottom sheet. Context-aware pre-targeting: from an approval → Hermes with the item linked; from an agent profile → that agent; from a goal node → the node's agent with node context. Keeps existing persistence + voice.
- **Connection/health:** top-bar dot = green (SSE live) / amber (reconnecting) / red (daemon down, with last-seen). Restart flows poll `/api/state` for real readiness — no fake timers.

## 5. Home — the Triage Cockpit

**Layout:** Left **Queue** (~360px fixed) + right **Canvas**. Above the queue, one-line **Today strip**: date · morning-brief link · meetings count · budget today.

### Queue model
One unified list, severity-ordered, grouped with counts:

| Rank | Kind | Source | Inline actions |
|---|---|---|---|
| 1 | Approvals | actions `status=proposed` (expiry shown) | approve · reject · open |
| 2 | Agent asks | `awaiting-human` mail (blocking parked goals) | answer · open |
| 3 | Failures/paused | goals `failed` (48h) + `paused-budget` + `paused-user` | open · abandon |
| 4 | Unread mail | reports/notes addressed to `user` | open · mark read |
| 5 | Ambient | degraded senses (re-auth needed), graduation offers | open |

- Approve/reject/answer work inline from the row (phone parity).
- Handled items collapse out over 200ms.
- No blocking dialogs; destructive actions use the existing two-step arm pattern (`TwoStepButton`, successor of `ConfirmButton`).

### Canvas renderers (by selected kind)
- **Approval** — gate-authored preview rendered by type: `email.draft` → email-shaped card (to/subject/body); `vault.write` → path + markdown preview; `permission.grant/revoke` → role/tool delta; generic fallback → preview text + payload table. Actions: Approve ↵ / Reject (reason field) / Discuss ⌘J.
- **Ask** — question + parked-goal context (title, asking node, mini-DAG thumbnail) + answer box. Answer resumes the goal via the existing endpoint.
- **Failed/paused goal** — error, failed node highlighted in mini DAG, cost so far; open-in-Goals / abandon / discuss.
- **Unread mail** — thread view + reply box.
- **Brief** (via Today strip) — morning/evening brief rendered as a readable memo.
- **Idle (default)** — **org pulse**: department columns, live agents with presence dots + current task + today cost, running goals as slim progress rows, today totals. Click-through to Staff/Goals. This is where the "alive" feeling lives.

**Empty state:** "Nothing needs you." + org pulse.

## 6. Sections

### Goals
- **List:** status groups (Needs attention / Running / Waiting / Done / Abandoned). Rows: title · dept · lead · node progress (3/7) · live cost · provenance chip (`mail from you` / `speculate` / `chat`). Filters: dept, timeframe.
- **Detail:** DAG canvas kept (restyled to Ember): nodes as calm cards (status edge-color, agent dot, cost), dimmed bezier edges, failed path highlighted. Right inspector: node brief, artifact preview (mono, collapsible), rounds, error, per-node cost. Header: status, pause/resume/abandon (two-step), replans used, total cost, spawned-by link. `awaiting-mail` / `awaiting-human` nodes render the question + answer box inline (same renderer as Home).

### Staff
- **Org:** department columns (fixed order). Agent cards: presence dot (idle/working/waiting-on-you), current-task line deep-linking to the goal node, today cost, 🔒 private / 🛡 guarded badges, unread mail badge.
- **Profile:** identity header (name, title, dept, aliases, model), charter; **Access panel** = effective tools (default/granted/revoked chips; grant/revoke queues an approval), trust states for the dept's action types, guard description; activity = recent runs with cost sparkline, handoffs, mail. Chat button → pre-targeted drawer.
- **Governance overview** (sub-tab): trust ledger table + permission matrix + denial feed (aggregate of profile data).
- **Department admin** (enable/disable, playbook YAML editor, run playbook) lives in a department-header ⋯ menu — not a separate section.

### Mail
Threads list (unread bold-amber, refused ⚠, pending-ask 🙋) + thread detail (bubbles by sender, kind tags, goal chips → DAG) + compose (recipient picker, private agents marked). Structural reuse of the existing Mail tab, restyled.

### System
- **Events:** live tail, preset filters (routing/goals/agents/actions/chat/mail), text search, pause-scroll. Mono, dim, dense.
- **Costs:** today/week/month totals, per-agent bars, 14-day chart, per-goal top spenders. Reads existing `/api/costs`; storage-side rollups belong to the Ops-floor spec.
- **Config:** grouped env editor (Channels / Models / Anchors / Budgets / Senses), secrets masked, restart with readiness polling.
- **Health:** daemon uptime, senses status (gmail/calendar/bunq/cloudflare: ok/degraded + re-auth hint), voice status, SSE client count, DB size.

## 7. Mobile (<768px) — queue-first

- Home = full-width queue list, Today strip on top, inline approve/reject/answer on rows; tap → full-screen detail using the same canvas renderers (push/back navigation).
- Bottom tab bar = the 5 sections. No idle org-pulse on phone (lives under Staff).
- DAG = pan/zoom scroll container; node inspector = bottom sheet. Chat = full-screen sheet.
- Touch targets ≥ 44px; row actions also swipe-revealed.

## 8. Stack + data layer

- **Fresh `ui2/`:** Vite + React + TypeScript (foundations unchanged — they were not the problem).
- **Styling:** Tailwind v4 over the Ember `tokens.css`. No component library; hand-rolled primitives (`Button`, `Row`, `Tag`, `Sheet`, `TwoStepButton`). Radix allowed only if a primitive proves painful.
- **Fonts:** self-hosted Inter var + JetBrains Mono.
- **Router:** hash router pattern kept, rebuilt clean around the 5-section map.
- **Data layer ported, not rewritten:** `dto.ts` stays the single wire contract; `useEvents` (SSE) + `useLiveQuery` (topic-keyed invalidation) + `topics.ts` ported as-is in pattern.
- **Mutations:** optimistic with rollback + inline row-level error line. No toast spam.

## 9. Server changes (additive only)

1. **`GET /api/attention`** — unified typed queue: `{ kind, id, title, meta, severity, ts, actions[] }[]`, assembled server-side from actions(proposed) + awaiting-human mail + failed/paused goals + unread user inbox + sense degradation + graduation offers. Replaces the UI-side stitching the old Inbox did across 4 endpoints. Invalidated by existing SSE topics.
2. **`GET /api/health`** — uptime, senses status, voice status, SSE client count, DB size.
3. **`AIOS_UI_DIST`** env — static-serve path switch so `ui2/dist` can be flipped on for testing and cutover.

No breaking changes to existing endpoints; the old UI keeps working until cutover.

## 10. Cutover plan

Build `ui2/` in parallel → test via `AIOS_UI_DIST=ui2/dist` → flip default when Home + Goals + Staff + Mail + System are all live → keep `ui/` one release as fallback → delete.

## 11. Error handling

- SSE connection states surfaced in the top-bar dot (live / reconnecting / down + last-seen).
- 401 → token gate (existing behavior kept).
- Daemon restart flows poll `/api/state` for readiness.
- Every mutating call: optimistic update → rollback + inline error on failure.
- Reduced-motion media query honored.

## 12. Testing

- `ui2/` gets **vitest + @testing-library/react** for pure logic: queue ranking/grouping, dag-layout port, formatters, canvas renderer selection. (Closes the old UI's no-test-runner gap.)
- `/api/attention` + `/api/health` unit-tested in the root suite (view-builder pattern, like `packs-view`/`org-view`).
- Live browser smoke at cutover (existing project policy).
- No automated visual regression (single user; not worth the harness).

## 13. Out of scope

- Light theme (tokens make it possible later; not at launch).
- Storage-side cost rollup tables (Ops-floor spec).
- Any engine/kernel/org/policy changes (separate specs in the redesign series).
- Native mobile app; push notifications (Telegram already covers push).

## 14. Open questions

None — all resolved in the brainstorm session (see §2 decision table).
