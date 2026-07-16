# Persona Explorer — Design Spec

Date: 2026-07-16
Cycle: ③ in the platform-evolution series (after Scheduling & Routines, Skills manager)

## Overview

Evolve the Staff section's agent profile from a thin read-only card into a rich persona
explorer: full manifest visibility (persona, prompt, kind, capabilities, aliases, skills),
a merged activity history (runs, handoffs, mail, goal work), and structured in-place
editing of identity/behavior fields with comment-preserving YAML splicing.

Scope decisions (locked during brainstorming):

- **Browse + edit.** Editing covers identity/behavior fields only: `title`, `charter`,
  `persona`, `prompt`, `model`, `maxTurns`. Structural fields (`name`, `department`,
  `kind`, `capabilities`, `aliases`, `permissionMode`, `tools`, `skills`) stay
  YAML-file-only — tools are governed via permission proposals, skills via the Skills tab.
- **Activity = merged timeline + work products.** One chronological feed plus structured
  Goals and Mail sections.
- **No hire/fire this cycle.** Creating or retiring agents is a separate future cycle.
- **No new top-level UI section.** Everything lives inside Staff (approach A); the profile
  page gains sub-tabs.

## Architecture

Follows the Schedule/Skills cycle pattern exactly: pure tested builders in `src/web/`,
thin untested routes in `server.ts`, DTO types in `dto.ts` (shared into the ui2 type
graph), a view component in `ui2/src/views/`.

### New file: `src/web/persona-view.ts`

Pure builders. May import store/bus/registry types (server-side only file; `dto.ts` must
not import from it — DTO interfaces live in `dto.ts` as usual).

**`buildAgentActivity(nameOrAlias, registry, store, bus): AgentActivityInfo | null`**

Returns `null` for unknown agents. Canonicalizes aliases via `registry.agentOf` the same
way `buildAgentProfile` does.

- `timeline`: merged from `bus.history(0, 5000)` (same `HISTORY_WINDOW` as org-view):
  - `agent.end` where agent canonicalizes to the target → kind `run` (ok flag, context, cost)
  - `route.decision` where `to` canonicalizes to the target → kind `route` (via, reason)
  - `mail.sent` where `from` or `to` is the target → kind `mail`
  - `node.status` where `agent` is the target → kind `goal` (goalId, nodeKey, status)

  Each entry: `{ ts: string; kind: "run" | "route" | "mail" | "goal"; summary: string;
  ok?: boolean }`. Sorted newest-first, capped at 100 entries.
- `goals`: from `store.listGoals()` + `store.listNodes(goalId)`, keeping goals that have
  at least one node assigned to the agent. Shape:
  `{ goalId, title, status, nodes: [{ key, status }] }` — nodes filtered to the agent's.
- `mail`: `store.listMail(agent, 30)` mapped to
  `{ id, ts, from, to, kind, subject, read }`.

**`spliceManifestField(yamlText, field, value): string`**

Comment-preserving single-field rewrite of an agent manifest. Throws (message becomes the
HTTP 400 body) on: unparseable YAML, field outside the whitelist, invalid value.

- Whitelist and value rules:
  - `title`: non-empty string → plain scalar
  - `charter`, `persona`, `prompt`: non-empty string → folded block scalar (`>`) with
    2-space-indented lines, matching the hand-authored house style
  - `model`: non-empty string → plain scalar
  - `maxTurns`: positive integer → plain scalar
- Mechanics: parse with `yaml` `parseDocument`, locate the key's AST node range, replace
  only the lines spanned by that key/value pair; every byte outside the spliced range is
  preserved verbatim (comments, ordering, quoting of untouched fields). Never
  `Document.toString()` (reformats the whole hand-authored file).
- Insert-when-missing: `model` and `maxTurns` are optional in manifests. When absent, the
  new `key: value` line is inserted after the `tools` line if present, else appended at
  the end of the document. Required fields (`title`, `charter`, `persona`, `prompt`) are
  always present in valid manifests; splice throws if the key is missing (corrupt file).

### DTO additions (`src/web/dto.ts`)

- `AgentProfileInfo` gains: `kind: string`, `capabilities: string[]`, `prompt: string`.
  (`persona`, `skills`, `aliases`, `maxTurns`, `handoffs` already exist — the UI finally
  renders them.)
- New `AgentActivityInfo` interface as described above.

`buildAgentProfile` in `org-view.ts` extends its return with the three new fields (all
straight off `def.manifest` / `def.kind`).

### Routes (`src/web/server.ts` — thin, untested per repo convention)

- `GET /api/agents/:name/activity` → `buildAgentActivity(...)`; 404 when null.
- `PATCH /api/agents/:name/manifest`, body `{ field: string, value: string | number }`:
  1. Resolve agent (404 unknown). Resolve its manifest path from the registry definition.
  2. Read file, `spliceManifestField` (validation errors → 400 with the thrown message).
  3. Write file, call `reloadPacks()` (the injected `reloadRegistry` — mutates the shared
     registry Maps in place).
  4. Return the fresh `buildAgentProfile` result.

  No new bus event type (unknown types hit the LLM triage classifier — routine.due
  precedent). A daemon log line records `persona edit: <agent>.<field>`.

The registry definition must expose the manifest's source file path. If `LoadedRegistry`
agent defs don't already carry it, `loader.ts` adds `file: string` (absolute path) to the
def at load time — a one-line addition, populated where manifests are read.

### Error handling

- Unknown agent → 404; unknown/invalid field or value, unparseable YAML → 400 with
  message; all validation happens before the file is touched.
- Write-then-reload ordering: if `reloadPacks()` throws after a successful write, respond
  500 and log; the file on disk is already valid YAML (splice parsed it), so the registry
  catches up on next reload/restart. No rollback machinery.

## UI

### `ui2/src/views/StaffProfile.tsx` (new file)

`Profile` (and its `GrantBox`/`Sparkline` helpers) moves out of `Staff.tsx` into
`StaffProfile.tsx`; `Staff.tsx` keeps `OrgColumns`, `DeptMenu`, `Governance` and shrinks.
Routing inside Staff grows one level:

- `staff/agents/:name` → overview (default)
- `staff/agents/:name/activity` → activity
- `staff/agents/:name/edit` → edit

Sub-tab header on the profile page, same pattern as Staff's org/governance switcher.

**Overview** — existing sections (charter, access, trust, recent runs, cost sparkline)
plus:

- persona paragraph under the charter
- collapsible prompt block (mono, read-only, collapsed by default)
- `kind`, `capabilities`, aliases rendered as tags in the header area
- skills as tags; clicking navigates to `skills/<skillName>`
- handoffs list (ts, reason, channel) — DTO field rendered for the first time

**Activity** — fetched from `GET /api/agents/:name/activity` with `useLiveQuery`
(refresh topics: agent actions + mail):

- timeline list: tone dot per kind (`run` ok/err, `route`, `mail`, `goal`), ts, summary
- Goals section: goal title + status, agent's nodes with per-node status tags
- Mail section: from → to, kind, subject, ts

**Edit** — per-field form, no whole-form submit:

- `title`, `model` text inputs; `maxTurns` number input; `charter`, `persona`, `prompt`
  textareas (mono)
- each field tracks dirty state and gets its own Save button → `PATCH manifest` → success
  note + profile reload; failure shows the 400 message inline next to that field
- hint text: clearing `model` entirely is not supported from the UI (empty value is
  rejected); removing optional keys stays a YAML-file operation

### `ui2/src/api.ts` additions

- `agentActivity(name): Promise<AgentActivityInfo>`
- `patchAgentManifest(name, field, value): Promise<AgentProfileInfo>`

## Testing

`src/web/persona-view.test.ts` (builders carry the tests; routes and views stay thin):

- activity: merge ordering (newest first), alias canonicalization, kind mapping per event
  type, 100-entry cap, goals filtered to agent nodes, unknown agent → null
- splice: scalar replace (`title`, `model`), block scalar replace (`charter`, `persona`,
  `prompt`) asserting bytes outside the spliced range are identical, insert-when-missing
  (`model`, `maxTurns`) placement, unknown field throws, invalid values throw (empty
  strings, non-positive/non-integer `maxTurns`), unparseable YAML throws, missing
  required key throws

Verification (post-build): root + ui2 vitest green, both `tsc --noEmit` clean, daemon
rebuild + `launchctl kickstart -k gui/501/com.ihab.aios` + ~5s sleep, smoke
`GET /api/agents/athena/activity`, idempotent live PATCH (same value) on one agent and
`git diff agents/` confirms a zero or single-line diff only.
