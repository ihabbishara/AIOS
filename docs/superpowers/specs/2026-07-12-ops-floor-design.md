# Ops Floor — Design

**Date:** 2026-07-12
**Status:** Approved (brainstorm with user)
**Scope:** Batch of independent operational/security hardening items. No architectural changes; each item is independently landable.

## 1. Problem

Operational gaps identified in the redesign review:

- No SQLite pragmas — no WAL, no busy_timeout; external readers of the DB file risk `SQLITE_BUSY`; sync writes stall harder than needed.
- `AIOS_UI_TOKEN` optional and historically unset for weeks — `/api/*` fully open on localhost including `.env` writes, restart, chat-that-spends.
- `events` and `memory_*` tables grow unbounded; `/api/costs`, `/api/org`, agent profiles, permissions view each scan `bus.history(0,5000)` per request.
- Secret denylist expressed three times (paths.ts regexes, exec.ts SBPL, jailEnv) with prose "superset" comments — drift risk.
- Atlas (write-capable DevOps agent) safety is prompt-advisory only; halalo proves the deterministic-guard pattern.
- Code sandbox allows full network egress in every mode.
- Restart flows unobservable (UI fakes a 12s timer); stale `data/aios.db` empty file traps queries.

## 2. Items

### 2.1 SQLite pragmas
At `Store` open: `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`, `PRAGMA foreign_keys=ON`. WAL file lives beside the DB (gitignored path already). No schema changes.

### 2.2 UI token default-on
First boot with no `AIOS_UI_TOKEN`: generate `randomBytes(32).hex`, append to `.env` (trailing-newline-guarded — the known corruption gotcha), log the value once at boot. Explicit opt-out: `AIOS_UI_TOKEN=off`. Existing token untouched.

### 2.3 Cost rollups + retention
- `cost_daily(agent TEXT, date TEXT, usd_cents INTEGER, runs INTEGER, PRIMARY KEY(agent,date))` maintained by the existing `agent.end` bus listener (same seam as `budget_ledger`).
- `/api/costs`, org view `costTodayUsd`, agent-profile `costByDay` read rollups; the `bus.history(0,5000)` scans are deleted. Backfill once from event history at migration.
- Retention sweeper on the daily anchor: `events` rows older than `AIOS_EVENT_RETENTION_DAYS` (default 90) pruned; `memory_use` (Memory v2) pruned at 90d. **`goal_journal` is never pruned** — it is the goals source of truth.

### 2.4 One secrets module
`src/kernel/secrets.ts`: single denylist (path roots + filename patterns) with three consumers — `paths.ts` `isSecretPath`, the SBPL profile generator in `exec.ts`, and `jailEnv` env scrubbing. The per-site copies and "superset" comments are deleted. One fixture set tests all three consumers.

### 2.5 Atlas deterministic guard
`atlasToolChecks` in registry code-extras (same mechanism as halalo): Bash/`mcp__code__sh` command parse denying `terraform apply|destroy`, `kubectl apply|delete|patch|drain`, `git push`, `helm install|upgrade|uninstall|rollback`, and non-read `aws` subcommands. Fallback **allow** (atlas stays useful; the denylist is the fence), denials logged via the existing denial-observer path.

### 2.6 Sandbox network egress
- `analyze` mode: SBPL `(deny network*)` — read-only audits need no network.
- `build` mode: keeps `(allow network*)` by default (npm/pip installs), overridable per department via `AIOS_SANDBOX_NET=deny`.
- Domain-allowlist egress (local proxy + SBPL restricted to the proxy port) documented as **deferred** — SBPL cannot filter hostnames honestly, and a half-working allowlist is worse than an honest toggle.

### 2.7 Health + cleanup
- `GET /api/health` (shared with the Ember Cockpit spec): uptime, senses status, voice status, SSE client count, DB size, policy-violation count (audit mode).
- Boot prints one readiness line after the web server binds.
- Boot cleanup: delete stale empty `data/aios.db` (the known wrong-file trap; guarded — only if zero-byte).

## 3. Testing

- Pragma assertions on a fresh Store.
- Token generation boot test (env file gains the line, newline-guarded); opt-out respected.
- Rollup equivalence: rollup numbers == history-scan numbers over a fixture event stream; backfill idempotent.
- Retention sweep: old events pruned, journal untouched, recent rows survive.
- Secrets module: one fixture set of hostile paths rejected by all three consumers.
- Atlas guard table tests (denied commands, allowed reads, compound-command rejection consistent with halalo parser reuse).
- SBPL: analyze-mode profile contains `(deny network*)`; build respects `AIOS_SANDBOX_NET`.

## 4. Out of scope

- Structured logging framework (current console logging stays).
- Multi-process/HA concerns.
- Domain-allowlist egress proxy (deferred, documented).

## 5. Open questions

None.
