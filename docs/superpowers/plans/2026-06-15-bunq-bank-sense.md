# Bunq Bank Sense Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync the user's bunq transactions (read-only) into a private `personal_transactions` table via an isolated, read-only Python helper, on a polling watcher — so a later money pack can analyze real spending.

**Architecture:** A read-only `scripts/bunq_read.py` (official `bunq_sdk`, read functions only) is spawned from Node via `execFile` and returns transactions as JSON. `src/senses/bunq/sync.ts` (with an **injectable** fetch, so tests use fixture JSON and never spawn Python) maps + dedupes + upserts into `personal_transactions`, advancing per-account cursors in `kv`. A watcher polls with capped backoff; degraded/re-auth surfaces in the brief. The TS daemon never imports a bunq library or holds the API key. **Strictly read-only — no payment code path exists anywhere.**

**Tech Stack:** TypeScript ESM, `node:sqlite`, `execFile` shell-out, Python 3 + `bunq_sdk` (helper only), vitest. No new Node dependency.

**Spec:** `docs/superpowers/specs/2026-06-15-bunq-bank-sense-design.md`

---

## File Structure

**New files:**
- `src/senses/bunq/sync.ts` — `BunqSync` (injectable fetch → map/dedupe/upsert/cursor) + shared types (`BunqTxn`, `HelperOutput`, `FetchTransactions`).
- `src/senses/bunq/index.ts` — `BunqSense` (`load`/`enabled`/`degraded`/`markDegraded`/`clearDegraded`) + the production execFile-based `fetch`.
- `scripts/bunq_read.py` — read-only helper (list accounts + payments → JSON). Read functions only.
- `scripts/bunq-setup.py` — one-time setup (API key → bunq context file, 0600).
- Tests: `test/bunq-store.test.ts`, `test/bunq-sync.test.ts`, `test/bunq-sense.test.ts`, `test/bunq-recall-exclusion.test.ts`.

**Modified files:**
- `src/store/db.ts` — `personal_transactions` table + `upsertPersonalTransaction` / `listPersonalTransactions`.
- `src/config.ts` — `bunqEnv`, `bunqPollSeconds`, `bunqBackfillDays`, `bunqContextPath`, `bunqHelperPath`, `bunqSetupPath`, `pythonBin`.
- `src/index.ts` — hoist + generalize `startWatcher`; construct `BunqSense`; register its watcher; add `bunq.degraded()` to the brief.
- `.gitignore` — ensure `data/bunq-context.*.conf` is ignored (likely covered by `data/`; confirm).

---

## Locked contracts (identical across tasks)

```ts
// src/senses/bunq/sync.ts
export interface BunqTxn {
  bunq_id: number;
  account_id: string;
  account_label: string;
  amount_cents: number;          // signed: negative = outgoing/spend, positive = incoming
  currency: string;
  description: string;
  counterparty: string | null;
  counterparty_iban: string | null;
  type: string | null;
  bunq_created: string;          // ISO-ish timestamp from bunq
}
export interface HelperOutput {
  accounts: Array<{ id: string; label: string; currency: string }>;
  transactions: BunqTxn[];
}
/** Given the per-account high-water cursor map, return fresh accounts + transactions. */
export type FetchTransactions = (sinceIdByAccount: Record<string, number>) => Promise<HelperOutput>;
```

**The Python helper's JSON contract is exactly `HelperOutput`.** The TS side depends only on that shape; the helper's SDK internals can change without touching TS.

---

## Task 1: `personal_transactions` table + Store methods

**Files:**
- Modify: `src/store/db.ts`
- Test: `test/bunq-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/bunq-store.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

const txn = {
  account_id: "acc1", account_label: "Main", bunq_id: 1001, amount_cents: -1299, currency: "EUR",
  description: "Spotify", counterparty: "Spotify AB", counterparty_iban: "NL00SPOT", type: "DIRECT_DEBIT",
  bunq_created: "2026-06-10T08:00:00.000Z",
};

describe("personal_transactions store", () => {
  it("inserts a transaction and reads it back", () => {
    const s = new Store(":memory:");
    expect(s.upsertPersonalTransaction(txn)).toBe(true); // inserted
    const rows = s.listPersonalTransactions("acc1");
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe(-1299);
    expect(rows[0].counterparty).toBe("Spotify AB");
  });
  it("dedupes by (account_id, bunq_id) — re-upsert is a no-op", () => {
    const s = new Store(":memory:");
    expect(s.upsertPersonalTransaction(txn)).toBe(true);
    expect(s.upsertPersonalTransaction(txn)).toBe(false); // already present
    expect(s.listPersonalTransactions().length).toBe(1);
  });
  it("same bunq_id under a different account is a distinct row", () => {
    const s = new Store(":memory:");
    s.upsertPersonalTransaction(txn);
    expect(s.upsertPersonalTransaction({ ...txn, account_id: "acc2", account_label: "Savings" })).toBe(true);
    expect(s.listPersonalTransactions().length).toBe(2);
    expect(s.listPersonalTransactions("acc2").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bunq-store.test.ts`
Expected: FAIL — `s.upsertPersonalTransaction is not a function`.

- [ ] **Step 3: Add the table to the `Store` constructor**

In `src/store/db.ts`, after the last `this.db.exec(...)` table block in the constructor, add:

```ts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personal_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        account_label TEXT NOT NULL,
        bunq_id INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        description TEXT NOT NULL,
        counterparty TEXT,
        counterparty_iban TEXT,
        type TEXT,
        bunq_created TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        UNIQUE(account_id, bunq_id)
      );
    `);
```

- [ ] **Step 4: Add an exported row type + the two methods**

Near the other exported row interfaces in `src/store/db.ts`:

```ts
export interface PersonalTransactionRow {
  id: number;
  account_id: string;
  account_label: string;
  bunq_id: number;
  amount_cents: number;
  currency: string;
  description: string;
  counterparty: string | null;
  counterparty_iban: string | null;
  type: string | null;
  bunq_created: string;
  synced_at: string;
}
```

Add to the `Store` class (before `close()`):

```ts
  // ---- personal transactions (bunq bank sense — read-only feed) ----

  /** Insert a bank transaction. Returns true iff a new row was inserted (false = already present). */
  upsertPersonalTransaction(t: {
    account_id: string; account_label: string; bunq_id: number; amount_cents: number;
    currency: string; description: string; counterparty: string | null;
    counterparty_iban: string | null; type: string | null; bunq_created: string;
  }): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO personal_transactions
           (account_id, account_label, bunq_id, amount_cents, currency, description,
            counterparty, counterparty_iban, type, bunq_created, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.account_id, t.account_label, t.bunq_id, t.amount_cents, t.currency, t.description,
        t.counterparty, t.counterparty_iban, t.type, t.bunq_created, new Date().toISOString(),
      );
    return res.changes > 0;
  }

  listPersonalTransactions(accountId?: string): PersonalTransactionRow[] {
    const rows = accountId
      ? this.db.prepare("SELECT * FROM personal_transactions WHERE account_id = ? ORDER BY bunq_created DESC, id DESC").all(accountId)
      : this.db.prepare("SELECT * FROM personal_transactions ORDER BY bunq_created DESC, id DESC").all();
    return rows as unknown as PersonalTransactionRow[];
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/bunq-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/store/db.ts test/bunq-store.test.ts
git commit -m "feat(bunq): personal_transactions table + Store upsert/list"
```

---

## Task 2: `BunqSync` (injectable fetch → map/dedupe/upsert/cursor)

**Files:**
- Create: `src/senses/bunq/sync.ts`
- Test: `test/bunq-sync.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/bunq-sync.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { BunqSync, type HelperOutput } from "../src/senses/bunq/sync.js";

function fixture(): HelperOutput {
  return {
    accounts: [{ id: "acc1", label: "Main", currency: "EUR" }],
    transactions: [
      { bunq_id: 1001, account_id: "acc1", account_label: "Main", amount_cents: -1299, currency: "EUR", description: "Spotify", counterparty: "Spotify AB", counterparty_iban: null, type: "DIRECT_DEBIT", bunq_created: "2026-06-10T08:00:00.000Z" },
      { bunq_id: 1002, account_id: "acc1", account_label: "Main", amount_cents: 250000, currency: "EUR", description: "Salary", counterparty: "ACME", counterparty_iban: null, type: "TRANSFER", bunq_created: "2026-06-11T08:00:00.000Z" },
    ],
  };
}

describe("BunqSync.poll", () => {
  it("upserts transactions and advances the per-account cursor to the max bunq_id", async () => {
    const s = new Store(":memory:");
    const sync = new BunqSync({ store: s, fetch: async () => fixture() });
    const res = await sync.poll();
    expect(res.inserted).toBe(2);
    expect(s.listPersonalTransactions("acc1").length).toBe(2);
    expect(s.kvGet("bunq:cursor:acc1")).toBe("1002");
  });
  it("passes the stored cursor back to fetch and is idempotent on replay", async () => {
    const s = new Store(":memory:");
    let sawSince: Record<string, number> = {};
    const sync = new BunqSync({ store: s, fetch: async (since) => { sawSince = since; return fixture(); } });
    await sync.poll();                 // first run: no cursor → since {}
    expect(sawSince).toEqual({});
    const res2 = await sync.poll();    // second run: cursor present, same fixture → 0 new
    expect(sawSince).toEqual({ acc1: 1002 });
    expect(res2.inserted).toBe(0);
    expect(s.listPersonalTransactions().length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bunq-sync.test.ts`
Expected: FAIL — cannot find module `sync.js`.

- [ ] **Step 3: Implement `src/senses/bunq/sync.ts`**

```ts
// src/senses/bunq/sync.ts
import type { Store } from "../../store/db.js";

export interface BunqTxn {
  bunq_id: number;
  account_id: string;
  account_label: string;
  amount_cents: number;
  currency: string;
  description: string;
  counterparty: string | null;
  counterparty_iban: string | null;
  type: string | null;
  bunq_created: string;
}
export interface HelperOutput {
  accounts: Array<{ id: string; label: string; currency: string }>;
  transactions: BunqTxn[];
}
export type FetchTransactions = (sinceIdByAccount: Record<string, number>) => Promise<HelperOutput>;

export interface BunqSyncDeps {
  store: Store;
  fetch: FetchTransactions;
  log?: (line: string) => void;
}

const CURSOR_PREFIX = "bunq:cursor:";

export class BunqSync {
  constructor(private deps: BunqSyncDeps) {}

  /** One sync pass: read cursors → fetch fresh txns → upsert → advance cursors. Idempotent. */
  async poll(): Promise<{ inserted: number }> {
    const { store } = this.deps;
    const accountsKnown = new Set(
      store.listPersonalTransactions().map((r) => r.account_id),
    );
    const since: Record<string, number> = {};
    for (const acc of accountsKnown) {
      const cur = store.kvGet(`${CURSOR_PREFIX}${acc}`);
      if (cur) since[acc] = Number(cur);
    }

    const out = await this.deps.fetch(since);

    const maxByAccount = new Map<string, number>();
    let inserted = 0;
    for (const t of out.transactions) {
      if (store.upsertPersonalTransaction(t)) inserted++;
      maxByAccount.set(t.account_id, Math.max(maxByAccount.get(t.account_id) ?? 0, t.bunq_id));
    }
    for (const [acc, max] of maxByAccount) {
      const prev = Number(store.kvGet(`${CURSOR_PREFIX}${acc}`) ?? 0);
      if (max > prev) store.kvSet(`${CURSOR_PREFIX}${acc}`, String(max));
    }
    this.deps.log?.(`bunq sync: +${inserted} transactions`);
    return { inserted };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/bunq-sync.test.ts`
Expected: PASS (2 tests).

> Note: the cursor for an account is only read once that account has at least one stored transaction. On the very first poll there are no stored rows, so `since` is `{}` and the helper applies its backfill window (Task 4). After the first poll, `accountsKnown` includes the account and the cursor is passed. This is exactly what the second test asserts.

- [ ] **Step 5: Commit**

```bash
git add src/senses/bunq/sync.ts test/bunq-sync.test.ts
git commit -m "feat(bunq): BunqSync — fixture-driven map/dedupe/upsert/cursor"
```

---

## Task 3: `BunqSense` (lifecycle + production fetch)

**Files:**
- Create: `src/senses/bunq/index.ts`
- Test: `test/bunq-sense.test.ts`

Reference: `src/senses/google/auth.ts` — `GoogleAccounts.load(path)` returns an instance with `enabled()`, `degraded(): Array<{name,reason}>`, `markDegraded(name,reason)`, `clearDegraded(name)`. Mirror that shape (single conceptual account named `"bunq"`). `src/voice/stt.ts` shows `const run = promisify(execFile); await run(bin, [args])`.

- [ ] **Step 1: Write the failing test**

```ts
// test/bunq-sense.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BunqSense } from "../src/senses/bunq/index.js";

function opts(contextPath: string) {
  return { contextPath, helperPath: "/x/bunq_read.py", env: "sandbox", backfillDays: 90, pythonBin: "python3" };
}

describe("BunqSense lifecycle", () => {
  it("is disabled when the context file is absent", () => {
    const sense = BunqSense.load(opts("/nope/missing.conf"));
    expect(sense.enabled()).toBe(false);
    expect(sense.degraded()[0].reason).toMatch(/bunq-setup/);
  });
  it("is enabled when a context file exists; degraded toggles", () => {
    const dir = mkdtempSync(join(tmpdir(), "bunq-"));
    const ctx = join(dir, "ctx.conf");
    writeFileSync(ctx, "{}");
    const sense = BunqSense.load(opts(ctx));
    expect(sense.enabled()).toBe(true);
    expect(sense.degraded()).toEqual([]);
    sense.markDegraded("re-auth needed");
    expect(sense.degraded()).toEqual([{ name: "bunq", reason: "re-auth needed" }]);
    sense.clearDegraded();
    expect(sense.degraded()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bunq-sense.test.ts`
Expected: FAIL — cannot find module `index.js`.

- [ ] **Step 3: Implement `src/senses/bunq/index.ts`**

```ts
// src/senses/bunq/index.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import type { FetchTransactions, HelperOutput } from "./sync.js";

const run = promisify(execFile);

export interface BunqSenseOpts {
  contextPath: string;
  helperPath: string;
  env: string;          // "sandbox" | "production"
  backfillDays: number;
  pythonBin: string;    // e.g. "python3"
}

/** Lifecycle + production fetch for the read-only bunq sense. Mirrors GoogleAccounts. */
export class BunqSense {
  private degradedReason: string | null = null;

  private constructor(private opts: BunqSenseOpts, private ready: boolean, private bootReason: string | null) {}

  static load(opts: BunqSenseOpts): BunqSense {
    if (!existsSync(opts.contextPath)) {
      return new BunqSense(opts, false, `no bunq context at ${opts.contextPath} — run: python3 scripts/bunq-setup.py`);
    }
    return new BunqSense(opts, true, null);
  }

  enabled(): boolean {
    return this.ready;
  }

  degraded(): Array<{ name: string; reason: string }> {
    if (!this.ready) return [{ name: "bunq", reason: this.bootReason ?? "disabled" }];
    return this.degradedReason ? [{ name: "bunq", reason: this.degradedReason }] : [];
  }

  markDegraded(reason: string): void {
    this.degradedReason = reason.slice(0, 120);
  }

  clearDegraded(): void {
    this.degradedReason = null;
  }

  /** Production fetch: spawn the read-only Python helper and parse its JSON. Read-only by construction. */
  fetch: FetchTransactions = async (sinceIdByAccount) => {
    const { stdout } = await run(this.opts.pythonBin, [
      this.opts.helperPath,
      "--env", this.opts.env,
      "--context", this.opts.contextPath,
      "--backfill-days", String(this.opts.backfillDays),
      "--since", JSON.stringify(sinceIdByAccount),
    ], { maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout) as HelperOutput;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/bunq-sense.test.ts`
Expected: PASS (2 tests). (The tests exercise lifecycle only — `fetch` is integration, covered by the sandbox e2e in Task 7.)

- [ ] **Step 5: Commit**

```bash
git add src/senses/bunq/index.ts test/bunq-sense.test.ts
git commit -m "feat(bunq): BunqSense lifecycle + execFile read-only fetch"
```

---

## Task 4: The read-only Python helper + setup script

**Files:**
- Create: `scripts/bunq_read.py`, `scripts/bunq-setup.py`

> **No CI unit test** — these scripts need `bunq_sdk` + a bunq context and are verified on the sandbox (Task 7). The TS side is already fully tested against the fixed JSON contract. **The code below is best-effort against `bunq_sdk`; the implementer MUST verify the exact SDK calls against the official docs (github.com/bunq/sdk_python, doc.bunq.com) and the sandbox, adjusting the SDK internals as needed while keeping the stdout JSON exactly equal to `HelperOutput`.**

- [ ] **Step 1: Create `scripts/bunq-setup.py` (one-time handshake → context file 0600)**

```python
#!/usr/bin/env python3
"""One-time bunq setup: API key -> persisted API context (mode 0600). READ-ONLY usage only."""
import argparse, os, sys
from bunq.sdk.context.api_context import ApiContext, ApiEnvironmentType
from bunq.sdk.context.bunq_context import BunqContext

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", choices=["sandbox", "production"], required=True)
    ap.add_argument("--context", required=True, help="path to write the context file")
    ap.add_argument("--api-key", required=True)
    args = ap.parse_args()
    env = ApiEnvironmentType.SANDBOX if args.env == "sandbox" else ApiEnvironmentType.PRODUCTION
    ctx = ApiContext.create(env, args.api_key, "AIOS read-only")
    ctx.save(args.context)
    os.chmod(args.context, 0o600)
    BunqContext.load_api_context(ApiContext.restore(args.context))  # sanity-check the saved context
    print(f"bunq context saved: {args.context} ({args.env})", file=sys.stderr)

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Create `scripts/bunq_read.py` (read functions ONLY → JSON to stdout)**

```python
#!/usr/bin/env python3
"""Read-only bunq fetcher: list monetary accounts + their payments, print HelperOutput JSON.
NO payment / draft-payment / write endpoint is called or imported here — read-only by construction."""
import argparse, json, sys
from bunq.sdk.context.api_context import ApiContext
from bunq.sdk.context.bunq_context import BunqContext
from bunq.sdk.model.generated.endpoint import MonetaryAccountBank, Payment

PAGE = 200

def to_cents(value: str) -> int:
    # bunq amount.value is a decimal string like "-12.99"
    neg = value.strip().startswith("-")
    digits = value.replace("-", "").split(".")
    euros = int(digits[0])
    cents = int((digits[1] + "00")[:2]) if len(digits) > 1 else 0
    total = euros * 100 + cents
    return -total if neg else total

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", required=True)
    ap.add_argument("--context", required=True)
    ap.add_argument("--backfill-days", type=int, default=90)
    ap.add_argument("--since", default="{}", help='JSON map account_id -> last bunq_id')
    args = ap.parse_args()
    since = json.loads(args.since)

    BunqContext.load_api_context(ApiContext.restore(args.context))

    accounts, transactions = [], []
    for acc in MonetaryAccountBank.list().value:
        if acc.status != "ACTIVE":
            continue
        acc_id = str(acc.id_)
        label = acc.description or f"account-{acc_id}"
        accounts.append({"id": acc_id, "label": label, "currency": acc.currency})
        params = {"count": str(PAGE)}
        newer = since.get(acc_id)
        if newer:
            params["newer_id"] = str(newer)
        # NOTE: verify Payment.list signature against the installed bunq_sdk version.
        for p in Payment.list(monetary_account_id=int(acc_id), params=params).value:
            cp = None; cp_iban = None
            try:
                lm = p.counterparty_alias.label_monetary_account
                cp = lm.display_name; cp_iban = lm.iban
            except Exception:
                pass
            transactions.append({
                "bunq_id": int(p.id_),
                "account_id": acc_id,
                "account_label": label,
                "amount_cents": to_cents(p.amount.value),
                "currency": p.amount.currency,
                "description": p.description or "",
                "counterparty": cp,
                "counterparty_iban": cp_iban,
                "type": getattr(p, "sub_type", None) or getattr(p, "type_", None),
                "bunq_created": p.created,
            })
    json.dump({"accounts": accounts, "transactions": transactions}, sys.stdout)

if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Make them executable + sanity-check syntax**

Run:
```bash
chmod +x scripts/bunq_read.py scripts/bunq-setup.py
python3 -c "import ast; ast.parse(open('scripts/bunq_read.py').read()); ast.parse(open('scripts/bunq-setup.py').read()); print('python syntax ok')"
```
Expected: `python syntax ok`.
(Do NOT run the scripts against bunq here — that's the sandbox step in Task 7, which requires a sandbox key + `pip install bunq_sdk`.)

- [ ] **Step 4: Add a one-line grep guard that no write endpoint is referenced (read-only invariant)**

Run:
```bash
grep -nE "RequestInquiry|DraftPayment|Payment\.create|\.create\(" scripts/bunq_read.py || echo "read-only: no payment/write endpoints referenced"
```
Expected: `read-only: no payment/write endpoints referenced`. (If anything matches, remove it — `bunq_read.py` must contain zero write/payment calls.)

- [ ] **Step 5: Commit**

```bash
git add scripts/bunq_read.py scripts/bunq-setup.py
git commit -m "feat(bunq): read-only python helper + one-time setup script"
```

---

## Task 5: Config

**Files:**
- Modify: `src/config.ts`
- Test: none (config wiring; covered by build + Task 6).

- [ ] **Step 1: Add fields to the `Config` interface**

```ts
  /** Bunq environment: "sandbox" | "production". */
  bunqEnv: string;
  bunqPollSeconds: number;
  bunqBackfillDays: number;
  /** Path to the persisted bunq API context (0600). */
  bunqContextPath: string;
  /** Read-only python helper + one-time setup script paths. */
  bunqHelperPath: string;
  bunqSetupPath: string;
  /** Python interpreter for the bunq helper. */
  pythonBin: string;
```

- [ ] **Step 2: Populate them in `loadConfig`'s returned object**

```ts
    bunqEnv: process.env.AIOS_BUNQ_ENV ?? "sandbox",
    bunqPollSeconds: Number(process.env.AIOS_BUNQ_POLL_SECONDS ?? 3600),
    bunqBackfillDays: Number(process.env.AIOS_BUNQ_BACKFILL_DAYS ?? 90),
    bunqContextPath: join(dataDir, `bunq-context.${process.env.AIOS_BUNQ_ENV ?? "sandbox"}.conf`),
    bunqHelperPath: join(root, "scripts", "bunq_read.py"),
    bunqSetupPath: join(root, "scripts", "bunq-setup.py"),
    pythonBin: process.env.AIOS_PYTHON_BIN ?? "python3",
```
(`dataDir`, `root`, and `join` are already in scope in `loadConfig` — confirm by reading the function; reuse them.)

- [ ] **Step 3: Build to verify**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "feat(bunq): config — env, poll, backfill, context + helper paths"
```

---

## Task 6: Daemon wiring (watcher + degraded surfacing)

**Files:**
- Modify: `src/index.ts`

Reference: READ `src/index.ts` around the "Watcher loops" block. `startWatcher(name, intervalMs, pollFn)` is currently defined **inside** `if (google.enabled())` and hardcodes `google.markDegraded`/`google.clearDegraded`. The brief gets `degraded: () => google.degraded()`.

- [ ] **Step 1: Hoist + generalize `startWatcher`**

Move the `BACKOFFS` const and `startWatcher` definition OUT of the `if (google.enabled())` block to just above it (so both google and bunq can use it), and parameterize the degraded callbacks. Replace the definition with:

```ts
  const BACKOFFS = [60_000, 300_000, 900_000];
  const startWatcher = (
    name: string,
    intervalMs: number,
    pollFn: () => Promise<void>,
    onFail: (reason: string) => void = () => {},
    onOk: () => void = () => {},
  ) => {
    let failures = 0;
    let timer: NodeJS.Timeout;
    const tick = async () => {
      try {
        await pollFn();
        failures = 0;
        onOk();
      } catch (err) {
        failures++;
        onFail((err as Error).message.slice(0, 120));
        log(`${name} poll failed (${failures}): ${(err as Error).message}`);
      }
      const delay = failures > 0 ? BACKOFFS[Math.min(failures - 1, BACKOFFS.length - 1)] : intervalMs;
      timer = setTimeout(() => void tick(), delay);
      timer.unref?.();
    };
    void tick();
    return () => clearTimeout(timer);
  };
```

Update the existing google watcher registrations to pass the callbacks (preserving today's behavior):
```ts
      stops.push(startWatcher(`gmail:${acc.name}`, config.gmailPollSeconds * 1000, () => gmailWatcher.poll(),
        (r) => google.markDegraded(acc.name, r), () => google.clearDegraded(acc.name)));
      stops.push(startWatcher(`gcal:${acc.name}`, config.calendarPollSeconds * 1000, () => calWatcher.poll(),
        (r) => google.markDegraded(acc.name, r), () => google.clearDegraded(acc.name)));
```
(The old `name.split(":")[1]` degraded logic is replaced by the explicit `acc.name` closures — same effect, clearer.)

- [ ] **Step 2: Construct the bunq sense + register its watcher**

Add the import:
```ts
import { BunqSense } from "./senses/bunq/index.js";
import { BunqSync } from "./senses/bunq/sync.js";
```
After `google` is loaded (near where `GoogleAccounts.load(...)` is called), add:
```ts
  const bunq = BunqSense.load({
    contextPath: config.bunqContextPath,
    helperPath: config.bunqHelperPath,
    env: config.bunqEnv,
    backfillDays: config.bunqBackfillDays,
    pythonBin: config.pythonBin,
  });
  if (bunq.enabled()) log(`bunq sense: enabled (${config.bunqEnv})`);
  else log(`bunq sense: disabled — ${bunq.degraded()[0]?.reason ?? "no context"}`);
```
In the watcher-registration area (after the google watchers, still using the now-hoisted `startWatcher`), add:
```ts
  if (bunq.enabled()) {
    const bunqSync = new BunqSync({ store, fetch: bunq.fetch, log });
    stops.push(startWatcher("bunq", config.bunqPollSeconds * 1000, () => bunqSync.poll().then(() => {}),
      (r) => bunq.markDegraded(r), () => bunq.clearDegraded()));
  }
```

- [ ] **Step 3: Add bunq degraded to the brief**

Change the `runBrief({ ..., degraded: () => google.degraded(), ... })` call in the `onAnchor` to:
```ts
        { store, bus, vault, narrate, send: sendVia, primary: config.primaryChat, degraded: () => [...google.degraded(), ...bunq.degraded()], log },
```

- [ ] **Step 4: Build + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests pass. With no bunq context present, `bunq.enabled()` is false → no watcher, behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(bunq): wire read-only bunq watcher + degraded surfacing"
```

---

## Task 7: Recall-exclusion invariant + sandbox verification

**Files:**
- Test: `test/bunq-recall-exclusion.test.ts`

- [ ] **Step 1: Write the recall-exclusion invariant test**

This pins the security invariant that bank data never enters the recall index. The recall index sources are vault files, events, and decisions (see `src/memory/indexer.ts`) — `personal_transactions` is none of those. The test seeds a transaction, runs the boot reconcile over an empty vault + store, and asserts recall finds nothing from the bank feed.

```ts
// test/bunq-recall-exclusion.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { reconcile } from "../src/memory/indexer.js";
import { recall } from "../src/memory/recall.js";

describe("bank data is excluded from recall", () => {
  it("a synced transaction is never indexed / recallable", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const store = new Store(":memory:");
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    store.upsertPersonalTransaction({
      account_id: "acc1", account_label: "Main", bunq_id: 1, amount_cents: -4200, currency: "EUR",
      description: "SecretPharmacyPurchase", counterparty: "Pharmacy", counterparty_iban: null, type: "CARD",
      bunq_created: "2026-06-10T08:00:00.000Z",
    });
    reconcile(store, vault); // boot indexing pass over vault + decisions + events
    expect(recall(store, "SecretPharmacyPurchase")).toEqual([]); // bank data not indexed
    expect(recall(store, "Pharmacy")).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test (it should PASS immediately — confirming the invariant holds by construction)**

Run: `npx vitest run test/bunq-recall-exclusion.test.ts`
Expected: PASS. If it FAILS, some code path is indexing `personal_transactions` — STOP and report it (the read-only sense must never feed recall).

- [ ] **Step 3: Full build + suite**

Run: `npm run build && npx vitest run`
Expected: build clean; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add test/bunq-recall-exclusion.test.ts
git commit -m "test(bunq): recall-exclusion invariant for bank data"
```

- [ ] **Step 5: Sandbox verification (manual, requires a bunq sandbox key — do with the user)**

This is the live gate before any production key. With the user:
```bash
pip install --upgrade bunq_sdk
# Generate a sandbox API key from the bunq developer portal, then:
python3 scripts/bunq-setup.py --env sandbox --context data/bunq-context.sandbox.conf --api-key <SANDBOX_KEY>
python3 scripts/bunq_read.py --env sandbox --context data/bunq-context.sandbox.conf --backfill-days 90 --since '{}'
```
Expected: the helper prints `HelperOutput`-shaped JSON (`{"accounts":[...],"transactions":[...]}`). Generate a sandbox payment in the bunq sandbox, re-run, and confirm it appears. Then start the daemon (`AIOS_BUNQ_ENV=sandbox`) and confirm `bunq sync: +N transactions` in the log and rows in `personal_transactions`. Only after sandbox is verified does the user run `bunq-setup.py --env production` with their real key.

> If the helper errors against the SDK (API call signature drift), fix `scripts/bunq_read.py` against the installed `bunq_sdk` version's docs — keep the stdout JSON exactly equal to `HelperOutput`; the TS side must not change.

- [ ] **Step 6: Finish the branch**

Use superpowers:finishing-a-development-branch. The sense ships disabled until a context exists, so merging is safe before the production key is ever generated.

---

## Self-Review notes (for the implementer)

- **Read-only is structural:** `scripts/bunq_read.py` contains only list/read endpoints; the grep guard (Task 4 Step 4) enforces no write/payment call; the Action Gate gains no bunq action; the TS daemon never imports a bunq library. There is no code path to move money.
- **Credential isolation:** context + key live only under `data/` at 0600 (setup `chmod 0o600`), gitignored, never logged/vaulted/agent-exposed. The key never enters the Node process.
- **Privacy:** `personal_transactions` is not a recall source (Task 7 pins it); the sense is surface-silent (no chat/brief content — only a degraded re-auth line, which carries no transaction data).
- **Zero-regression:** with no bunq context, `bunq.enabled()` is false → no watcher, no behavior change. The hoisted `startWatcher` preserves the google watchers' exact behavior via explicit degraded closures.
- **TS is deterministic, Python is contract-bound:** every TS unit test uses fixture JSON / the injectable `fetch`; the Python helper is verified only on the sandbox, and only its stdout JSON shape is load-bearing.
- **No new Node dependency; subscription auth unaffected** (the bunq key is unrelated to `CLAUDE_CODE_OAUTH_TOKEN`).
