---
name: image-generation
description: Use when a request needs a generated picture — a photographic, illustrative, or creative image from a description — via the generate_image tool (Nano Banana / Gemini 2.5 Flash Image).
---

# Image generation

`generate_image` turns a text prompt into a PNG. Deliver the returned path with `attach_file`.

## Pick the right tool

- Numbers, series, comparisons → `render_chart`.
- Structure, graphs, flows, hierarchies → `render_diagram`.
- A photo, illustration, scene, product shot, logo concept, or any creative visual → `generate_image`.

## Write the prompt in one pass

Each call costs ~$0.039 and the prompt goes to Google — get it right the first time, don't spam retries. A strong prompt names, in order:

1. **Subject** — the one thing the image is of, concretely ("a ceramic pour-over coffee dripper").
2. **Style** — photographic / watercolour / 3D render / line art / flat vector; name a medium, not "nice".
3. **Composition** — framing and angle (close-up, top-down, wide establishing shot), and what's in frame.
4. **Lighting & mood** — soft morning light, high-key studio, moody low-key.
5. **Aspect** — say "square", "wide 16:9", or "tall portrait" if it matters.

Example: "A top-down photo of a ceramic pour-over coffee dripper on a light oak table, soft morning window light, minimal styling, shallow depth of field, square."

## Limits

- Weak at rendering long or exact text inside the image, precise charts/data, and fine UI mockups — use the chart/diagram tools for those.
- Every output carries an invisible SynthID watermark.
- Don't send private or sensitive content in a prompt — it leaves the machine.
