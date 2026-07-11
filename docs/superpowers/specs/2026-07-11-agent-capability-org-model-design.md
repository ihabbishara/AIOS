# Agent × Capability Org Model — Design

**Date:** 2026-07-11
**Status:** Approved (brainstorm with user)
**Scope:** Registry unification. All 15 named agents stay (user decision). Pack struct and hardcoded tool-server wiring deleted; one resolution path for every agent seam.

## 1. Problem

Four overlapping concepts accreted across cycles — Role, Pack, Pillar, Department — leaving vestiges and special cases:

- `packSchema.roles[]`, `pillarOf`/`roleOf` maps: vestigial; the live path is `makeResolveDeptFor` synthesizing a Pack shape from a Department.
- Cloudflare tool server hardcoded to `canonical === "halalo"` in `direct.ts` — outside the toolServer registry every other server uses.
- Hermes is a pseudo-role: real tools in `MODERATOR_ALLOWED_TOOLS` (`session.ts`), YAML persona is one line, `isChiefOfStaff` special-cases scattered.
- Every engineering agent re-lists the same tools; aliases collide silently (first-wins).
- Two address parsers with different matching (`parseDirectAddress` prefix-only vs `findAgentMention` prefix-or-@-anywhere) selected by chat binding.
- Model tiering unused — every agent inherits the daemon default.
- Capability parity across seams (direct chat / hand_off / playbook node) is maintained by pinned tests, not by construction.

## 2. Decisions (locked with user)

| Decision | Choice |
|---|---|
| Staff | **All 15 named agents stay** — unification is structural, personas untouched |
| Primitive | New **Capability** struct; agents/departments declare capability sets |
| Moderator | Hermes becomes a normal registry agent (`kind: coordinator`) |
| Aliases | Kept; collisions become **boot errors** (was silent first-wins) |
| Models | Tiering by `kind` with per-agent override |

## 3. Capability primitive

`agents/_capabilities.yaml` — one struct owns what is currently smeared across pack manifests, dept manifests, code-extras, and hardcoded wiring:

```yaml
money-analysis:  { server: money,      tools: [mcp__money__*],    actions: [],             labels: [personal.finance] }
ledger:          { server: ledger,     tools: [mcp__ledger__*],   actions: [ledger.write], guard: ledger-read-confine }
code-sandbox:    { server: code,       tools: [mcp__code__sh],    actions: [vault.write],  guard: code-jail, sandbox: true }
research-kb:     { server: research,   tools: [mcp__research__*], actions: [vault.write] }
lifeops:         { server: lifeops,    tools: [mcp__lifeops__*],  actions: [],             labels: [personal.tasks] }
halalo-aws:      { server: cloudflare, tools: [mcp__halalo_analytics__*], guard: halalo-readonly }
web:             { tools: [WebSearch, WebFetch] }
files-ro:        { tools: [Read, Grep, Glob] }
memory:          { tools: [recall, vault_read, vault_write] }
mail:            { server: aios-mail,  tools: [send_mail, ask_mail] }
attachments:     { server: aios_attachments, tools: [attach_file] }
```

Fields: `server?` (name in the single MCP builder registry), `tools[]`, `actions[]` (gate ceiling contribution), `guard?` (named deterministic ToolChecks from code-extras), `sandbox?`, `labels[]` (data-scope labels — the hook the Information-Flow Policy spec consumes).

Resolution semantics:
- `allowedTools` = union of the agent's capability tools; ownership clamp preserved (a tool survives only if some capability of *this agent* grants it).
- MCP servers come from **one builder registry** — the Cloudflare/attachments/mail hardcoded wiring in `direct.ts` is deleted; they are capabilities like everything else.
- Action ceiling = union of capability `actions`.
- Guards compose: every guard must allow (AND semantics), same PreToolUse + canUseTool double-layer as today.

## 4. Agent and department schema (v2)

- Agent gains: `kind: coordinator | lead | worker | critic`, `capabilities: [...]`. Loses: duplicated tool lists (department defaults cover shared sets). Keeps: name, title, persona, prompt, maxTurns, permissionMode, visibility, outputSchema, aliases, model?.
- Department gains: `capabilities: [...]` (defaults inherited by members). Keeps: mission, lead, memoDomain, vaultSection, playbooks, privateMemo. Loses: `toolServer`/`toolServers`/`tools` (subsumed by capabilities).
- Exactly one `kind: coordinator` agent required at boot (Hermes).

## 5. Everything is a registry agent

- Hermes: full prompt moves to YAML; generated blocks (team roster, playbook list, attachment rules) stay template-injected at session build. `MODERATOR_ALLOWED_TOOLS` and `isChiefOfStaff` deleted; code reads `registry.coordinator()`.
- The moderator/finance pseudo-role special cases in `permissions-view.ts` die — every agent resolves the same way.
- `kind: lead` = department heads (planners, standup narrators). `kind: critic` = verdict/test-report agents.

## 6. Model tiering

Defaults by kind: coordinator/lead → `AIOS_MODERATOR_MODEL`; worker → `AIOS_SPECIALIST_MODEL`; critic → `AIOS_CRITIC_MODEL` (new, optional, falls back to specialist — critics are cheap structured-output calls). Per-agent `model:` override wins (schema already supports it).

## 7. One resolution path

`resolveAgent(name, origin, ctx) → { options, ceiling, labels }` — single function used by playbook nodes, direct chats, hand_off, and mail injection. Replaces the `roleQueryOptions → packRunOptions → withEffectiveTools → withDenialObserver` composition being re-assembled at each seam. Order of layers inside is preserved (widen-before-wrap invariant, DB permission overrides fail-closed, denial observer last). Capability parity across seams becomes structural; the parity pin test stays as a regression tripwire.

`packs/types.ts` Pack shape, `makeResolveDeptFor`, `pillarOf`/`roleOf`: deleted.

## 8. One address parser

`parseDirectAddress` and `findAgentMention` merge: `@name` anywhere, or `name:` prefix. Bound group chats require the `@` form (fixes bare-prefix hijacking of ordinary text like "finance: revenue up"); DM prefix form stays.

## 9. Migration

1. Loader v2 ships with back-compat shims: missing `capabilities` → synthesized from dept `toolServer(s)` + tool lists; missing `kind` → inferred (dept lead field → lead; outputSchema → critic; hermes → coordinator; else worker).
2. Migrate the 15 YAMLs + department manifests to v2 fields.
3. Delete shims + dead code (Pack struct, pseudo-role paths, second parser, hardcoded servers).

`role_permissions` table unchanged (keyed by canonical name). Alias set unchanged.

## 10. Testing

- Loader golden tests: YAML → fully resolved options for all 15 agents (tools, servers, ceiling, guards, model).
- Clamp invariant property test: no agent ever gains a tool outside its capability union.
- Boot-error tests: alias collision, unknown capability, unknown guard, zero/two coordinators.
- Seam parity test (direct vs hand_off vs node) retained.
- Address parser table tests (bound/unbound × @/prefix/plain).

## 11. Out of scope

- Label enforcement semantics (`labels` are declared here, consumed by the Information-Flow Policy spec).
- Trust/gate changes. UI changes (Staff section reads the same views).
- Any persona/prompt rewrites.

## 12. Open questions

None — resolved in brainstorm (§2).
