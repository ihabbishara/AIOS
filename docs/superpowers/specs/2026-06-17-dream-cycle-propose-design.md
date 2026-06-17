# AI-OS — Phase 8 Dream Cycle (Propose) — Design

**Date:** 2026-06-17
**Status:** Approved (brainstorm complete, awaiting implementation plan)
**Trigger:** The cognitive-kernel vision (`2026-06-11-cognitive-kernel-design.md`, lines 73-80) defines a nightly "dream cycle": *consolidate → propose → speculate*. **Consolidate** already shipped (the Phase 6 distiller curates per-domain memos at the evening anchor). **Propose** and **speculate** remain. This spec is the **propose** half — the foundation. **Speculate** (overnight autonomous work) is decomposed into its own later cycle, building on propose's ranked initiatives.

## Summary

A new **02:00 "dream" anchor** on the existing heartbeat runs a nightly **propose** pass: it compiles a non-sensitive **observations digest** from four sources (reminders, calendar, decision journal, jobs + second-brain), runs **one one-shot LLM pass** (the proven distiller/curator pattern) to rank the **top N initiatives** worth considering, and stores the result in kv. The **07:30 morning brief** renders a "Dream" section from it, so the operator wakes to a short, ranked "here's what I noticed — worth considering" list. It is strictly **read-only**: it never queues actions, never auto-acts, never writes the vault directly. **Money is excluded** (it has its own proactive watcher and a hard privacy wall); **email content is excluded** (security). Failure is silent (no dream section, never breaks the heartbeat).

## Requirements (from brainstorm)

| Decision | Choice |
|---|---|
| Scope | **Propose only** (this cycle). Speculate (overnight work, code spikes in worktrees) is its own next spec |
| Proposal form | **Ranked initiatives in the morning brief** — read-only analysis; no queued gated actions, no auto-drafted artifacts |
| Sources scanned | **Reminders, Calendar, Decision journal, Jobs + second-brain.** Money EXCLUDED (own watcher + privacy wall); email *content* EXCLUDED (security) |
| Reasoning | A **single one-shot LLM pass** over a compiled digest (mirrors the distiller's `curateLLM`), not a tool-using agent |
| Trigger | A **02:00 "dream" anchor** (fire-once, same-day catch-up — like morning/evening) |
| Surface | The **morning brief** renders a "Dream" section from the stored output (the evening brief does not) |
| Dedup | **LLM-guided** — the pass sees last night's initiatives + recent decisions and is told not to re-surface dismissed/stale items |
| Storage | The ranked initiatives are stored in **kv (`dream:latest`)**, not a separate vault note |

## Existing foundation (reused, not rebuilt)

- **Heartbeat anchors** (`src/heartbeat/clock.ts`) — `anchorDue` fires once per local day when `now.hhmm >= anchor.hhmm` and not already fired today (kv stamp `anchor:<name>:last`, written **before** the handler so a crash never re-fires). `onAnchor(name)` is the dispatch. Adding a `"dream"` anchor requires widening the `"morning" | "evening"` union in `clock.ts` (`AnchorConfig.name`, `ClockDeps.onAnchor`) and `briefs.ts` (`BriefData.anchor`, `runBrief`). Config at `src/config.ts:174-175` (`anchorMorning`/`anchorEvening`); the Clock is built at `src/index.ts:359-381`.
- **The distiller's one-shot LLM pattern** (`src/memory/distiller.ts:88-114`, `curateLLM`) — `query({ prompt, options: { systemPrompt, allowedTools: [], permissionMode: "dontAsk", settingSources: [], persistSession: false, maxTurns: 1, ...(model ? {model} : {}) } })`, read `msg.result` on `result/success`, **return `""` on any failure**. The dream cycle copies this exactly (with a JSON-schema `outputFormat` for the ranked list). Model: `config.curatorModel` (`AIOS_CURATOR_MODEL ?? AIOS_SPECIALIST_MODEL`), or a dedicated `config.dreamModel`.
- **The morning/evening brief** (`src/heartbeat/briefs.ts`) — `assembleBrief(store, anchor, nowIso, since)` builds `BriefData`; `runBrief` narrates (via the moderator) + delivers to `config.primaryChat` + writes a vault note `briefs/<date>-<anchor>.md`. The brief already aggregates the proposal queue (`pendingApprovals`). The dream section is a new `BriefData` field rendered only for the morning anchor.
- **Source-state read methods** (`src/store/db.ts`) — `listReminders(status?)`; `kvByPrefix("gcal:")` (calendar snapshots, as `briefs.ts` uses); `listDecisions(since?)` (the decision journal: `{id, type, preview, verdict, reason, ts}`, verdict ∈ approved/auto/rejected/failed); job state via `job.status` events (`listEventsSince`) + `getJob`; `recall(store, query, {domain?})` for open second-brain threads. `kvGet`/`kvSet` for `dream:latest` + same-day freshness.
- **The money privacy wall** (money pillar spec) — money data lives only in `personal_*` SQLite, never in vault/recall; money has its **own** proactive watcher pushing direct to the private chat. The dream cycle **does not read `personal_*` tables** at all, so the wall is preserved by construction (and the dream output stays safe to put in the recall-indexed brief note).

## Architecture

```
02:00 "dream" anchor ─▶ runDreamCycle
   ├─ collectObservations(store, now)  (PURE, non-sensitive)
   │     reminders (overdue/upcoming/stale) + calendar (gcal: snapshots) +
   │     decisions (listDecisions) + jobs/recall (failed jobs, open threads)
   │        → a plain-text observations digest
   ├─ one-shot LLM (curateLLM pattern, JSON-schema output)
   │     prompt = digest + last night's initiatives (anti-repeat) + "rank top N"
   │        → [{ title, why, suggestion }]  (≤ dreamTopN)
   └─ store kv  dream:latest = { date, initiatives }     (NEVER gate, NEVER vault, NEVER action)

07:30 morning brief ─▶ assembleBrief reads dream:latest (if from this night)
                         → BriefData.dreamInitiatives → "Dream" section in narration + note
```

### 1. The "dream" anchor (02:00)

- `src/config.ts`: add `anchorDream: process.env.AIOS_ANCHOR_DREAM ?? "02:00"`, `dreamTopN: Number(process.env.AIOS_DREAM_TOP_N ?? 3)`, and (optional) `dreamModel: process.env.AIOS_DREAM_MODEL ?? config.curatorModel`.
- `src/heartbeat/clock.ts`: widen `AnchorConfig.name` and `ClockDeps.onAnchor`'s param from `"morning" | "evening"` to `"morning" | "evening" | "dream"`. No other clock change — the `anchors` loop is generic; the fire-once kv stamp `anchor:dream:last` and same-day catch-up come free.
- `src/index.ts`: add `{ name: "dream", hhmm: config.anchorDream }` to the Clock's `anchors` array; in the `onAnchor` handler add an `if (name === "dream")` branch that calls `runDreamCycle({ store, vault, recall, dreamModel, topN, log, nowFn })` **fire-and-forget** (`void runDreamCycle(...).catch(...)`, mirroring the distiller wiring) so its LLM call never blocks the tick. The `"dream"` branch does **not** call `runBrief` (the brief is morning/evening-shaped).

### 2. `collectObservations(store, now)` — pure, non-sensitive

A pure function returning a structured plain-text digest (one section per source). It reads only non-sensitive state:

- **Reminders** — `store.listReminders("pending")`: split into **overdue** (`due_at < now`), **upcoming** (next 7 days), and **stale** (created long ago, far-future or no movement). A few lines each.
- **Calendar** — `store.kvByPrefix("gcal:")` snapshots (the same source the brief uses): the next 1–7 days of meetings; flag **overlaps/conflicts**, **unusually full** days, and **large gaps**. Titles + times only.
- **Decision journal** — `store.listDecisions(sinceN_days)`: recent verdicts; surface **recurring rejections** (same type rejected ≥2×) and high-frequency action types — signal about friction/patterns.
- **Jobs + second-brain** — recent `job.status` events (`listEventsSince`) for **failed/stalled** jobs; plus a small `recall(...)` over the `lifeops`/`code`/`general`/`research` domains for **open threads** (recently noted, not resolved). No `inbox` (email) domain.

The digest is bounded (each source capped to a handful of lines) and contains **no money data and no email content**. If every source is empty, return an empty digest (the caller then skips the LLM and stores nothing).

### 3. `runDreamCycle(deps)` — the one-shot pass + store

- Build the observations digest. If empty → log + return (no `dream:latest` write).
- Read the previous output `store.kvGet("dream:latest")` to feed the LLM an anti-repeat list.
- One-shot `query()` (curateLLM pattern) with a **JSON-schema `outputFormat`**: `{ initiatives: [{ title, why, suggestion }] }`, capped at `topN`. System prompt: a chief-of-staff persona that ranks what's most worth the operator's attention, suggests a concrete next step per item, and **explicitly avoids re-surfacing anything in the anti-repeat list or anything the decision journal shows was dismissed**. Read `msg.structured_output` on `result/success`; **on any failure return without writing** (no dream section that morning — fail-silent, exactly like the distiller).
- Store `store.kvSet("dream:latest", JSON.stringify({ date: localDate(now), initiatives }))`.
- **It never calls `gate.propose`, never queues an action, never writes the vault.** Its only persistence is the kv key.

### 4. Morning-brief integration

- `BriefData` gains `dreamInitiatives?: { title: string; why: string; suggestion: string }[]`.
- `assembleBrief(store, anchor, nowIso, since)`: when `anchor === "morning"`, read `dream:latest`; if its `date` matches the current night (today's local date), set `data.dreamInitiatives = parsed.initiatives`. Otherwise omit (stale/absent → no section).
- `renderBriefNote` and the narrator input include a **"Dream — worth considering"** section listing the initiatives (title + suggestion). The evening brief never shows it. If `dreamInitiatives` is empty/absent, no section is rendered.
- The dream content is non-sensitive (reminders/calendar/decisions/jobs), so writing it into the recall-indexed brief note is fine and even useful ("what did the dream cycle suggest last week?").

## Error handling — fail-safe, never break the tick, never leak

- `collectObservations` reads only — any read error on one source is caught and that section is omitted; the digest still builds from the rest.
- The LLM pass returns silently on any failure (timeout, bad JSON, model error) → no `dream:latest` write → no dream section that morning. Never throws.
- `runDreamCycle` is invoked fire-and-forget from `onAnchor` with a `.catch` log; the anchor loop in `clock.ts` is already try/caught, so a dream failure never affects reminders or other anchors.
- The dream cycle never reads `personal_*` (money) tables and never touches email content — the privacy walls hold by construction.
- A malformed/old `dream:latest` (e.g. JSON parse error, or a date from a prior day) → the brief simply omits the section.

## Testing

- **`collectObservations`**: with seeded reminders/calendar-snapshots/decisions/job-events, the digest contains the expected overdue reminder / conflict / recurring rejection / failed job lines; empty state → empty digest; a throwing source is skipped, others still appear; **asserts no `personal_*` read** (money excluded) and no email content.
- **`runDreamCycle`** (stubbed LLM): a non-empty digest → the injected classifier's ranked initiatives are stored in `dream:latest` with today's date, capped at `topN`; an empty digest → no kv write; an LLM failure (throw / non-success) → no kv write (fail-silent); the previous `dream:latest` is passed to the LLM as anti-repeat context.
- **Brief integration**: a `dream:latest` dated today → the morning brief's `BriefData.dreamInitiatives` is populated and the rendered note/narration contains the "Dream" section; an evening brief never includes it; a stale-dated or absent `dream:latest` → no section.
- **Anchor**: a `"dream"` anchor fires once per day via the kv stamp; the dream handler does not run `runBrief`; an error in the dream handler doesn't stop reminders/other anchors.
- **Privacy**: a test confirms `collectObservations` makes no call that reads bank tables and the dream output never includes money/email-content; the brief note remains safe.

## Build stages (one spec, ordered)

1. **Observations compiler** — `collectObservations(store, now)` (pure) + tests. Shippable alone (no behavior change yet).
2. **Dream cycle + anchor** — `runDreamCycle` (LLM pass + kv store) + the `"dream"` anchor (config + clock union + index wiring) + tests. The pass runs nightly and stores `dream:latest`; nothing surfaces yet.
3. **Morning-brief integration** — `BriefData.dreamInitiatives` + assemble + render + tests. The "Dream" section goes live in the morning brief.

## Out of scope (this cycle / later)

- **Speculate** — overnight autonomous *work* (research digests, drafted replies, code spikes in isolated git worktrees), its outputs landing as proposals. Its own next spec; it consumes propose's ranked initiatives as a work-list and needs new machinery (overnight job orchestration, worktree lifecycle, cost/time budgeting, a heavier safety story).
- **Queued gated actions from the dream cycle** — propose v1 is read-only (brief only). Auto-constructing `email.draft`/`vault.write` proposals is deferred (overlaps with speculate).
- **Money initiatives** — money already has its own proactive watcher (budget/renewal/recurring/large-tx) pushing direct to the private chat; folding money into the dream cycle would fight the privacy wall for no added value.
- **Email-content scanning** — inbound email is deliberately unindexed (security); the inbox triage already handles it.
- **A Mission Control "dream" view / history UI** — surface is the morning brief for v1.
- **User feedback loop on initiatives** (thumbs-up/down to train ranking) — later if the surfaced initiatives prove useful.
