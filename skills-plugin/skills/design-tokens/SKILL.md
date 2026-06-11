---
name: design-tokens
description: Use when defining a visual direction or design-token starter for a product — palette, typography, spacing system that developers can drop into code.
---

# Design Tokens

Deliver tokens as copy-pasteable CSS custom properties, not prose.

## Process

1. **Anchor in the audience.** One sentence: who uses this and in what mood/context. Every choice below must trace back to it.
2. **Palette** — define as CSS variables with exact hex:
   - 1 primary, 1 accent, 1 semantic set (success/warning/danger), 4-step neutral ramp, plus explicit background/surface/text colors.
   - Check primary-on-background and text-on-surface contrast against WCAG AA (4.5:1 body, 3:1 large text) — state the ratios.
   - Avoid the generic-AI look: no purple-on-white gradients, no default cream-serif unless the brief is editorial.
3. **Typography** — pick 1–2 typefaces with fallback stacks (avoid Inter/Roboto/system defaults unless justified); type scale as ratio (e.g. 1.25): caption, body, h3, h2, h1 with px values and line-heights.
4. **Spacing** — one base unit (4 or 8px) and a named scale (xs…2xl). Border radii and elevation/shadow levels (2–3 each, no more).
5. **Dark mode** — if relevant, provide the overridden variables only, not a second full set.

## Output format

```css
:root {
  --color-primary: #...;
  /* ... full set ... */
}
```

followed by a short rationale table: token group → choice → why it fits the audience.
