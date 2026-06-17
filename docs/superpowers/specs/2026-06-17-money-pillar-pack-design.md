# AI-OS — Money Pillar Pack (Personal CFO) — Design

**Date:** 2026-06-17
**Status:** Approved (brainstorm complete, awaiting implementation plan)
**Trigger:** Phase 7 shipped the pillar-pack framework but **zero packs exist** (`packs: (none)` in prod), and the Bunq bank sense is **live** (195 real transactions syncing) with **no consumer**. Cycle 2 of personal-money turns that dormant data + dormant framework into a working personal CFO — and is the first real pack, validating the framework end-to-end.

## Summary

A **money pillar pack**: a private personal-CFO that reads the already-synced bunq `personal_transactions` feed and adds categorization, subscription tracking, and budgets on top — surfaced both **reactively** (a private `@cfo` pack agent you chat with) and **proactively** (money signals pushed to your private chat via the heartbeat). It is **analysis-only** (no payments ever — bunq stays read-only; no outward effects at all this cycle). The pack is **private-surface-only**: raw money data lives exclusively in SQLite and is **never written to the vault or indexed into recall**, preserving the hard wall the personal-money split exists to protect. Delivering it requires a small, reusable **framework extension**: packs can declare their own MCP tool-server (the missing piece deferred from Phase 7).

## Requirements (from brainstorm)

| Decision | Choice |
|---|---|
| Mode | **Proactive + reactive** — conversational pack agent AND heartbeat-pushed alerts |
| Categorization | **Hybrid, learning** — DB rules → built-in defaults → Haiku one-shot → cache + learn a rule (mirrors the existing triage pattern) |
| Subscriptions | **Auto-detect from the feed + confirm** — surface recurring-charge candidates; you confirm/dismiss; manual add also allowed |
| Outward effects | **None** — analysis-only. Internal writes (budgets, confirmed subs, category rules) are direct Store writes; `pack.actions = []` (no gated outward actions) |
| Delivery | **Extend the pack framework** (pack-specific tool-server) + ship money as a proper `playbooks/money/pack.yaml` — validates Phase 7, reusable by all future packs |
| Surface | Private `cfo` role bound to the money pack (DM `@cfo`); **hard group-chat refusal**; proactive alerts to the **private primary chat only** |
| Net worth / account balances | **Out of scope** — bunq syncs transactions, not balances; no `personal_accounts` table this cycle |

## Existing foundation (reused, not rebuilt)

- **Pack framework** (`src/packs/{types,loader,server,resolve}.ts`) — `packSchema` (pillar/persona/memoDomain/vaultSection/tools/actions/roles/playbooks); the shared `aios-pack` MCP server (`buildPackServer`: `recall`/`vault_read`/`vault_write`/`propose_action`) with the gate ceiling (`proposeThroughCeiling`/`withinCeiling`); `resolvePack` → `ResolvedPack {contextBlock, tools, mcpServers}`; `makeResolvePackFor` routing playbook/role → pack. **`ResolvedPack.mcpServers` is already a multi-entry `Record` and `packRunOptions` (`runner.ts:56-63`) spread-merges it** — the plumbing supports multiple servers; only the schema + `resolvePack` build step need a hook.
- **Bunq feed** (`src/store/db.ts` `personal_transactions` + `upsertPersonalTransaction`/`listPersonalTransactions`; `src/senses/bunq/sync.ts` the sole writer) — read-only, append-only, `UNIQUE(account_id, bunq_id)`. No categories, no annotation today.
- **Finance agent** (`src/finance/agent.ts`) — the pattern to mirror for direct-CRUD MCP tools (`add_expense`/`list_expenses`/… write straight to the Store). The money server copies the CRUD shape; it does **not** copy finance's group-chat binding or its gate-bypass for outward effects (money has none).
- **Triage** (`src/heartbeat/triage.ts`) — the proven hybrid classify-with-learning idiom (`triage_rules` table → code defaults → Haiku one-shot, structured output). Categorization mirrors it.
- **Heartbeat** (`src/heartbeat/{clock,briefs}.ts`) — 30s tick, anchor briefs, reminders pinging the origin chat. The proactive money check rides this cadence — but pushes **direct to chat**, NOT via a vault-written brief (see Privacy).
- **Second-brain memo domains** (`src/memory/`) — `money` is already a Phase 6 domain. The money pack's `recall` is safe by construction (the index never contains bank rows).
- **Privacy guard** (`test/bunq-recall-exclusion.test.ts`) — bank data is absent from recall *structurally* (the indexer never reads `personal_transactions`). The money pack must preserve this: never feed raw money data into `indexDoc`, `vault.appendDaily`, `vault.writeNote`, or any vault path `reindexVault` scans.

## Architecture

```
bunq sync ─▶ personal_transactions (immutable feed) ─┐
                                                       ├─▶ categorize() ──▶ personal_tx_category (cache)
personal_category_rules (learned) ────────────────────┘        │  rules → defaults → Haiku → cache+learn
                                                                ▼
money MCP server (direct CRUD): spending_summary / list_transactions / *_subscription / *_budget / budget_status / set_category_rule
                                                                ▲
playbooks/money/pack.yaml { toolServer: "money", actions: [] } ─┘ ──▶ @cfo role (DM-private, group-refusal)

heartbeat tick ─▶ money signals (budget overrun · renewal due · new recurring · large tx)
                     └─▶ DIRECT private-chat message (NEVER vault/recall) ; alert-state in SQLite
```

### 1. Framework extension — pack-specific tool-servers (reusable)

The one missing framework piece. Minimal, additive, used by every future pack.

- **Schema** (`src/packs/types.ts`): add `toolServer: z.string().optional()` to `packSchema`. Absent → behaves exactly as today (shared `aios-pack` server only) → **zero regression for packless/serverless packs**.
- **Builder registry**: a `Record<string, PackToolServerBuilder>` mapping a server name → a builder `(deps) => McpServer`. The money builder registers as `"money"`. Defined where packs are wired (`src/index.ts`) and threaded into `ResolveDeps`.
- **`resolvePack`** (`src/packs/resolve.ts`): if `pack.toolServer` is set and resolves in the registry, build it and add to the `mcpServers` record alongside `aios-pack`:
  `mcpServers: { [SERVER_NAME]: shared, [pack.toolServer]: builder(deps) }`. Unknown `toolServer` → log + omit (fail-soft; the pack still loads with the shared server).
- **Tool-name resolution**: the manifest's `tools` list the pack agent's allowlist. Pack-server tools are listed as already-fully-qualified names (`mcp__money__spending_summary`); `resolvePack`'s existing prefixing (only rewrites the four `MCP_TOOL_NAMES`) leaves fq names untouched, so they pass through correctly. (No change to the prefix logic needed.)

### 2. Data layer — 4 new tables (`personal_transactions` stays immutable)

All `INSERT/CREATE` mirror the existing `node:sqlite` conventions (`id INTEGER PRIMARY KEY AUTOINCREMENT`, ISO-string timestamps, `ON CONFLICT … DO UPDATE` upserts). Raw bank data is **never** copied out of SQLite.

```sql
-- learned counterparty/pattern → category (mirrors triage_rules)
CREATE TABLE personal_category_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL,            -- matched against counterparty/description (normalized, case-insensitive contains)
  category TEXT NOT NULL,           -- one of the fixed taxonomy
  source TEXT NOT NULL,             -- 'user' | 'llm'
  created_at TEXT NOT NULL,
  UNIQUE(pattern)
);

-- per-transaction category cache (rebuildable; keeps personal_transactions pristine)
CREATE TABLE personal_tx_category (
  account_id TEXT NOT NULL,
  bunq_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  source TEXT NOT NULL,             -- 'rule' | 'llm'
  created_at TEXT NOT NULL,
  UNIQUE(account_id, bunq_id)
);

-- subscriptions (detected from the feed, then confirmed; or added manually)
CREATE TABLE personal_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  counterparty TEXT,               -- the feed counterparty that matched (null for manual)
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  cadence TEXT NOT NULL,           -- 'monthly' | 'yearly' | 'weekly'
  next_renewal TEXT,               -- ISO date, best-effort from last seen + cadence
  status TEXT NOT NULL,            -- 'detected' | 'confirmed' | 'dismissed'
  source TEXT NOT NULL,            -- 'auto' | 'manual'
  created_at TEXT NOT NULL
);

-- monthly budgets per category
CREATE TABLE personal_budgets (
  category TEXT NOT NULL,
  limit_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(category)
);
```

Store methods (mirroring existing CRUD): `upsertCategoryRule`/`listCategoryRules`; `setTxCategory`/`getTxCategory`/`listTxCategories`; `addSubscription`/`listSubscriptions(status?)`/`setSubscriptionStatus`; `setBudget`/`listBudgets`. Read of the feed reuses the existing `listPersonalTransactions(accountId?)`.

### 3. Categorization service (hybrid, mirrors triage)

`categorize(tx) → category`, evaluated in order, result cached in `personal_tx_category`:

1. **Cache** — if `personal_tx_category` already has it, return it.
2. **DB rules** — first `personal_category_rules` whose `pattern` matches (normalized contains on counterparty/description).
3. **Built-in defaults** — a small seeded map of common NL merchant patterns (e.g. `albert heijn`/`jumbo` → groceries; `ns.nl`/`ov-chipkaart` → transport; `vattenfall`/`eneco` → utilities). Code-level, no LLM.
4. **Haiku one-shot** — classify into the **fixed taxonomy** via structured output (enum): `groceries, eating-out, transport, housing, utilities, subscriptions, shopping, health, entertainment, income, transfers, fees, other`. Only the counterparty + description + amount-sign are sent (minimal data). On success, cache **and** write a learned `personal_category_rules` row (`source='llm'`) so the next identical merchant is rule-hit (cheaper over time).
5. **Fallback** — `other` if the LLM is unavailable/fails (never throws; categorization degrades, never breaks a query).

Categorization runs **lazily** when `spending_summary`/`budget_status` need it (batched over the period's uncached transactions), so it costs nothing until used and amortizes via the cache + learned rules.

### 4. Money MCP server (`money`) — direct-CRUD tools (no gate; analysis-only)

Built per the `FinanceAgent.buildServer` pattern (`createSdkMcpServer`, direct Store access). No `gate` dependency, no outward effects. Tools:

- `spending_summary({ month?, account? })` — totals by category for the period (categorizes uncached txns first). The "where did my money go".
- `list_transactions({ month?, category?, account?, limit? })` — filtered feed read.
- `list_subscriptions({ status? })` / `confirm_subscription({ id })` / `dismiss_subscription({ id })` / `add_subscription({ name, amount, currency, cadence })` — manage the subs list.
- `set_budget({ category, limit })` / `list_budgets()` / `budget_status({ month? })` — budgets vs actuals for the period.
- `set_category_rule({ pattern, category })` — teach a categorization rule (the agent uses this when you correct it).

The pack **also inherits** the shared `aios-pack` server's `recall` + `vault_read` (read-only context). It does **not** get `vault_write`/`propose_action` in its `tools` allowlist (analysis-only — nothing to write outward).

### 5. Proactive heartbeat signals (deterministic compute → private push)

A money-signals check rides the existing heartbeat (evaluated once per anchor/day, gated by a kv stamp like the brief/anchor pattern so it fires once). It computes deterministically over SQLite:

- **Budget overrun** — a category's month-to-date actuals ≥ its `personal_budgets` limit (or ≥ a warn threshold, e.g. 90%).
- **Renewal due** — a `confirmed` subscription whose `next_renewal` is within N days.
- **New recurring charge** — a counterparty with ≥3 regular same-amount hits not yet in `personal_subscriptions` → a `detected` candidate to confirm.
- **Unusually-large transaction** — a debit above a threshold (configurable; default a multiple of the trailing median).

Each fired signal is **pushed directly to the private primary chat as a concise templated message** (a direct channel send — **no agent turn**, so money data never enters a persisted agent session, and no LLM cost per alert; the user asks `@cfo` for detail). Its **state is recorded in SQLite** (a kv stamp / a `notified` flag) so it fires once. **It is never written to the vault or a brief file** (those are recall-indexed → would leak bank data). Detection of candidate subscriptions writes `personal_subscriptions` rows with `status='detected'`.

### 6. Surface — the `cfo` role + pack manifest

- **`playbooks/money/pack.yaml`**: `pillar: money`, `persona:` (private personal CFO — refuses to discuss finances in any group chat or with anyone but the operator; never initiates or suggests payments; bunq is read-only), `memoDomain: money`, `toolServer: money`, `tools: [mcp__money__*, recall, vault_read]`, `actions: []`, `roles: [cfo]`, `playbooks: []`.
- **`cfo` role** (`src/agents/roles/index.ts`): a `RoleDef` bound to the money pack (the pack's `roles: [cfo]` makes `@cfo` direct chats inherit the pack). `permissionMode: "dontAsk"`, the money/recall tools as `allowedTools` (supplied by the pack), a strong system prompt enforcing the private + group-refusal + no-payments rules.
- **Group-chat refusal** — enforced in the persona/system prompt AND structurally: the proactive push targets only the configured private primary chat; the `@cfo` role, if addressed from a group origin, refuses (mirrors the finance agent's chat-binding discipline, but inverted — money refuses groups instead of binding to one).

## Privacy — the hard wall (non-negotiable, tested)

- Raw money data (amounts, counterparties, descriptions) lives **only** in the `personal_*` SQLite tables. The money server returns it **only** into the live private agent turn (ephemeral) — never persisted to vault/memo/recall.
- Proactive alerts go **direct to the private chat**; alert *content* is never written to a vault brief (vault → `reindexVault` → recall). Only non-sensitive *state* (a kv "alerted" stamp, a `notified` flag) is persisted.
- The `money` memo domain is **not** injected into the moderator's general system-prompt memo set (it stays pack-scoped, surfaced only inside a `@cfo` turn).
- A test mirrors `bunq-recall-exclusion`: after exercising the money pack (categorize, summary, subscription detect, a proactive signal), `recall(...)` for a transaction's counterparty/description returns `[]`.

## Error handling — fail-safe, never leak, never break a query

- Categorization LLM unavailable/fails → category `other`; the query still returns. Never throws.
- Unknown `toolServer` in a manifest → logged, omitted; the pack still loads with the shared server (fail-soft, mirrors the loader's skip-on-error discipline).
- A proactive-signal computation error → swallowed; the heartbeat tick and other senses are unaffected (mirrors the denial-hook and watcher patterns).
- Empty feed / no budgets / no subs → tools return empty summaries, not errors.
- Money data must never reach a vault write — enforced by construction (the pack has no `vault_write` tool) and by the recall-exclusion test.

## Testing

- **Framework extension**: a pack with `toolServer: "money"` resolves to `mcpServers` containing both `aios-pack` and `money`; a pack without `toolServer` resolves to only `aios-pack` (zero regression); an unknown `toolServer` loads with only the shared server (fail-soft).
- **Store**: each new table's CRUD round-trips (upsert/list/status transitions); `UNIQUE` constraints dedupe (category rule per pattern, budget per category, tx-category per (account,bunq_id)).
- **Categorization**: cache hit short-circuits; DB rule beats default; default beats LLM; LLM result is cached + learned as a rule; LLM failure → `other` (no throw); only minimal fields are sent to the classifier.
- **Subscription detection**: ≥3 regular same-amount hits from a counterparty → a `detected` candidate; confirm/dismiss transitions; manual add.
- **Budgets**: `budget_status` computes month-to-date actuals per category vs limit; overrun flagged at the threshold.
- **Proactive signals**: each signal type fires from a seeded fixture; the kv stamp makes it fire once; a signal-compute error is swallowed.
- **Privacy (load-bearing)**: after the full pack flow, recall returns `[]` for bank counterparties/descriptions; no `vault.*` write is invoked with money data; the `money` memo domain is absent from the moderator's general prompt.
- **Group refusal**: a `@cfo` turn from a group origin refuses; proactive push targets only the private chat.

## Build stages (one spec, ordered)

1. **Framework extension** — `toolServer` schema field + builder registry + `resolvePack` build/merge + tests. Shippable alone; zero regression with no `toolServer`.
2. **Money data + categorization + server (reactive core)** — the 4 tables + Store CRUD; the hybrid categorization service; the `money` MCP server tools; the `money` pack.yaml + `cfo` role. `@cfo` works privately end-to-end.
3. **Proactive heartbeat** — the money-signals check + private push + once-firing state + the privacy test. Briefs/alerts go live.

## Out of scope (YAGNI / later)

- **Net worth / account balances** — bunq syncs transactions, not balances; no `personal_accounts` table or balance history this cycle.
- **Outward effects** — no email reports, exports, or any gated action (`actions: []`). A later cycle can add a gated `email.draft` monthly summary.
- **A Mission Control money view** — surface is private chat + briefs for cycle 2; a localhost dashboard is a later add.
- **Payments / transfers of any kind** — permanently out; bunq is read-only forever (the bunq sense has a CI guard against write endpoints).
- **Multi-currency normalization / FX** — amounts are reported in their native currency; cross-currency budget math is deferred.
- **Other packs** (code/research/lifeops) — each its own spec; this cycle only ships the framework hook they'll reuse + the money pack.
