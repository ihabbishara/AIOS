# ui2 "Command Deck" Visual Redesign — Design

**Date:** 2026-07-15
**Status:** approved (brainstormed with visual companion; user selected direction A "Command Deck", kanban Goals layout, dark+light themes)
**Predecessor:** `2026-07-11-mission-control-redesign-design.md` (Ember Cockpit — IA kept, visual language replaced)

## Problem

User verdict on the shipped Ember ui2: "clean but stale, a bit dead, not really professional." Goals page is an unstructured long list. Home canvas is 70% empty space with bare bullet lists for the org pulse. The product should look credible enough to demo as an enterprise tool.

## Decision summary

- **Scope:** full visual overhaul; IA, routes, data layer, and keyboard model stay exactly as-is (5 sections, queue+canvas Home, ⌘J chat drawer, ⌘K palette, mobile bottom tabs).
- **Direction:** "Command Deck" — dark ops console (Linear/Raycast lineage): layered cool-dark surfaces, 1px borders, subtle glows, dense data, tabular mono numerals, live-feeling accents.
- **Theming:** dark AND light as first-class themes; toggle in the top bar; system-preference default.
- **Goals page:** kanban lanes (Needs you / Running / Done).
- **No new dependencies.** No server/API changes. Restyle + per-page recomposition only.

## Non-goals

- No IA changes, no new routes, no new endpoints.
- No component library adoption (shadcn etc.) — the existing hand-rolled components get restyled.
- No decorative animation; motion is informational only.
- Old warm-Ember look is fully replaced (no legacy-theme option).

## 1. Design language

### Token sets (CSS custom properties)

Two complete sets on `:root[data-theme="dark"]` and `:root[data-theme="light"]`. Components consume ONLY semantic tokens — zero hardcoded colors in TSX.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--bg` | `#0b0d12` | `#f4f4f2` | app background |
| `--surface` | `#0e1117` | `#ffffff` | panels, lanes, tables |
| `--raised` | `#12151d` | `#fafaf9` | cards on surfaces |
| `--line` | `#1e2330` | `#e6e7e4` | borders, dividers |
| `--line-soft` | `#1a1f2b` | `#f0f0ee` | row separators |
| `--dim` | `#6b7386` | `#82838c` | secondary text, labels |
| `--fg` | `#8b96ad` | `#5a5b64` | body text |
| `--strong` | `#e6e9f0` | `#191a1e` | headings, primary text |
| `--bright` | `#f0f2f7` | `#000000` | emphasized titles |
| `--accent` | `#ffb454` | `#c2410c` | needs-you ONLY (kept rule: never decorative) |
| `--accent-bg` | `#241a10` | `#fef0e8` | needs-you chip/lane tint |
| `--ok` | `#4ade80` | `#16a34a` | done / healthy / running-fine |
| `--err` | `#f87171` | `#dc2626` | failed / degraded |
| `--err-bg` | `#141019` | `#fffbf9` | failure card background |
| `--err-line` | `#3d2430` | `#f3d9d3` | failure card border |
| `--info` | `#7ea6f4` | `#2f5af5` | mail / links / neutral actions |
| `--agent` | `#9c8cc9` | `#6d5bc7` | agent activity |

Fonts unchanged: Inter Variable (sans), JetBrains Mono (mono, all numerals/timestamps/costs via `tabular-nums`).

### Depth system

Three layers: `bg` page → `surface` panel (1px `line` border, 10–12px radius) → `raised` card (1px border, 8–9px radius). Dark adds `box-shadow` glows only for semantic emphasis (failure card: faint red glow; needs-you count: faint amber). Light uses `0 1px 3px rgba(20,20,30,.05)` card shadows instead of glows. Hover: `translateY(-1px)` + border lightens.

### Tailwind v4 wiring

`tokens.css` becomes:

```css
:root[data-theme="dark"]  { --bg: #0b0d12; /* … full set … */ }
:root[data-theme="light"] { --bg: #f4f4f2; /* … full set … */ }
@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  /* … one @theme line per semantic token … */
}
```

`@theme inline` makes utilities like `bg-raised text-strong border-line` resolve through the runtime variable, so the toggle is pure CSS. Existing utility names (`bg`, `surface`, `raised`, `line`, `dim`, `fg`, `strong`, `accent`, `ok`, `err`, `agent`) keep working; new ones (`bright`, `info`, `line-soft`, `accent-bg`, `err-bg`, `err-line`) are added. Old warm values are deleted.

## 2. Theme toggle

- State: `localStorage["aios_theme"]` = `"dark" | "light"`; absent → `matchMedia("(prefers-color-scheme: dark)")`.
- Applied as `data-theme` on `<html>`. Inline script in `ui2/index.html` sets it before the bundle loads (no flash of wrong theme).
- Toggle button (☀/☾) in the top bar, right side next to the health dot; also a ⌘K palette entry ("Toggle theme").
- React side: tiny `useTheme()` hook (read + set + subscribe to storage/matchMedia) in `ui2/src/lib/theme.ts`.

## 3. Goals page — kanban

Three lanes on desktop (grid `repeat(3, 1fr)`), stacked on mobile (<768px) in priority order.

| Lane | Statuses (via existing `bucketOf`) | Notes |
|---|---|---|
| **Needs you** | `needs` (failed) + `waiting` (paused-budget, paused-user) | amber header; failure cards get red left-glow treatment; paused cards amber. Node-level `needs-review` goals already surface here via status. |
| **Running** | `running` bucket (planning, running, replanning) + `awaiting-mail` (with a "waiting on mail" chip) | running cards show a live node progress bar + pulsing status dot |
| **Done** | `done` + `abandoned` (muted, tagged) | newest 10 rendered; "Show all N →" expands the full history inline (no route change) |

Card anatomy: status dot + mono status line ("failed · node 1/2"), title (strong, 13px), meta line (dept · lead · relative time), cost right-aligned mono, inline actions (Retry / Open / Chat — reusing existing handlers; Retry only where the action exists today). Clicking a card opens the existing goal detail (route unchanged, detail canvas restyled to match: MiniDag recolored with tokens, node list as raised cards).

Header row: "Goals" + mono summary ("16 total · $7.90 this week" — computed client-side from the already-fetched goal list), department filter dropdown (existing), theme toggle lives in the app bar not here.

Empty lanes render a designed placeholder (dashed border, two-line explanation) — never blank space.

`BUCKETS`/`bucketOf` stay the source of truth; a thin `laneOf(status)` maps statuses → 3 lanes (it consults `bucketOf`, with one status-level exception: `awaiting-mail` renders in Running despite living in the `waiting` bucket).

## 4. Home

IA unchanged: attention queue (left, 300–360px) + context canvas (right). Restyle:

- **Queue cards**: new card language; typed mono kickers color-coded by kind (approval=amber, failure=red, ask=amber, mail=info, sense=red). Primary action filled, secondary outlined. Optimistic tombstones keep working.
- **Org pulse (idle canvas)** — the "dead" screen, rebuilt: header row ("Organization · live" + mono "$X today · ● all systems ok"); grid of department cards (`raised`), each with dept label + agent count, agent rows (initials avatar circle, name, live status line: "working · goal:slug", "done 8:26 · $0.67", "1 failed goal" in red, "idle" dimmed). Avatar accent = violet when working, amber only if that agent owns a needs-you item.
- **Activity strip** at the canvas bottom: last ~6 notable SSE events (goal done/failed, mail sent, anchor fired) as mono lines with colored timestamps, sliding in live. Data source: the existing `StoredEvent` stream already held by the app — no new endpoint.
- Today strip (date + spend) stays, restyled.

## 5. Staff / Mail / System

Same kit, no structural change: panels → `surface`, rows → `raised` cards or bordered rows, labels → uppercase `dim` 10–11px, all counts/costs mono, status dots with the semantic palette, Governance shadow column and System health badges recolored via tokens (amber badge stays the enforce-flip signal). Chat drawer and ⌘K palette restyled to match.

## 6. Motion

- Card enter: 150ms fade + 4px slide-up (existing `.arrive` keyframe retuned).
- Running status dots: 2s opacity pulse (existing `.breathe`).
- Activity strip lines: slide-in on arrival.
- Hover: 100ms border/translate transitions.
- `prefers-reduced-motion: reduce` disables all of it.

## 7. Implementation shape

- `ui2/src/tokens.css` — rewritten (both theme sets + `@theme inline` bridge).
- `ui2/index.html` — pre-bundle theme script.
- `ui2/src/lib/theme.ts` — new (~30 lines).
- `ui2/src/lib/goal-buckets.ts` — add `laneOf(status)`.
- `ui2/src/components/ui.tsx` — restyled primitives (Button, Tag, SectionLabel, Empty, tones).
- `ui2/src/views/*` — recomposed per above; `App.tsx` top bar + toggle.
- Server: zero changes. `src/web/dto.ts`: zero changes.

## 8. Testing

- Existing 24 ui2 tests stay green (they assert behavior/text, not colors; `findAllByText` pattern unaffected).
- New: `theme.test.ts` — default follows system, toggle persists to localStorage, `data-theme` lands on `<html>`.
- New: `goal-lanes.test.ts` — `laneOf` mapping (failed→needs-you, paused-user→needs-you, awaiting-mail→running, abandoned→done), Done lane caps at 10 + "Show all" expands.
- Visual verification at the end via browser-harness screenshots: Goals dark, Goals light, Home dark, mobile 390px.
- `npx tsc --noEmit` in both roots; root suite untouched (1175+2).

## Accessibility

- Both themes AA-contrast for text tokens (light-theme accent is the darker `#c2410c`, not amber-on-white).
- Theme toggle is a real button with `aria-label`.
- Status conveyed by dot color AND text (mono status line), never color alone.
