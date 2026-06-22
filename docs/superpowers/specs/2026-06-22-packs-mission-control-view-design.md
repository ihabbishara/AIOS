# Packs Mission Control View — Design Spec

**Date:** 2026-06-22
**Status:** Approved (brainstorm complete) — ready for implementation plan
**Related:** [[phase7-pillar-packs-design]], [[code-pillar-pack-design]], [[money-pillar-pack-design]]

## 1. Motivation

The pillar-pack framework (money + code, more coming) is invisible in Mission Control. The
boot log says `packs: code, money`; the UI does not. Roles surface flat in Permissions, jobs
in Board, approvals in Approvals — but nothing shows *which pillars are bound, what each can
do, and what they've been doing*. This adds a **Packs** tab: one card per bound pillar,
reflecting its real config + live activity, with launch + manage actions — a faithful,
comprehensive view of the pack reality.

## 2. Scope, decomposition, deferrals

**In scope (one spec, sequenced MVP-first in the plan):**
- A read-only **pack dashboard** (`/api/packs` + `Packs.tsx`): every bound pillar's config + live signals.
- **Launch**: enqueue one of a pillar's playbooks (validated, reuses the moderator's `run_playbook` path).
- **Manage — kill-switch toggle**: enable/disable any pack via a generalized per-pillar env flag + restart.
- **Manage — playbook edit**: inline YAML editor reusing the existing `/api/playbooks` GET/PUT.

**Plan sequence:** (1) dashboard → (2) launch → (3) generalized kill-switch + toggle → (4) playbook edit. Each independently shippable.

**Deferred:** dedicated money/speculate/email-drafts dashboards (separate cycles); editing
persona/roles/tools from the UI (config + code own those); a live per-job workspace *diff*
viewer (link to vault artifacts is enough this cycle).

## 3. Architecture

```
Packs.tsx ──GET /api/packs──► buildPacksView(config, store)   src/web/packs-view.ts
   │                              reads: every playbooks/*/pack.yaml on disk (so DISABLED packs
   │                              still appear) + roles record + each referenced playbook yaml
   │                              + live: store.listJobs() filtered by pillar, workspace stat, memo count
   ├─ [Run] ──POST /api/packs/<pillar>/run {playbook, project_dir}──► validate → jobs.createJob()
   ├─ [⏻]   ──POST /api/packs/<pillar>/enabled {enabled}──────────► write AIOS_<PILLAR>_DISABLED → restart
   └─ [Edit YAML] ──GET/PUT /api/playbooks (existing)──────────────► savePlaybook → reloadPacks
```

**Source of truth = the filesystem, not the live registry.** A disabled pack is dropped from
the in-memory registry at boot, so if the view read the registry a disabled pack would vanish
and become un-re-enableable. Instead `buildPacksView` scans `config.playbooksDir` for every
`*/pack.yaml` and computes `enabled` from the env flag — disabled packs render (greyed, with an
*enable* toggle) so the toggle works both ways. Live signals still come from `store` regardless.

## 4. Backend

### 4.1 `src/web/packs-view.ts` (new — mirrors `permissions-view.ts`)

`buildPacksView(config: Config, store: Store): PackView[]` — scans `config.playbooksDir` for
every `<pillar>/pack.yaml`, parses each with `packSchema` (skip-on-error, mirroring the loader),
loads each referenced playbook yaml for stage info, and joins live signals from `store`.

```ts
export interface PackRoleView {
  name: string;
  description: string;
  privateOnly: boolean;        // role.privateOnly (e.g. cfo)
  advisoryInDirect: boolean;   // true when the pack is sandboxed (direct @role = advisory/no-workspace)
  permissionMode: string;
  allowedTools: string[];
}
export interface PackPlaybookView {
  name: string;
  description: string;
  needsProjectDir: boolean;
  stages: Array<{ id: string; type: string; role: string }>;  // role = single.role | loop.producer | verify.runner
}
export interface PackJobView {
  id: string; title: string; playbook: string; status: string; created_at: string;
  projectDir: string | null;
}
export interface PackWorkspaceView { taskDir: string; exists: boolean; jobId: string; title: string; status: string; }
export interface PackView {
  pillar: string;
  persona: string;
  memoDomain: string;
  vaultSection: string;
  sandbox: boolean;
  enabled: boolean;            // !(AIOS_<PILLAR>_DISABLED === "1") — false packs render greyed w/ an enable toggle
  toolServer?: string;
  tools: string[];             // tool ceiling
  actions: string[];           // gated action ceiling
  roles: PackRoleView[];
  playbooks: PackPlaybookView[];
  recentJobs: PackJobView[];   // store.listJobs(N) where job.playbook ∈ pack.playbooks (empty for chat-only packs)
  workspaces: PackWorkspaceView[]; // sandbox packs only: distinct projectDir under config.workspaceRoot, existsSync-checked
  memoCount: number;           // memory_doc COUNT for memoDomain (existing store query ~db.ts:690)
}
```

`enabled = process.env[\`AIOS_${pillar.toUpperCase()}_DISABLED\`] !== "1"`. Both enabled and
disabled packs are returned (disabled ones still carry full config + live signals so the UI can
render them greyed with a working *enable* toggle).

- Roles resolved from the `roles` record (`src/agents/roles/index.ts`) by name; a role named in
  the manifest but absent from the record is reported with `description: "(missing role def)"`
  rather than throwing.
- `recentJobs`: `store.listJobs(50)` filtered to `pack.playbooks.includes(job.playbook)`, capped ~10.
- `workspaces`: from those jobs' `project_dir`, distinct, where the path is under
  `config.workspaceRoot`; `exists` via `existsSync`.
### 4.2 Wiring + endpoints (`src/web/server.ts`, `src/index.ts`)

- `GET /api/packs` → `json(buildPacksView(config, store))`. No registry threading needed —
  `config` + `store` are already in `WebDeps`; the builder scans disk for definitions.
- `POST /api/packs/:pillar/run` `{ playbook, project_dir? }`:
  - 404 if `playbooks/<pillar>/pack.yaml` absent; 400 if `playbook ∉` that manifest's `playbooks`
    (a disabled pack's playbooks aren't loaded, so `createJob` would also reject — double guard);
    `project_dir` (if given)
    `resolve()`d and **must be under `config.projectsRoot`** else 400 (verbatim the `run_playbook`
    guard at `tools.ts:55-58`); then `deps.jobs.createJob({ playbook, title, request, projectDir,
    channel: "web", chatId: "packs-view" })`. Returns `{ id }`.
- `POST /api/packs/:pillar/enabled` `{ enabled: boolean }`:
  - 404 if pillar unknown. Writes env key `AIOS_<PILLAR>_DISABLED` = `"1"` (disable) or removes it
    (enable) via the **same .env writer the Config PUT uses**, then calls the existing restart path
    (`/api/restart` logic) so the change takes effect on reboot. Returns `{ ok: true, restarting: true }`.
- All endpoints flow through the **existing auth gate** (server.ts:115-118): when
  `AIOS_UI_TOKEN` is set every `/api/*` requires it; when unset the API is localhost-open — these
  endpoints are exactly as protected as the existing `config PUT` / `restart` / `actions resolve`.

### 4.3 Generalized kill-switch (`src/packs/loader.ts`, `src/index.ts`)

- Rename/generalize `dropCodePack(reg)` → `dropPack(reg: LoadedPacks, pillar: string)` (drop the
  pack + its playbooks from `playbooks`/`pillarOf` + its `roleOf` entries; null-safe if absent).
  Keep a `dropCodePack` thin alias OR update the single call site.
- In index.ts after `loadPacks` (and inside `reloadPacks` on the fresh registry): for each loaded
  pillar `P`, if `process.env[\`AIOS_${P.toUpperCase()}_DISABLED\`] === "1"` → `dropPack(reg, P)`.
  `AIOS_CODE_DISABLED` is now just the `code` case of this pattern — backward-compatible
  (`config.codeDisabled` may stay as a convenience alias or be subsumed).

## 5. Frontend — `ui/src/views/Packs.tsx`

New nav tab **Packs**. `usePoll(() => api.packs(), [lastJobOrPackEvent])`. One card per pillar
(terminal/phosphor aesthetic, matching existing views):

```
┌─ CODE  [sandbox]                                  [● enabled ⏻]──┐
│ persona: "senior software engineer in a sandboxed workshop…"     │
│ memo: code · vault: code · ceiling(actions): [vault.write]       │
│ ROLES  developer  tester  reviewer  architect  code-reviewer     │
│        researcher  devops          ★ = advisory in direct chat   │
│ PLAYBOOKS                                                        │
│   code-build   research→design→implement→verify→review     [Run] │
│   code-analyze read-only audit · needs project_dir         [Run] │
│                                                  [Edit YAML ▾]    │
│ RECENT JOBS   ▸ audit halalo   ✓done  06-22  → open              │
│ WORKSPACES    ~/projects/AIOS-Workspace/2026-06-22-x-ab12   ✓    │
│ memos: 14                                                        │
└──────────────────────────────────────────────────────────────────┘
┌─ MONEY                                            [● enabled ⏻]──┐
│ persona: "private personal CFO…"   ceiling(actions): [] (analysis)│
│ ROLES  cfo (private)        direct-chat pillar — no playbooks/jobs│
│ TOOLS  mcp__money__spending_summary, …            [Edit YAML ▾]   │
└──────────────────────────────────────────────────────────────────┘
```

- `[Run]` → inline form: the playbook is preselected; a `project_dir` text input (required for
  `needsProjectDir` playbooks); submit → `api.runPack(pillar, playbook, projectDir)` → toast with
  the new job id + a link to Board. Refuses client-side if a needsProjectDir playbook has no dir.
- `[⏻]` → confirm dialog ("Disable <pillar>? This restarts the daemon (~10s).") →
  `api.setPackEnabled(pillar, false)`; UI shows a "restarting…" state and re-polls.
- `[Edit YAML ▾]` → expands a textarea preloaded from `api.playbooks()` for that pillar's
  playbook files; save → `api.savePlaybook(file, yaml)` (existing) → re-poll.
- Graceful rendering: a pack with no playbooks (money) shows roles + tools and "direct-chat
  pillar — no jobs"; no Run/workspaces sections.
- A **disabled** pack (`enabled:false`) renders greyed with the toggle in the off state and an
  *enable* action; Run/Edit are disabled while off (its playbooks aren't loaded). This is why
  the view reads definitions from disk, not the live registry.

`api.ts` additions: `packs()`, `runPack(pillar, playbook, projectDir?)`, `setPackEnabled(pillar, enabled)` + the `PackView` types. `App.tsx`: import + a "Packs" tab.

The existing flat **Agents** view stays unchanged (covers non-pack specialists: halalo, finance,
moderator). Packs is the pillar-centric lens; no removal.

## 6. Safety + auth

- Launch + toggle validated server-side: pillar must exist, playbook ∈ pillar, `project_dir`
  under `projectsRoot` (fail-closed 400). Toggle requires a client confirm before restart.
- Endpoints inherit the existing token auth — no new exposure beyond today's mutating endpoints.
- The kill-switch stays fail-closed: a disabled pack never loads (dropped at boot); generalizing
  it doesn't widen the code-pack's existing guarantees. `AIOS_CODE_DISABLED` keeps working.
- The view is otherwise read-only; it cannot change personas, roles, tools, ceilings, or trust —
  those remain code/config/gate-owned.

## 7. Testing (TDD)

- **`buildPacksView` unit:** shape correct for a sandbox pack (code) — roles marked
  `advisoryInDirect`, playbooks with stages, `actions:[vault.write]`, tools include `mcp__code__sh`
  not `Bash`; for a chat-only pack (money) — no playbooks, `recentJobs:[]`, cfo `privateOnly`;
  live-signal join (a seeded done job for `code-build` appears in `recentJobs`; its `project_dir`
  under workspaceRoot appears in `workspaces` with `exists`); `memoCount` reads the domain count;
  a manifest role missing from the record degrades, not throws. **Disabled-pack visibility:** with
  `AIOS_CODE_DISABLED=1` set, the code pack still appears in the view with `enabled:false` + full
  config (so it can be re-enabled) — i.e. the view reads disk, not the dropped registry.
- **`dropPack` generalization:** drops a named pillar + its playbooks + roleOf; **regression** that
  `AIOS_CODE_DISABLED=1` still drops the code pack and a money-disable drops money, each leaving
  the other intact.
- **Endpoints:** `run` refuses unknown pillar / wrong playbook / project_dir outside projectsRoot,
  and on success creates a job; `enabled` writes the right env key and triggers restart; both
  pass through the auth gate.
- **Frontend:** `Packs.tsx` renders both pack shapes (sandbox + chat-only) from a fixture; the Run
  form requires a dir for needsProjectDir playbooks; the toggle shows a confirm.

## 8. What ships

- A new Packs tab, read+launch+manage, reflecting every bound pillar. Zero behavior change to
  existing views/endpoints; money + code packs unaffected at runtime (the generalized kill-switch
  is backward-compatible and pinned). Built subagent-driven TDD in an isolated worktree off clean
  main; the pdf-attachments WIP in the main checkout stays untouched (explicit-path commits).
  Deploy = backend + ui build + kickstart (no DB migration — no schema change this cycle).
