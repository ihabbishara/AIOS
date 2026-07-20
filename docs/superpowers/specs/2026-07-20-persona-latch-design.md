# Persona latch — design spec (④, split-source surface hash)

Cycle ④, the cut noted in the session-surface-refresh cycle (8edb0d5→8f100cf): `surfaceHash` is
tools-only, so editing an agent's persona does NOT invalidate its live session — the edit is
silent until a manual fleet reset ("persona latching", accepted then, fixed now).

## Problem

`surfaceHash` (src/agents/resumable.ts:24) hashes `allowedTools + mcpServers keys +
permissionMode`. The systemPrompt was deliberately excluded because the memo block re-renders
nightly — hashing the full prompt would invalidate every session every night and nuke hermes
continuity (settled decision, still honored).

But that lock conflated two things glued into one string. The assembled systemPrompt is:

- **static** — `base.systemPrompt` (persona text from the agent YAML + injected contextFiles,
  runner.ts:25-27) + `## Pillar: <dept>` + dept mission (resolve.ts:186). Changes only when the
  user edits a definition.
- **dynamic** — the rendered memo (`memoContextForDomain`, resolve.ts:180, policy-gated) and, at
  the moderator seam only, `moderatorBlocks` state (session.ts:127). Churns nightly / per turn.

Only the dynamic half churns. Hashing the static half gets persona-latch invalidation for free
while preserving exactly the continuity the original lock protected.

## Decision

Expose the static half from resolve as `ResolvedAgent.personaSurface`, fold it (plus the skills
list) into `surfaceHash` as an optional second argument, and pass it at both resume seams. A
persona / contextFile / skills / mission edit → hash changes → the **existing** resume gate
(resumable.ts:51-52) declines to resume → next turn starts a fresh session with the new
definition. Memo re-renders and moderator state blocks never touch the hash.

Boundary (user decision: whole static surface, not persona-text-only):

- **Hashed**: `base.systemPrompt` (persona + contextFiles), dept pillar + mission,
  `options.skills` (sorted), plus everything already hashed (tools, server names, mode).
- **Excluded**: memo (nightly churn — the settled no-churn guarantee), `moderatorBlocks`
  (per-turn state; appended after resolve, structurally outside `personaSurface`).

Note on contextFiles: they are read fresh per session into `base.systemPrompt`, so editing e.g. a
project CLAUDE.md also invalidates. Desired — context changed → fresh session — and files change
only on user edits, so no auto-churn.

## Components

### 1. `ResolvedAgent.personaSurface` (src/agents/resolve.ts)

At the options-assembly site (resolve.ts:186/209), the static and dynamic parts are already
separate variables — the split exists, it just gets flattened before hashing:

```ts
const personaSurface = [base.systemPrompt, `## Pillar: ${dept.department}`, dept.mission.trim()]
  .filter(Boolean).join("\n\n"); // memo deliberately EXCLUDED — the no-churn guarantee
```

- Add `personaSurface: string` to the `ResolvedAgent` interface (resolve.ts:44) and to the return
  (resolve.ts:252).
- Built from the same variables the `contextBlock` uses, minus `memo`.

### 2. `surfaceHash(options, personaSurface?)` (src/agents/resumable.ts)

Payload gains two fields:

```ts
persona: personaSurface ?? null,
skills: [...(options.skills ?? [])].sort(),
```

- Optional second parameter — every existing caller/mock (`vi.mock` of resumable.js exports
  surfaceHash) stays source-compatible; omitting it hashes `persona: null` exactly as today's
  callers implicitly do.
- Skills ride along because they shape behavior like the persona does and were invisible to the
  hash (a skills edit previously latched too).

### 3. Seams pass it (src/moderator/session.ts:178, src/agents/direct.ts:142)

`surfaceHash(finalOptions)` → `surfaceHash(finalOptions, resolved.personaSurface)` at both sites.
The moderator's extra `moderatorBlocks` suffix and both seams' tool widenings (ATTACH_TOOL etc.)
are already inside `finalOptions` and keep hashing as before.

### One-time effect on deploy

Every stored surface hash predates the new payload fields → first turn per session after deploy
starts fresh (same one-time fleet reset as the original surface-refresh ship, 8edb0d5). Expected
and harmless; noted so nobody debugs it as a regression.

## Untouched

- Memo pipeline (memoContextForDomain, distiller, renderMemo) — unchanged.
- The tools/servers/mode portion of the hash and the resume-gate mechanics (resumeFor,
  reset-epoch) — unchanged.
- Agent tool surface — none. **No golden regen.** No new deps. No new bus events.

## Error handling

No new failure modes: `personaSurface` is a pure string built from already-required fields
(`dept.mission` and `base.systemPrompt` already exist or resolve throws earlier). A missing/empty
surface hashes as `null`/empty — worst case is a spurious fresh session, never a stale resume.

## Testing

`test/session-surface.test.ts` (existing file, tests are additive; current tests must stay green
unchanged — proves back-compat of the optional param):

- Same options + same personaSurface → same hash (stability).
- Persona text edit → different hash.
- Mission change → different hash.
- Skills change (`options.skills`) → different hash.
- **Memo-only change → SAME hash** — the core no-churn regression: two resolves differing only in
  the memo produce identical `personaSurface`, hence identical hash. Guards the hermes-continuity
  guarantee.
- Resume gate: stored hash ≠ new (persona-edited) hash → `resumeFor` declines (fresh session).

Live smoke (post-deploy): edit a test agent's persona line → next direct turn logs a fresh
session (no resume); send two turns with an unrelated memo re-render between → second turn
resumes (continuity preserved).
