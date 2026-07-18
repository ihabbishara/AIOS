# Media generation — design spec (⑤d)

Date: 2026-07-19
Status: approved

## Problem

Agents consume media (⑤b) but cannot produce any: no charts, no diagrams, no on-demand speech.
Outbound files exist only in direct @agent chats (`aios_attachments` collector); hermes — the main
conversational surface — replies text-only. Kokoro TTS runs solely as the voice-in→voice-out
mirror.

## Decision

An in-process `media` MCP server (research-server pattern) with three render tools, exposed via a
new `media-gen` capability; the moderator seam gains the same turn-scoped attachment collector
direct chats have; voice results deliver as playable voice notes. No new npm deps — python3 +
matplotlib, graphviz `dot`, and kokoro are all already on the box.

Rejected alternatives:
- **Goal/playbook-based generation** — no chat immediacy; "show me a spend chart" should not
  spawn a goal.
- **Prompt-only SVG writing** — no rasterization, no TTS, and Telegram renders SVG documents
  poorly.
- **Raw matplotlib code from agents** — arbitrary code execution from agent-authored text;
  rejected on security grounds (user-confirmed). Charts use a constrained spec instead.

## Components

### 1. Media server (src/media/server.ts)

`buildMediaServer(deps)` where deps carry the live VoiceService handle (⑤b MediaDeps precedent)
and a log fn. Three tools:

- `render_chart(spec)` — zod-constrained spec, no agent code executed:
  `{type: "line"|"bar"|"pie"|"scatter", title?, xLabel?, yLabel?, labels: string[],
  series: Array<{name?, values: number[]}>}`. The handler writes the spec as JSON to the temp
  dir and invokes a fixed python template (`src/media/chart.py`, shipped with the repo) via
  `python3` subprocess; the template reads the JSON and renders a PNG with matplotlib. ~20s
  timeout; on nonzero exit the tool returns the stderr tail as its error text.
- `render_diagram(dot)` — graphviz dot source rendered via `dot -Tpng -o out.png`. Dot is a
  declarative graph language, not code execution. Same timeout/stderr contract; a syntax error
  comes back to the agent verbatim so it can fix the source and retry.
- `speak(text)` — clamps to the existing `MAX_TTS_CHARS` (3000, src/voice/tts.ts), calls the
  live VoiceService synthesize → ogg path. When TTS is unavailable or fails, the tool returns a
  clear error and the agent falls back to prose.

All outputs land in a per-call `mkdtemp("/tmp/aios-media-")` directory — inside the attachment
server's existing `/tmp/aios-` literal-prefix safe rule (attachment-server.ts:23), so results are
attachable with zero safeDirs changes. Each tool's success text states the absolute output path
and reminds the agent to deliver it with `attach_file` (or that it will be inlined by the seam).

### 2. media-gen capability (agents/_capabilities.yaml)

`media-gen: { server: media, tools: [mcp__media__render_chart, mcp__media__render_diagram,
mcp__media__speak] }` plus a `media` entry in resolve.ts `SERVER_BUILDERS`.

Assigned (1-line-per-agent, trivially extendable): **hermes** (all-purpose), **midas** (finance
charts), **athena**, **odin** (design/architecture diagrams), **clio** (report charts),
**venus** (visuals). org-golden regenerated accordingly.

### 3. Moderator attachment seam (src/moderator/session.ts, src/router.ts)

The moderator turn builds the same turn-scoped collector + `aios_attachments` server direct.ts
uses (session.ts:152 already merges per-turn mcpServers). `ModeratorSession.handle` returns
`{text, attachments}` instead of a bare string; the router's moderator branch forwards them into
`RouterResult`. Safe dirs mirror direct.ts (projectsRoot, data/downloads, `/tmp/aios-` prefix).

### 4. Voice-note delivery (src/agents/attachment.ts, src/agents/attachment-server.ts, src/index.ts)

`Attachment` gains optional `kind?: "voice"`; `attach_file` accepts the optional kind. The
index.ts delivery loop sends voice-kind attachments via `channel.sendVoice` when the channel
supports it (Telegram), falling back to `sendFile` otherwise. `speak` results are attached with
`kind: "voice"` so they arrive as playable voice notes, not document files. The voice-in→voice-out
mirror policy (src/voice/mirror.ts) is untouched.

## Untouched

Engine/goals (goal agents holding the capability may render and file artifacts; goal-completion
delivery stays text — user's scope call), STT/attachment understanding (⑤b), mirror policy,
playbooks, no new bus event types, no new npm deps.

## Error handling

Every failure is an in-band tool error message (missing binary, timeout, bad spec, TTS down) —
never a thrown turn abort; the agent degrades to prose. Subprocess calls get explicit timeouts
and surface stderr tails. `render_chart` validates the spec shape via zod before any subprocess
spawns; series/labels length mismatches are rejected with a message naming the mismatch.

## Testing

- Root vitest: chart spec zod validation (mismatched series lengths rejected); real matplotlib
  render behind `skipIf` on python3/matplotlib absence, asserting PNG magic bytes; dot render
  happy path + syntax-error path (skipIf no `dot`); speak clamp + unavailable-TTS error path
  (stub VoiceService); attachment `kind` plumbing through attach_file → collector; moderator
  handle returns attachments (stubbed run).
- Live smoke after deploy: hermes "chart my last 7 days of spend" → PNG in chat; hermes "read
  me a one-line summary aloud" → playable voice note; @athena "diagram the AIOS media pipeline"
  → PNG diagram.
