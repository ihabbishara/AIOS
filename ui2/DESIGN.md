# AIOS Cockpit Design Doctrine — Ember Command Deck

This is the binding design contract for `ui2/`. Every session — human or agent — that touches
the cockpit follows it. If a change needs to break a rule, update this file in the same commit
and say why. `test/design-doctrine.test.ts` pins the mechanically-checkable rules.

## 1. What this product is

An operator cockpit for a company you run. One person, glanceable, always-on. The screen's job,
in priority order:

1. **What needs me?** (approvals, questions, failures)
2. **What is happening right now?** (working agents, running goals, live activity)
3. **What happened, and what did it cost?** (done work, mail, spend)

Anything that doesn't serve one of those three is decoration — cut it.

## 2. Color — semantic only, tokens only

All color comes from `src/tokens.css` variables through Tailwind utilities (`bg-raised`,
`text-accent`…). **No raw hex anywhere else** (pinned by test).

Meaning is fixed and never reassigned:

| Tone | Token | Means | Never used for |
|------|-------|-------|----------------|
| Amber | `accent` | needs YOU (approvals, asks, waiting-on-user) | branding, emphasis, links |
| Violet | `agent` | agent working / in-flight | static labels |
| Green | `ok` | done, healthy, executed | CTAs |
| Red | `err` | failed, refused, destructive | warnings that aren't failures |
| Blue | `info` | mail, focus ring, neutral-informational | success |
| Dim/fg/strong/bright | grays | text ramp | color-coding state |

If everything glows, nothing glows: a normal screen is mostly gray with at most a few tone
accents. Amber especially is a budget — spend it only on rows that block on the user.

## 3. Type ramp

Inter Variable for prose, JetBrains Mono for data. Data means: ids, costs, timestamps, counts,
event types, agent initials — anything the eye scans as a value, set in mono.

| Role | Spec |
|------|------|
| Page title | 19px bold `text-bright` tracking-tight (via `PageHeader`) |
| Card/row title | 13px semibold `text-bright`/`text-strong` |
| Body | 13px `text-fg` |
| Secondary | 11.5px `text-dim` |
| Section label | `.label` — 10px uppercase tracked `text-dim` |
| Data | mono, 10–12px |

Don't invent sizes outside this ramp without a reason worth writing down here.

## 4. Layout system

- Every section view renders inside **`.page`** (max-w 1160, centered, px-5 py-5) and opens
  with **`PageHeader`** (title · mono meta · right-aligned actions). Two exceptions, deliberate:
  **Home** (full-bleed triage: 360px queue + canvas) and full-height tails (System events).
- Depth is exactly three steps: page `bg` → `.panel` (surface) → `.card` (raised). Never nest
  deeper; never put a panel inside a card.
- Grids wrap; content never horizontally scrolls the page. Truncating children of flex/grid
  need `min-w-0` — this is the #1 recurring overflow bug.
- Sub-navigation inside a section = `.seg` segmented control, not bare label buttons.

## 5. Components — reuse before invention

Primitives live in `src/components/ui.tsx`: `Button` (primary/ghost/danger), `Tag`, `Dot`,
`Avatar` (3-letter — two letters cannot disambiguate this roster), `Segments` (per-node
progress), `PageHeader`, `SectionLabel`, `Empty`, plus `TwoStepButton` and `Sheet`.

- New UI composes these. A new primitive requires: it's used in ≥2 places, and it's added to
  this list in the same commit.
- Status→tone mapping goes through `toneOfStatus` — never a local switch.
- Every event rendered as text goes through `lib/activity.ts describeEvent` — raw JSON is
  click-to-expand detail, never the default presentation.

### Chat conventions

- Agent text renders through `lib/markdown.tsx` — a safe markdown-lite subset built as React
  nodes, never `innerHTML`; unknown syntax and raw HTML stay literal; only http(s) links link.
- The composer is a textarea: **Enter sends, Shift+Enter breaks the line**, auto-grows to a cap.
- Voice is first-class when available: the `VoiceOrb` (in Chat.tsx) is idle mic → red recording
  orb scaled by live mic RMS with pulse rings + elapsed clock → breathing while transcribing.
  Red-while-recording is the one sanctioned use of `err` for a non-failure (universal recording
  convention).
- Bubbles: agent = avatar + left-anchored `rounded-2xl rounded-tl-md`; you = right-anchored
  `rounded-br-md` with `agent/40` border; mono timestamp under the bubble.

## 6. Interaction rules

- **Destructive or irreversible → `TwoStepButton`.** No single-click abandon/delete/restart.
- **Approvals act optimistically** with rollback + inline row error (see Home queue).
- Keyboard: `⌘K` palette, `⌘J` chat, `g`+letter section jumps, `j/k/a/r/d` in the queue,
  `Esc` closes overlays. Any new surface with actions gets shortcuts AND visible hints —
  undiscoverable shortcuts don't exist.
- Nothing important lives only in a hover menu or popover. Collapsed-but-visible (disclosure
  with a label and count) is the floor for secondary features.
- Motion means liveness only: `breathe` (working), `shimmer` (running), `arrive` (new row),
  `tick` (count change). No decorative animation. `prefers-reduced-motion` kills all of it.

## 7. Data honesty

- Every metric names its window: "today", "7d", "all time". Never juxtapose different windows
  unlabeled (the Costs byAgent=all-time vs byDay=14d trap).
- Bars are sized by value with no full-width track behind them (tracks read as bars).
- Counts on nav badges: amber = needs-you, blue = unread info.

## 8. Writing

Sentence case everywhere except `.label` (styled uppercase). Buttons say what they do
("Create routine", not "Submit"); the name stays stable through the flow. Empty states name
the next action ("No routines yet — create one below."). Errors say what happened and what to
do, no apology, no vagueness. No system jargon in user-facing labels — "agents", "playbooks",
"brief", not "SDK sessions" or "manifests".

## 9. Themes

Dark is primary; light must stay usable (it swaps borders for soft shadows via
`--t-card-shadow`). Any new color pair gets defined in BOTH theme blocks of `tokens.css` or it
doesn't ship.

## 10. Definition of done for UI work

1. `npm test` green (pinned strings intact), `tsc --noEmit` clean, `npm run build` succeeds.
2. Looked at in the browser, dark AND light, at ~1380px and phone width (BottomTabs).
3. No page-level horizontal overflow (`document.documentElement.scrollWidth === innerWidth`).
4. New capability is visible or one labeled disclosure away — never popover-only.
5. This file updated if any rule above changed.
