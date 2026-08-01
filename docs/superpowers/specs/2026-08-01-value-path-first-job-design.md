# AIOS Value Path — Workspace, First Job, Library — Design

Plan 3 of the onboarding-as-a-product decomposition. Parent spec:
`docs/superpowers/specs/2026-07-29-onboarding-product-design.md` (§3 workspace, §6 first half).

Plans 1 (foundation), 2a (org provisioning) and 2b (Architect interview) are merged. The wizard
today walks `welcome → auth → workspace → interview → review → provision` and then dead-ends: the
`first-job` step renders a placeholder (`ui2/src/views/Setup.tsx:22-29`). The org gets created and
does nothing. This spec closes that gap, which is the entire distance between current state and the
locked definition of the aha: **first job completes end to end**.

## The problem underneath the placeholder

Replacing the placeholder is not a UI task.

**Setup mode never boots the engine.** `src/index.ts:85-92` starts the wizard server and `return`s.
No registry, no `GoalEngine`, no moderator, no channels, no heartbeat. Spec §6 says the first job is
"routed through the normal coordinator/playbook path — zero special-case execution", but in setup
mode there is nothing to route into.

**Playbooks are not the dispatch path.** `createFromPlaybook` requires a playbook, and an
INTERVIEWED org has zero playbooks by design (plan 2b strips them — the model invents prose names
that provision rejects). The playbook path exists only for template orgs.

**Department leads are optional.** `lead` is absent from `INTERVIEW_SCHEMA`'s `required` array
(`src/onboarding/architect.ts:90`), so an interviewed department may have none — and
`planGoal` throws `unknown department or no lead` in exactly that case (`src/engine/plan.ts:251`).

**The coordinator, however, always exists.** `proposalShape` enforces exactly one `kind: coordinator`
agent, and `registry.coordinator` resolves by kind rather than by the name `neo`
(`src/agents/registry/loader.ts:197`). Whatever the interview named it, it is there.

## Decisions

| Decision | Choice |
|---|---|
| Scope | All three of spec §3 + §6 first half: workspace step, first-job step, Library view |
| How the engine becomes available | Hot boot in-process — extract `main()`'s normal body into a callable `bootNormal` |
| How the first job dispatches | Coordinator chat turn — `moderator.handle(firstJob)`, the coordinator picks its own tool |
| Port + auth handover | Setup server holds :4280 until `done`, then hands over the UI token and closes |
| Workspace picker | Typed path + server-side validation (a browser cannot hand a server a real path) |
| Library depth | Tree + markdown render + inline images/PDFs |

## Section 1 — Boot lifecycle

### `bootNormal` extraction

`src/index.ts:95-891` moves **verbatim** into an exported `bootNormal(config, opts)` in a new
`src/boot.ts`. `main()` shrinks to roughly twenty lines: load config, branch on `bootMode`, call
either `startSetupServer` or `bootNormal(config, { startWeb: true })`.

Moving the body untouched is deliberate. The largest risk in this refactor is a *reordered* boot —
the loader's constraints (write everything then reload once; playbooks before departments) and the
forward-referencing closures in `main()` (`infoPolicy`, `scheduleEmbed`, `goals` inside `mailbox`'s
`onQueued`) all depend on the existing order. Reordering must be impossible, not merely avoided.

`bootNormal` returns a handle rather than running to completion:

```ts
export interface BootedWorld {
  store: Store; bus: EventBus; goals: GoalEngine;
  moderator: Moderator; registry: LoadedRegistry; vault: VaultWriter;
  startWeb: () => void;        // the deferred startWebServer call
  shutdown: () => Promise<void>;
}
```

`opts.startWeb` defaults to `true`, so `main()`'s normal path is behaviourally unchanged. The wizard
passes `false` and calls `startWeb()` itself at `done`.

`startWebServer` is `main()`'s second-to-last statement (`index.ts:869-872`), so it splits off
cleanly with nothing after it but `resumeUnfinished` and the shutdown handlers.

### Config is re-read at boot

`bootNormal` calls `loadConfig()` itself rather than accepting the object loaded at process start.
The workspace step writes `AIOS_VAULT_PATH` to `.env` *after* that original load, so a captured
config would send every artifact to the wrong directory.

### The setup server gains one injected dep

`boot?: () => Promise<BootedWorld>` — matching the seam that `provisionFn`, `architect` and
`orgExists` already use, so the whole first-job path is testable against a fake world with no
model calls and no daemon.

### Sequence after "Create this org"

| Point | What happens |
|---|---|
| `review`, provision succeeds | Org written to disk. Unchanged from plan 2a. |
| Still inside the provision handler | `await boot()` — engine, channels, heartbeat, senses come up. **The web server does not.** |
| → `first-job` | Wizard renders the job card. Setup server still owns :4280, still unauthenticated, still Origin-checked. |
| User runs the job | `world.moderator.handle("web", "onboarding", request)` |
| → `done` | Response carries `AIOS_UI_TOKEN`. Browser stores it, setup server closes, `world.startWeb()` binds :4280, tab reloads into the cockpit. |

### `/api/state` remains the mode oracle

It returns `{ mode: "setup", step, booted, bootError? }` for as long as `onboarding.step !== "done"`.
Booting does not flip the browser out of the wizard. `booted` exists so the first-job screen can
distinguish "engine coming up" from "engine ready".

## Section 2 — Workspace step

`POST /api/onboarding/workspace` → `{ mode: "builtin" | "custom", path?, subdir? }`.

- **builtin** — writes nothing. `config.ts:208-209` already defaults to `~/AIOS/workspace` with
  subdir `AIOS` (plan 1's de-personalization landed). Advances.
- **custom** — the server resolves `~`, creates the directory, writes a probe file to prove
  writability, and deletes it. On success it writes `AIOS_VAULT_PATH` and `AIOS_VAULT_SUBDIR`
  through the existing `updateEnvFile`. On failure it returns the real errno message and does not
  advance.
- **Sync warning** — a path containing `iCloud`, `Library/Mobile Documents`, `Dropbox`,
  `Google Drive` or `OneDrive` returns `{ ok: true, warning }`. The UI shows it with a
  "use it anyway" confirm. Warn, never block: it is the user's disk.

Path logic lives in an exported pure `resolveWorkspace(input, home)` so it is unit-testable without
HTTP.

The UI is two radio options; choosing Obsidian reveals a path field and a subdir field. There is no
native folder picker — the File System Access API is Chrome-only and yields a handle, not a path a
server can use.

## Section 3 — First-job step

The card renders `proposal.firstJob` in an editable textarea. Spec §6's "one-click card plus a
free-text alternative" collapses into one control: prefilled and editable beats two widgets.

`POST /api/onboarding/first-job` → `{ request }`:

1. 400 unless `booted` — the engine must be up.
2. `world.moderator.handle("web", "onboarding", request)` — the coordinator picks its own tool
   (`hand_off`, `plan_goal`, `run_playbook`). No special-casing anywhere.
3. `{ request, startedAt }` is stored in kv immediately; the reply is stored when the promise settles.

`GET /api/onboarding/first-job` → `{ status: "idle" | "running" | "done" | "failed", reply?, error?, goals: [...] }`.

The `goals` array is `store.listGoals()` filtered to `origin_chat_id === "onboarding"`, each with its
nodes — the same shape `Goals.tsx` already consumes, so the wizard reuses the existing `MiniDag`
instead of drawing a second pipeline. The origin tuple the engine already persists is the correlation
key; no job-id registry is invented, and a coordinator that spawns several goals from one request is
handled for free.

The screen renders both coordinator outcomes honestly: a direct answer appears as the reply, a
spawned goal appears as a live DAG that fills in. Neither is a failure.

**Continue is always enabled.** A first job that flops must not trap the user in the wizard.

## Section 4 — Library view

Core logic goes in `src/web/library-view.ts`, matching the existing `*-view.ts` convention
(`goals-view`, `org-view`, `packs-view`):

```ts
export function libraryTree(root: string): TreeNode[]              // dirs + files, sorted, depth-capped
export function libraryRead(root: string, rel: string): { mime: string; body: Buffer }
```

Containment reuses `VaultWriter.assertContained`'s exact rule — `resolve()`, then
`startsWith(base + sep)` — lifted into a shared helper rather than reimplemented. Symlinks are
resolved *before* the check, so a symlink pointing out of the vault is rejected rather than followed.
Path escape is the entire risk surface of this feature, which is why the rule lives in a function
reachable without HTTP.

Two endpoints in `web/server.ts` — `GET /api/library/tree` and `GET /api/library/file?path=` — both
behind the normal UI-token gate.

`ui2/src/views/Library.tsx`: tree on the left, content pane on the right. Markdown renders,
`image/*` and `application/pdf` render inline, everything else is a download link. Registered in
`App.tsx` alongside the other views.

The wizard does **not** proxy the Library. The first-job screen shows its artifact inline through the
first-job endpoint; the Library is what the `done` screen links into after handover — which is
precisely when the browser has a token.

## Section 5 — Done screen

`POST /api/onboarding/advance { from: "first-job" }` returns `{ step: "done", uiToken }`. The browser
stores the token the way Mission Control already stores one, then the setup server closes and
`startWeb()` binds the port.

The screen itself is the parent spec's "Your org. Your workspace. What to try next.": the provisioned
departments and agents, the resolved workspace path, a link into the Library, and two or three
suggested next actions. It is the only place the UI token is ever handed to the browser, so it must
render before the handover completes — the token is in the advance response, not fetched afterwards
from an endpoint that will be gated by then.

## Section 6 — Failure modes

| Failure | Handling |
|---|---|
| Hot boot throws | Provision is **not** rolled back — the org is valid, boot failing is a separate fault. The error goes to kv; `/api/state` returns `booted: false` and `bootError`. The screen reads "Your org was created, but the daemon could not start", shows the real error, and offers **Retry**. |
| Double boot (refresh, double-click) | A `booting` latch plus a `world` singleton, the same shape as the existing `verifying` guard. A second call returns the in-flight promise, never a second world. |
| Channels or senses unconfigured | Already correct. `google.enabled()` and `bunq.enabled()` are presence checks, and `startWatcher` (`index.ts:789-811`) catches every poll failure, backs off, and marks degraded. A fresh user has no Telegram token, so no channel starts. Boot survives. |
| Google `invalid_grant` (live today) | Degrades via the same watcher path. It does **not** break hot boot. Only an email-shaped first job would be blocked by it. |
| First job throws | `status: "failed"` plus the error. Retry re-dispatches. Continue stays enabled. |
| Job runs long | No wizard timeout. Status polls; the user may continue to `done` while it runs, and the goal survives into the cockpit where the Goals view owns it. |
| Crash mid-job | `goals.resumeUnfinished()` (`index.ts:875`) is inside the extracted body and still runs. The wizard re-reads status from the store and shows the job again. |
| Port handover fails | `startWeb()` runs inside `setupServer.close()`'s callback, never before. If the rebind throws, log fatally and tell the user to restart — the org and workspace are already on disk, so a restart lands in normal mode and loses nothing. |
| Token lost after handover | `ensureUiToken` (`config.ts:319-329`) already writes the token to `.env` and logs it. No new recovery path. |

## Section 7 — Testing

- **Unit** — `resolveWorkspace`: tilde expansion, missing directory, unwritable directory, and each
  sync-path pattern. `libraryTree` / `libraryRead` containment: `../` escape, absolute path, and a
  symlink pointing outside, all rejected.
- **Setup server, with an injected fake `boot`** — first-job 400s before boot and dispatches after;
  the status shape across idle / running / done / failed; `/api/state` carries `booted`.
- **Extraction regression** — the existing suite passing is the proof that `bootNormal` moved
  cleanly. Plus one new test that the default `startWeb: true` path still starts the web server.
- **E2E smoke** (parent spec §9) — empty dir, walk the wizard over HTTP with a mock architect and a
  fake boot, then assert the org is on disk, the workspace env is written, and the first job
  dispatched.
- **Never in vitest** — anything that makes a real model call. The first-job path is exercised live
  by hand, as plan 2b's walkthrough was.

## Out of scope

- `npx create-aios` (parent spec §1)
- The Connect page (parent spec §6 second half — plan 4)
- The skills catalog (parent spec §5 — plan 2c)
- Any authoring or editing in the Library. It stays read-only.
