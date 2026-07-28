# AIOS Onboarding as a Product — Design

**Date:** 2026-07-29
**Status:** Approved (brainstorm session)
**Scope:** New-user first-run experience: setup wizard, AI-interview org creation, storage decision, skills catalog, de-personalization, failure-mode mitigations.

## Decisions (locked during brainstorm)

| Question | Decision |
|---|---|
| Target user | Staged: v1 = technical builders (npm-capable); every choice must survive a later packaged desktop app |
| Aha moment | First real job completes end-to-end (org → ask → agents collaborate → artifact). Everything else deferred past it |
| Org creation | AI interview (built-in Org Architect) drafts the org; review gate before anything lands; template gallery as always-visible escape hatch |
| Storage | Wizard asks: built-in workspace (default, `~/AIOS/workspace`) or existing Obsidian vault. Same `vaultPath` code path. Mission Control gains a Library view either way |
| Skills | Curated first-party catalog (~12), UI-attachable per agent. No authoring in v1 |
| Channels | Browser chat only before the aha. Telegram/Slack/Google/Voice = post-onboarding Connect cards |
| Install | One command (`npx create-aios` or clone + `npm run dev`) → browser wizard. All setup logic behind wizard HTTP endpoints, none in the CLI |
| Personal pillars | CFO/money, reminders/lifeops, scheduling/briefs, email/calendar are product capabilities offered to every user (capability catalog + personal-assistant template + Connect cards). Only personal values (company names, member rosters, client paths) stay private |

**Structural constraint discovered:** the interview cannot be run by the coordinator (Neo) — no org exists during onboarding. The interviewer is a built-in system flow (direct SDK call), never registry staff.

**Architecture principle:** the interview never gets write access. It only drafts a structured proposal; provisioning replays the proposal through the same deterministic validators that guard manual hiring (`validateHire`, dept walls). LLM creativity upstream, deterministic validation downstream — the existing action-gate philosophy applied to onboarding.

## Section 1 — Setup mode & wizard shell

**First-run detection.** Daemon boots in one of two modes, decided at startup:

- `setup` — `CLAUDE_CODE_OAUTH_TOKEN` missing/invalid **or** registry has zero agents.
- `normal` — otherwise. Existing installs never see setup mode.

In setup mode the daemon starts only the web server + a new `src/onboarding/` module. No channels, no heartbeat, no senses, no packs — nothing that assumes an org. `GET /api/state` returns `{ mode: "setup", step }`; Mission Control renders the wizard full-screen instead of the cockpit.

**Wizard = server-side state machine.** Steps: `welcome → auth → workspace → interview → review → provision → first-job → done`. Current step persisted in SQLite (`onboarding` table) so refresh/crash resumes in place. Each step = one POST endpoint that validates, stores, advances. The browser is a thin renderer of server state; back-navigation to any completed step is allowed.

**Install entry.** `npx create-aios` (new tiny package): scaffold directory (data dir, `.env` stub, empty `agents/`), install, start daemon, open `http://localhost:4280`. Clone + `npm run dev` reaches the identical wizard. Zero setup logic in the CLI — it all lives behind the wizard endpoints, which is what makes a future desktop app a reskin, not a rewrite.

## Section 2 — Auth step

One screen: "AIOS runs on your Claude subscription." Shows `claude setup-token` with a copy button, a short explanation, and a paste field. On submit the server writes the token to `.env`, verifies with one minimal SDK call, and returns ok/fail with the actual error surfaced (expired token, no subscription, network). No advancing on unverified auth — the interview itself needs it.

Edge: no `claude` CLI installed → an "I don't have the claude command" toggle reveals the install one-liner (`npm i -g @anthropic-ai/claude-code`). No environment sniffing.

## Section 3 — Workspace step

One screen, one choice:

- **Built-in workspace (default, pre-selected):** `~/AIOS/workspace/` (wizard-created; path overridable). Plain markdown/files, same layout as today's vault subdir (`jobs/`, `briefs/`, …).
- **Use my Obsidian vault:** folder picker + subdir name — today's `AIOS_VAULT_PATH`/`AIOS_VAULT_SUBDIR` semantics.

Same code path either way (`vaultPath` config). New product rule: **artifacts must be readable without Obsidian** — Mission Control gains a **Library view** (read-only workspace browser: tree, markdown render, attachments), shipped regardless of the choice. Obsidian is a bonus viewer, not infrastructure.

Wizard validates the directory is writable before advancing, and warns on iCloud/Dropbox-synced paths. Path changes later happen in Config; the daemon migrates by simple copy.

## Section 4 — Interview, review, provision

### Org Architect (built-in, not staff)

Hardcoded system prompt + direct SDK `query()` in `src/onboarding/architect.ts`. Not in the registry, no tools, no vault, ephemeral session. Context given to it:

- capability catalog (`agents/_capabilities.yaml`, filtered to product capabilities — includes the personal domains `money-analysis`, `lifeops`, `ledger`, `research-kb`; excludes client-specific ones like `halalo-aws`),
- skills catalog (names + summaries),
- org templates as few-shot examples,
- hard rules: exactly one coordinator; ≤3 departments; 2–5 agents; every agent has kind/charter/persona/prompt; capabilities/skills only from the catalogs.

### Interview UX

Chat panel, 4–6 questions max ("What do you do? What eats your time? What should never happen without your approval?"). A visible **Skip — pick a template instead** button at all times. The interview ends when the Architect emits a structured **OrgProposal** (forced JSON schema, same `structured_output` mechanism the engine already uses for verdicts): departments (name, mission, lead), agents (name, kind, title, charter, persona, prompt, capabilities, skills), playbook role mapping, suggested first job.

### Review screen

The proposal rendered as an org chart: department cards containing agent cards; expanding shows charter/persona/prompt, all inline-editable; capability/skill chips add/removable (catalog-only). Regenerate (re-runs the last interview turn) and per-agent redraft buttons. Nothing has touched disk yet — this is the trust gate; the user must be able to read what they approve.

### Provision

On approve, the server replays the proposal through the existing validated mutation path, extended once:

1. New `POST /api/departments` — validates name and lead-in-proposal, writes `department.yaml`.
2. Each agent through existing `validateHire` + `renderAgentYaml` (`src/web/agents-admin.ts`).

All-or-nothing: a validator rejection returns card-level errors highlighted on the review screen; a mid-write failure compensates (deletes written files) so the registry is never half-loaded. On success: `reloadPacks()`, step advances to `first-job`.

Validation asymmetry is handled at the source — the Architect's schema and rules are derived from the validators' constraints, so proposals that render are proposals that provision. Any drift is still caught by the replay.

## Section 5 — Templates & skills catalog

### Org templates

`templates/orgs/<name>/` (starter, solo-dev, founder, researcher, **personal-assistant** — 5 to start), each `org.yaml` (dept + agent manifests, same schemas) + generic playbooks. The personal-assistant template ships a Life/Personal department: a CFO-style finance agent (money capabilities: spending, subscriptions, budgets), a personal-ops agent (lifeops tasks/reminders), and scheduling via the existing heartbeat/routines. Any interview can also propose a personal department for other templates — personal capabilities are product features, not preset-exclusive. Used three ways:

1. Few-shot grounding for the Architect.
2. "Skip interview" gallery (provisioned through the same provisioner).
3. QA baseline — tests provision every template through the real provisioner, so templates cannot rot.

### The personal org moves out — but personal capabilities stay product

Current `agents/` content (juno, halalo, jasmine, …) is personal *data*, not product. It moves to a gitignored path (or private overlay repo). `agents/` becomes user data: gitignored, created by the provisioner. Migration shim: an existing non-empty `agents/` dir boots untouched in `normal` mode — the current install feels nothing.

The *capabilities* those agents use are product for everyone: money analysis (CFO), lifeops (tasks/reminders), ledger (team finance), email/calendar senses, heartbeat briefs, scheduling routines. They ship in the catalog, the Architect can propose agents carrying them, and the personal-assistant template showcases them. Only the values are personal (IDAMA, member rosters, client paths) — those arrive via Connect cards or the interview, never as defaults.

### Playbook-name coupling

Solved by the template unit, not a name-resolution layer: each template ships playbooks referencing its own agent names. The Architect maps proposal agents onto the chosen template's playbook roles (`playbooks: [{template, roles}]` in the proposal). Names stay consistent at provision time.

### Skills catalog

`skills-plugin/skills/` grows to ~12 first-party skills; each `SKILL.md` gains frontmatter `tags` + `summary`. New read-only `GET /api/skills/catalog`. Surfaced in: interview suggestions, review-screen chips, and the existing Skills tab (`ui2/src/views/Skills.tsx`) extended to attach/detach per agent via the existing manifest-PATCH pattern. No skill authoring in v1.

## Section 6 — First job, aha, and after

**First-job step.** The proposal's suggested first job is shown as a one-click card plus a free-text alternative. Click → routed through the normal coordinator/playbook path — zero special-case execution. The UI shows the live pipeline view (already exists) with a gentle overlay explaining what's happening. Job completes → artifact opens in the Library view → `done` summary screen ("Your org. Your workspace. What to try next.").

**Post-onboarding = Connect page.** Cards, each with status (off/configured/error), a guided modal (step-by-step copy, paste fields), and a **Test connection** button:

- **Telegram / Slack** — chat channels (BotFather / Socket Mode flows).
- **Email & Calendar** — Google OAuth (Gmail + Calendar senses: inbox digests, urgent pings, meeting reminders). Powers the personal-assistant story.
- **Briefs & reminders** — heartbeat card: enable morning/evening briefs, set anchor times, pick the primary chat. Reminders themselves need no setup (chat-native), but this card makes them visible as a feature.
- **Team finance** — company name + members (today's `AIOS_FINANCE_COMPANY`/`AIOS_FINANCE_MEMBERS`), optional group-chat binding. Personal money analysis (CFO agent) needs no card — its capabilities are attached at hire; a bank connection (e.g. bunq) gets its own card when configured.
- **Voice**, **Run-at-login** (launchd), **Tailscale/UI-token**.

Writes `.env` via the existing config PUT + restart prompt. All BotFather/OAuth friction lives here: after value is proven, entirely optional, each card independently testable. Client packs (e.g. halalo-style project dirs) appear only as opt-in cards, never preloaded.

## Section 7 — De-personalization (code, not files)

| Residue | Fix |
|---|---|
| `extras.ts:10` halalo path + guard + agent | Whole halalo unit loads only when `AIOS_HALALO_DIR` is set; guard stays compiled but unreferenced otherwise (generalizes later into "client packs") |
| `config.ts` `financeCompany: "IDAMA"` default | No default; finance dormant until its Connect card sets it |
| Vault default `~/Desktop/AI-Vault` | Replaced by wizard workspace choice; config default `~/AIOS/workspace` |
| `launchd/com.ihab.aios.plist` hardcoded paths | Template with `{{ROOT}}` placeholders; Run-at-login Connect card renders + installs it |
| DB alias migration waves (`db.ts:626`), TodayStrip hermes fallback | No-op on empty DBs; leave |

## Section 8 — Failure-mode inventory → mitigation

| # | User problem | Mitigation |
|---|---|---|
| 1 | Token invalid/expired/no subscription | Auth step verifies with a real SDK ping; exact error shown; re-paste loop. Runtime 401 → banner linking back to auth step |
| 2 | No `claude` CLI | Install one-liner inside the auth step |
| 3 | Interview produces a weird org | Review gate — nothing lands without approval; per-agent redraft; template escape hatch always visible |
| 4 | Interview stalls/errors mid-way | Ephemeral Architect session + resumable step; "start over" and "skip to templates" both one click |
| 5 | Proposal fails validation | Replay returns card-level errors highlighted on the review screen; never partial writes |
| 6 | Daemon crash mid-wizard | Server-side step persistence in SQLite → resume on reload |
| 7 | Port 4280 taken | Boot scans 4280→+10, prints + opens the actual URL |
| 8 | Workspace dir unwritable / cloud-synced | Writability probe at the workspace step; warning for iCloud/Dropbox paths |
| 9 | First job fails (overload, timeout) | Pipeline view shows the failure honestly + one-click retry; `done` reachable via "skip for now" — org already provisioned, aha degraded not blocked |
| 10 | User abandons mid-wizard | Wizard resumable forever; setup mode does nothing costly (no polling, no heartbeat) |
| 11 | User breaks agents later | Existing never-brick invariant (compensating file ops) + `_retired/` rehire |
| 12 | Playbook references broken by renames | Templates keep names consistent at provision; `retireBlockers` already refuses breaking fires |
| 13 | Telegram misconfig (privacy mode, wrong id) | Connect card Test button sends the user a message and checks the echo; explicit BotFather `/setprivacy` step in the modal |
| 14 | Upgrade wipes org | `agents/` is user data outside the tracked tree; templates versioned separately; wizard never runs when an org exists |
| 15 | Shared Mac / exposed UI | localhost bind unchanged; `AIOS_UI_TOKEN` offered on the Tailscale Connect card |

## Section 9 — Testing

- **Unit:** wizard state-machine transitions; OrgProposal schema ↔ validator agreement (property: every schema-valid proposal provisions cleanly on every template); provisioner compensation under injected failure.
- **Golden:** every shipped template provisioned through the real provisioner in a temp dir → registry loads, dept walls pass, playbook owners resolve.
- **Architect eval:** fixture interviews (5 personas) → proposals must validate + meet a rubric (agent count, no wall violations). On-demand, not CI-blocking.
- **E2E smoke:** boot an empty dir → walk the wizard via HTTP (mock SDK for the interview) → assert org on disk, registry live, first job enqueued.

## Out of scope (v1)

- Skill authoring UI.
- Desktop app packaging (design merely must not block it).
- Name-resolution layer for playbooks (template unit makes it unnecessary).
- Multi-user / multi-tenant.
- Cloud sync of workspace.

## Implementation decomposition (suggested order)

1. **Foundation:** setup-mode boot + wizard state machine + auth step + de-personalization (Section 1, 2, 7).
2. **Org path:** templates + `POST /api/departments` + provisioner + review screen + interview (Sections 4, 5).
3. **Value path:** workspace step + Library view + first-job step (Sections 3, 6 first half).
4. **Connect page** (Section 6 second half).

Each gets its own implementation plan.
