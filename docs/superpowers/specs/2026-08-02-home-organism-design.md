# Home "Organism" — Design Language + Home Redesign

**Date:** 2026-08-02
**Status:** approved (brainstormed with visual companion + artifacts; user selected direction B "Organism", idle state 3 "Anticipation", layout ii "Tide", light-theme option A "Home stays night")
**Predecessor:** `2026-07-15-ui2-command-deck-redesign-design.md` (Command Deck — its visual language and its motion non-goal are both replaced, for Home only)

## Problem

The user compared AIOS's onboarding to Buzz's (acid-yellow, bloom, texture, generous space) and judged AIOS "shallow from a creativity point of view", then escalated: "the whole UI needs a revisit."

The current look is not a failure of execution. It is the Command Deck spec being executed faithfully — dark ops console, Linear/Raycast lineage, dense data, explicit non-goal "no decorative animation; motion is informational only." The direction is what is being replaced.

There is also a structural problem underneath the visual one. **Home is an attention queue — things blocked on the user.** The org's actual life (running goals, executing nodes, agents mid-turn, mail in flight) lives on Goals, not Home. The emotional register the user asked for is *structurally absent* from the first screen they open.

## Decision summary

- **Emotional register:** "Something alive is working for me." Organism, not org chart — ambient motion, breathing states, presence over information.
- **Design principle:** **motion is real or it doesn't exist.** AIOS has genuine liveness data most apps must fake. Nothing animates for mood; if it moves, something is actually happening. This deliberately overturns Command Deck's motion non-goal.
- **Direction:** **Organism** — Home stops being an inbox and becomes a window onto the org. Agents are dots that glow while working; the needs-you queue docks.
- **Idle behaviour:** **Anticipation** — when nothing is running, the surface reorganises around what is coming (anchors, routines, reminders).
- **Layout:** **Tide** — one layout whose proportions move. Work grows the field and shrinks the clock; quiet does the reverse. Three discrete levels with hysteresis, never a continuum.
- **Light theme:** **Home's field stays night in both themes.** Shared chrome (nav, dock, queue sheet) still follows the theme.
- **Scope:** design language + Home only, proven, before touching the other 12 views.
- **No new dependencies, no new endpoints, no server changes.**

## Non-goals

- No brand identity work — logo, wordmark, or full palette system. Explicitly deferred by the user.
- No new typeface. Deferred, not rejected (see §3).
- The other 12 views keep Command Deck this cycle.
- `Queue.tsx`, `Canvas`, and the j/k/a/r/d keyboard model are **reused unchanged**, not redesigned. Triage is relocated, not rebuilt.
- No markdown renderer in Library; no `.svg` in the image MIME map. (Standing constraints, unchanged.)

---

## 1. Ground

Command Deck's ground is a flat cool black with hairline boxes drawn on it. Organism replaces boxes with a field that has a light source in it: one radial bloom, biased blue, plus a low-opacity grain.

The grain is not only texture — a bloom that large will band on 8-bit displays, and the grain dithers it away.

| Token | Value | Role |
|---|---|---|
| `--field-base` | `#07090f` | the field's outer ground |
| `--field-bloom` | `#16233f` | radial centre, ~`120% 100% at 50% 8%` |
| `--surface` | `#10131b` | dock, sheets, overlays |
| `--rule` | `#1b2130` | the few remaining borders |
| `--rule-soft` | `#141924` | row separators inside the sheet |

Grain: inline `feTurbulence` as a `data:` URI at **3.5%** opacity, no network request.

## 2. Colour is a clock

The substantive change. Command Deck's palette encodes **severity**. Organism's encodes **time relationship** — has it happened, is it happening, is it coming. Amber sits off that axis entirely: it is the only colour that means *a human is the blocker*.

| Token | Value | Meaning | Driven by |
|---|---|---|---|
| `--now` | `#7fd7a4` | executing this second | `OrgAgentCard.status === "working"` |
| `--past` | `#38624e` | finished and fine | fired anchors on the clock (`firedToday === true`); completed nodes in the queue sheet. Does **not** appear on field dots — a dot has only idle/working/waiting |
| `--next` | `#8fb4ff` | scheduled, hasn't fired | `anchors[].hhmm` with `firedToday === false`, `routines[].nextFire`, `reminders[].dueAt` |
| `--needs` | `#ffb454` | a human is the blocker | any `AttentionItem`; also `OrgAgentCard.status === "waiting"` |
| `--fail` | `#f87171` | broken | `goal.status=failed`, node error, sense not-ok |
| `--rest` | `#28314a` | present, nothing to say | `OrgAgentCard.status === "idle"` |

`--needs` is unchanged from Command Deck's `--t-accent`, because it already means exactly this.

**Consequence to carry forward:** `AttentionItem.severity` (1–5) no longer maps to hue — every attention row is amber. Severity must survive as **order and position** (see §7).

## 3. Type

No new typeface. Inter Variable and JetBrains Mono already ship (`@fontsource-variable/inter`, `@fontsource/jetbrains-mono`). What changes is **range**: ui2 today runs 10px→15px and never below weight 400, a five-pixel span in which the sensing layer and the working layer look identical.

| Role | Face | Size / weight | Use |
|---|---|---|---|
| Display | Inter | 42 / 200 / −0.03em | the one line that says what is happening |
| Section | Inter | 24 / 300 / −0.015em | cluster and band headings |
| Read | Inter | 15 / 400 / 1.6 | prose, `currentTask` |
| UI | Inter | 13 / 400 | controls, chips |
| Label | JetBrains Mono | 10 / 500 / .16em / uppercase | band labels |
| Data | JetBrains Mono | 11.5 / 400 / tabular | times, money, counts |

**Deferred, not skipped:** a real display face would push this further. It is one offline `@fontsource` package, no CDN. Held only because brand identity is deferred.

## 4. Space and depth

Air where you sense, density where you act. The field and status line take the generous end of the ramp; the dock and any table stay as tight as they are today.

Space ramp: **4 · 8 · 12 · 20 · 32 · 52 · 84**.

Depth stops being a border and becomes light. A panel is a place where the ground is brighter, not a place with a line around it. This retires `--t-card-shadow`, the token that exists only because the light theme could not do glow.

Radii: `6` chips · `12` overlays · `16` the queue sheet · `0` the field, which is never a box.

## 5. Motion inventory

**Motion is real or it doesn't exist.** Every animation is bound to a fact. The complete inventory is five entries; anything not on this list does not animate.

| Name | Duration | Bound to |
|---|---|---|
| Breath | 2.4s loop | a dot pulses only while that agent is `working`; stops on `agent.end` |
| Travel | 2.8s, **once** | one `mail.sent` between two agents. It does not loop — a loop would be a lie about traffic |
| Approach | 2.6s loop | only the single nearest upcoming anchor. Everything further out is still |
| Tide | 1400ms, `cubic-bezier(.4,0,.2,1)` | a committed tide-level change (§6) |
| Arrive | 200ms | a new dock chip |

**The proof:** at 3am with an empty schedule and nothing running, **nothing on the screen moves.** That stillness is what makes the rest of it mean something.

All five respect `prefers-reduced-motion` (the existing block in `index.css` already establishes this pattern).

## 6. Home structure — Tide

Four bands. Only two of them move.

| Band | Height | Contents |
|---|---|---|
| Status | fixed | display line; mono sub-line: date · uptime · spend |
| Field | tides | departments as clusters, agents as dots |
| Clock | tides | day axis, NOW marker, anchors past/next/future |
| Dock | fits content | needs-you chips, `q` for the full queue |

### Tide levels

Three discrete levels, never a continuum — a continuum is unpredictable and untestable.

Percentages are of the space remaining between the fixed Status band and the content-sized Dock — the two tiding bands always sum to 80%, with the balance as the gap between them.

| Level | Input | Field | Clock |
|---|---|---|---|
| High | 3+ working | 68% | 12% |
| Mid | 1–2 working | 50% | 30% |
| Low | 0 working | 14% | 66% |

Input is the count of `OrgAgentCard.status === "working"` in the `/api/org` payload — **not** a scan of the client event buffer (see §8).

**Hysteresis: a level commits only after the input has held it for 8 seconds.** This is the anti-twitch gate; agents finishing turns must not make the page jump.

### The rule that makes it a body

**A dot never moves.** At Low the clusters do not become a different layout — the same cluster grid scales down in place. Dots 8px→5px, department and agent labels fade to zero opacity, inter-cluster gaps shrink from the `32` step to the `12` step. Relative position within the grid is identical at every level; only the grid's overall scale and the label opacity change.

An agent lighting up at 3am appears exactly where it would at 2pm. Because there is only one rendering, there is no crossfade and therefore no mode switch hiding inside the tide. This is also what makes the tide cheap: one `height` and one `transform: scale()`, no re-layout.

## 7. Paying the queue debt

Choosing Organism costs one hop of triage distance. This is the payment.

- **Dock** — 3 chips maximum, ordered by `severity` ascending then `ts` descending, with `+N` for the remainder. Amber **fill** = severity 1 (approvals); **outline** = everything else. The dock therefore shows the *shape* of what is waiting, not just a count — which is how severity survives losing its hue (§2).
- **`q` opens a sheet** over the field containing today's Queue: the existing component, unmodified. `groupQueue`/`flatQueue`, the j/k/a/r/d map, `Canvas` in the right pane, phone push-detail — all reused as-is.

Triage is relocated, not redesigned. This cycle touches `Home.tsx` and CSS, not `Queue.tsx` or `Canvas`.

`TodayStrip` dissolves: date, brief link and spend all move into the status line and sub-line.

## 8. Data and wiring

**The field must not read the client event buffer.** `useEvents` caps at 400 events and replays only 100 on reconnect, so a long-running agent's `agent.start` can scroll out of the window and the dot would go dark while the agent is still working — the core signal would lie.

`src/web/org-view.ts` already computes this server-side over a 5000-event window (`HISTORY_WINDOW = 5000`), and `/api/org` already returns it:

```
OrgDepartmentView[] → { department, mission, lead, agents: OrgAgentCard[] }
OrgAgentCard        → { name, title, status: "idle" | "working" | "waiting", currentTask, costTodayUsd }
```

That is the field: departments are clusters, agents are dots, `status` is the colour, `currentTask` is the sub-line.

| Band | Source | Invalidated by |
|---|---|---|
| Field | `api.org()` | `T.agentsActions` — exists |
| Clock | `api.schedule()` | **new** `T.schedule = ["brief.sent", "routine.due", "reminder.due"]` |
| Status line | derived from org + attention | — |
| Dock | `api.attention()` | `T.attention` — exists |
| Sub-line | `api.health()`, `api.budget()` | `T.budget` — exists |
| Travel | `mail.sent` off the SSE stream | carries `from` and `to` |
| Tide level | working-count from the same org payload | — |

Tide reading the org payload rather than raw events means the tide and the dots can never disagree.

**Total new server code: none. New client state: one 8-second hysteresis timer. `topics.ts` gains one line.**

Schedule *edits* have no event (they happen via API POST), so the client invalidates locally after its own mutation. The NOW marker ticks on a **30s** interval, not per second.

## 9. Degradation and edge cases

- **SSE drops** — `useEvents` already exposes `connected`. On false, motion stops and the field dims. A breathing dot on a dead stream is precisely the lie §5 forbids.
- **Reduced motion** — all five animations off. State must therefore be legible in **hue alone**: `--now` green vs `--rest` slate. Non-negotiable and testable.
- **Fresh org** — 3 agents, 2 departments, possibly no routines. Clusters centre rather than left-align. The field takes a min-height that floors the Low level specifically (a 14% band on a short viewport can otherwise clip the compressed grid); when the floor wins, the clock gives up the difference. An empty clock reads "Nothing scheduled today", not a blank axis.
- **Large org** — 6 departments wrap. Past ~40 agents, dots shrink again and clusters show a count instead of individual labels.
- **Private agents** — `visibility: "private"` agents **are** shown. It is the owner's own org; hiding them would make the field an incomplete body.
- **Light theme** — the field stays night; nav, dock and sheet follow the theme. In dark they are continuous; in light the field reads as a lit window inset in paper. The alternative (Home edge-to-edge night) flips the shared nav dark on every navigation to Home and light on every navigation away, which is a worse artifact than the one it avoids.
- **Phone** — clusters stack vertically, tide still drives heights, dock chips scroll horizontally.

## 10. Testing

Pure functions and RTL, in the existing ui2 suite:

- `tideLevel(working)` → `high | mid | low` — table test
- hysteresis reducer — **"6 count changes inside 4s produce zero level changes"**
- `stateOf(card)` → colour token — table test
- dock ordering — 3 chips by severity then recency, `+N` correct
- **position stability** — the layout function returns identical coordinates for a given agent across all three tide levels
- disconnected → no motion classes present
- reduced-motion → no motion classes, and hue still distinguishes `now` from `rest`

Not provable by test: whether it feels alive. That requires a live walk on a scratch daemon (never `:4280`, channel tokens blanked).

## Open items

- A display typeface (§3) — deferred with brand identity, revisit when that unblocks.
- Direction B applied to **Goals** — the node-and-lane treatment rejected for Home (option iii, "Day spine") is likely the right answer there. Out of scope this cycle.
