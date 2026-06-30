# Lifeops Pillar Pack — Design Spec

**Date:** 2026-06-30
**Status:** Approved (brainstorm), pending implementation plan
**Pillar:** `lifeops` (the reserved second-brain domain; first concrete use)
**Pack #:** 4th shipped pillar pack (after money, code, research)

## Summary

A private **personal task / errand manager**. A new role, **`jasmine`**, tracks open
loops — errands, follow-ups, deadlines — in a dedicated `personal_tasks` table, richer
than the time-triggered heartbeat reminders that already exist. Jasmine surfaces work
two ways: an "Open loops" section in the 07:30 morning brief, and intra-day nudges to
the primary chat when a task goes overdue / due-soon / stale.

It deliberately mirrors the **money pack's privacy architecture** (private surface,
own structured table, not indexed into recall, transport-only proactive push) because
that architecture is already proven in production and adds no new security surface.

## Goals / Non-goals

**Goals**
- A structured open-loop store: title, status, optional due date / project / next-action / notes.
- Proactive surfacing: morning-brief section + intra-day overdue/due-soon/stale nudges.
- Private: reachable only from the primary chat + local cockpit; never indexed; never on shared chats.
- Self-contained: pure local CRUD, no outward effects (`actions: []`).

**Non-goals (v1, each deferrable to its own cycle)**
- No calendar events, no email drafts, no heartbeat-reminder creation from tasks (cross-system effects deferred).
- No separate projects/contexts tables, no tags, no GTD weekly-review flow (a `project` text column gives grouping).
- No priority field (overdue + due ordering is sufficient).
- No recurrence (time-recurring belongs to heartbeat reminders, which stay untouched).

## Boundary vs existing capabilities

Reminders, calendar, and email already live at the **moderator + heartbeat** level.
Lifeops carves around them:

| | Owns | Trigger |
|---|---|---|
| heartbeat **reminders** (existing, untouched) | one-shot timed pings | fire-time |
| lifeops **tasks** (new) | open loops, may have a due date | surfaced by brief + watcher, not individually scheduled |

A task with a due date is surfaced by lifeops' own watcher/brief — it does **not** also
create a heartbeat reminder (no double machinery, no double ping).

## Architecture

Mirrors the `src/money/` layout and the money pack's wiring seams.

### 1. Data model — `personal_tasks`

`CREATE TABLE IF NOT EXISTS` in `src/store/db.ts` (greenfield, **no migration** — like `research_sources`):

| column | type | notes |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | |
| `title` | TEXT NOT NULL | the open loop |
| `status` | TEXT NOT NULL DEFAULT `'open'` | one of `open` / `waiting` / `done` / `dismissed` |
| `project` | TEXT | freeform area/grouping; **no projects table** |
| `due_date` | TEXT | `YYYY-MM-DD`, nullable |
| `next_action` | TEXT | concrete next step, nullable |
| `notes` | TEXT | nullable |
| `created_at` | TEXT NOT NULL | ISO |
| `updated_at` | TEXT NOT NULL | ISO; bumped on every mutation (drives "stale") |

Index `(status, due_date)` for the watcher/brief filters.

**Store accessors** (mirror the money/research accessors): `addTask`, `listTasks(status?, project?)`,
`updateTask(id, fields)`, `completeTask(id)`, `dismissTask(id)`, `getTask(id)`. `updateTask`/`complete`/`dismiss`
bump `updated_at`.

### 2. Pure ops — `src/lifeops/ops.ts`

- `openLoopsForBrief(tasks, today)` → `{ overdue: Task[], dueToday: Task[], openCount: number }` (pure; brief section input).
- `computeLifeopsSignals(tasks, now, cfg)` → `LifeopsSignal[]` (`{ key, text }`, mirrors `MoneySignal`):
  - **overdue** — `status==='open'` && `due_date < today`. key `lifeops:overdue:<id>:<today>`.
  - **due-soon** — `status==='open'` && `today <= due_date <= today + SOON_DAYS`. key `lifeops:soon:<id>:<due_date>`.
  - **stale** — `status==='open'` && `due_date == null` && `updated_at` older than `STALE_DAYS`. key `lifeops:stale:<id>:<today>`.

  Keys embed a date so a task pings once per transition (per day for overdue/stale, per due-date for soon), never every poll. Pure function over already-fetched rows — no I/O, fully unit-testable.

### 3. Tools — `lifeops` MCP server (`src/lifeops/server.ts`)

`buildLifeopsServer({ store })` via `createSdkMcpServer` (mirrors `buildMoneyServer`). Tools, **ungated direct DB CRUD**, no gate, no outward effect:

- `add_task(title, due_date?, project?, next_action?, notes?)`
- `list_tasks(status?, project?)`
- `update_task(id, title?, status?, due_date?, project?, next_action?, notes?)`
- `complete_task(id)`
- `dismiss_task(id)`
- `vault_read`

No `recall` tool — lifeops is not indexed, so recall over the lifeops domain returns nothing.

### 4. Role — `jasmine` (`src/agents/roles/index.ts`)

New `RoleDef`:
- persona: "You are Jasmine, the user's personal operations aide. You track open loops — errands, follow-ups, deadlines. Always surface the concrete next action. Personal-life topics are private — refuse in any shared context. Be concise."
- tools: the 6 above.
- `privateOnly: true` (reuses the existing cfo guard).
- `permissionMode: 'dontAsk'`, no Bash/Edit/Write.

### 5. Pack manifest — `playbooks/lifeops/pack.yaml`

```yaml
pillar: lifeops
persona: |
  You are Jasmine, the user's personal operations aide. You track open loops — errands,
  follow-ups, deadlines — in their private task list. Always surface the concrete next
  action. Personal-life topics are private — refuse in any shared context. Be concise.
memoDomain: lifeops
toolServer: lifeops
roles: [jasmine]
actions: []
tools:
  - mcp__lifeops__add_task
  - mcp__lifeops__list_tasks
  - mcp__lifeops__update_task
  - mcp__lifeops__complete_task
  - mcp__lifeops__dismiss_task
  - vault_read
playbooks: []
```

### 6. Proactive surface

- **Watcher** (`src/index.ts`): `startWatcher("lifeops", config.lifeopsPollSeconds * 1000, async () => { const signals = computeLifeopsSignals(store.listTasks("open"), new Date(), config); for each unfired key → sendVia(primaryChat, text) → kvSet(key) })`. Byte-for-byte the money-watcher shape at index.ts:520. Needs `AIOS_PRIMARY_CHAT`. **Transport-only**: `sendVia` direct to primary chat — no agent turn, no vault write, no `bus.emit`.
- **Brief** (`src/heartbeat/briefs.ts`): add `openLoops?: { overdue, dueToday, openCount }` to `BriefData`; `assembleBrief` fills it **morning-only** via `openLoopsForBrief(store.listTasks("open"), today)` (same morning-gating as `dreamInitiatives`/`speculateResults`); `isEmptyBrief` counts it; `renderBriefNote` adds a `section("Open loops", …)` listing overdue + due-today titles + the open count.

### 7. Wiring (`src/index.ts`)

- Register the tool server alongside money/research: `toolServers: { money: …, research: …, lifeops: (d) => buildLifeopsServer({ store: d.store }) }` (index.ts:169).
- The `AIOS_<PILLAR>_DISABLED` boot loop + `dropPack` (index.ts:75) give `AIOS_LIFEOPS_DISABLED=1` for free.
- Add the `startWatcher("lifeops", …)`.

### Config

| env | default | meaning |
|---|---|---|
| `AIOS_LIFEOPS_DISABLED` | (off) | `=1` drops the pack via `dropPack` |
| `AIOS_LIFEOPS_POLL_SECONDS` | `21600` (6h) | watcher cadence — catches intra-day deadline transitions |
| `AIOS_LIFEOPS_SOON_DAYS` | `2` | due-soon horizon |
| `AIOS_LIFEOPS_STALE_DAYS` | `14` | a no-due-date open task untouched this long is "stale" |

Proactive nudges require `AIOS_PRIMARY_CHAT` (same as money signals).

## Privacy invariants (load-bearing, opus-verifiable — the money pack's four)

1. **`personal_tasks` is never indexed into recall.** The indexer (`src/memory/indexer.ts`) only reads vault notes/memos, resolved decisions, and `calendar.changed` events — it never reads `personal_*` tables or kv. `personal_tasks` is excluded by construction, exactly as `personal_transactions` is. Pinned test: `recall(<task title>)` returns `[]`.
2. **No outward effect.** `actions: []`; the lifeops server has no `vault_write`, no `propose_action`, no `bus.emit` — local DB only.
3. **Private reach only.** `jasmine` is `privateOnly` → `DirectChats.handle` refuses it from any origin ≠ primary chat / `web:ui` (direct.ts:58). Moderator `ask_specialist` gives a toolless jasmine (no pack passed). Jobs blocked (`playbooks: []`). The lifeops memo domain is not in the moderator's `ALWAYS_LOADED` set.
4. **Watcher push is transport-only.** `sendVia` to the primary chat — never `vault.writeNote`, never an agent turn, never `bus.emit`.

**Deliberate relaxation vs money:** task *titles* DO appear in the morning brief and nudges.
Both land only in the user's own primary chat + local Obsidian vault — neither is a shared
surface, and neither is the recall index. The wall is "not indexed, not on shared chats," not
"invisible to the user." (Money was stricter — generic counts only — because bank/email is
maximally sensitive; tasks are not.)

## Framework consequences (intended)

- `jasmine` is a brand-new role → binds **solo** to lifeops → `roleOf(jasmine) = lifeops`, so `@jasmine` direct chat resolves the lifeops pack. No role-sharing drop (unlike `researcher`/`reviewer`, which are in multiple pillars).
- money / code / research manifests are **byte-unaffected** — verified by the existing pack-killswitch / manifest pins.
- Boot log becomes `packs: code, lifeops, money, research`.
- No `node:sqlite` migration (greenfield `CREATE TABLE IF NOT EXISTS`).

## Files

| file | change |
|---|---|
| `src/store/db.ts` | `personal_tasks` table + 6 accessors |
| `src/lifeops/ops.ts` | `openLoopsForBrief`, `computeLifeopsSignals` (pure) |
| `src/lifeops/server.ts` | `buildLifeopsServer` (6 tools) |
| `src/agents/roles/index.ts` | `jasmine` RoleDef |
| `playbooks/lifeops/pack.yaml` | manifest |
| `src/index.ts` | register toolServer + `startWatcher("lifeops")` + config |
| `src/config.ts` | the 4 new env knobs |
| `src/heartbeat/briefs.ts` | `openLoops` in `BriefData` + assemble + isEmpty + render section |

## Testing

- **`lifeops-ops`** — overdue/due-soon/stale classification, date-boundary edges, `openLoopsForBrief` partition.
- **`lifeops-server`** — CRUD round-trip via `server.instance._registeredTools[name].handler` (mirrors money/research server tests).
- **`lifeops-privacy`** — `recall(<task string>) === []` (pinned); `jasmine` refused from a non-private origin; `jasmine` has no outward (gate/vault-write) tool.
- **`lifeops-watcher`** — fire-once kv (second poll of an unchanged task emits nothing); push is transport-only (no vault write, no bus emit).
- **`briefs`** — "Open loops" section renders; `isEmptyBrief` counts it; morning-only (evening brief omits it).

## Deferred (each its own later cycle)

- Cross-system effects: `calendar.create` from a due date (needs a new gated calendar-write executor); `email.draft` follow-ups (reuses the existing executor but couples to the inbox privacy surface).
- Projects/contexts/tags, GTD weekly review, priority, recurrence.
- A Mission Control lifeops view.
