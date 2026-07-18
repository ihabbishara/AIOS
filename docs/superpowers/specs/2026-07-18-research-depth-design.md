# Research depth — design spec (⑤c)

Date: 2026-07-18
Status: approved

## Problem

Research today is one 25-turn clio run (hand_off or the `research-report` playbook's single
clio⇄minos loop). One agent, one pass, prose-only review: no parallel angles, and minos cannot
open a cited URL — citation quality is judged on vibes.

## Decision

Deep research runs through the **existing goal engine** via `plan_goal(research)`. Clio (research
lead) plans a fan-out graph: parallel sub-question `run` nodes → one cited-synthesis `loop` node.
Minos gains WebFetch and verifies citations during critic rounds. The only new code is a small,
generic **planner doctrine hook**; no new engine node types, no new bus event types, no new deps.

Rejected alternatives:
- **Fanout playbook stage type** — runtime node-spawning in the journaled engine buys only skeleton
  determinism (sub-questions are LLM-generated either way) at the highest-risk spot in the codebase.
  Remains available as an upgrade if planner-shaped fan-out proves flaky.
- **Deeper single run** — no parallelism, no structural verification.

## Components

### 1. Planner doctrine hook (only new code)

- `departmentSchema` (src/agents/registry/types.ts:26) gains optional `plannerDoctrine: z.string()`.
  Flows through `LoadedDepartment` to the planner with no loader changes.
- `planningBrief()` (src/engine/plan.ts) appends a `# Department doctrine` section when the goal's
  department carries one. Export the function for unit testing.
- Generic: any department may adopt doctrine later; absent field = today's behavior, byte-identical
  brief.

### 2. Research doctrine (agents/research/department.yaml — hand-authored, normal Edit)

Doctrine text instructs the planning lead:
- Deep or multi-angle goals: fan out 2–5 parallel `run` nodes, one per sub-question — clio for
  general investigation, janus for market angles, borrow odin (engineering) for technical ones.
  Fan-out nodes have no deps between them; each brief demands recent primary sources, cited URLs
  for every load-bearing claim, and `save_source` for reusable finds.
- Final `loop` node (producer clio, critic minos) depending on all fan-out nodes: merge into one
  report with inline citations, known-vs-newly-found distinction, filed under `knowledge/`.
- Scale to the question: a small question is a single node; do not pad graphs.

### 3. Minos verification teeth (agents/research/minos.yaml)

- tools: add `WebFetch`. maxTurns 15 → 20 (fetch rounds cost turns).
- prompt: add a sourcing axis — spot-check load-bearing citations by fetching them; a dead URL or
  a source that does not support its claim is a revise verdict naming the claim. Keeps
  `outputSchema: verdict`; loop validation is unchanged.

### 4. Hermes routing (src/moderator/tools.ts — thin, no test)

`plan_goal` tool description gains the research example: deep/multi-angle research →
`plan_goal(research)`. `hand_off(clio)` stays the quick-lookup path; `run_playbook
research-report` stays the standard single-report path.

## Untouched

Engine node types and tick loop, playbook schema/compilation, clio/janus manifests (doctrine
carries planning guidance), ARTIFACT_CHAR_LIMIT 12k (2–5 sub-reports fit a synthesis brief),
MAX_NODES 12, replan machinery (node-failure path already exists), triage rules (plan_goal
already emits `route.decision`).

## Error handling

Doctrine rides the planner's existing reject-retry loop: a plan violating graph rules fails
`validateGraph` and the lead retries once with the error appended. Node failures hit existing
replan. No new failure surface.

## Testing

- Root vitest: `departmentSchema` parses `plannerDoctrine` (and defaults absent);
  `planningBrief` includes the doctrine section when present and omits it when absent;
  research department.yaml loads with doctrine via the real loader.
- Live smoke after deploy: send hermes a deep multi-angle research request → plan preview shows
  parallel fan-out + synthesis loop; goal completes; report carries inline citations; minos
  critic rounds show WebFetch spot-checks.
