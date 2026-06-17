# AI-OS — Phase 8 Dream Cycle: Speculate (Research) — Design

**Date:** 2026-06-17
**Status:** Approved (brainstorm complete, awaiting implementation plan)
**Trigger:** The cognitive-kernel "dream cycle" is consolidate → propose → speculate. Consolidate (Phase 6 distiller) and propose (`2026-06-17-dream-cycle-propose-design.md`, live) are shipped. This spec is the **first slice of speculate**: run cheap, read-only **overnight research** on the worthwhile initiatives the propose step surfaced, landing reviewed notes for the morning. The riskier slice — **drafted email replies** (untrusted email content + a recall-privacy story) — is decomposed into its own next cycle and reuses the orchestration this spec builds. Code spikes in worktrees are deferred indefinitely (no worktree machinery exists).

## Summary

A new **03:00 "speculate" heartbeat anchor** runs after the 02:00 dream-propose pass. It reads propose's `dream:latest` initiatives, runs a **one-shot LLM planner** that picks at most **K** initiatives genuinely worth overnight research and writes a research question for each, then enqueues a `research-report` job per task via the **existing JobManager** (origin `{channel:"system", chatId:"speculate"}`). The jobs run serially (concurrency 1), each producing a reviewed note in the vault. The **07:30 morning brief** renders a "Speculate — researched overnight" section listing the finished notes. It is bounded by a simple **K-job cap**, uses only the **read-only `researcher`/`reviewer`** roles (no Bash-unattended, no worktree, no outward effect), and produces **read-only vault notes — no gated action** (the gate path belongs to the email-drafts cycle). Failure costs nothing (a failed job surfaces in the brief and self-contains). Inputs are non-sensitive — propose already excludes money and email.

## Requirements (from brainstorm)

| Decision | Choice |
|---|---|
| Scope | **Overnight research only.** Email drafts = its own next cycle (reuses this orchestration); code spikes deferred (no worktree machinery) |
| Input | Propose's `dream:latest` initiatives (non-sensitive) |
| Planning | A **one-shot LLM planner** turns initiatives → ≤K research questions (or none); anti-repeat against recent speculate output |
| Execution | `JobManager.createJob({playbook:"research-report", channel:"system", chatId:"speculate"})` — reuses the engine + read-only `researcher`/`reviewer` loop; serial (concurrency 1) |
| Output | Reviewed vault notes (`jobs/<date>-<slug>/report.md`) — **read-only, no gated action** |
| Surface | A "Speculate — researched overnight" section in the **morning brief** |
| Budget | A **K-job cap** (`AIOS_SPECULATE_MAX_JOBS`, default 2). Full token/cost-budget enforcement deferred |
| Trigger | A new **03:00 "speculate" anchor** (after the 02:00 dream anchor) |

## Existing foundation (reused, not rebuilt)

- **Heartbeat anchors** (`src/heartbeat/clock.ts`) — `AnchorConfig.name` / `ClockDeps.onAnchor` are a `"morning" | "evening" | "dream"` union (propose widened them); this spec adds `"speculate"`. Fire-once kv stamp (`anchor:speculate:last`) + same-day catch-up come free; the anchor loop is try/caught (`clock.ts:66`), so a speculate failure can't break reminders/other anchors. Config at `src/config.ts` (`anchorMorning`/`anchorEvening`/`anchorDream`). Clock built in `src/index.ts` (the `onAnchor` handler with the `if (name === "dream")` branch is the template).
- **The propose output** (`src/heartbeat/dream.ts`) — `dream:latest = {date, initiatives}` where `initiatives: Initiative[]` and `Initiative {title, why, suggestion}`. Speculate reads it back exactly as the morning brief does (date-gated to the current night).
- **The JobManager** (`src/engine/jobs.ts`) — `createJob({playbook, title, request, projectDir?, channel, chatId}): JobRow` is the single public entrypoint; it inserts, emits `job.created`, and pumps the queue. It is **non-chat callable** — the distiller already uses a `{channel:"system"}` origin elsewhere. Concurrency `config.maxConcurrentJobs` (default 1); per-job wall-time `config.jobWallTimeMs` (default 2h). The one shared instance is built in `src/index.ts`.
- **`playbooks/research-report.yaml`** — `needsProjectDir: false`; a single `loop` stage (`producer: researcher`, `critic: reviewer`, `maxRounds: 2`) producing a reviewed report. The ideal speculate primitive (no worktree, read-only roles).
- **Job completion + surfacing** — a finished job writes its artifact under `jobs/<date>-<slug>/<stage>.md` (`executor.ts` → `vault.writeJobArtifact`), fires `job.status` (`done`/`failed`), and calls `onComplete(outcome)` with `JobOutcome.artifactFiles`. The brief already surfaces finished/failed jobs (`briefs.ts` `jobsFinished`/`jobsFailed` from `job.status` events) and pending approvals.
- **The one-shot LLM pattern** — `dreamRankLLM` (`dream.ts`) / `modelClassifier` (`triage.ts`): `query` with `allowedTools:[]`, `maxTurns:1`, `settingSources:[]`, `persistSession:false`, `outputFormat: json_schema`, read `structured_output`, return a safe default on any failure. The speculate planner copies this.
- **Cost telemetry** — `agent.end.costUsd` events feed `/api/costs` (report-only). No budget *enforcement* exists; v1 bounds cost via the K-job cap, not token accounting.

## Architecture

```
02:00 dream anchor ─▶ runDreamCycle → dream:latest {date, initiatives}   (propose; already live)

03:00 speculate anchor ─▶ runSpeculate
   ├─ read dream:latest (today's initiatives); if none/stale → return
   ├─ one-shot LLM planner: initiatives + recent speculate output (anti-repeat)
   │        → ≤K research tasks [{ title, question }]   (or none)
   ├─ for each task: jobs.createJob({ playbook:"research-report",
   │        title, request: question, channel:"system", chatId:"speculate" })   (serial, read-only)
   └─ store kv speculate:latest = { date, tasks:[{title, slug}] }

…jobs run (concurrency 1) → reviewed note jobs/<date>-<slug>/report.md, fire job.status done…

07:30 morning brief ─▶ assembleBrief reads speculate:latest (this night) + the jobs table
                         → BriefData.speculateResults → "Speculate — researched overnight" section
```

### 1. The "speculate" anchor (03:00)

- `src/config.ts`: add `anchorSpeculate: process.env.AIOS_ANCHOR_SPECULATE ?? "03:00"`, `speculateMaxJobs: Number(process.env.AIOS_SPECULATE_MAX_JOBS ?? 2)`, and (optional) `speculateModel: process.env.AIOS_SPECULATE_MODEL ?? process.env.AIOS_SPECIALIST_MODEL`.
- `src/heartbeat/clock.ts`: widen `AnchorConfig.name` and `ClockDeps.onAnchor` to add `"speculate"`.
- `src/index.ts`: push `{ name: "speculate", hhmm: config.anchorSpeculate }` to the `anchors` array **after** the dream anchor; add an `if (name === "speculate") { void runSpeculate(...).catch(log); return; }` branch in `onAnchor` (early-return before `runBrief`, mirroring the dream branch). Fire-and-forget so the anchor tick isn't blocked.

### 2. `runSpeculate(deps)` — the planner + enqueue

`runSpeculate({ store, jobs, plan, maxJobs, nowFn?, log? })`:
1. Read `dream:latest`; parse; if absent, not from the current night, or no initiatives → log + return (no work).
2. Read the prior `speculate:latest` for anti-repeat context (its task titles).
3. Run the injected `plan(initiatives, recentTitles)` → `ResearchTask[]` (`{title, question}`), already capped at `maxJobs` by the planner prompt; defensively `slice(0, maxJobs)`. Empty → store nothing, return.
4. For each task: `const job = jobs.createJob({ playbook: "research-report", title: task.title, request: task.question, channel: "system", chatId: "speculate" })`. Collect `{title: task.title, slug: job.slug}`.
5. Store `store.kvSet("speculate:latest", JSON.stringify({ date: localParts(now).date, tasks }))`.
6. Read-only: it NEVER calls `gate.propose`, NEVER writes the vault directly (the jobs do that under `jobs/`), NEVER emits an event beyond what `createJob` does. Each `createJob` is wrapped so one failure doesn't abort the rest. `plan` failure → log + return (no jobs, no kv write).

`jobs` is the existing `JobManager` (already a `main()` local). The injected `plan` is the real `speculatePlanLLM`; tests pass a stub. `JobManager.createJob` is synchronous and returns immediately (the work runs async via the pump), so enqueuing K jobs does not block.

### 3. `speculatePlanLLM(model)` — the one-shot planner

`(initiatives: Initiative[], recentTitles: string[]) => Promise<ResearchTask[]>` — a one-shot `query` (curate/triage pattern) with `outputFormat: json_schema` `{ tasks: [{ title, question }] }`. System prompt: a chief-of-staff researcher who selects ONLY initiatives that genuinely benefit from web/literature research (skip pure reminders/scheduling), writes a focused research question for each, returns **at most K**, and avoids anything in `recentTitles`. Returns `[]` on any failure (fail-silent). The `question` becomes the job's `request` (the research brief).

### 4. Morning-brief "Speculate" section

- `BriefData` gains `speculateResults?: Array<{ title: string; status: "done" | "failed" | "running"; ref: string | null }>` (`ref` = the artifact path when done).
- `assembleBrief` (morning only): read `speculate:latest`; if from the current night, for each task look up the job by slug (`store.getJobBySlug` or scan `store.listJobs` — see note) to resolve `status` + the artifact path (`jobs/<dir>/report.md`); set `speculateResults`. Stale/absent → omit.
- `renderBriefNote` adds a "Speculate — researched overnight" section: done → `${title} — ${ref}`, failed → `${title} — failed`, running → `${title} — still running`. Evening never shows it. Counted in `isEmptyBrief` so a morning carrying only speculate results still narrates. The narrator gets `speculateResults` for free via the `BriefData` JSON.

> Note: a `getJobBySlug`/job-lookup helper may need adding to `Store` if one doesn't exist; the plan pins the exact lookup (the jobs table already stores `slug`).

## Safety & budget

- **Read-only work.** `research-report` uses only `researcher` (Read/Grep/Glob/WebSearch/WebFetch) + `reviewer` — no Bash, no Write, no Edit, no outward effect. Even running unattended, a speculate job cannot send email, move money, or change files. The note it writes is to the vault under `jobs/`.
- **No gated action from research.** Speculate never calls `gate.propose`; pure research has no outward effect, so there is nothing to approve — the note is surfaced for reading. (The email-drafts cycle adds the gated path.)
- **Bounded.** At most `speculateMaxJobs` (default 2) jobs per night; serial (concurrency 1); each ≤ the 2h wall-time ceiling (research jobs finish in minutes, well inside 03:00→07:30). The K-cap is the cost bound for v1; token-budget enforcement is deferred.
- **Fail-safe.** Planner error / no initiatives → no jobs, no kv write. A failed research job surfaces in the brief's `jobsFailed` (and `speculateResults` status `failed`) and self-contains. The anchor handler is fire-and-forget with `.catch`; the clock loop is try/caught — a speculate failure never affects reminders or other anchors.
- **Non-sensitive inputs.** Initiatives come from propose, which already excludes money (`personal_*`) and email content. Research topics are therefore non-sensitive, and the notes (recall-indexed under `jobs/`) carry no bank/email data.

## Error handling

- Absent/stale/malformed `dream:latest` → no work (return). Malformed `speculate:latest` on the brief read → omit the section (caught).
- `createJob` throws (e.g. unknown playbook) → caught per task, logged; remaining tasks still enqueue; partial progress is fine.
- A research job that fails or overruns wall-time → `job.status failed` → surfaced as `failed` in the brief; never retried beyond the executor's existing one-retry-per-stage.
- The planner returning a malformed/oversized list → coerced (non-array → `[]`; `slice(0, maxJobs)`).

## Testing

- **`speculatePlanLLM` wiring** is exercised via `runSpeculate` with a stub `plan` (the real LLM isn't unit-tested, mirroring `dreamRankLLM`).
- **`runSpeculate`**: with a fresh `dream:latest` + a stub `plan` returning 3 tasks and `maxJobs:2` → exactly 2 jobs are `createJob`'d (cap enforced) and `speculate:latest` stores 2 tasks with today's date; a stub JobManager records the calls (`playbook:"research-report"`, `channel:"system"`, `chatId:"speculate"`, the question as `request`). No `dream:latest` / stale date / empty initiatives / empty plan → no jobs, no kv write. `plan` throws → no jobs, no kv write (fail-silent). Prior `speculate:latest` titles are passed to `plan` as anti-repeat.
- **Brief integration**: a `speculate:latest` dated this night + matching done/failed jobs → `BriefData.speculateResults` populated with the right status + artifact ref; the rendered note has the "Speculate — researched overnight" section; evening never includes it; stale/absent → omitted; a speculate-only morning is not "empty".
- **Anchor**: a `"speculate"` anchor fires once/day; its handler runs `runSpeculate` and does NOT run `runBrief`; an error doesn't stop other anchors.
- **Safety**: `runSpeculate` only ever calls `jobs.createJob` (no `gate.propose`, no `vault.write`, no `email.*`); the playbook used is `research-report` (read-only roles).

## Build stages (one spec, ordered)

1. **Planner + runSpeculate** — `speculatePlanLLM` + `runSpeculate(deps)` (with an injected `plan` + a stub-able JobManager) + tests (cap, fail-silent, anti-repeat, system origin). New `src/heartbeat/speculate.ts`. Shippable headless (enqueues jobs; nothing surfaces yet).
2. **03:00 anchor + config** — `anchorSpeculate`/`speculateMaxJobs`/`speculateModel` + the clock union widening + the `onAnchor` speculate branch + wiring. The nightly pass runs and enqueues research.
3. **Morning-brief Speculate section** — `BriefData.speculateResults` + the job-lookup + assemble + render + `isEmptyBrief` + tests. The overnight research surfaces in the brief.

## Out of scope (next cycles / later)

- **Drafted email replies** — the next speculate cycle. Reuses this orchestration but adds reading inbound **email content** unattended (a new access path the system avoids today) and a **recall-privacy story** (the draft preview must not leak email content into the recall-indexed brief — route to private chat / generic previews, like the money wall). Its own spec.
- **Code spikes in isolated git worktrees** — no worktree-lifecycle machinery exists in the daemon; agents running Bash unattended is the heaviest safety story. Deferred indefinitely; its own spec if ever.
- **Real token/cost-budget enforcement** — the vision's per-job `token_budget` + daily global budget + priority/deadline queue. v1 bounds cost with the K-job cap only; the full budget system is a separate effort.
- **A pre-approval registry** — "which initiative types may run unattended." v1 runs only read-only research, which needs no per-initiative approval; an allowlist matters once outward-effecting work (drafts/spikes) is added.
- **A Mission Control speculate view** — surface is the morning brief for v1.
