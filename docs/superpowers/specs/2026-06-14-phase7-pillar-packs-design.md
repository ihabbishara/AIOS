# AI-OS Phase 7 — Pillar Packs — Design

**Date:** 2026-06-14
**Status:** Approved (brainstorm complete, awaiting implementation plans)
**Master vision:** `docs/superpowers/specs/2026-06-11-cognitive-kernel-design.md` (§2 Cognition — pillar packs)
**Builds on:** Phase 6 second brain (`memos/<domain>.md`, `recall`, the Action Gate).

## Summary

Turn AI-OS's ad-hoc roles and playbooks into coherent, data-driven **pillar packs**. A
pack binds a life domain (money, code, research, lifeops) to a persona, a tool allowlist,
a gated-action ceiling, its slice of memory (`memos/<pillar>.md` + profile), `recall`, and
its own playbooks — applied automatically whenever a job in that pillar runs. Packs are
declarative manifests; the framework that loads and applies them is the load-bearing piece
and ships first (with zero packs, zero behavior change). The four packs follow, each its
own independently shippable stage.

## Requirements (from brainstorm)

| Decision | Choice |
|---|---|
| Scope this cycle | Framework + all 4 packs (money, code, research, lifeops), full playbook suite each |
| Scheduler / token-budget changes | **Deferred** (packs run on the existing engine; budget is a separate concern) |
| Pack definition | **Declarative manifest (hybrid)** — `playbooks/<pillar>/pack.yaml`; shared executors stay code, referenced by name |
| Routing | **Playbooks own their pillar** — engine resolves playbook → owning pack → injects pack context; moderator unchanged, no classifier |
| Tool scoping | Pack `tools` list **replaces** the role default (tight per-pillar scoping) |
| Effect surface | Packs act **only through existing executors** (`vault.write`, `email.draft/send`). NEW domain executors (`finance.pay_bill`, `git.push`, `calendar.create`) are explicitly out of this cycle — each its own later, security-reviewed build |

## Existing foundation (reused, not rebuilt)

- **Playbook engine** (`src/engine/`) runs YAML playbooks (`single`/`loop`/`verify` stages)
  via `runSpecialist` (`src/agents/runner.ts`) — the seam where pack context is injected.
- **Roles** (`src/agents/roles/index.ts`): architect, developer, reviewer, tester,
  code-reviewer, halalo, researcher, market-researcher, ui-ux-designer. The finance agent
  is a separate bound-chat module (`src/finance/`), wrapped as a `finance` RoleDef here.
- **Existing playbooks** (flat): echo, software-feature, market-research, research-report,
  product-design. These stay packless and behave exactly as today.
- **Gated executors that exist**: `vault.write`, `email.send/draft/archive/label`,
  `test.echo`, `trust.promote`. **No** `finance.*`/`git.*`/`calendar.create` executors.
- **Phase 6 memory**: `memos/<domain>.md` (per pillar, hook built), `recall` tool,
  `memoContext` (currently moderator-scoped — gains a pillar-scoped variant here).
- **Action Gate** (`src/kernel/gate.ts`): the single audited effect path + trust ledger.

## Architecture

```
playbook run ──▶ resolve owning pack ──▶ augment specialist options ──▶ runSpecialist
                       │                        │
                  pack registry           persona + memos/<pillar>.md + profile
                  (loader)                 tools = pack.tools (replace)
                                           scoped MCP server: recall, vault_read,
                                             vault_write, propose_action(ceiling=pack.actions)
                                           → all effects still go through the Action Gate
```

### 1. Pack manifest + loader

A pack is a directory `playbooks/<pillar>/` containing `pack.yaml`:

```yaml
# playbooks/money/pack.yaml
pillar: money
persona: >
  You are the Money specialist for AI-OS — finance, billing, subscriptions, expenses.
  Numerate, conservative, evidence-first. Every outward money action goes through the
  Action Gate; never move money without an approved gate action.
memoDomain: money            # loads memos/money.md (+ profile.md) into agent prompts
vaultSection: money          # pack artifacts land under <vault>/money/
tools:   [Read, Grep, recall, vault_read, vault_write, list_inbox, read_email]  # SDK allowedTools (REPLACE)
actions: [vault.write, email.draft]                                            # gated action-type ceiling
roles:   [finance]           # RoleDefs this pack governs
playbooks: [subscription-audit, monthly-report, expense-review]                # files in this dir
```

- **Loader** (`src/packs/loader.ts`): at boot, scans `playbooks/*/pack.yaml`, validates each
  with a zod schema, builds a `Pack` registry keyed by pillar, and an index
  `playbookName → pillar`. A file `playbooks/<pillar>/<name>.yaml` is owned by that pack.
  Flat top-level playbooks remain pack-less (today's behavior, zero regression).
- `pillar` ∈ the Phase 6 domains. `vaultSection` defaults to `pillar`. `tools` entries are
  built-in or MCP tool names; `actions` are registered gated action types.
- **Validation (fail loud at load)**: unknown role, missing playbook file, duplicate
  pillar, or zod failure → the pack is skipped and logged at boot; the daemon still runs and
  other packs load. A pack is never half-loaded.

### 2. Runtime pack-context injection

When the engine runs a playbook stage (or a direct `@role` chat) belonging to a pack, the
pack augments the specialist's SDK options. **Approach: pack-aware `runner.ts`** —
`runSpecialist(role, brief, opts)` gains an optional `pack`; when present it merges:

```
systemPrompt = role.systemPrompt
             + "\n\n## Pillar: <pillar>\n<pack.persona>"
             + "\n\n## Learned preferences & profile\n<memoContext(pack.memoDomain)>"
allowedTools = pack.tools                       // REPLACE — pack agents see only listed tools
mcpServers  += { aios-pack: <scoped server, §3> }
cwd / guards / permissionMode = role's (unchanged)
```

- **Tool allowlist is replace, not merge.** A money-pack agent cannot acquire `Bash` or a
  `git.push`; the pack author opts tools in explicitly. (The `code` pack lists `Bash`.)
- **Memo injection is pillar-scoped** — a `memoContext` variant loading
  `memos/<memoDomain>.md` + `profile.md` (not the moderator's general/inbox set), read
  fresh per run.
- **Resolution**: the engine maps `playbook → owning pack` from the loader registry before
  each stage; packless → no augmentation (exactly today's behavior). One central seam — the
  pipeline runner and direct chats share it, so security settings can't diverge.

### 3. Memory + gate access for pack agents (scoped MCP server)

Specialists today get only built-in tools + their role allowlist, not the aios MCP server.
The framework gives each pack run a **scoped MCP server** exposing `recall`, `vault_read`,
`vault_write`, and `propose_action`. The manifest's two lists govern exposure and effects:

- **`tools`** = SDK `allowedTools` (built-in + which of the scoped MCP tools the agent sees).
- **`actions`** = gated action types the pack may push through the gate. `propose_action`
  (and `vault_write`, which proposes a `vault.write`) **refuses any type not in `actions`** —
  a per-pack ceiling enforced *before* the gate's own trust check. A research-pack agent
  literally cannot propose `finance.pay_bill`.
- **The Action Gate remains the one and only effect path.** Pack agents never execute
  outward effects directly; they propose → gate → (autonomous or approval) → audit log.
  `recall` is the read-only Phase 6 tool (no injection surface). No new effect surface is
  introduced — packs only *reach* the existing one under tighter scoping.

### 4. The four pack rosters

Effects limited to existing executors (`vault.write`, `email.draft/send`). Each pack writes
artifacts under `<vault>/<pillar>/`.

**money** — persona: numerate, conservative finance specialist.
- roles: `finance` (existing finance agent wrapped as a RoleDef)
- tools: `Read, Grep, recall, vault_read, vault_write, list_inbox, read_email` · actions: `vault.write, email.draft`
- playbooks (new): `subscription-audit` (scan ledger + receipt emails → flag unused/duplicate
  subs → draft cancellation emails + vault report), `monthly-report` (ledger → markdown
  summary), `expense-review` (categorize + anomalies → vault).

**code** — persona: pragmatic engineer.
- roles: `architect, developer, reviewer, tester, code-reviewer, halalo`
- tools: `Read, Grep, Glob, Bash, recall, vault_write` · actions: `vault.write` (worktree
  changes stay local; no `git.push` this cycle)
- playbooks: `software-feature` (existing — moved under code), `codebase-onboard` (new: map a
  repo → architecture brief), `code-review` (new: review a branch/diff → findings),
  `bug-investigate` (new: trace → root-cause report).

**research** — persona: rigorous multi-source researcher.
- roles: `researcher, market-researcher`
- tools: `Read, Grep, WebSearch, WebFetch, recall, vault_write` · actions: `vault.write`
- playbooks: `research-report` (existing — moved under research), `market-research` (existing
  — moved under research), `deep-dive` (new: fact-checked dossier with citations).

**lifeops** — persona: proactive personal chief-of-staff (calendar/errands/personal).
- roles: `lifeops` (NEW RoleDef)
- tools: `Read, recall, vault_read, vault_write, list_inbox, read_email` · actions: `vault.write, email.draft`
- playbooks (new): `meeting-prep` (pull context for upcoming meetings → brief), `trip-plan`
  (research + draft itinerary to vault), `weekly-prep` (compile the week → checklist note).

### 5. Discovery / UX

- `list_playbooks` groups output by pillar (pack playbooks under their pillar, packless under
  "general").
- The moderator prompt gains a short "Pillars" line so it routes tasks naturally; no
  classifier, no new moderator tool.
- A direct `@role` chat inherits the pack when the role belongs to exactly one pack;
  ambiguous (role in multiple packs or none) → role default, no pack.

## Error handling — fail loud at load, fail safe at run

- Bad/duplicate/incomplete manifest → pack skipped + logged at boot; daemon and other packs
  unaffected. Never half-load.
- Pack agent proposes an action type ∉ `actions` → refused before the gate, clear message.
- Pack agent calls a tool ∉ `tools` → SDK denies (allowlist replace).
- Packless playbooks + existing roles/direct-chats unchanged — **zero regression is a hard
  requirement** and is asserted by tests.

## Testing

- **Loader**: valid pack → registry entry + playbook index; invalid (dup pillar, missing
  role/playbook, bad yaml) → skipped + logged, never throws into boot.
- **Injection merge** (pure unit): role + pack → systemPrompt contains pillar persona +
  pillar memo; `allowedTools === pack.tools`; scoped MCP server attached.
- **Action ceiling**: a pack `propose_action` with a type ∉ `actions` is refused; an in-list
  type passes through to the gate.
- **Memo scoping**: a pack run loads `memos/<memoDomain>.md` + profile, not the moderator's
  general/inbox set.
- **Zero-regression**: a packless playbook run / existing `@role` chat produces identical
  options to today (no persona, no memo, role's own allowlist).
- **E2E (fake-executor)**: run a pack playbook end-to-end; assert the artifact lands under
  `<vault>/<pillar>/` and any effect went through the gate. Zero real side effects.

## Build stages (one spec, sequential plans — each independently shippable)

1. **Framework** — `src/packs/{loader,types}.ts`, the `runner.ts` injection seam, the scoped
   pack MCP server (`recall`/`vault_read`/`vault_write`/`propose_action` with the action
   ceiling), pillar-scoped `memoContext`, `list_playbooks` grouping, and all framework tests.
   Ships with **zero packs** → no behavior change → safe to merge first.
2. **money** · 3. **code** · 4. **research** · 5. **lifeops** — each adds its `pack.yaml`,
   new playbook files, and (lifeops) the new `lifeops` RoleDef. Each its own plan, each
   independently shippable and individually reviewable.

## Out of scope (YAGNI / later)

- **New domain executors** — `finance.pay_bill` (real money → hard ceiling), `git.push`,
  `calendar.create`, etc. Each is its own security-reviewed cycle. Phase 7 packs draft/report
  through `vault.write` + `email.draft`.
- **Scheduler / token budgets / per-job pillar priority** — deferred (master vision §2);
  packs run on the existing engine.
- **Proactive per-pillar initiatives** (pack runs fired by the heartbeat/anchors) — that is
  the Phase 8 dream cycle (propose/speculate).
- **Mission Control "Pillars" view** — Phase 8 (full Mission Control).
