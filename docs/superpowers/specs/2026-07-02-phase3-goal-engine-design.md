# Phase 3 — Goal Engine: task graphs, department leads, daily budget

**Date:** 2026-07-02
**Status:** Approved design, pending implementation plans (3a engine, 3b cockpit)
**Scope:** Phase 3 of the org redesign (spec lineage: `2026-07-02-agent-registry-legibility-design.md` §Vision)

## Problem

Phase 1 gave AIOS one registry and one routing brain; Phase 2 made the org visible. But work execution is still two-shaped and single-file:

1. **Linear only.** Playbooks run stages strictly in sequence; `AIOS_MAX_CONCURRENT_JOBS` defaults to 1. A goal like "design X, implement it, write docs, test, review" cannot run its independent parts in parallel.
2. **No decomposition.** Hermes can dispatch one playbook or one hand_off at a time. Nobody turns a big goal into a coordinated set of tasks; the user is the planner.
3. **Leads are decorative.** `department.yaml lead:` is read by nothing but the org UI.
4. **No spend control.** Cost is observable (agent.end events, /api/costs) but nothing enforces a ceiling; a runaway overnight job spends without bound.

## Decisions locked (user-approved in brainstorm, 2026-07-02)

1. **V1 scenario: single-department goals.** User → hermes → dept lead decomposes into a task graph; cross-dept goals are a later phase.
2. **Budget: daily global cap only.** No per-goal budgets in v1.
3. **Cap gates background work only.** Graph nodes, dream, speculate. Direct chat always answers; triage/briefs exempt. Paused goals resume automatically next day.
4. **Unified engine.** One runtime for all multi-step work; the old linear executor is deleted (not kept alongside).
5. **Playbooks compile to graphs.** Playbook YAML stays the SOP authoring format, untouched on disk; the loader compiles stages → nodes with identical semantics, parity-pinned before the old executor dies. `code_task` stays the only entry for code playbooks.
6. **Plan gate: preview, auto-start, interruptible.** Lead posts the plan to chat, execution starts immediately, `/pause` and `/abandon` intercept deterministically. No approval round-trip (daily budget bounds damage).
7. **UI: full DAG canvas** in Mission Control (hand-rolled SVG — no new npm deps).
8. **Data model: new `goals` + `task_nodes` tables; `jobs`/`stages` retired.** `code_task`/`run_playbook` become facades that compile to goals.

**Untouchable moat (unchanged from Phase 1 spec):** action gate + trust ledger, privacy walls (recall exclusions, private visibility, privateMemo), 5-layer code sandbox, senses, voice, integer-cents money math, playbooks-as-SOPs.

## Design

### 1. Node model — stage primitives generalized to a DAG

Three node types, exactly today's stage primitives:

- **`run`** — one agent, one brief, one artifact.
- **`loop`** — producer + critic rounds (`maxRounds` 1–5, default 3). Critic **must** carry the VERDICT output schema — the existing invariant (playbook-critics pin) becomes a compile/validation rule.
- **`verify`** — runner + fixer rounds (`maxRounds` 1–5, default 2).

A goal is a DAG of nodes; edges are `depends_on`. The linear playbook chain is the degenerate case (each node depends on the previous one).

### 2. Data model

New tables in `src/store/db.ts` (integer cents for money, ISO strings for time, mirroring existing conventions):

**`goals`**: `id` (uuid), `slug`, `title`, `request`, `department`, `lead`, `origin_channel`, `origin_chat_id`, `status` (`planning | running | paused-budget | paused-user | replanning | done | failed | abandoned`), `project_dir` (nullable), `goal_dir` (vault dir name), `plan_summary`, `replans_used` (int, default 0), `error` (nullable), `created_at`, `updated_at`.

**`task_nodes`**: `goal_id`, `node_key` (short slug, unique per goal), `type` (`run | loop | verify`), `agent`, `critic` (nullable; loop critic / verify fixer), `brief`, `depends_on` (JSON array of node_keys), `max_rounds` (int), `status` (`pending | ready | running | done | failed | skipped`), `artifact` (nullable vault-relative path), `cost_cents` (int, default 0), `rounds_used` (int, default 0), `error` (nullable), `started_at`, `finished_at`. UNIQUE(goal_id, node_key).

**`budget_ledger`**: `date` (YYYY-MM-DD, PK), `spent_cents` (int). Incremented by an `agent.end` bus listener (NOT derived from the 5000-event history window — heavy days would truncate). All agent runs count toward the ledger (chat included — the ledger is the truth of spend); only *enforcement* distinguishes background from chat.

`jobs` + `stages` tables are dropped at the end of the 3a migration (see §10).

### 3. Playbook compiler

`compilePlaybook(pb: Playbook) → GraphSpec` in `src/engine/compile.ts`:

- `single` stage → `run` node.
- `loop` stage → `loop` node (producer, critic, maxRounds carried over).
- `verify` stage → `verify` node (runner, fixer, maxRounds).
- Stage order → linear `depends_on` chain.
- Brief text, artifact chaining (each node's context includes prior artifacts, as `contextBlock` does today), and `needsProjectDir` semantics carry over unchanged.

**Parity pins:** before the old executor is deleted, tests pin per stage type: agents invoked in order, verdict rounds honored (approve stops the loop, revise continues, round cap respected), fixer rounds honored, artifacts written with the same names/flow into later briefs, SessionLimitError converts to hard failure. The old executor's observable behavior is the fixture.

### 4. Lead planner

**Entry:** new moderator tool `plan_goal(department, title, request)` (hermes-only). Hermes picks the department by charter match and says so; `route.decision` gains `via: "plan"` (union extension in `src/events.ts`). Deterministic bypasses unchanged.

**Planning run:** the dept lead (from `department.yaml lead:`) runs one-shot through its normal dept resolution with a planning prompt and structured output:

```
GRAPH_SCHEMA = {
  summary: string,
  needsWorkspace: "greenfield" | "worktree" | "analyze" | "none",
  projectDir?: string,
  nodes: [{ key, type: "run"|"loop"|"verify", agent, critic?, brief, deps: string[] }]
}
```

**Code-side validation, fail-closed (`validateGraph` in `src/engine/plan.ts`):**
- every `agent`/`critic` resolves via `registry.agentOf` to a member of the lead's department (single-dept v1; hermes/operations excluded as node agents);
- `loop` nodes: `critic` present and its manifest carries `outputSchema: verdict`; `verify` nodes: `critic` (fixer) present and the `agent` (runner) manifest carries `outputSchema: test-report` — the faithful port of today's critic invariants;
- `deps` reference existing keys; topological sort succeeds (no cycles);
- node count ≤ 12; `key` matches `[a-z][a-z0-9-]*`;
- `projectDir` (when present) passes the existing inplace/projectsRoot assertions.

Invalid plan → one retry with the validation error appended → still invalid → goal `failed` ("planning failed: …"), nothing executed, user notified.

**Plan preview:** the plan (summary + node list with agents/deps) posts to the origin chat; execution starts immediately.

**Re-planning:** on node failure, the lead is re-invoked with the current graph state (node statuses, the failure's error + artifact tail) and returns patch ops: `replace(node_key, node)`, `add(nodes)`, `abandon(reason)`. Same validation. `replans_used` capped at 2; cap exhausted → goal `failed` with a summary to chat.

**`skipped` semantics:** when a goal is abandoned (user `/abandon` or a lead `abandon` patch) or fails terminally, all unfinished nodes (`pending`/`ready`) become `skipped`. `skipped` is terminal and never satisfies a dependency.

### 5. GoalEngine (scheduler)

`src/engine/goals.ts` replaces JobManager/Executor:

- **pump():** a node is `ready` when all `depends_on` are `done`. Run ready nodes up to `AIOS_MAX_CONCURRENT_NODES` (global, default 2; replaces `AIOS_MAX_CONCURRENT_JOBS`). FIFO across goals.
- **Node run:** through the same `specialistOptions`/dept-resolution path as `hand_off` and `@mention` — the Phase 1 capability-parity invariant extends to graph nodes by construction. Loop/verify rounds implemented in the engine (porting today's executor round logic). Per-node wall time: `AIOS_JOB_WALL_TIME_MS` unchanged.
- **Cost:** node's runs report costUsd → accumulate `task_nodes.cost_cents` + `budget_ledger`.
- **Artifacts:** vault `goals/<YYYY-MM-DD>-<slug>/<node_key>.md` (+ plan.md for the graph). Same VaultWriter traversal guards.
- **Workspace:** allocated once per goal at start (`allocateWorkspace` modes unchanged); all nodes share `project_dir` (as stages share cwd today). Unsandboxed-write gate (`isUnsandboxedWrite`, registry-required fail-closed) checked at goal creation exactly as at job creation today. **Inplace mode is facade-only:** `code_task(mode: inplace)` keeps its existing gate + `assertInplaceTarget` path; lead-planned goals cannot request inplace (GRAPH_SCHEMA's `needsWorkspace` deliberately omits it — sandboxed modes only).
- **Completion:** `onComplete` posts outcome + artifact list to the origin chat (same UX as jobs today).
- **Events:** `goal.created {goalId,title,department}`, `goal.status {goalId,status,error?}`, `node.status {goalId,nodeKey,status,agent,error?}` — new `AiosEvent` members. `stage.start/finish`, `job.created/status` retired with the old engine.
- **Restart recovery:** startup-only sweep (mirrors gate `failStaleExecuting`'s startup-only rule): nodes `running` at boot reset to `pending` — they simply re-run, preserving today's resume-and-re-run-the-incomplete-stage behavior; goals in `running`/`replanning` resume via pump. Re-plans are reserved for genuine node failures, never burned by a restart. Never run the sweep on an interval.

### 6. Budget enforcement

`SpendGuard` (`src/engine/budget.ts`): `allow(kind)` where kind ∈ `node | dream | speculate`.

- `AIOS_DAILY_BUDGET_USD` unset → always allow (current behavior preserved).
- Set → allow while `budget_ledger[today] < cap`. Checked **before scheduling** each background run; running nodes always finish (no mid-flight kills).
- At cap: goals with unscheduled work → `paused-budget`; ONE Telegram ping per day ("daily budget reached — paused N goals, resumes tomorrow"; kv stamp `budget:pinged:<date>`).
- Resume: heartbeat clock tick after midnight flips `paused-budget` goals back to `running`; pump picks them up.
- Exempt: direct chat, triage, briefs, senses. (Ledger still records their cost; guard just isn't consulted.)
- Dream/speculate call `SpendGuard.allow` before their runs.

### 7. Facades and entry points

- **`code_task`** (only entry for code playbooks, unchanged contract): compiles the mapped playbook → creates a goal (department = playbook owner via `ownerOfPlaybook`, lead attribution from dept manifest). Same argument surface, same notifications.
- **`run_playbook`**: same treatment for non-code playbooks.
- **`plan_goal`**: the new lead-planned path (§4).
- **`job_status`** → **`goal_status`** (moderator tool): by id or 10 recent, rendering nodes instead of stages. Old name kept as alias for a transition window.
- **`/pause <goal>` / `/resume <goal>` / `/abandon <goal>`**: deterministic router intercepts (like `/approve`); abandon requires the goal slug to match. Paused-user goals never auto-resume.

### 8. Privacy

- Goal creation passes the same `isPrivateOrigin` wall as `hand_off`: a department whose lead (or any planned agent) is `visibility: private` refuses non-private origins, fail-closed when primary chat unset. Concretely: finance goals (lead midas) are private-origin only.
- `validateGraph` re-checks each planned agent's visibility against the goal origin (defense in depth — re-plans included).
- Goal/node artifacts follow existing vault rules; no personal_* / bank / email content enters goal briefs by any new path. Recall exclusions untouched.

### 9. Mission Control (plan 3b)

**API (token gate):** `GET /api/goals` (list + node summaries), `GET /api/goals/<id>` (full graph: nodes, deps, statuses, per-node cost/artifact/rounds, replan history), `POST /api/goals/<id>/pause|resume|abandon`, `GET /api/budget` (`{date, spentCents, capCents|null}`). `goal.*`/`node.*` events on the existing SSE stream. `/api/jobs` and the board tab are removed (facade means all work is goals).

**Goals tab with DAG canvas** (hand-rolled SVG, no new deps; graphs ≤12 nodes):
- topological layering → columns; node boxes colored by status (pending dim, ready cyan, running amber sweep, done phosphor, failed alert, skipped struck);
- bezier edges between layers;
- click node → side panel: brief, artifact preview, cost, rounds, error;
- goal header: status, department/lead, pause/resume/abandon buttons, replan history;
- budget bar in the app header: spent/cap, alert color ≥80% (hidden when no cap).
- Org tab agent cards deep-link to the node an agent is currently running.

### 10. Migration (inside plan 3a, ordered)

1. Tables + compiler + GoalEngine land behind tests (old engine still wired).
2. Parity pins green → facades flip (`code_task`/`run_playbook` create goals).
3. Old executor, JobManager, `jobs`/`stages` tables, `job.*`/`stage.*` events, `/api/jobs`, packs-view recentJobs/workspaces readers switch or die. Suite invariants (capability pins, privacy pins, critic pins) all green.
4. Old vault `jobs/` directories remain on disk (read-only history).

No data migration for historical jobs (they're event/vault history, not live state).

### 11. Error handling

- Planner invalid output → retry once → fail goal, notify. Nothing partial runs.
- Node failure → re-plan (≤2) → goal failed with node-level summary.
- SessionLimitError → node failed, goal `paused-user` (quota won't heal by re-planning; user resumes after reset).
- Budget cap → `paused-budget`, auto-resume next day.
- Daemon restart → startup sweep + resumable graphs (§5).
- Unknown department / no lead defined → `plan_goal` returns error string to hermes (no crash), suggests hand_off/playbook instead.

### 12. Testing

- **Compiler parity:** single/loop/verify semantics pinned against old-executor behavior (verdict rounds, fixer rounds, artifact chaining, session-limit hard-fail), then old executor deleted.
- **Planner:** cycle rejection, foreign-dept agent, private-agent-from-shared-origin, non-VERDICT critic, node cap, bad key, retry-then-fail.
- **Scheduler:** dep readiness, parallel cap honored, FIFO across goals, wall-time, restart sweep + resume, replan cap.
- **Budget:** ledger integer-cents accumulation from agent.end, cap pause, midnight resume, single daily ping, unset-cap no-op, dream/speculate gated.
- **Facades:** code_task produces same sandbox modes/notifications/artifact layout as before (compat pins).
- **Privacy:** finance-goal origin refusal (create + re-plan), recall exclusions untouched, personal_* never in briefs.
- **Capability parity:** node-run tools ≡ hand_off ≡ @mention for every agent (extends the Phase 1 pin).
- Suite baseline 742 + 1 skip; tsc/build/ui clean at every merge.

### 13. Explicitly out of scope (later phases)

Cross-department goals, per-goal budgets, plan approval gating / goal.plan trust type, agent mailbox/standups (Phase 4), overnight autonomy through leads + eval loop (Phase 5), fancy canvas interactions (zoom/drag), Gantt/timeline views, model-tier selection per node.
