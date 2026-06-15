# AI-OS — Bunq Bank Sense — Design

**Date:** 2026-06-15
**Status:** Approved (brainstorm complete, awaiting implementation plan)
**Master vision:** `docs/superpowers/specs/2026-06-11-cognitive-kernel-design.md` (§1 Perception — `ledger` watcher + CSV bank import; here upgraded to a live bunq API sense)
**Context:** Cycle 1 of the personal-money work. Cycle 2 (the **money pillar pack** — `money` MCP server, subscriptions/budgets, analysis playbooks, the surface walls vs the group finance agent) is a separate spec built on top of this sense's `personal_transactions` table.

## Summary

Give AI-OS a **read-only** view of the user's real spending by syncing transactions from their
**bunq** bank account into a private `personal_transactions` table. The sense mirrors the existing
Google senses (a polling watcher, secure credential storage, degraded-and-reauth handling) but
isolates all bunq capability behind a **read-only Python helper** invoked over a process boundary —
the TypeScript daemon never imports a bunq library, never holds the API key, and has no payment
code path anywhere.

## Requirements (from brainstorm)

| Decision | Choice |
|---|---|
| Why bunq | The user's bank (bunq) exposes a public API; pull real spending instead of CSV/manual entry |
| Access scope | **Strictly read-only, forever** — only bunq read/list endpoints; NO payment code path anywhere; the Action Gate never gets a bunq-pay action; payments stay 100% manual in the bunq app |
| Client approach | **Official bunq Python SDK, shelled out** — a read-only `scripts/bunq_read.py`, invoked from Node via `execFile` (the whisper/ffmpeg pattern), returns JSON. The official SDK handles the auth handshake/signing correctly; read-only by construction; the key lives only in that isolated process |
| Personal vs group isolation | The group expense-splitting agent (`src/finance/`) is untouched. Bank data lands only in the new private `personal_transactions` table — never the group `expenses` table, never recall, never a shared surface |
| Sandbox | **Sandbox-first** — built + verified against bunq's sandbox before any production key loads |
| Surface (cycle 1) | **Silent** — the sense writes the table + logs; it emits no chat events / brief lines (the primary chat could be a group). Proactive bank insights are deferred to the money pack (cycle 2, private surface) |

## Existing foundation (reused, not rebuilt)

- **Google senses** (`src/senses/google/`) — the watcher + degraded/re-auth + secure-token pattern this mirrors. Watcher loops in `src/index.ts` (per-account isolation, capped backoff).
- **Shell-out pattern** — `src/voice/stt.ts` invokes `whisper-cli`/`ffmpeg` via `execFile`; the bunq helper uses the same boundary.
- **One-time setup script** — `scripts/google-auth.ts` (one-time consent → tokens file 0600); `scripts/bunq-setup.py` mirrors it.
- **Store** (`node:sqlite`) + `kv` table for per-account cursors. Brief/degraded surfacing in `src/heartbeat/briefs.ts`.
- **Group finance agent** (`src/finance/`) — left exactly as-is; this sense never touches it or the `expenses` table.

## Architecture

```
bunq API ──(read-only)── scripts/bunq_read.py ──JSON──▶ src/senses/bunq/sync.ts ──▶ personal_transactions
  (official bunq_sdk)     [execFile boundary]            (parse, dedupe, upsert)        (private SQLite table)
                                                              ▲
                                                    watcher loop (poll + backoff, index.ts)
```

- **`scripts/bunq_read.py`** — small Python helper using the official `bunq_sdk`. **Only read functions**: list active monetary accounts, list payments per account (optionally `since_id`). No payment / draft-payment / counterparty-write code exists in the file. Loads the persisted bunq context; prints `{ accounts, transactions }` JSON to stdout. The API key/context never leave this process.
- **`src/senses/bunq/sync.ts`** — invokes the helper via `execFile`, parses JSON, maps fields, dedupes by `(account_id, bunq_id)`, upserts into `personal_transactions`, advances per-account cursors. Knows nothing of bunq auth internals; never imports a bunq library.
- **`src/senses/bunq/index.ts`** — sense lifecycle: detect availability (python3 + helper + context present), expose `enabled()`/`degraded()` like `GoogleAccounts`.
- **Watcher** — registered in `src/index.ts` alongside the gmail/calendar watchers: a poll loop with capped backoff, `AIOS_BUNQ_POLL_SECONDS` (default 3600 — bank data isn't real-time; respect rate limits).
- **`personal_transactions`** — new private table (raw bank feed); the money pack reads it in cycle 2.

The TS daemon spawning a read-only helper *is itself a safety wall*: the key + all bunq capability are sandboxed in one read-only script; the broad daemon surface can neither pay nor leak the key.

## Auth, setup, secure storage, sandbox/production

- **Handshake** — bunq's installation → device-registration → session is run once by the official SDK and persisted to a context file; later runs restore it and auto-refresh the session.
- **One-time setup** — `scripts/bunq-setup.py` (mirrors `scripts/google-auth.ts`): the user supplies their API key + environment; it runs the SDK handshake and writes `data/bunq-context.<env>.conf` at **mode 0600**.
- **Secure storage** — the context file (RSA keys + tokens) and API key live only under `data/` at 0600, gitignored, **never logged, never vaulted, never passed to an agent** (same discipline as `data/google-tokens.json`).
- **Sandbox-first** — `AIOS_BUNQ_ENV=sandbox|production` (default `sandbox`). The sense is built and verified against bunq's sandbox (sandbox user + generated payments) before a production key is ever used. Going live = config flip + one `bunq-setup.py` run with the production key.
- **Degraded** — missing/expired/revoked context → log `bunq sense: re-auth needed` and surface it in the brief (the Google senses' re-auth path); never crash the daemon.

Config knobs: `AIOS_BUNQ_ENV`, `AIOS_BUNQ_POLL_SECONDS`, `AIOS_BUNQ_BACKFILL_DAYS`. Setup is interactive/one-time, not part of the daemon.

## Data model + sync

```sql
CREATE TABLE personal_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,          -- bunq monetary-account id (multi-account)
  account_label TEXT NOT NULL,       -- e.g. "Main", "Savings"
  bunq_id INTEGER NOT NULL,          -- bunq payment id (dedupe key)
  amount_cents INTEGER NOT NULL,     -- signed: negative = outgoing/spend, positive = incoming
  currency TEXT NOT NULL,
  description TEXT NOT NULL,
  counterparty TEXT,                 -- display name
  counterparty_iban TEXT,
  type TEXT,                         -- bunq payment type/sub_type (card/transfer/direct-debit…)
  bunq_created TEXT NOT NULL,        -- transaction timestamp from bunq
  synced_at TEXT NOT NULL,
  UNIQUE(account_id, bunq_id)
);
```

- **Multi-account** — list all active monetary accounts; sync each independently; tag rows with `account_id`/`account_label`.
- **Cursor** — per-account `kv: bunq:cursor:<account_id>` = highest synced `bunq_id`. Incremental syncs request only payments newer than the cursor (bunq `newer_id` pagination); the helper takes an optional `since_id` per account.
- **Backfill** — first sync (no cursor) pulls a bounded window: `AIOS_BUNQ_BACKFILL_DAYS` (default 90), so day one doesn't drag years of history.
- **Dedupe / idempotency** — `UNIQUE(account_id, bunq_id)` + `INSERT OR IGNORE`; the cursor advances to the max `bunq_id` ingested. Overlapping/replayed windows never double-insert.
- **Faithful storage** — amounts stored signed and raw; the sense does **not** categorize or judge spend-vs-income — that's the money pack (cycle 2). It mirrors bunq accurately and nothing more.

The helper returns `{ accounts:[{id,label,currency}], transactions:[{bunq_id,account_id,amount_cents,currency,description,counterparty,counterparty_iban,type,bunq_created}] }`; `sync.ts` upserts + persists cursors. No transformation beyond field mapping.

## Security walls

- **Read-only by construction** — only bunq read/list endpoints; no payment code anywhere; the Action Gate gains no bunq action type.
- **Credential isolation** — key/context 0600, never logged/vaulted/agent-exposed; held only by the helper process.
- **No recall indexing (invariant + test)** — `personal_transactions` is not a recall-index source (the index covers vault/events/decisions only), so it is excluded by default; a test pins this so no future change silently indexes bank data.
- **Surface-silent (cycle 1)** — no chat events, no brief lines; table-only. The primary chat could be a group, so bank data never touches a chat surface in this cycle.
- **Outbound-only** — the helper makes outbound HTTPS to bunq; no inbound exposure (the daemon's standing rule).

## Error handling — fail-safe, never silent

- Helper failure (network/auth/rate-limit) → sync logs + watcher backoff; auth failures surface a brief re-auth line; daemon never crashes.
- Malformed helper JSON → caught, logged, skipped (no partial corruption — upsert only on a fully-parsed payload).
- python3 / `bunq_sdk` absent, or no context → sense **disabled at boot** with a clear log (mirrors "google senses disabled").
- Rate limits → conservative default poll + capped backoff.

## Testing

- **Sync (TS, no real bunq)** — fixture JSON (a fake helper payload) → assert: upsert, dedupe via `UNIQUE`, cursor advance to max `bunq_id`, multi-account tagging, signed amounts, idempotent re-run (no dupes).
- **Recall-exclusion invariant** — a test asserting `personal_transactions` never enters the recall index.
- **Degraded** — missing context → sense disabled + brief re-auth line.
- **Sandbox e2e (opt-in, `AIOS_TEST_BUNQ_SANDBOX=1`, not in CI)** — real sandbox user + generated payments → verify they land in `personal_transactions`. This is the live verification gate before any production key.

## Build stages

This spec is **cycle 1 (bank sense)** only:
1. `personal_transactions` table + Store methods.
2. `scripts/bunq_read.py` (read-only helper) + `scripts/bunq-setup.py` (one-time setup).
3. `src/senses/bunq/{sync,index}.ts` — execFile boundary, field mapping, dedupe, cursors.
4. Watcher wiring in `src/index.ts` (poll + backoff + degraded surfacing) + config.
5. Tests + sandbox verification.

**Cycle 2 (separate spec):** the money pillar pack — `money` MCP server reading `personal_transactions` + `personal_subscriptions`/`personal_budgets`/`personal_accounts` tables, analysis playbooks (subscription-audit, monthly-report, budget-check, expense-review), persona, and the hard surface walls vs the group finance agent (private-only, group-chat-refusal, ledger-pinned).

## Out of scope (YAGNI / later)

- **Any bunq write/payment capability** — permanently out (strictly read-only).
- **Categorization / budgets / subscription detection** — cycle 2 (money pack).
- **Proactive bank surfacing** (brief lines, alerts) — cycle 2, on the private surface only.
- **Other banks / aggregators** (Plaid, etc.) — bunq only for now; the sense boundary (helper → JSON → table) would generalize later if needed.
- **A TS-native bunq client** — rejected in favor of the official Python SDK for auth correctness; revisitable only if the Python dependency becomes a problem.
