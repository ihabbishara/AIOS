# The Staff — Agent Registry + Legibility (Phases 1+2 of the org redesign)

**Date:** 2026-07-02
**Status:** Approved design, pending implementation plan
**Scope:** Phase 1 (agent registry, unified routing, named personas) + Phase 2 (Mission Control 2.0 org-first core)

## Problem

AIOS grew subsystem by subsystem. The result works but is illegible:

1. **Three dispatch brains.** The router parses `@role` and hardcodes the finance agent; the moderator dispatches via `run_playbook` / `code_task` / `ask_specialist`; the job engine resolves packs via `pillarOf` while direct chats use `roleOf`. Nobody — including the user — can predict which mechanism handles a given message.
2. **Fractured agent identity.** Who an agent is lives in four places: `RoleDef` (TypeScript), `pack.yaml` (persona + role bindings), the moderator prompt roster, and the hardcoded `FinanceAgent`. There is no single "who works here" source.
3. **Same agent, different faces.** `@developer` chat resolves the code pack (tools, sandbox); `ask_specialist("developer")` spawns a *toolless* clone. `roleOf` silently drops any role bound to 2+ packs — when the research pack shipped, `@researcher` silently lost its pack.
4. **Anonymous workforce.** Only jasmine, cfo, halalo have identity. The rest are job titles with no persona, no name, no card in the UI.
5. **UI shows plumbing, not the org.** Mission Control renders tables of jobs/actions/permissions; it cannot answer "who is doing what right now, and why did they get the job?"

## Vision (full roadmap, for context)

AIOS as a **company of named agents**: one staff directory, departments, a chain of command, and visible routing. Phased:

- **Phase 1 — Registry + routing (this spec):** every agent is a named registry entry with a charter; one routing brain; every dispatch logged with a reason.
- **Phase 2 — Mission Control 2.0 (this spec):** org-chart home, agent profiles, chat-first, routing trail.
- **Phase 3 — Department leads + task graphs (later spec):** leads decompose goals into persisted task DAGs, parallel execution, re-planning; token/€ budget enforcement.
- **Phase 4 — Agent mailbox (later spec):** structured agent-to-agent handoffs, standups feeding the morning brief.
- **Phase 5 — Autonomy expansion + eval loop (later spec):** dream/speculate route through leads; job outcomes scored and fed back into memos.

**Untouchable moat (all phases):** action gate + trust ledger, privacy walls (recall exclusions, private visibility), the 5-layer code sandbox, senses, voice, integer-cents finance math, playbooks-as-SOPs.

## Decisions locked (user-approved)

1. Legibility first: Phases 1+2 before orchestration intelligence.
2. Six departments: Operations, Engineering, Research, Finance, Life, Clients.
3. Registry = YAML manifests + code-by-name split (guards/tool builders stay TypeScript).
4. One agent = one capability set, every entry path. `hand_off` replaces toolless `ask_specialist`.
5. Names: assistant-drafted, user edits at spec review. Jasmine and Halalo keep their names.
6. UI Phase 2 = org-first core (org home, profiles, chat-first, routing trail). Task-graph viz and budget meters arrive with Phase 3 backends.

## Design

### 1. Agent registry

New `agents/` tree, sibling to `playbooks/`:

```
agents/
  operations/
    department.yaml
    rami.yaml
  engineering/
    department.yaml
    kai.yaml maya.yaml tarek.yaml nadia.yaml omar.yaml ziad.yaml
  research/
    department.yaml
    lina.yaml sami.yaml dalia.yaml yara.yaml
  finance/
    department.yaml
    faris.yaml salim.yaml
  life/
    department.yaml
    jasmine.yaml
  clients/
    department.yaml
    halalo.yaml
```

**Agent manifest schema** (zod, `src/agents/registry/types.ts`):

```yaml
name: maya                    # unique across registry, lowercase
title: Senior Engineer
department: engineering       # must equal parent directory name
charter: >                    # WHEN this agent takes a job — routing + UI text
  Owns implementing code changes in sandboxed workspaces:
  new features, refactors, fixes. Hand me a design or a bug.
persona: >                    # voice, injected atop systemPrompt
  Pragmatic and terse. Ships small verifiable diffs. Says
  "I don't know" instead of guessing.
prompt: >                     # the working instructions (ex-RoleDef.systemPrompt body)
  You are a senior software engineer...
model: sonnet                 # tier alias; resolved via config (optional, defaults dept/specialist model)
tools: [Read, Grep, Glob, Edit, Write, Bash, TodoWrite]
guards: []                    # names into a code guard registry (e.g. halalo-readonly)
skills: []                    # aios-skills plugin skill names
maxTurns: 80
permissionMode: bypassPermissions   # dontAsk | default | bypassPermissions
visibility: shared            # shared | private (private = today's privateOnly semantics)
outputSchema: null            # name into a code schema registry (verdict | test-report)
aliases: [developer]          # back-compat @role mentions
```

**Department manifest** = `pack.yaml` evolved (same zod lineage, `src/agents/registry/types.ts`):

```yaml
department: engineering
mission: Build, test, review, and operate software safely.
lead: kai                     # display-only in Phase 1; activates in Phase 3
memoDomain: code
vaultSection: code
toolServer: null              # money | research | lifeops | ledger (new) | null
actions: [vault.write]        # gated action ceiling, unchanged semantics
sandbox: true                 # code-style confinement, unchanged semantics
playbooks: [code-build, code-analyze]   # names into playbooks/ (files stay where they are)
```

**Loader** (`src/agents/registry/loader.ts`): `loadRegistry(agentsDir)` →

```
{ agents: Map<name, AgentDef>, departments: Map<dept, DepartmentDef>,
  agentOf: Map<name|alias, name>, ownerOfPlaybook: Map<playbook, dept> }
```

- Atomic skip-on-error per manifest (mirrors `loadPacks`): a bad agent YAML skips that agent with a loud log; the department still loads. A bad department.yaml skips the whole department.
- Duplicate `name` or `alias` across the registry: later entry skipped, loud log.
- `department` field must match the parent directory; mismatch = skip.
- Referenced playbook missing from `playbooks/` = skip department (mirrors current pack behavior).
- Hot reload mutates the same Map instances in place (mirrors `reloadPacks`).

**Compilation:** the registry compiles each manifest to the existing `RoleDef` shape (persona + prompt concatenated into systemPrompt; guards/outputSchema resolved from small code registries by name). `runner.ts`'s option pipeline — `roleQueryOptions → packRunOptions → withEffectiveTools → withDenialObserver` — is untouched. `ResolvedPack` semantics are preserved; the resolver reads department manifests instead of pack manifests.

**Kill-switches:** `AIOS_<DEPT>_DISABLED=1` drops a department (agents + playbooks) at load, exactly like today's pillar switches. The four existing env names keep working via a legacy alias map applied at load: CODE→engineering, MONEY→finance, RESEARCH→research, LIFEOPS→life (see Migration).

**Shared roles duplicated per department.** Engineering's reviewer (nadia) and Research's reviewer (yara) are distinct agents with distinct manifests. No template/inheritance system in Phase 1 — duplicate YAML is acceptable at this scale (revisit if manifests exceed ~20).

### 2. Routing — one brain, every decision logged

- `@name` / `@alias` → `agentOf` lookup → persistent direct session (today's DirectChats machinery, resolved via registry). Capability identical regardless of entry path.
- **Chief of Staff** (rami) replaces "moderator" as a registry entry. Same persistent per-chat session, same MCP toolset except:
  - `ask_specialist` **deleted**.
  - `hand_off(agent, task, context?)` added: resolves the named agent through the registry with its **full** department resolution (tools, toolServer, confinement), runs one-shot, returns the result text to the Chief of Staff. Unknown agent → error string, no crash.
- **FinanceAgent class dissolves.** `salim` (bookkeeper) is a normal registry agent; the group-ledger tools move into a `ledger` toolServer builder registered alongside money/research/lifeops. Chat bindings map chat keys to agent names; the router special-case for finance is deleted. Ledger isolation (per channel:chatId) and integer-cents math unchanged.
- **`route.decision` event** added to the `AiosEvent` union: `{ type: "route.decision", to, via: "mention" | "binding" | "handoff" | "default" | "verdict", reason }`. Emitted at every dispatch point (router mention path, binding path, moderator default, hand_off, /approve intercept). Persisted via the existing events table; powers the UI routing trail.
- `visibility: private` enforced where `privateOnly` is enforced today: top of the direct-chat handler, before any await, fail-closed when primary chat unset. Web cockpit (`web:ui`) remains a private origin.
- Deterministic bypasses unchanged: `/approve` / `/reject` intercept, `/reset`, bindings, mentionOnly.

### 3. The staff (draft roster — edit freely)

| Dept | Name | Title | Persona sketch |
|---|---|---|---|
| Operations | **Rami** | Chief of Staff | Calm dispatcher. Clarifies, routes, follows up. Never does the specialist's job; always says who he handed work to and why. |
| Engineering | **Kai** | Architect / Eng Lead | Sees systems, hates cleverness. Designs are short and opinionated with explicit trade-offs. (Lead powers arrive Phase 3.) |
| Engineering | **Maya** | Senior Engineer | Pragmatic, terse, ships small verifiable diffs. Tests before claiming done. |
| Engineering | **Tarek** | QA Engineer | Professionally distrustful. Reproduces before believing; reports failures verbatim. |
| Engineering | **Nadia** | Code Reviewer | Reads diffs like an auditor. Flags what breaks at 3am, ignores style noise. |
| Engineering | **Omar** | DevOps | Infrastructure-as-code only; refuses live mutations. Everything reproducible. |
| Engineering | **Ziad** | Eng Researcher | Digs through code and docs fast, returns maps not essays. |
| Research | **Lina** | Analyst / Librarian | Curious and rigorous. Recalls before researching; cites sources; files everything under knowledge/. |
| Research | **Sami** | Market Researcher | Numbers-first storyteller. Sizes markets conservatively and says when data is thin. |
| Research | **Dalia** | UI/UX Designer | User-obsessed. Argues from flows and friction, not aesthetics alone. |
| Research | **Yara** | Research Reviewer | Challenges sources and logic. Approves reluctantly, in writing. |
| Finance | **Faris** | CFO (private) | Discreet, precise, read-only on the bank. Speaks in categories, trends, and flags. Never in group chats. |
| Finance | **Salim** | Bookkeeper (group) | Keeps the IDAMA ledger exact to the cent. Splits fairly, settles greedily, exports on demand. |
| Life | **Jasmine** | Personal Ops (kept) | Warm but relentless about open loops. Always ends with the next concrete action. |
| Clients | **Halalo** | Halalo Project Agent (kept) | Read-only ops analyst for the Halalo product: AWS, logs, DB, Cloudflare analytics. |

Personas inject at the top of each agent's systemPrompt; charters render in the UI and drive Chief-of-Staff routing language.

### 4. Mission Control 2.0 — org-first core

**Views (evolve existing React app, no rebuild):**

- **Org (new home):** department columns; agent cards showing name, title, live status dot (idle / working / waiting-approval), current task snippet, cost today. Status derived from existing `agent.start`/`agent.end` events plus pending actions.
- **Agent profile:** charter, persona, effective tools (base ∪ grants − revokes), trust rows for the action types it can propose, recent jobs/handoffs, cost history, a Chat button.
- **Chat (promoted):** agent picker fed by the registry; inline routing trail ("Rami → Maya: charter match — code change").
- **Routing trail:** filterable feed of `route.decision` events.
- Packs view becomes the **department settings** tab (manifests editable, same file-endpoint pattern with the same traversal guards).

**Backend:** `GET /api/org` (departments + agents + live status), `GET /api/agents/<name>` (profile), route.decision events ride the existing SSE stream. All behind the existing token-auth gate. No new write endpoints beyond the existing pack-file pattern pointed at `agents/`.

### 5. Migration

Mechanical, one branch:

1. Create `agents/` tree; port 13 `RoleDef`s + moderator + finance into manifests (prompt text copied verbatim).
2. Port each `playbooks/<pillar>/pack.yaml` into `agents/<dept>/department.yaml`; delete pack.yaml files. `playbooks/` YAML files stay in place.
3. `aliases` preserve every existing `@role` habit (`@developer` → maya, `@cfo` → faris, etc.).
4. Env compat: existing `AIOS_CODE|MONEY|RESEARCH|LIFEOPS_DISABLED` continue to work (mapped to the owning department at load).
5. Delete `FinanceAgent`; register `ledger` toolServer; bind bookkeeper via chatBindings.
6. Moderator prompt roster now generated from the registry (single source).

### 6. Error handling

- Bad manifest → skip that unit, loud log, rest of registry loads (fail-soft load, fail-closed capability).
- Unknown `hand_off` target → error string returned to Chief of Staff.
- Registry read error at permission-merge time → fall back to compiled base tools (never widen) — inherits `effectiveAllowedTools` fail-closed behavior.
- Hot reload keeps Map identity (JobManager/resolver hold references).

### 7. Testing

- Registry loader: bad-manifest skip, dept-dir mismatch skip, duplicate name/alias skip, alias resolution, kill-switch drop.
- **Capability-parity pin:** for every agent, tools resolved via `hand_off` ≡ tools resolved via `@name` (kills the two-faces bug class permanently).
- `route.decision` emitted on each dispatch path (mention, binding, handoff, default, verdict).
- Privacy pins re-run green: faris/jasmine private-origin refusal, recall exclusions untouched, bank/task data never indexed.
- Ledger behavior pinned before/after FinanceAgent dissolution (settlement math byte-identical).
- Suite baseline 620 + new tests; tsc + build clean.

### 8. Explicitly out of scope (later phases)

Task DAGs, department leads acting, budget enforcement, agent mailbox, standups, overnight autonomy through leads, eval loop, task-graph UI, budget meters.
