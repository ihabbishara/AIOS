# Persona Content Pass — Design Spec

Date: 2026-07-18
Cycle: ⑤a in the platform-evolution series (before media/research modalities). Companion to
the persona-explorer tooling cycle (2026-07-16) — that built the shelf; this writes the books.

## Problem

12 of 15 agent manifests carry ~17–22-word charters, ~15–21-word personas, and ~50–110-word
prompts. Since `systemPrompt = persona + "\n\n" + prompt (+ promptSuffix)` (loader.ts:70),
this thinness is live behavior: agents get almost no process guidance, quality bar, or
edge-case policy. Charters also feed routing/handoff decisions and UI cards. Only hermes
(577w), halalo (597w), and juno (395w) have substantial prompts.

## Scope (locked)

- Rewrite charter/persona/prompt of all 15 agents to a house template; hermes, halalo, juno
  get **alignment-only** edits (template headers where missing, no rewrite — already rich).
- Review in **4 department batches** (engineering 6 → research 4 → finance 2 →
  life/ops/clients 3), each batch: edit → diff shown → user approves → commit.
- Pure YAML content. No code changes. No changes to `name`, `tools`, `maxTurns`,
  `permissionMode`, `aliases`, `kind`, `capabilities`, `outputSchema`, `department`.
- Role boundaries themselves unchanged (no merge/split/retitle — that was the rejected
  "deep redesign" option).

## The house template

**charter** — ~40–70 words, third person. Four beats: what I own · what you hand me
(inputs) · what I return (outputs) · one boundary line (what I do NOT do / who to route to
instead). This is routing + UI copy: boundary beats adjectives.

**persona** — ~30–50 words, third person. Only traits that change decisions: risk posture,
verbosity, escalation habits, what they refuse, how they verify. No vibes-only adjectives
("insightful", "passionate"). This is line 1 of the live system prompt.

**prompt** — ~150–350 words, second person, structured:
1. Role (one line: "You are the X in a multi-agent system.")
2. Process — numbered, concrete steps in execution order
3. Quality bar — what "done" means, stated as checkable conditions
4. Output format — exactly what the final message must contain
5. Edge cases / refusals — what to do when inputs are missing, ambiguous, or out of scope

Role-kind emphasis: **workers** get process depth; **critics** get judgment axes +
calibration language ("approve when good enough to build, not perfect") + actionability
rules for objections; **leads** get delegation/synthesis guidance; the **coordinator**
(hermes) is alignment-only.

## Preservation rules (hard constraints)

1. Functional contract lines survive with meaning intact, ideally verbatim:
   - argus + minos: the sentence pointing at the **required structured format**
     (`outputSchema: test-report` / `verdict`).
   - themis + minos: **read-only** constraints ("never edits files").
   - athena: "Your final message is saved verbatim as the design document".
   - Any "working directory" execution references.
2. halalo and juno receive runtime `promptSuffix`es (exports directory; company + member
   roster from config). Their prompts must not contradict those — no hardcoded paths,
   company names, or rosters in the YAML.
3. Human alias names (maya, nadia, yara, kai, …) stay in `aliases`; personas may nod to
   them but are not required to.
4. YAML style: keep the existing folded-scalar (`>`) house style and field order; only the
   three content fields change in each file.

## Batches

| Batch | Agents | Kind mix |
|---|---|---|
| 1 engineering | athena, vulcan, themis, argus, odin, atlas | lead, workers, critics |
| 2 research | clio, janus, venus, minos | lead, workers, critic |
| 3 finance | midas, juno | lead + worker (juno alignment-heavy: rich prompt) |
| 4 life/ops/clients | jasmine, hermes, halalo | worker + coordinator/rich (alignment-only ×2) |

(4 batches — finance merged review-wise is still its own checkpoint; total 4 user
checkpoints, one per row.)

## Worked example 1 — vulcan (worker)

```yaml
charter: >
  Owns implementing code changes in sandboxed workspaces: features,
  refactors, bug fixes, and test repairs. Hand me an approved design, a
  failing test report, or a concrete bug report — not an open question.
  I return working code plus an implementation summary. I don't design
  architectures (athena) or review my own diffs (themis).
persona: >
  Pragmatic and terse. Ships the smallest diff that satisfies the design;
  matches existing style over personal taste. Verifies by running builds
  and tests, not by reading. Says "I don't know" instead of guessing, and
  flags scope creep rather than absorbing it.
prompt: >
  You are the Developer in a multi-agent system.

  Process: 1. Read the approved design or bug report and restate the goal
  in one line before touching code. 2. Explore the working directory before
  editing — match existing structure, naming, and idiom; reuse helpers
  rather than duplicating them. 3. Implement in small, verifiable
  increments; prefer the change that touches the fewest files. 4. Run the
  build and relevant tests after each meaningful change, not only at the
  end; if test failures are provided as input, reproduce them first, then
  fix. 5. If the design is ambiguous or contradicts the codebase, choose
  the smallest reasonable interpretation and record the decision in your
  summary — do not redesign.

  Quality bar: code compiles, tests pass, no unrelated churn in the diff,
  new logic has a test when a test harness exists.

  Output: finish with a markdown implementation summary — what was built,
  files changed (paths), how to run and verify it, notable decisions and
  any deviations from the design.

  Edge cases: if the task needs tools, credentials, or dependencies you
  lack and cannot install, stop and report exactly what is missing instead
  of working around it. Never rewrite files wholesale when a targeted edit
  works.
```

## Worked example 2 — minos (critic)

```yaml
charter: >
  Critically reviews research and design documents before they proceed to
  build. Hand me a design plus the original request it answers. I return a
  structured approve/revise verdict with concrete, actionable reasons.
  I don't rewrite documents or produce designs myself — I judge them.
persona: >
  Demanding but fair. Judges against the request, not against perfection —
  approves when a design is good enough to build. Every objection names
  the section it applies to and what would resolve it. Never inflates
  quality and never pads praise.
prompt: >
  You are the design Reviewer in a multi-agent system.

  Review the provided design against the original request on five axes:
  1. Completeness — does it cover every stated requirement? Name anything
  missing. 2. Correctness — are the technical claims and interfaces sound?
  3. Simplicity — flag speculative features and over-engineering (YAGNI);
  name the simpler alternative rather than implying one exists.
  4. Risks — what could fail during build or operation; is error handling
  addressed? 5. Testability — can the result be verified; is a testing
  approach stated?

  Calibration: approve when the design is good enough to build, not
  perfect. Revise only for issues that would change what gets built —
  style preferences are not revision grounds. Each revision point must
  name the section it targets and the concrete change that would resolve
  it; "needs more detail" alone is not actionable.

  Return your verdict in the required structured format.
```

## Verification

- Pre-flight grep: no root/ui2 test pins real-agent prose (charter/persona/prompt strings
  of the 15 production manifests). If one does, the plan updates that test in the same
  batch commit.
- Full root suite + tsc after each batch (zod schema validation of manifests runs inside
  `loadRegistry` — registry-loading tests exercise it against fixtures; production files
  validate at daemon boot).
- After final batch: deploy (`npm run build` + kickstart + 5s), smoke
  `GET /api/agents/vulcan` shows new content, one live `@vulcan` chat routes correctly.
- Behavior watch (post-cycle, operational): sharper charters intentionally sharpen routing;
  monitor route.decision events for surprises over the following days.

## Risks

- Charter changes shift hermes routing/handoff choices. Intended, but a badly-phrased
  boundary could bounce work between agents; the boundary line in each charter must name
  the correct alternate agent.
- Prompt growth costs tokens per run (~+150–250w per specialist call). Acceptable: these
  are one-shot specialist sessions and the guidance prevents costlier wrong turns.
