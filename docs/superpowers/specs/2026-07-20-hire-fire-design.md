# Hire/fire from UI — design spec (②)

Cycle ②, deferred twice. Create and retire agents from the ui2 cockpit. The edit side already
exists (`PATCH /api/agents/:name/manifest` → spliceManifestField → `reloadPacks()`); this cycle
adds the two missing verbs on the same pattern: validate → file op → in-place registry reload →
live, no daemon restart.

## Problem

Adding or removing an agent today means hand-authoring YAML over SSH and bouncing the daemon.
Everything needed already exists in pieces: the loader validates manifests (collisions, unknown
capabilities/guards, exactly-one-coordinator), `reloadRegistry` re-reads the whole roster in
place (index.ts:149, mutating the shared Maps), and ui2 has Staff/StaffProfile views. Missing:
a create endpoint, a retire endpoint with reference guards, and the UI affordances.

One blocker discovered in exploration: the loader iterates **every** directory under `agentsDir`
(loader.ts, `statSync(full).isDirectory()`), so an `agents/_retired/` archive would still load —
the underscore-dir skip must be added first or retire cannot work.

## Decision

User-locked choices:

- **Retire = archive**, not delete: move `agents/<dept>/<name>.yaml` → `agents/_retired/<name>.yaml`.
  History preserved, re-hire = move back (manual for now). Loader gains a skip for `_`-prefixed
  directories (mirrors the `_capabilities.yaml` file convention).
- **Retire guards (all three)**: refuse to retire (with the reason) — the coordinator (loader
  THROWS without exactly one; retiring hermes would brick every subsequent reload), any
  `department.yaml lead:`, and any role referenced by a playbook stage `role:`.
- **Hire form = minimal + capabilities**: `name, department, kind, title, charter, persona,
  prompt, capabilities[]`. Tools come ONLY from capabilities (clamp-safe by construction — the
  capability union IS the surface). Defaults: `maxTurns: 25`, `permissionMode: dontAsk`; no
  aliases/model/skills/tools at hire — all editable later via the existing manifest PATCH.
- **Golden fixture skips unknown agents**: the golden test iterates `Object.keys(golden)` instead
  of the registry and warns about unpinned agents. Runtime hires never redden the suite; the
  dev-time regen ritual (scripts/gen-org-golden.ts + diff review) is unchanged.

New-file YAML is rendered from a template literal — the parse-to-locate+splice rule governs
*editing* hand-authored YAML (preserving formatting); a from-scratch render has nothing to
preserve. Retire is a file move; no YAML parsing at all.

## Components

### 1. Loader: skip `_`-prefixed directories (src/agents/registry/loader.ts)

In the `readdirSync(dir)` loop: `if (entry.startsWith("_")) continue;` before the `statSync`
branch. Enables the archive; also future-proofs other `_` support dirs.

### 2. Agent-file builder (src/web/agents-admin.ts — new, the tested unit)

Pure functions, no HTTP:

- `validateHire(body, registry): { ok: true; manifest: HireManifest } | { ok: false; error: string }`
  — name matches `^[a-z][a-z0-9-]*$` and collides with no agent name or alias (registry.agentOf
  covers both); department exists in `registry.departments`; kind ∈ `lead | worker | critic`
  (coordinator refused); every capability ∈ `registry.capabilities`; charter/persona/prompt
  non-empty strings.
- `renderAgentYaml(manifest): string` — template-literal YAML with block scalars (`charter: >`
  etc.), `maxTurns: 25`, `permissionMode: dontAsk`, `kind`, `capabilities: [...]`. Output MUST
  round-trip: `agentSchema.parse(parseYaml(rendered))` succeeds (pinned by test).
- `retireBlockers(name, registry): string[]` — empty = retirable; else reasons:
  `"is the coordinator"`, `"is lead of <dept>"`, `"referenced by playbook <name> stage <id>"`.
  Sources: `def.kind === "coordinator"`; `registry.departments` values' `lead`; every
  `registry.playbooks` stage `role` (resolve through `registry.agentOf` so aliases count).

### 3. Routes (src/web/server.ts — thin, untested per house rule)

- `POST /api/agents` — `validateHire` → 400 on fail; `writeFileSync(agents/<dept>/<name>.yaml,
  renderAgentYaml(...))` → `reloadPacks()` → 200 with `buildAgentProfile(name, ...)`. If
  `reloadPacks` throws (loader rejection despite validation), delete the just-written file and
  500 — never leave a file the loader chokes on (every later reload would fail).
- `DELETE /api/agents/:name` — resolve alias → canonical; 404 unknown; `retireBlockers` → 409
  with `{ blockers }`; else `mkdirSync(agents/_retired, recursive)` +
  `renameSync(yamlPath, agents/_retired/<name>.yaml)` (path via existing `agentYamlPath`) →
  `reloadPacks()` → 200. On reload throw: move the file back, 500 (same never-brick rule).

### 4. Golden test change (test/resolve-agent.test.ts)

The golden-surface test iterates `Object.keys(golden)`; after the loop,
`const unpinned = [...registry.agents.keys()].filter((n) => !(n in golden));` →
`console.warn("golden: unpinned agents:", unpinned)` when non-empty. The clamp invariant test
still iterates the full registry (hired agents stay clamp-checked from day one).

### 5. ui2 (Staff.tsx + StaffProfile.tsx + api.ts — thin, untested)

- `api.hireAgent(body)` → POST; `api.retireAgent(name)` → DELETE.
- Staff org view: `+ hire` button → inline form (text inputs; department + kind as selects;
  capabilities as checkboxes). Capability + department lists come from data already in
  `/api/state` (agents carry them) or a small static list — no new read endpoint unless state
  lacks capability names; if it does, extend `/api/state` with `capabilities: string[]`
  (registry keys) rather than adding a route.
- StaffProfile: `retire` via the existing `TwoStepButton` (confirm pattern); on 409 show the
  blockers; on 200 navigate back to staff.

## Untouched

- Existing agents' tool surfaces — unchanged → **no golden regen in this ship**.
- Manifest PATCH / skills endpoints, resolve, sessions, persona-latch — untouched (a hired agent
  resolves fresh; later edits propagate next turn via ④).
- No new npm deps, no new bus event types. Re-hire UI deferred (move the file back by hand).

## Error handling

- Validation failures → 400 with a single human-readable `error`.
- Retire blockers → 409 with the full list (UI renders them verbatim).
- Reload throw after a file op → compensate (delete new file / move back) then 500; the roster
  never ends in a state the loader cannot reload. This is the critical invariant: a bad file on
  disk breaks EVERY future reload, not just this request.
- Concurrent hires of the same name: second `validateHire` runs after the first `reloadPacks`,
  so the collision check catches it; worst case both pass validation and the second write wins
  identically-named — acceptable for a single-user cockpit (noted, not defended).

## Testing

`test/agents-admin.test.ts` (new) against the real registry (same harness as
resolve-agent.test.ts):

- validateHire matrix: bad name pattern, agent-name collision, ALIAS collision (e.g. "cfo"),
  unknown dept, unknown capability, kind=coordinator, missing charter → each refused with a
  distinct error; happy path ok.
- renderAgentYaml round-trip: `agentSchema.parse(parseYaml(rendered))` succeeds; parsed manifest
  carries name/department/kind/capabilities; defaults present.
- retireBlockers: hermes → coordinator; a dept lead (from live registry.departments) → lead
  reason; a playbook-referenced role (from live registry.playbooks) → playbook reason; a
  worker with no refs → [].
- Loader `_`-skip: write a temp `agents/_retired/<x>.yaml` fixture copy → loadRegistry does NOT
  register it (use a tmp agentsDir copy, not the live tree).
- Golden: suite stays green when a synthetic agent is present in the registry but absent from
  the fixture (the skip behavior itself).

Live smoke (browser): hire `test-scout` (research dept, worker, files-ro capability) from the
Staff view → appears in roster + chat targets → direct-chat it replies → retire from its profile
→ 200, gone from roster → `agents/_retired/test-scout.yaml` exists. Also verify hermes retire →
409 with "coordinator" blocker.
