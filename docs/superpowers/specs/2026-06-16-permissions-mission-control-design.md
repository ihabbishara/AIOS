# AI-OS — Permissions in Mission Control — Design

**Date:** 2026-06-16
**Status:** Approved (brainstorm complete, awaiting implementation plan)
**Trigger:** An AI-OS daemon agent hit its `dontAsk` permission wall and (via relayed output) tried to get the operator to globally disable the safety mode + disclose `~/.claude/settings.json`. The operator correctly refused and asked for **visibility + deliberate control of agent permissions in Mission Control** instead of a hidden override.

## Summary

Make AI-OS's agent tool-permissions **visible and deliberately controllable** in Mission Control,
without opening a self-escalation path on a daemon that ingests untrusted content. Role tool-allowlists
stay defined in code as the **default**; a gated, audited **override layer** lets the human grant/revoke
a specific tool for a specific role — and every grant/revoke is an **always-supervised Action Gate
action**, so even a rogue agent hitting the (unauthenticated, localhost) web API can only *propose* a
grant that the human must then approve. The UI also **surfaces tool denials** so incidents like the one
that triggered this are explained on-screen, never a mystery.

## Requirements (from brainstorm)

| Decision | Choice |
|---|---|
| Scope | Visibility **+ grant/deny from the UI** + surface denials |
| Security model | **Gated `permission.grant`/`permission.revoke`** — always-supervised, never autonomous; the UI button only *proposes*; the human's approval is the only authority |
| Permission storage | Code roles stay the **default**; a `role_permissions` DB table holds overrides; effective allowlist computed fresh per run |
| Granularity | Per-tool grant/revoke (precise, least-privilege) — NOT flipping a role's `permissionMode` |
| Editing `permissionMode`/`toolCheckFallback` | Out of scope — shown read-only; grants operate at the tool-allowlist level |

## Existing foundation (reused, not rebuilt)

- **Roles** (`src/agents/roles/index.ts`) — the `roles` registry: `permissionMode` (`dontAsk`/`bypassPermissions`/`default`), `allowedTools`, `toolChecks`, `toolCheckFallback`, `skills`. The moderator's allowlist lives in `src/moderator/session.ts` (`MCP_TOOLS` + built-ins).
- **Action Gate + trust ledger** (`src/kernel/{gate,trust,actions,executors}.ts`) — the single audited effect chokepoint; `alwaysSupervised` ceiling (already holds `trust.promote`); gate authors previews for privileged types via `authoredPreview()`.
- **Option-building seams** — `roleQueryOptions`/`runSpecialist` (`src/agents/runner.ts`), `DirectChats` (`src/agents/direct.ts`), pack runs (`src/packs/resolve.ts` → `packRunOptions`), moderator session (`src/moderator/session.ts`). Each builds an agent's SDK options + `allowedTools`.
- **PreToolUse guards** (`src/agents/guards/`) — already build PreToolUse hooks for guarded roles; generalized here into the denial-observation seam.
- **Mission Control** (`src/web/server.ts` + `ui/`) — already has Trust, Approvals, Agents, Config views and `/api/{state,actions,trust,config,…}`; binds **127.0.0.1**, **no request auth**.
- **SDK permission semantics** — `allowedTools`/safe-tools bypass `canUseTool`; PreToolUse hooks are the only always-on gate; an `allow` decision needs `updatedInput` (memory `sdk-permission-semantics`).

## Architecture

```
roles/index.ts (CODE default)  ─┐
role_permissions (DB override) ─┼─▶ effectiveAllowedTools(role, store) ─▶ every agent run's allowedTools
                                │        (fresh per run; fail-closed → defaults on error)
UI "Grant" button ─▶ POST /api/permissions/propose ─▶ gate.propose("permission.grant", {role,tool})
                                                            │ always-supervised → Approvals queue
                                                            ▼ human taps approve
                                              permissionGrantExecutor → upsert role_permissions (audited)
agent tool blocked ─▶ PreToolUse hook ─▶ emit tool.denied{role,tool} ─▶ events ─▶ Permissions view
```

### 1. Override model (code default + gated override layer)

```sql
CREATE TABLE role_permissions (
  role TEXT NOT NULL,          -- "finance", "halalo", "moderator" (pseudo-role), …
  tool TEXT NOT NULL,          -- "Bash", "Edit", "mcp__aios__recall", …
  allow INTEGER NOT NULL,      -- 1 = grant (add to allowlist), 0 = revoke (remove a default)
  granted_by TEXT NOT NULL,    -- the gate verdict_by (who approved)
  created_at TEXT NOT NULL,
  UNIQUE(role, tool)
);
```

- **Effective allowlist** for a role = `(role.allowedTools ∪ {tools with allow=1}) \ {tools with allow=0}`.
- Computed by `effectiveAllowedTools(role, store)` (pure given role-defaults + override rows; testable), read **fresh per agent run** — a grant applies on the agent's next run, no restart.
- The code role config is **never mutated**; overrides are a separate, auditable, clearable layer.
- The grant boundary controls **tool access (local capability)**. Every outward **effect** still passes the
  Action Gate + trust ledger — granting `Bash` lets an agent run shell locally but does not let it send
  email / move money without approval.

### 2. Gated `permission.grant` / `permission.revoke`

- **Action types** `permission.grant` (payload `{role, tool}`) and `permission.revoke` (payload `{role, tool}`).
- Added to the gate's **`alwaysSupervised`** set (config `trustPolicy.alwaysSupervised`, alongside `trust.promote`) — they **can never graduate to autonomous**; every instance requires a human tap, forever.
- **Gate authors the preview** (extend `authoredPreview()`): `Grant Bash to finance` / `Revoke Bash from finance`, computed from the payload — caller-supplied preview text is ignored (anti-forgery, same pattern as `trust.promote`/`email.*`).
- **Executors** `permissionGrantExecutor` / `permissionRevokeExecutor`: on approval, upsert/delete the
  `role_permissions` row (`allow=1` grant; `allow=0` or delete for revoke), set `granted_by` = approver,
  audited in the actions log.
- **Self-escalation closed:** the UI button (and anything else, incl. a rogue agent curling the unauth
  localhost API) only *proposes*; it lands in **Approvals** and waits for the human's tap. An agent can
  request a permission; it can never grant itself one.

### 3. Denial surfacing

- A shared **PreToolUse hook** on every agent run records tool attempts and emits `tool.denied
  { role, tool, context }` when a tool is blocked (rate-limited/deduped so a looping agent can't flood
  the event log). Reuses/generalizes the existing `src/agents/guards/` PreToolUse machinery.
- Stored in the existing `events` table; aggregated per role+tool. The Permissions view shows recent
  denials (`finance — Bash denied 3× (last 10:42)`), each with a one-click **Grant**.
- **Always-correct fallback:** the view also renders each role's **effective allowlist** statically, so even
  if a particular denial path isn't captured, you can always *see* what a role can and cannot use.
- **Caveat:** exactly which denials the hook observes depends on the SDK permission ordering (PreToolUse
  vs allowlist vs `canUseTool`, per `sdk-permission-semantics`). The plan pins this empirically; the
  static-allowlist fallback guarantees the view is useful regardless. Denial events are **observability
  only** — never auto-grant.

### 4. Permissions view + API

- **`GET /api/permissions`** — per role (the `roles` registry + the moderator as a pseudo-role):
  `name`, `description`, `permissionMode`, `toolCheckFallback`, `skills`, the **effective allowlist** (each
  tool tagged `default`/`granted`/`revoked`), and **recent denials** (per-tool count + last ts).
- **`POST /api/permissions/propose`** `{role, tool, action:"grant"|"revoke"}` — calls
  `gate.propose({type:"permission.grant"|"permission.revoke", payload:{role,tool}}, {channel:"web", chatId:"mission-control"})`.
  Returns the queued action id; applies **nothing** (the gate approval is the authority — safe despite
  the endpoint being unauth-localhost, because it only proposes).
- **`Permissions.tsx`** — a new view alongside Trust/Approvals/Agents: one card per role showing its mode
  (plain-English tooltip — `dontAsk` = "denies anything not listed"), the effective tool list (granted
  badged, revoked struck), and the denial feed. Per-tool **Revoke**; denials + a free-tool-add field have
  **Grant** buttons. Clicking proposes the gated action and toasts *"queued in Approvals — approve to apply."*
- Reuses the **Approvals** view for the actual approve/reject; "Permissions" added to the nav in `App.tsx`.

### 5. Runtime merge + safety

- `effectiveAllowedTools(role, store)` applied at every option-building seam (`roleQueryOptions`/
  `runSpecialist`, `DirectChats`, pack runs, moderator session), read fresh per run.
- **Fail-closed:** if the override read fails, the agent falls back to its **code default** allowlist — never
  to *more*. An error can only narrow, never widen.
- With zero overrides, every role's effective allowlist `==` its code default → **zero regression**.
- `permission.grant`/`permission.revoke` are always-supervised even if mis-seeded.
- Denial-hook failure is swallowed — it can never break an agent run.

## Error handling — fail-safe, never widen

- Override read failure → code-default allowlist (narrow, never widen); logged.
- Unknown role/tool in a stored override → inert at runtime (no matching role/tool); harmless.
- Denial-hook error → swallowed; agent run unaffected.
- `permission.grant` for an unregistered tool → the row is written but inert until/unless that tool exists.
- Gate/executor failure → surfaced in the actions log + brief, like any other effect.

## Testing

- **`effectiveAllowedTools`**: defaults ∪ grants \ revokes; duplicate/contradictory rows resolved by the
  `allow` flag; **read-fail → defaults (fail-closed)**; moderator pseudo-role merges its base allowlist.
- **Zero-regression**: with no `role_permissions` rows, every role's effective allowlist equals its code
  default; existing agent/role/pack tests unchanged.
- **Gate**: `permission.grant` cannot execute autonomously (always-supervised even if seeded); gate authors
  the preview (caller text ignored); approving runs the executor → row written with `granted_by`.
- **API**: `/api/permissions` shape (roles + tags + denials); `/api/permissions/propose` queues a gated
  action and applies nothing (asserted by checking no `role_permissions` row appears pre-approval).
- **Denial surfacing**: a blocked tool emits a deduped `tool.denied` event; hook failure doesn't break the run.
- **Security**: an override-read failure never widens an allowlist; the propose endpoint never mutates
  permissions directly; granting a tool does not bypass the Action Gate for outward effects.
- **E2E**: propose grant → approve via the gate → next agent run sees the granted tool in its effective
  allowlist; revoke reverses it. Fake-executor / in-memory store; zero real side effects.

## Build stages (one spec, ordered tasks)

1. **Secure backend core** — `role_permissions` table + Store CRUD; `effectiveAllowedTools` + runtime merge
   at all option seams; gated `permission.grant`/`permission.revoke` action types + executors +
   always-supervised + gate-authored previews. Shippable headless (no UI); zero-regression with no overrides.
2. **Denial surfacing** — PreToolUse observation hook + `tool.denied` events (deduped) + aggregation.
3. **UI** — `GET /api/permissions`, `POST /api/permissions/propose`, `Permissions.tsx`, nav entry.

## Out of scope (YAGNI / later)

- Editing `permissionMode` / `toolCheckFallback` from the UI (shown read-only; grants are tool-level).
- Authenticating the Mission Control web API (pre-existing unauth-localhost; the gated-grant design makes
  it unnecessary for *this* feature — but the latent risk that an agent can already curl `/api/config PUT`
  / `/api/restart` is noted as a separate hardening item).
- Time-boxed / expiring grants, per-tool approval policies, multi-operator auth — later if needed.
