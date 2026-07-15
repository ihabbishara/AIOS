# Skills Manager — Design Spec

**Date:** 2026-07-15
**Status:** Approved (brainstorm), pending implementation plan
**Context:** Second of the platform-evolution series (after Scheduling & Routines; remaining:
persona explorer, Obsidian daily/jobs write-path repair, media/research modalities).

## Summary

Skills exist in AIOS (`skills-plugin/skills/<name>/SKILL.md`, loaded per-agent at spawn
via `skillOptions` in `src/agents/runner.ts`) but are invisible and unmanageable: two
skills, two consumers, all wiring hand-edited in role YAML. This design adds a **skills
manager**: a filesystem-as-truth API over the plugin directory plus a dedicated **Skills
tab** in ui2 — list skills with a usage map (skill → agents), create/edit/delete skill
files, import by paste or URL-prefill, and assign/unassign skills to agents from the UI.

No new storage: the plugin directory is the registry, the live agent registry provides
the usage cross-reference, and assignment writes go into the existing role YAML files
followed by the existing `reloadPacks()` registry reload. Skills load at agent spawn, so
skill-file changes need no daemon restart; only assignment (role YAML) needs the reload
that the API already triggers.

## Goals / Non-goals

**Goals**
- `GET /api/skills` view: every skill (name, description) + `usedBy` agent list.
- Skill CRUD: create/edit via raw SKILL.md editor; delete guarded by usage.
- Import: paste markdown, or URL fetch that **prefills the editor** (never auto-saves).
- Assignment: per-skill agent toggles → rewrites the agent YAML `skills:` field →
  registry reload.
- New ui2 **Skills** section (7th tab).

**Non-goals (v1)**
- No skill versioning, no marketplace/package index, no dependency metadata.
- No multi-file skills (only `SKILL.md` per directory; extra files may exist but are
  not managed by the UI).
- No file upload (paste + URL prefill cover it).
- No skill "testing/preview" runner.
- No changes to how the SDK loads skills at spawn.

## Architecture

### 1. Backend — `src/web/skills-view.ts` (mirrors `packs-view.ts`)

The skills plugin root is `process.env.AIOS_SKILLS_PLUGIN ?? <cwd>/skills-plugin`
(same resolution as `runner.ts` — export a shared accessor from `skills-view.ts` and
have `runner.ts` keep its own; they must agree on the default).

- `listSkills(pluginRoot): Array<{ name; description; dir }>` — scan
  `<root>/skills/*/SKILL.md`, parse frontmatter. Unparseable skills appear with
  `description: "(invalid frontmatter)"` rather than vanishing — the UI is where you
  fix them.
- `buildSkillsView(pluginRoot, registry): SkillView[]` — adds
  `usedBy: string[]` (agents whose `role.skills` include the name, from the live
  `LoadedRegistry`).
- `validateSkillMd(text): { ok: true; name: string; description: string } | { ok: false; error: string }` —
  requires a `---` frontmatter block whose `name` matches `/^[a-z][a-z0-9-]*$/` and a
  non-empty `description`. On save, frontmatter `name` must equal the directory name.
- `readSkill(pluginRoot, name): string | null` — full SKILL.md text; name validated
  against the regex before any path join (containment by construction).
- `writeSkill(pluginRoot, name, md)` / `deleteSkill(pluginRoot, name)` — mkdir+write /
  rm -r of the single skill directory.

### 2. API routes — `src/web/server.ts`

| Route | Behavior |
|---|---|
| `GET /api/skills` | `SkillView[]` (name, description, usedBy) |
| `GET /api/skills/:name` | `{ md }` full text; 404 unknown |
| `PUT /api/skills/:name` | body `{ md }`; validate; frontmatter name must equal `:name`; write; 200 `{ ok: true }` |
| `DELETE /api/skills/:name` | 409 `{ error, usedBy }` when referenced by any agent unless `?force=1`; else delete |
| `POST /api/skills/fetch` | body `{ url }`; **https only**, 256 KB cap, 10 s timeout; returns `{ md }` for editor prefill — never writes to disk |
| `PATCH /api/agents/:name/skills` | body `{ skills: string[] }`; every name must exist as a skill; rewrite the agent's YAML; `reloadPacks()`; 200 `{ ok: true }` |

Assignment file resolution: the agent's manifest file is
`<agentsDir>/<def.department>/<agentName>.yaml`. If that file doesn't exist (renamed
file), scan the department directory for the YAML whose parsed `name` matches. Rewrite
= parse with the existing `yaml` dependency, replace the `skills` array (add the key if
absent, drop it when empty), stringify, write back — all other fields preserved.

**Security posture:** imported skill text becomes agent system-prompt content — a prompt
injection vector if fetched blindly. The fetch endpoint therefore only *returns* content
for the editor; a human reviews and explicitly saves. URL guard: `https:` scheme only,
response capped at 256 KB, content-type must be text/*, no redirects followed off-https.
Skill names are regex-validated before any filesystem path is built.

### 3. UI — `ui2/src/views/Skills.tsx`, new section

- Router: `SECTIONS` gains `"skills"`; bottom-tab icon `✦`; jump key `g k`;
  route `#/skills` (detail via `#/skills/<name>`).
- Layout: master list (name, description, usage chips linking to `#/staff/agents/<agent>`)
  + detail pane: raw SKILL.md editor (monospace textarea), Save, Delete (TwoStepButton;
  when `usedBy` non-empty the first click surfaces the list and requires force),
  URL-fetch input ("Fetch → editor"), and an agent assignment checklist (all agents,
  checked = has skill) that PATCHes on toggle.
- "New skill" creates an editor pre-seeded with a frontmatter template.
- Data: `GET /api/skills` on mount + refetch after mutations (`useFetch` + `reload`,
  same as Schedule view).

### 4. Error handling

- All validation at the API boundary; builders trust validated input.
- YAML rewrite failures (parse error in an existing role file) → 500 with the parse
  message; no partial write (stringify before write).
- Registry reload failure after a successful YAML write → 500 carrying the loader
  error; the file stays saved (same posture as pack-file saves).
- Fetch failures (timeout, non-https, oversize, non-text) → 400 with a specific reason.

### 5. Testing

- **skills-view unit:** scan/parse (valid, invalid-frontmatter, empty dir), usage
  cross-ref, `validateSkillMd` accept/reject matrix, name/dir mismatch rejection.
- **Fetch guard:** scheme rejection, size cap, timeout (injectable fetch).
- **Assignment:** YAML rewrite round-trip preserves unrelated fields; add/remove/empty
  cases; unknown skill name rejected; department-scan fallback for renamed files.
- **UI:** render list + usage chips; editor save; assignment toggle fires PATCH —
  jsdom + stubApi, matching existing ui2 test conventions.
- Route wiring stays thin and untested per repo convention (builders/validators carry
  the logic and the tests).
