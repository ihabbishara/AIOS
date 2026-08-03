# Goals "Memory" — Organism applied to the Goals section

**Date:** 2026-08-03
**Status:** approved (brainstormed; user selected premise "design for what's actually there", scope "list + detail", node display "vertical thread", call sites "all four", ground "follow the theme")
**Predecessor:** `2026-08-02-home-organism-design.md` (Organism design language — §1 ground, §2 colour-is-a-clock, §5 motion inventory). This spec applies that language to its second surface.

## Problem

Last cycle proved the Organism language on Home and left the other 12 views on Command Deck. The Home spec's own open items nominated Goals next, with direction iii "Day spine" — departments as lanes, work as blocks against the hours — reasoning that *"it turns the body into a Gantt chart, which is exactly right for Goals."*

That nomination was made from reasoning, not data. The live store contradicts it.

| Measurement | Value | Consequence |
|---|---|---|
| Goals with exactly 1 node | **38 of 57 (67%)** | Two-thirds have no DAG to lay out |
| Goals that are a single node **or a linear chain** | **50 of 57 (88%)** | Only 7 goals branch at all, max fan-out 2 |
| Goals created per day | 0–8; on the day of writing, **1** | A 24-hour axis renders near-empty |
| Node wall-clock duration | **0.3 min → 220 min** | On a 1440-min axis a 0.3min block is sub-pixel |
| Status distribution | **51 done, 5 abandoned, 1 failed, 0 running** | Goals is an archive, not a live worksite |
| Goals per department | engineering 26, research 19, operations 9, life 2, clients 1 | Lanes would be badly lopsided |

A day spine would render one block on an otherwise blank axis, with four empty lanes. **Direction iii is rejected on evidence.**

There is also a structural point. Home now answers *"what is running"* (the field) and *"what needs you"* (the dock). Anything Goals spends on liveness duplicates a screen the user just came from.

## Decision summary

- **Goals is the org's memory** — a record of finished work, in which the rare live goal is unmissable *because* everything around it is settled.
- **Organising spine: recency bands**, not status lanes. Status is near-constant across the corpus and therefore carries almost no information; recency is the axis the data actually varies on.
- **The DAG becomes a vertical thread.** Branches are expressed as text, not geometry.
- **Scope: the whole Goals section** — list, detail, node display, inspector — plus the three non-Goals call sites of the component being replaced.
- **Goals follows the light/dark toggle.** It does not inherit Home's pinned `.night`.
- **No new endpoints, no server change, no new dependencies.**

### Jobs this surface serves

The user named all four as real:

1. **Find something we produced** — retrieval of artifacts and titles.
2. **Check how a live goal is going** — node-level progress on the rare running goal.
3. **See what failed or got stuck** — the 1 failed + 5 abandoned.
4. **Understand cost / where effort went** — cost as a first-class column.

One surface serves all four: a recency-ordered list with the live goal promoted, exceptions coloured amber in place, artifacts named inline, and cost right-aligned throughout.

## Non-goals

- No day spine, no Gantt, no department lanes. Rejected on the data above.
- No brand identity work, no new typeface. Still deferred (Home spec §3).
- The other 11 views keep Command Deck this cycle.
- No fuzzy-search dependency. 57 rows need a substring filter, not a search engine.
- No markdown renderer in Library; no `.svg` in the image MIME map. Standing constraints, unchanged.

---

## 1. The list

Organising spine is recency. Four bands, top to bottom:

```
Goals                          57 · $12.40 this week    [all departments ▾] [filter…]

LIVE ─────────────────────────────────────────────────────────────
 ● render-investor-deck-to-professional      engineering · vulcan
   node 3 of 5 · running 22m                         deck.html   $0.87

TODAY ────────────────────────────────────────────────────────────
 ○ delivery-handoff-you-are-the-only-        operations · neo
   1 node · 3m                                    handoff.md   $0.04

THIS WEEK ────────────────────────────────────────────────────────
 ○ agentic-operating-systems-landscape       research · clio
   1 node · 73m                                 landscape.md   $1.22
 ○ algerian-agri-food-market-analysis        research · clio     (dimmed)
   abandoned after 30m                                          $0.31
 ⚠ vault-write-silent-no-op-write-tool       engineering · atlas
   failed · node 1 of 1 · ENOENT vault/notes                    $0.09

EARLIER ──────────────────────────────────────────────────────────
 Jul 28 · 8    Jul 27 · 6    Jul 26 · 7    Jul 25 · 7    ⋯
```

### The LIVE band is absent when nothing is running

Not empty-with-a-placeholder — **absent**. This is the same discipline that made Home's stillness mean something: a permanently-empty "Running" column is a standing lie about the org. The current view reserves a third of the screen for a lane that has been empty for most of the corpus's life.

`EARLIER` collapses to day chips with counts. Clicking one expands that day inline.

### Filtering

The existing department `<select>` is kept. One addition: a substring filter over goal title, applied across all bands. 57 rows need a substring match, not a search dependency — see non-goals.

`Segments` (`components/ui.tsx`) is **not** used in the new row; per-node progress is what the thread shows on the detail view, and a 1-node goal has no progress bar worth drawing. The component itself stays — `canvas/OrgPulse.tsx:55` still renders it.

### Colour follows the clock axis (Home spec §2), unchanged

| Goal status | Token | Reasoning |
|---|---|---|
| `running`, `planning`, `replanning`, `awaiting-mail` | `--now` | happening this second. `awaiting-mail` waits on the *world*, not the user — it is in flight |
| `done` | `--past` | finished and fine |
| `failed`, `paused-user`, `paused-budget`, `paused-api` | amber | a human is the blocker — the one meaning amber carries |
| `abandoned` | `--past`, reduced opacity | over, but not "fine" |
| anything unrecognised | amber | see the safety property below |

**Safety property carried over from `laneOf`:** an unknown backend status must surface as needing attention, never as healthy. `laneOf` documented this deliberately (`goal-buckets.ts:44-47`); the replacement mapping must preserve it, and a test asserts it.

### Removed

- `LANES` / `laneOf` and `test/goal-lanes.test.ts` — the 3-lane kanban is what recency bands replace.
- `BUCKETS` / `bucketOf` and `test/goal-buckets.test.ts` — exported and unit-tested, but rendered by no view in `src/`. Dead code behind a passing test.
- `DONE_CAP = 10` and the "Show all N →" button. 57 rows do not need paging.
- The `md:grid-cols-3` lane grid.

`provenance()` is kept and stays in `goal-buckets.ts`.

### Considered and rejected

- **Department lanes** — engineering 26 vs clients 1 makes them structurally lopsided.
- **Flat recency list, no bands** — loses the emphasis that makes one live goal unmissable.

---

## 2. The thread

`ui2/src/views/MiniDag.tsx` is renamed to `Thread.tsx` and its internals replaced. Keeping the name would be a lie once no graph is drawn.

```
│ ● research-sources          past · clio      14m   $0.31
│
│ ● draft-outline             past · venus      8m   $0.12
│
┼▸ build-deck                 NOW · vulcan     22m   $0.44   deck.html
│
│ ○ review                   next · argus       —      —
│   after: build-deck, draft-outline
│
│ ○ publish                  next · atlas       —      —
```

### Branches are text, not geometry

A row prints `after: …` **only when the linear reading would be wrong** — that is, when `deps.length > 1`, or when its single dep is not the row immediately above.

- The 38 single-node goals print nothing.
- The 12 linear chains print nothing.
- The 7 branching goals print one extra line each.

Fan-out needs no representation at all: each dependent already names its parents, so a node depended on by three others is described three times from the reading side. This removes the layout engine entirely while handling arbitrary DAGs.

### Motion

The running row reuses `.breath` from `index.css` — the same animation as a Home field dot, bound to the same fact (`status === "running"`). **No new keyframes**, so `design-doctrine.test.ts`'s allowlist needs no amendment.

This also *deletes* the SMIL `<animate>` at `MiniDag.tsx:36-38`. That is genuine data-bound motion, but it lives in SVG and the CSS-keyframe allowlist cannot see it. Doctrine coverage improves by removing code.

### Props

`{ nodes, failedKey?, onSelect? }`. `scale` is dropped — it sized an SVG `viewBox` and is meaningless in DOM. Only `Goals.tsx:208` passes it.

### Call sites

All four callers get the thread:

| Call site | Note |
|---|---|
| `views/Goals.tsx:208` | in scope by definition |
| `views/canvas/Goal.tsx:43` | renders **inside Home's queue sheet** — currently leaks Command Deck tokens into the Organism surface |
| `views/canvas/Ask.tsx:46` | same |
| `views/Setup.tsx:694` | the wizard. `Setup.tsx:543` states the intent explicitly: *"one MiniDag per goal it spawns, so this step and the cockpit draw the same pipeline."* Honouring that comment is why the wizard is included despite being nominally out of scope |

`src/views/dag-layout.ts` and `test/dag-layout.test.ts` are deleted.

### Inspector

Kept, restyled to Organism tokens. The thread replaces the DAG as its selector; the `onSelect(key)` contract is unchanged, as is the four-step fallback that guarantees the inspector never starts empty (`Goals.tsx:132-136`).

---

## 3. Ground and theme

**Goals follows the light/dark toggle.** It does not take Home's pinned `.night`.

The `.night` pin exists because Home's `field-ground` bloom is unreadable under a light chrome. Goals has no bloom, so it inherits no such problem, and Goals is a reading surface — long titles, artifact filenames, error text — where light theme is legitimately better in daylight. Keeping `.night` to a single, justified surface stops it becoming the default answer for view three.

Accepted cost: navigating Home → Goals in light theme is a dark→light transition.

### The light theme carries dark clock tokens — this must be fixed first

`tokens.css:62-68` currently repeats the dark values verbatim inside `:root[data-theme="light"]`, with a comment (lines 59-61) saying this is intentional. It was intentional *while Home was the only consumer and Home is pinned night*. The moment a theme-following surface uses the clock axis, those placeholders invert it:

| Token | on `#07090f` (night) | on `#f4f4f2` (light) | |
|---|---|---|---|
| `--now` | 11.52:1 — loudest | **1.57:1** | invisible |
| `--next` | 9.61:1 | **1.88:1** | invisible |
| `--past` | 2.87:1 — quiet | 6.30:1 | shouts |
| `--rest` | 1.54:1 — ground | 11.71:1 | shouts |

The live thing disappears and the finished thing dominates. The clock reads backwards. This is the same failure shape that rendered Home as near-black text on near-black ground last cycle when §9 was implemented strictly.

**Light-theme values** replacing lines 65-68:

| Token | Light value | Contrast on `#f4f4f2` |
|---|---|---|
| `--t-now` | `#07663c` | 6.41:1 — loudest, meets 4.5:1 for text |
| `--t-next` | `#3a5fd6` | 5.03:1 — meets 4.5:1 for text |
| `--t-past` | `#7e9488` | 2.94:1 — quiet |
| `--t-rest` | `#c7ccd6` | 1.46:1 — ground |

Ordering `now > next > past > rest` now holds in both themes.

`--t-field-base`, `--t-field-bloom` and `--t-field-mid` stay identical across themes. The lines 59-61 comment is narrowed to cover only those three — it currently claims the whole group is deliberately identical, which stops being true.

---

## 4. Data flow

Unchanged. `useLiveQuery(() => api.goals(), events, T.goals)` for the list, `api.goal(slug)` for the detail. No new endpoints and no server change.

Artifact **filenames** are already present in the list payload — `GoalView.nodes[].artifact` (`dto.ts:175`) — so naming produced files in the list costs nothing. Artifact **content** stays detail-only, because `buildGoalDetail` reads each file off the vault (`goals-view.ts:47-49`); doing that for 50 goals would be a large payload for no gain.

## 5. Error handling

Existing shape kept: `error → <Empty>{error}</Empty>`, `actionError` cleared when status changes, `askError` inline under the answer box.

One addition. **3 of 107 nodes carry a `finished_at` with no `started_at`.** `elapsed()` must return `—` for that case rather than computing against `null` and rendering a negative duration or `NaN`.

## 6. Files

| Action | Path |
|---|---|
| rewrite | `ui2/src/views/Goals.tsx` — `GoalList` + `GoalDetailView` |
| rename + rewrite | `ui2/src/views/MiniDag.tsx` → `ui2/src/views/Thread.tsx` |
| new | `ui2/src/lib/thread.ts` — `threadOrder`, `elapsed` |
| new | `ui2/src/lib/goal-recency.ts` — band assignment |
| edit (import + props) | `ui2/src/views/canvas/Goal.tsx`, `canvas/Ask.tsx`, `Setup.tsx` |
| edit | `ui2/src/lib/goal-buckets.ts` — keep `provenance`, drop the rest |
| edit | `ui2/src/tokens.css` — light clock tokens, narrowed comment |
| edit | `ui2/test/design-doctrine.test.ts` — contrast-ordering test |
| delete | `ui2/src/views/dag-layout.ts`, `test/dag-layout.test.ts`, `test/goal-lanes.test.ts`, `test/goal-buckets.test.ts` |

## 7. Testing

Pure functions, tested the way `tide.ts` was:

- **`threadOrder`** — determinism (stable tie-break by original array index), linear chains, fan-in and fan-out, and a node whose dep is missing from the set (must not hang or drop the node).
- **`elapsed`** — missing `startedAt`, equal timestamps, sub-minute, multi-hour.
- **`goal-recency`** — band boundaries at local midnight and at 7 days; a goal created in the future (clock skew) must land in `TODAY`, not vanish.
- **status → token mapping** — every known status, plus the unknown-status safety property from §1.
- **`design-doctrine.test.ts`** — contrast ordering `now > next > past > rest` asserted in *both* token blocks. Hexes stay tunable; the property is enforced.

**One existing test is at risk.** `test/setup-first-job.test.tsx:91` asserts `screen.getByText("research")` with the comment *"MiniDag drew the spawned goal"*. Thread still renders agent names, so it may pass unchanged — but it asserts on a component being replaced and must be verified, not assumed.

### Verification before done

- `npx vitest run` at the repo root **and** `cd ui2 && npm test`. Two separate suites; the root run does not include ui2's.
- `npx tsc --noEmit` at root **and** `cd ui2 && npm run typecheck`.
- Read the **"Tests" line**, never exit codes, and check for a separate `Errors` line — green Tests plus an Errors line is a failure.
- A live walk against the stub harness, which can serve branching, single-node, failed, abandoned and empty-corpus cases without a daemon or tokens.

Not provable by test: whether Goals reads as memory rather than as a dashboard. That needs the live walk.

## Open items

- The remaining 11 views. Mail is the natural next candidate — it is the other high-volume archive, and the recency-band and thread work here should transfer directly.
- Home's high tide renders its field band at 744px while the dots and task lines occupy roughly 100px of it, centred, so "busy" reads emptier than "resting". Observed during the tide verification walk on 2026-08-02. Out of scope here; worth a decision before the next Home change.
- **Deferred as of 2026-08-03:** §1's promise that EARLIER collapses to day chips with counts, expanding inline on click, is not implemented — EARLIER renders as a flat list like every other band. This is a deliberate deferral, not a bug: at 57 goals the flat list is still usable, and day chips are a complication with no payoff yet. Revisit once the corpus is around 200 goals, where a flat EARLIER band would get unwieldy.
