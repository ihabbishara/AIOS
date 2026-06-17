# Money Pillar Pack (Personal CFO) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private personal-CFO pillar pack that reads the live bunq `personal_transactions` feed and adds categorization, subscription tracking, and budgets — surfaced via a private `@cfo` pack agent and proactive heartbeat alerts — analysis-only, with bank data never leaving SQLite.

**Architecture:** First extend the Phase 7 pack framework so a pack can declare its own MCP tool-server (the missing piece). Then build the money domain: 4 new `personal_*` tables, a hybrid learning categorizer (rules→defaults→Haiku→cache+learn, mirroring triage), pure money-ops functions, a thin `money` MCP server, a private `cfo` role, and a heartbeat money-signals watcher that pushes alerts straight to the private chat (never the vault/recall).

**Tech Stack:** TypeScript (NodeNext, `.js` specifiers), Node 23 `node:sqlite` (`DatabaseSync`), Claude Agent SDK (`tool`/`createSdkMcpServer`/`query`), Zod, vitest (`new Store(":memory:")` per test). Subscription auth only. Haiku (`config.triageModel`) for the categorizer.

**File structure:**
- Create: `src/money/categorize.ts` (built-in defaults + rule match + `makeCategorizer` + `categoryClassifier`), `src/money/ops.ts` (pure `spendingSummary`/`budgetStatus`/`detectRecurring`), `src/money/server.ts` (`buildMoneyServer`), `src/money/signals.ts` (`computeMoneySignals`), `playbooks/money/pack.yaml`.
- Modify: `src/packs/types.ts` (+`toolServer`), `src/packs/resolve.ts` (build/merge named server), `src/store/db.ts` (4 tables + CRUD), `src/agents/roles/index.ts` (+`cfo`, +`privateOnly` field), `src/agents/direct.ts` (group refusal + `primaryChat` dep), `src/config.ts` (money thresholds), `src/index.ts` (wire builder + signals watcher + DirectChats primaryChat).
- Tests: `test/pack-toolserver.test.ts`, `test/money-store.test.ts`, `test/money-categorize.test.ts`, `test/money-ops.test.ts`, `test/money-signals.test.ts`, `test/money-pack.test.ts`, `test/money-privacy.test.ts`, plus additions to `test/direct.test.ts` (or a new `test/cfo-role.test.ts`).

**Taxonomy (used across categorizer, ops, server):** `groceries, eating-out, transport, housing, utilities, subscriptions, shopping, health, entertainment, income, transfers, fees, other`.

---

## Stage 1 — Framework extension (pack-specific tool-servers)

Reusable by every future pack. Zero regression when `toolServer` is absent.

### Task 1: `toolServer` manifest field + builder registry + `resolvePack` merge

**Files:**
- Modify: `src/packs/types.ts:3-12` (schema)
- Modify: `src/packs/resolve.ts:19-65` (ResolveDeps + resolvePack + makeResolvePackFor)
- Test: `test/pack-toolserver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/pack-toolserver.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { resolvePack } from "../src/packs/resolve.js";
import { packSchema } from "../src/packs/types.js";

function deps(extra: Record<string, unknown> = {}) {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const gate = new ActionGate({ store, registry: new ExecutorRegistry(), policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
  return { store, vault: new VaultWriter("/tmp/aios-test-vault"), gate, origin: { channel: "web", chatId: "x" }, ...extra };
}
const base = { pillar: "money", persona: "p", memoDomain: "money" };

describe("pack-specific tool-server", () => {
  it("a pack with no toolServer resolves to only the shared aios-pack server (zero regression)", () => {
    const pack = packSchema.parse(base);
    const r = resolvePack(pack, deps());
    expect(Object.keys(r.mcpServers)).toEqual(["aios-pack"]);
  });

  it("a pack with toolServer pointing at a registered builder adds that named server", () => {
    const pack = packSchema.parse({ ...base, toolServer: "money" });
    const built: string[] = [];
    const r = resolvePack(pack, deps({ toolServers: { money: () => { built.push("money"); return { __server: "money" }; } } }));
    expect(Object.keys(r.mcpServers).sort()).toEqual(["aios-pack", "money"]);
    expect(built).toEqual(["money"]); // builder invoked once
  });

  it("an unknown toolServer is fail-soft: pack still loads with only the shared server", () => {
    const pack = packSchema.parse({ ...base, toolServer: "nope" });
    const r = resolvePack(pack, deps({ toolServers: {} }));
    expect(Object.keys(r.mcpServers)).toEqual(["aios-pack"]);
  });
});
```

> `VaultWriter`'s constructor arg is a root path — confirm its signature in `src/vault/writer.js` and adjust the `new VaultWriter(...)` line if it differs. The test never writes to the vault.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/pack-toolserver.test.ts`
Expected: FAIL — `toolServer` is stripped by the schema / `toolServers` unused.

- [ ] **Step 3: Add the schema field**

In `src/packs/types.ts`, add `toolServer` to `packSchema` (before the `.transform`):

```ts
export const packSchema = z.object({
  pillar: z.string().min(1),
  persona: z.string().min(1),
  memoDomain: z.string().min(1),
  vaultSection: z.string().optional(),
  /** Optional pack-specific MCP tool-server name (resolved from the builder registry). */
  toolServer: z.string().optional(),
  tools: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
  roles: z.array(z.string()).default([]),
  playbooks: z.array(z.string()).default([]),
}).transform((p) => ({ ...p, vaultSection: p.vaultSection ?? p.pillar }));
```

- [ ] **Step 4: Build/merge the named server in `resolve.ts`**

In `src/packs/resolve.ts`, add the builder type + a `toolServers` field to `ResolveDeps`, and branch in `resolvePack`. Replace the `ResolveDeps` interface and the tail of `resolvePack`:

```ts
/** Builds a pack-specific MCP server instance for a resolve. */
export type PackToolServerBuilder = (deps: {
  store: Store;
  vault: VaultWriter;
  gate: ActionGate;
  origin: { channel: string; chatId: string };
}) => unknown;

export interface ResolveDeps {
  store: Store;
  vault: VaultWriter;
  gate: ActionGate;
  origin: { channel: string; chatId: string };
  /** Registry of pack-specific tool-server builders, keyed by manifest `toolServer`. */
  toolServers?: Record<string, PackToolServerBuilder>;
}
```

In `resolvePack`, replace the final `return` so it conditionally adds the named server:

```ts
  const mcpServers: Record<string, unknown> = { [SERVER_NAME]: server };
  if (pack.toolServer) {
    const builder = deps.toolServers?.[pack.toolServer];
    if (builder) {
      mcpServers[pack.toolServer] = builder({ store: deps.store, vault: deps.vault, gate: deps.gate, origin: deps.origin });
    }
    // unknown toolServer → fail-soft: omit it; the pack still loads with the shared server.
  }

  return { pillar: pack.pillar, contextBlock, tools, mcpServers };
```

Thread `toolServers` through `makeResolvePackFor` — change its `deps` param type and the `resolvePack` call:

```ts
export function makeResolvePackFor(
  reg: PackResolverReg,
  deps: { store: Store; vault: VaultWriter; gate: ActionGate; toolServers?: Record<string, PackToolServerBuilder> },
) {
  return (key: string, origin: { channel: string; chatId: string }, byRole = false): ResolvedPack | undefined => {
    const pillar = byRole ? reg.roleOf.get(key) : reg.pillarOf.get(key);
    if (!pillar) return undefined;
    const pack = reg.packs.get(pillar);
    return pack
      ? resolvePack(pack, { store: deps.store, vault: deps.vault, gate: deps.gate, origin, toolServers: deps.toolServers })
      : undefined;
  };
}
```

- [ ] **Step 5: Run to verify it passes + full suite**

Run: `npx vitest run test/pack-toolserver.test.ts` → 3 pass.
Run: `npx vitest run` → green (existing pack tests still pass — `toolServers` is optional, no `toolServer` in any current pack).
Run: `npm run build` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/packs/types.ts src/packs/resolve.ts test/pack-toolserver.test.ts
git commit -m "feat(packs): pack-specific tool-server support (toolServer + builder registry)"
```

---

## Stage 2 — Money data + categorization + server (reactive core)

### Task 2: `personal_*` tables + Store CRUD

**Files:**
- Modify: `src/store/db.ts` (Row interfaces near the other `*Row`; `CREATE TABLE`s in the constructor next to `personal_transactions` ~`:234`; methods near `upsertPersonalTransaction` ~`:711`)
- Test: `test/money-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/money-store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";

describe("money store", () => {
  it("category rules upsert on pattern", () => {
    const s = new Store(":memory:");
    s.upsertCategoryRule("albert heijn", "groceries", "user");
    s.upsertCategoryRule("albert heijn", "shopping", "llm");
    expect(s.listCategoryRules()).toHaveLength(1);
    expect(s.listCategoryRules()[0]).toMatchObject({ pattern: "albert heijn", category: "shopping", source: "llm" });
  });

  it("tx-category cache upserts on (account_id, bunq_id)", () => {
    const s = new Store(":memory:");
    s.setTxCategory("acc1", 100, "groceries", "rule");
    s.setTxCategory("acc1", 100, "eating-out", "llm");
    expect(s.getTxCategory("acc1", 100)).toMatchObject({ category: "eating-out", source: "llm" });
    expect(s.getTxCategory("acc1", 999)).toBeUndefined();
  });

  it("subscriptions add + status transitions", () => {
    const s = new Store(":memory:");
    const id = s.addSubscription({ name: "Spotify", counterparty: "Spotify AB", amount_cents: 1099, currency: "EUR", cadence: "monthly", next_renewal: "2026-07-01", status: "detected", source: "auto" });
    expect(s.listSubscriptions("detected")).toHaveLength(1);
    s.setSubscriptionStatus(id, "confirmed");
    expect(s.listSubscriptions("confirmed")[0].name).toBe("Spotify");
    expect(s.listSubscriptions("detected")).toHaveLength(0);
  });

  it("budgets upsert per category", () => {
    const s = new Store(":memory:");
    s.setBudget("groceries", 40000, "EUR");
    s.setBudget("groceries", 35000, "EUR");
    expect(s.listBudgets()).toHaveLength(1);
    expect(s.listBudgets()[0].limit_cents).toBe(35000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/money-store.test.ts`
Expected: FAIL — `store.upsertCategoryRule is not a function`.

- [ ] **Step 3: Add Row interfaces** (in `src/store/db.ts`, near the other `*Row` interfaces):

```ts
export interface CategoryRuleRow { id: number; pattern: string; category: string; source: "user" | "llm"; created_at: string; }
export interface TxCategoryRow { account_id: string; bunq_id: number; category: string; source: "rule" | "default" | "llm"; created_at: string; }
export interface SubscriptionRow {
  id: number; name: string; counterparty: string | null; amount_cents: number; currency: string;
  cadence: "monthly" | "yearly" | "weekly"; next_renewal: string | null;
  status: "detected" | "confirmed" | "dismissed"; source: "auto" | "manual"; created_at: string;
}
export interface BudgetRow { category: string; limit_cents: number; currency: string; created_at: string; }
```

- [ ] **Step 4: Add the tables** (in the `Store` constructor, next to the `personal_transactions` block):

```ts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personal_category_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern TEXT NOT NULL, category TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(pattern)
      );
      CREATE TABLE IF NOT EXISTS personal_tx_category (
        account_id TEXT NOT NULL, bunq_id INTEGER NOT NULL, category TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(account_id, bunq_id)
      );
      CREATE TABLE IF NOT EXISTS personal_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, counterparty TEXT, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL,
        cadence TEXT NOT NULL, next_renewal TEXT, status TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_budgets (
        category TEXT NOT NULL, limit_cents INTEGER NOT NULL, currency TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(category)
      );
    `);
```

- [ ] **Step 5: Add the methods** (near `upsertPersonalTransaction`):

```ts
  // ---- money pack (personal CFO) ----
  upsertCategoryRule(pattern: string, category: string, source: "user" | "llm"): void {
    this.db.prepare(
      `INSERT INTO personal_category_rules (pattern, category, source, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(pattern) DO UPDATE SET category=excluded.category, source=excluded.source, created_at=excluded.created_at`,
    ).run(pattern, category, source, new Date().toISOString());
  }
  listCategoryRules(): CategoryRuleRow[] {
    return this.db.prepare("SELECT * FROM personal_category_rules ORDER BY id").all() as unknown as CategoryRuleRow[];
  }
  setTxCategory(accountId: string, bunqId: number, category: string, source: "rule" | "default" | "llm"): void {
    this.db.prepare(
      `INSERT INTO personal_tx_category (account_id, bunq_id, category, source, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, bunq_id) DO UPDATE SET category=excluded.category, source=excluded.source, created_at=excluded.created_at`,
    ).run(accountId, bunqId, category, source, new Date().toISOString());
  }
  getTxCategory(accountId: string, bunqId: number): TxCategoryRow | undefined {
    return this.db.prepare("SELECT * FROM personal_tx_category WHERE account_id = ? AND bunq_id = ?").get(accountId, bunqId) as TxCategoryRow | undefined;
  }
  addSubscription(s: { name: string; counterparty: string | null; amount_cents: number; currency: string; cadence: SubscriptionRow["cadence"]; next_renewal: string | null; status: SubscriptionRow["status"]; source: SubscriptionRow["source"] }): number {
    const res = this.db.prepare(
      `INSERT INTO personal_subscriptions (name, counterparty, amount_cents, currency, cadence, next_renewal, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.name, s.counterparty, s.amount_cents, s.currency, s.cadence, s.next_renewal, s.status, s.source, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }
  listSubscriptions(status?: SubscriptionRow["status"]): SubscriptionRow[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM personal_subscriptions WHERE status = ? ORDER BY id").all(status)
      : this.db.prepare("SELECT * FROM personal_subscriptions ORDER BY id").all();
    return rows as unknown as SubscriptionRow[];
  }
  setSubscriptionStatus(id: number, status: SubscriptionRow["status"]): void {
    this.db.prepare("UPDATE personal_subscriptions SET status = ? WHERE id = ?").run(status, id);
  }
  setBudget(category: string, limitCents: number, currency: string): void {
    this.db.prepare(
      `INSERT INTO personal_budgets (category, limit_cents, currency, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(category) DO UPDATE SET limit_cents=excluded.limit_cents, currency=excluded.currency, created_at=excluded.created_at`,
    ).run(category, limitCents, currency, new Date().toISOString());
  }
  listBudgets(): BudgetRow[] {
    return this.db.prepare("SELECT * FROM personal_budgets ORDER BY category").all() as unknown as BudgetRow[];
  }
```

- [ ] **Step 6: Run + commit**

Run: `npx vitest run test/money-store.test.ts` → 4 pass. `npx vitest run` → green. `npm run build` → clean.

```bash
git add src/store/db.ts test/money-store.test.ts
git commit -m "feat(money): personal_* tables (category rules/cache, subscriptions, budgets) + Store CRUD"
```

---

### Task 3: Categorization service (hybrid, learning)

**Files:**
- Create: `src/money/categorize.ts`
- Test: `test/money-categorize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/money-categorize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { CATEGORIES, normalize, matchRuleCategory, defaultCategory, makeCategorizer } from "../src/money/categorize.js";

const tx = (over = {}) => ({ account_id: "acc1", bunq_id: 1, amount_cents: -1099, description: "card payment", counterparty: "Albert Heijn 1234", ...over });

describe("categorize helpers", () => {
  it("taxonomy is the fixed set incl. 'other'", () => {
    expect(CATEGORIES).toContain("groceries");
    expect(CATEGORIES).toContain("other");
  });
  it("default merchant map hits known NL merchants", () => {
    expect(defaultCategory(normalize("Albert Heijn 1234"), normalize("card"))).toBe("groceries");
    expect(defaultCategory(normalize("NS Reizigers"), normalize("ov"))).toBe("transport");
    expect(defaultCategory(normalize("Some Random Shop"), normalize("x"))).toBeUndefined();
  });
  it("rule match is normalized contains", () => {
    expect(matchRuleCategory([{ pattern: "albert heijn", category: "groceries" }], "ALBERT HEIJN 1234", "card")).toBe("groceries");
  });
});

describe("makeCategorizer ordering", () => {
  it("cache short-circuits (no rule/default/llm consulted)", async () => {
    const s = new Store(":memory:");
    s.setTxCategory("acc1", 1, "entertainment", "llm");
    let llmCalls = 0;
    const cat = makeCategorizer(s, async () => { llmCalls++; return "other"; });
    expect(await cat(tx())).toBe("entertainment");
    expect(llmCalls).toBe(0);
  });
  it("DB rule beats default and is cached as 'rule'", async () => {
    const s = new Store(":memory:");
    s.upsertCategoryRule("albert heijn", "shopping", "user"); // override the default 'groceries'
    const cat = makeCategorizer(s, async () => "other");
    expect(await cat(tx())).toBe("shopping");
    expect(s.getTxCategory("acc1", 1)).toMatchObject({ category: "shopping", source: "rule" });
  });
  it("default beats LLM and is cached as 'default'", async () => {
    const s = new Store(":memory:");
    let llmCalls = 0;
    const cat = makeCategorizer(s, async () => { llmCalls++; return "other"; });
    expect(await cat(tx())).toBe("groceries"); // Albert Heijn default
    expect(llmCalls).toBe(0);
    expect(s.getTxCategory("acc1", 1)!.source).toBe("default");
  });
  it("unknown merchant → LLM, then cached + learned as a rule", async () => {
    const s = new Store(":memory:");
    const cat = makeCategorizer(s, async () => "health");
    expect(await cat(tx({ counterparty: "Apotheek Zuid", description: "pharmacy" }))).toBe("health");
    expect(s.getTxCategory("acc1", 1)).toMatchObject({ category: "health", source: "llm" });
    expect(s.listCategoryRules().some((r) => r.category === "health" && r.source === "llm")).toBe(true); // learned
  });
  it("LLM failure → 'other', not cached (so it retries later)", async () => {
    const s = new Store(":memory:");
    const cat = makeCategorizer(s, async () => { throw new Error("llm down"); });
    expect(await cat(tx({ counterparty: "Unknownco", description: "x" }))).toBe("other");
    expect(s.getTxCategory("acc1", 1)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/money-categorize.test.ts` → module not found.

- [ ] **Step 3: Implement** — create `src/money/categorize.ts`:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "../store/db.js";

export const CATEGORIES = [
  "groceries", "eating-out", "transport", "housing", "utilities", "subscriptions",
  "shopping", "health", "entertainment", "income", "transfers", "fees", "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface TxLike {
  account_id: string; bunq_id: number; amount_cents: number; description: string; counterparty: string | null;
}

export function normalize(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Seeded NL merchant patterns → category. Code-level, no LLM. */
const DEFAULTS: Array<[string, Category]> = [
  ["albert heijn", "groceries"], ["jumbo", "groceries"], ["lidl", "groceries"], ["aldi", "groceries"], ["dirk", "groceries"],
  ["ns ", "transport"], ["ns reizigers", "transport"], ["ov-chipkaart", "transport"], ["ov-chip", "transport"], ["uber", "transport"], ["shell", "transport"],
  ["vattenfall", "utilities"], ["eneco", "utilities"], ["greenchoice", "utilities"], ["ziggo", "utilities"], ["kpn", "utilities"], ["vodafone", "utilities"],
  ["netflix", "subscriptions"], ["spotify", "subscriptions"], ["disney", "subscriptions"], ["youtube", "subscriptions"], ["icloud", "subscriptions"], ["apple.com/bill", "subscriptions"],
  ["apotheek", "health"], ["pharmacy", "health"],
  ["bol.com", "shopping"], ["amazon", "shopping"], ["zalando", "shopping"], ["coolblue", "shopping"],
];

export function defaultCategory(normCounterparty: string, normDesc: string): Category | undefined {
  const hay = `${normCounterparty} ${normDesc}`;
  for (const [needle, cat] of DEFAULTS) if (hay.includes(needle)) return cat;
  return undefined;
}

export function matchRuleCategory(rules: Array<{ pattern: string; category: string }>, counterparty: string, description: string): Category | undefined {
  const hay = `${normalize(counterparty)} ${normalize(description)}`;
  const hit = rules.find((r) => hay.includes(normalize(r.pattern)));
  return hit ? (hit.category as Category) : undefined;
}

/** A short pattern to learn for a transaction's merchant (the counterparty, normalized). */
function learnPattern(tx: TxLike): string | undefined {
  const c = normalize(tx.counterparty);
  return c.length >= 3 ? c : undefined;
}

/**
 * Hybrid categorizer: cache → DB rule → built-in default → LLM (then cache + learn a rule).
 * Fail-safe: LLM failure returns "other" and does NOT cache (so it retries on a later call).
 * `classify` is injected (the real one is `categoryClassifier`); tests pass a stub.
 */
export function makeCategorizer(
  store: Store,
  classify: (tx: TxLike) => Promise<Category>,
): (tx: TxLike) => Promise<Category> {
  return async (tx) => {
    const cached = store.getTxCategory(tx.account_id, tx.bunq_id);
    if (cached) return cached.category as Category;

    const ruleCat = matchRuleCategory(store.listCategoryRules(), tx.counterparty ?? "", tx.description);
    if (ruleCat) { store.setTxCategory(tx.account_id, tx.bunq_id, ruleCat, "rule"); return ruleCat; }

    const def = defaultCategory(normalize(tx.counterparty), normalize(tx.description));
    if (def) { store.setTxCategory(tx.account_id, tx.bunq_id, def, "default"); return def; }

    let cat: Category;
    try {
      cat = await classify(tx);
    } catch {
      return "other"; // degrade, never throw, never cache a failure
    }
    if (!CATEGORIES.includes(cat)) cat = "other";
    store.setTxCategory(tx.account_id, tx.bunq_id, cat, "llm");
    const pattern = learnPattern(tx);
    if (pattern) store.upsertCategoryRule(pattern, cat, "llm"); // learn → next identical merchant is a rule hit
    return cat;
  };
}

/** The real one-shot LLM classifier (Haiku via config.triageModel). Minimal data: counterparty + description + direction. */
export function categoryClassifier(model: string): (tx: TxLike) => Promise<Category> {
  return async (tx) => {
    const direction = tx.amount_cents < 0 ? "outgoing" : "incoming";
    const q = query({
      prompt: `Counterparty: ${tx.counterparty ?? "(none)"}\nDescription: ${tx.description}\nDirection: ${direction}\n\nWhich category?`,
      options: {
        systemPrompt: `You categorize a personal bank transaction into exactly one category: ${CATEGORIES.join(", ")}. Incoming money is usually "income" or "transfers". Reply with the category only.`,
        allowedTools: [], maxTurns: 1, settingSources: [], persistSession: false, model,
        outputFormat: { type: "json_schema" as const, schema: {
          type: "object", properties: { category: { enum: [...CATEGORIES] } }, required: ["category"], additionalProperties: false,
        } },
      },
    });
    for await (const msg of q) {
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          const c = (msg.structured_output as { category?: string } | undefined)?.category;
          if (c && (CATEGORIES as readonly string[]).includes(c)) return c as Category;
        }
        break;
      }
    }
    return "other";
  };
}
```

- [ ] **Step 4: Run + commit**

Run: `npx vitest run test/money-categorize.test.ts` → all pass. `npx vitest run` green. `npm run build` clean.

```bash
git add src/money/categorize.ts test/money-categorize.test.ts
git commit -m "feat(money): hybrid learning categorizer (cache → rule → default → Haiku → learn)"
```

---

### Task 4: Money ops (pure) — spending summary, budget status, recurring detection

**Files:**
- Create: `src/money/ops.ts`
- Test: `test/money-ops.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/money-ops.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { makeCategorizer } from "../src/money/categorize.js";
import { spendingSummary, budgetStatus, detectRecurring } from "../src/money/ops.js";

function seed(s: Store) {
  const base = { account_label: "Main", currency: "EUR", counterparty_iban: null, type: "CARD", account_id: "acc1" };
  const rows = [
    { bunq_id: 1, amount_cents: -2000, description: "x", counterparty: "Albert Heijn", bunq_created: "2026-06-03T10:00:00.000Z" },
    { bunq_id: 2, amount_cents: -3000, description: "x", counterparty: "Jumbo", bunq_created: "2026-06-10T10:00:00.000Z" },
    { bunq_id: 3, amount_cents: -1099, description: "x", counterparty: "Spotify AB", bunq_created: "2026-06-05T10:00:00.000Z" },
    { bunq_id: 4, amount_cents: 250000, description: "salary", counterparty: "Employer", bunq_created: "2026-06-01T10:00:00.000Z" },
  ];
  for (const r of rows) s.upsertPersonalTransaction({ ...base, ...r });
}

describe("money ops", () => {
  it("spendingSummary totals outgoing by category for a month", async () => {
    const s = new Store(":memory:"); seed(s);
    const cat = makeCategorizer(s, async () => "other");
    const sum = await spendingSummary(s, cat, "2026-06");
    expect(sum.byCategory.groceries).toBe(5000);       // AH 2000 + Jumbo 3000
    expect(sum.byCategory.subscriptions).toBe(1099);   // Spotify default
    expect(sum.byCategory.income).toBeUndefined();     // incoming excluded from spend
    expect(sum.totalOut).toBe(6099);
  });
  it("budgetStatus compares month-to-date actuals vs limit", async () => {
    const s = new Store(":memory:"); seed(s);
    s.setBudget("groceries", 4000, "EUR");
    const cat = makeCategorizer(s, async () => "other");
    const status = await budgetStatus(s, cat, "2026-06");
    const g = status.find((b) => b.category === "groceries")!;
    expect(g.spent_cents).toBe(5000);
    expect(g.limit_cents).toBe(4000);
    expect(g.over).toBe(true);
  });
  it("detectRecurring finds ≥3 same-amount same-counterparty outgoing charges", () => {
    const s = new Store(":memory:");
    const base = { account_label: "Main", currency: "EUR", counterparty_iban: null, type: "DIRECT_DEBIT", account_id: "acc1", description: "sub" };
    ["2026-04-05", "2026-05-05", "2026-06-05"].forEach((d, i) =>
      s.upsertPersonalTransaction({ ...base, bunq_id: 10 + i, amount_cents: -1099, counterparty: "Spotify AB", bunq_created: `${d}T10:00:00.000Z` }));
    const cands = detectRecurring(s.listPersonalTransactions());
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ counterparty: "Spotify AB", amount_cents: -1099, cadence: "monthly", count: 3 });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/money-ops.test.ts` → module not found.

- [ ] **Step 3: Implement** — create `src/money/ops.ts`:

```ts
import type { Store, PersonalTransactionRow } from "../store/db.js";
import type { Category, TxLike } from "./categorize.js";

const month = (iso: string) => iso.slice(0, 7); // "2026-06"

/** Spend by category for a month (outgoing only; amounts in positive cents). */
export async function spendingSummary(
  store: Store, categorize: (tx: TxLike) => Promise<Category>, ym: string,
): Promise<{ byCategory: Partial<Record<Category, number>>; totalOut: number }> {
  const byCategory: Partial<Record<Category, number>> = {};
  let totalOut = 0;
  for (const t of store.listPersonalTransactions()) {
    if (month(t.bunq_created) !== ym) continue;
    if (t.amount_cents >= 0) continue; // outgoing only
    const cat = await categorize(t);
    const amt = Math.abs(t.amount_cents);
    byCategory[cat] = (byCategory[cat] ?? 0) + amt;
    totalOut += amt;
  }
  return { byCategory, totalOut };
}

export interface BudgetLine { category: string; spent_cents: number; limit_cents: number; currency: string; over: boolean; }

export async function budgetStatus(
  store: Store, categorize: (tx: TxLike) => Promise<Category>, ym: string,
): Promise<BudgetLine[]> {
  const { byCategory } = await spendingSummary(store, categorize, ym);
  return store.listBudgets().map((b) => {
    const spent = byCategory[b.category as Category] ?? 0;
    return { category: b.category, spent_cents: spent, limit_cents: b.limit_cents, currency: b.currency, over: spent >= b.limit_cents };
  });
}

export interface RecurringCandidate { counterparty: string; amount_cents: number; currency: string; cadence: "monthly"; count: number; lastSeen: string; }

/** ≥3 outgoing charges, same counterparty + exact amount, spread across ≥2 distinct months → a monthly candidate. */
export function detectRecurring(txns: PersonalTransactionRow[]): RecurringCandidate[] {
  const groups = new Map<string, PersonalTransactionRow[]>();
  for (const t of txns) {
    if (t.amount_cents >= 0 || !t.counterparty) continue;
    const key = `${t.counterparty}\x00${t.amount_cents}\x00${t.currency}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }
  const out: RecurringCandidate[] = [];
  for (const [key, ts] of groups) {
    if (ts.length < 3) continue;
    const months = new Set(ts.map((t) => month(t.bunq_created)));
    if (months.size < 2) continue;
    const [counterparty, amount, currency] = key.split("\x00");
    const lastSeen = ts.map((t) => t.bunq_created).sort().at(-1)!;
    out.push({ counterparty, amount_cents: Number(amount), currency, cadence: "monthly", count: ts.length, lastSeen });
  }
  return out;
}
```

- [ ] **Step 4: Run + commit**

Run: `npx vitest run test/money-ops.test.ts` → pass. `npx vitest run` green. `npm run build` clean.

```bash
git add src/money/ops.ts test/money-ops.test.ts
git commit -m "feat(money): pure ops — spendingSummary, budgetStatus, detectRecurring"
```

---

### Task 5: The `money` MCP server (thin tool wrappers)

**Files:**
- Create: `src/money/server.ts`
- Test: `test/money-pack.test.ts` (resolves the money pack with the money server — wired in Task 7; here just build-verify the server compiles via a smoke import)

This task has no unit test for the SDK tools themselves (they wrap the already-tested ops/store, mirroring how `FinanceAgent` tools are not unit-tested). Verification is build + the Task 7 pack-resolve test.

- [ ] **Step 1: Implement** — create `src/money/server.ts`:

```ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store/db.js";
import { CATEGORIES, type Category, type TxLike } from "./categorize.js";
import { spendingSummary, budgetStatus } from "./ops.js";

function text(s: string) { return { content: [{ type: "text" as const, text: s }] }; }
const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const thisMonth = () => new Date().toISOString().slice(0, 7);

export interface MoneyServerDeps {
  store: Store;
  categorize: (tx: TxLike) => Promise<Category>;
}

/** Direct-CRUD MCP server for the personal CFO. Analysis-only — no gate, no outward effects. */
export function buildMoneyServer(deps: MoneyServerDeps) {
  const { store, categorize } = deps;

  const summary = tool(
    "spending_summary", "Totals your spending by category for a month (YYYY-MM; omit for current).",
    { month: z.string().regex(/^\d{4}-\d{2}$/).optional() },
    async (a) => {
      const ym = a.month ?? thisMonth();
      const s = await spendingSummary(store, categorize, ym);
      const lines = Object.entries(s.byCategory).sort((x, y) => y[1]! - x[1]!).map(([c, v]) => `  ${c}: ${eur(v!)}`);
      return text(`Spending ${ym} (total ${eur(s.totalOut)}):\n${lines.join("\n") || "  (no spending)"}`);
    },
  );

  const listTx = tool(
    "list_transactions", "List recent transactions, optionally filtered by month/category/account.",
    { month: z.string().regex(/^\d{4}-\d{2}$/).optional(), category: z.enum(CATEGORIES).optional(), account: z.string().optional(), limit: z.number().int().positive().max(100).default(20) },
    async (a) => {
      let rows = store.listPersonalTransactions(a.account);
      if (a.month) rows = rows.filter((r) => r.bunq_created.slice(0, 7) === a.month);
      const out: string[] = [];
      for (const r of rows) {
        if (out.length >= a.limit) break;
        if (a.category) { if (r.amount_cents >= 0 || (await categorize(r)) !== a.category) continue; }
        out.push(`  ${r.bunq_created.slice(0, 10)} ${eur(r.amount_cents)} ${r.counterparty ?? r.description}`);
      }
      return text(out.join("\n") || "(no matching transactions)");
    },
  );

  const listSubs = tool(
    "list_subscriptions", "List subscriptions by status (detected/confirmed/dismissed; omit for all).",
    { status: z.enum(["detected", "confirmed", "dismissed"]).optional() },
    async (a) => {
      const rows = store.listSubscriptions(a.status);
      return text(rows.map((r) => `  #${r.id} ${r.name} ${eur(r.amount_cents)}/${r.cadence} [${r.status}]${r.next_renewal ? ` next ${r.next_renewal}` : ""}`).join("\n") || "(none)");
    },
  );
  const confirmSub = tool("confirm_subscription", "Confirm a detected subscription by id.", { id: z.number().int() },
    async (a) => { store.setSubscriptionStatus(a.id, "confirmed"); return text(`Subscription #${a.id} confirmed.`); });
  const dismissSub = tool("dismiss_subscription", "Dismiss a detected subscription (not a real subscription) by id.", { id: z.number().int() },
    async (a) => { store.setSubscriptionStatus(a.id, "dismissed"); return text(`Subscription #${a.id} dismissed.`); });
  const addSub = tool(
    "add_subscription", "Manually add a subscription.",
    { name: z.string(), amount: z.number().positive(), currency: z.string().default("EUR"), cadence: z.enum(["monthly", "yearly", "weekly"]) },
    async (a) => {
      const id = store.addSubscription({ name: a.name, counterparty: null, amount_cents: Math.round(a.amount * 100), currency: a.currency.toUpperCase(), cadence: a.cadence, next_renewal: null, status: "confirmed", source: "manual" });
      return text(`Added subscription #${id}: ${a.name}.`);
    },
  );

  const setBudget = tool(
    "set_budget", "Set a monthly budget for a category.",
    { category: z.enum(CATEGORIES), limit: z.number().positive(), currency: z.string().default("EUR") },
    async (a) => { store.setBudget(a.category, Math.round(a.limit * 100), a.currency.toUpperCase()); return text(`Budget set: ${a.category} ${eur(Math.round(a.limit * 100))}/month.`); },
  );
  const listBudgetsTool = tool("list_budgets", "List the monthly budgets.", {},
    async () => text(store.listBudgets().map((b) => `  ${b.category}: ${eur(b.limit_cents)}/month`).join("\n") || "(no budgets)"));
  const budgetStatusTool = tool(
    "budget_status", "Show month-to-date spending vs each budget (YYYY-MM; omit for current).",
    { month: z.string().regex(/^\d{4}-\d{2}$/).optional() },
    async (a) => {
      const lines = (await budgetStatus(store, categorize, a.month ?? thisMonth()))
        .map((b) => `  ${b.category}: ${eur(b.spent_cents)} / ${eur(b.limit_cents)}${b.over ? " ⚠ OVER" : ""}`);
      return text(lines.join("\n") || "(no budgets set)");
    },
  );

  const setRule = tool(
    "set_category_rule", "Teach a categorization rule (counterparty substring → category).",
    { pattern: z.string(), category: z.enum(CATEGORIES) },
    async (a) => { store.upsertCategoryRule(a.pattern.toLowerCase().trim(), a.category, "user"); return text(`Rule saved: "${a.pattern}" → ${a.category}.`); },
  );

  return createSdkMcpServer({
    name: "money", version: "0.1.0",
    tools: [summary, listTx, listSubs, confirmSub, dismissSub, addSub, setBudget, listBudgetsTool, budgetStatusTool, setRule],
  });
}
```

- [ ] **Step 2: Build-verify** — `npm run build` → clean (confirms the SDK `tool`/`createSdkMcpServer` shapes + enum usage compile).

- [ ] **Step 3: Commit**

```bash
git add src/money/server.ts
git commit -m "feat(money): money MCP server (direct-CRUD tools, analysis-only)"
```

---

### Task 6: `cfo` role + `privateOnly` + group-refusal in DirectChats

**Files:**
- Modify: `src/agents/roles/index.ts` (add `privateOnly?` to `RoleDef`; add `cfo` role)
- Modify: `src/agents/direct.ts` (refuse non-private origins; add `primaryChat` dep)
- Test: `test/cfo-role.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cfo-role.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { roles } from "../src/agents/roles/index.js";
import { parseDirectAddress } from "../src/agents/direct.js";
import { isPrivateOrigin } from "../src/agents/direct.js";

describe("cfo role", () => {
  it("cfo is registered and @cfo is addressable", () => {
    expect(roles.cfo).toBeDefined();
    expect(roles.cfo.privateOnly).toBe(true);
    expect(parseDirectAddress("@cfo how much did I spend?")).toMatchObject({ role: "cfo", text: "how much did I spend?" });
  });
  it("isPrivateOrigin matches only the configured primary chat", () => {
    const primary = { channel: "telegram", chatId: "123" };
    expect(isPrivateOrigin(primary, "telegram", "123")).toBe(true);
    expect(isPrivateOrigin(primary, "telegram", "999")).toBe(false);
    expect(isPrivateOrigin(undefined, "telegram", "123")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/cfo-role.test.ts` → `roles.cfo` undefined / `isPrivateOrigin` not exported.

- [ ] **Step 3: Add `privateOnly` to `RoleDef` + the `cfo` role**

In `src/agents/roles/index.ts`, add to the `RoleDef` interface (after `toolCheckFallback`):

```ts
  /** When true, this role is refused from any origin other than the configured primary (private) chat. */
  privateOnly?: boolean;
```

Add the `cfo` key to the `roles` registry (before the closing `};`):

```ts
  cfo: {
    name: "cfo",
    description: "Private personal CFO — your bank transactions, subscriptions, and budgets.",
    systemPrompt:
      "You are the user's private personal CFO. You have read-only visibility into their personal bank " +
      "transactions (via the money tools) plus their subscriptions and budgets. You NEVER initiate or " +
      "suggest payments or transfers — banking is strictly read-only. You discuss finances ONLY with the " +
      "user in private; if anyone else is present or you are addressed from a shared/group context, refuse " +
      "and say money topics are private. Be concise and concrete: amounts, categories, trends. Use " +
      "set_category_rule when the user corrects a categorization so you learn it.",
    allowedTools: [],
    permissionMode: "dontAsk",
    privateOnly: true,
    maxTurns: 20,
  },
```

- [ ] **Step 4: Add `isPrivateOrigin` + the refusal guard in `direct.ts`**

In `src/agents/direct.ts`, add the exported helper and a `primaryChat` field to `DirectChatsDeps`:

```ts
export function isPrivateOrigin(primary: { channel: string; chatId: string } | undefined, channel: string, chatId: string): boolean {
  return !!primary && primary.channel === channel && primary.chatId === chatId;
}
```

Add to `DirectChatsDeps`:

```ts
  /** The private primary chat — privateOnly roles are refused from any other origin. */
  primaryChat?: { channel: string; chatId: string };
```

At the very top of `handle(role, channel, chatId, userText)` (right after `const def = roles[role]; if (!def) throw ...`):

```ts
    if (def.privateOnly && !isPrivateOrigin(this.deps.primaryChat, channel, chatId)) {
      return "That's private — ask me from your private chat.";
    }
```

- [ ] **Step 5: Wire `primaryChat` into DirectChats** in `src/index.ts` (the `new DirectChats({...})` deps object, ~`:179-186`): add `primaryChat: config.primaryChat,`.

- [ ] **Step 6: Run + build + commit**

Run: `npx vitest run test/cfo-role.test.ts` → pass. `npx vitest run` green. `npm run build` clean.

```bash
git add src/agents/roles/index.ts src/agents/direct.ts src/index.ts test/cfo-role.test.ts
git commit -m "feat(money): private cfo role + privateOnly group-refusal in DirectChats"
```

---

### Task 7: Wire the money server builder + `playbooks/money/pack.yaml` (reactive core end-to-end)

**Files:**
- Create: `playbooks/money/pack.yaml`
- Modify: `src/index.ts` (build categorizer + pass `toolServers` into `makeResolvePackFor`)
- Test: `test/money-pack.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/money-pack.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { resolvePack } from "../src/packs/resolve.js";
import { packSchema } from "../src/packs/types.js";
import { buildMoneyServer } from "../src/money/server.js";
import { makeCategorizer } from "../src/money/categorize.js";

describe("money pack resolves with the money server", () => {
  it("a money manifest (toolServer: money) yields both aios-pack and money servers + fq tools", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const gate = new ActionGate({ store, registry: new ExecutorRegistry(), policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
    const categorize = makeCategorizer(store, async () => "other");
    const pack = packSchema.parse({
      pillar: "money", persona: "CFO", memoDomain: "money", toolServer: "money", roles: ["cfo"],
      tools: ["mcp__money__spending_summary", "recall", "vault_read"],
    });
    const r = resolvePack(pack, {
      store, vault: new VaultWriter("/tmp/aios-test-vault"), gate, origin: { channel: "telegram", chatId: "1" },
      toolServers: { money: (d) => buildMoneyServer({ store: d.store, categorize }) },
    });
    expect(Object.keys(r.mcpServers).sort()).toEqual(["aios-pack", "money"]);
    expect(r.tools).toContain("mcp__money__spending_summary");      // already fq → passes through
    expect(r.tools).toContain("mcp__aios-pack__recall");            // shared tool rewritten
  });
});
```

- [ ] **Step 2: Run to verify it fails** — passes only once the builder is supplied (it already would, given Task 1). Run it: `npx vitest run test/money-pack.test.ts`. If green already, that's fine — it's the integration guard. If `buildMoneyServer` import fails, ensure Task 5 landed.

- [ ] **Step 3: Create `playbooks/money/pack.yaml`**

```yaml
pillar: money
persona: |
  You are the user's private personal CFO. Read-only visibility into their bank transactions, plus
  their subscriptions and budgets. Never initiate or suggest payments. Money topics are private — refuse
  in any shared context. Be concise: amounts, categories, trends.
memoDomain: money
toolServer: money
roles: [cfo]
actions: []
tools:
  - mcp__money__spending_summary
  - mcp__money__list_transactions
  - mcp__money__list_subscriptions
  - mcp__money__confirm_subscription
  - mcp__money__dismiss_subscription
  - mcp__money__add_subscription
  - mcp__money__set_budget
  - mcp__money__list_budgets
  - mcp__money__budget_status
  - mcp__money__set_category_rule
  - recall
  - vault_read
playbooks: []
```

- [ ] **Step 4: Wire the builder in `src/index.ts`**

Near where `resolvePackFor` is built (`index.ts:133-134`), construct the categorizer once and pass the `toolServers` registry:

```ts
  const categorize = makeCategorizer(store, categoryClassifier(config.triageModel));
  const resolvePackFor = makeResolvePackFor(
    { packs, pillarOf, roleOf },
    { store, vault, gate, toolServers: { money: (d) => buildMoneyServer({ store: d.store, categorize }) } },
  );
```

Add imports at the top of `src/index.ts`:

```ts
import { makeCategorizer, categoryClassifier } from "./money/categorize.js";
import { buildMoneyServer } from "./money/server.js";
```

- [ ] **Step 5: Run + build + manual check**

Run: `npx vitest run test/money-pack.test.ts` → pass. `npx vitest run` green. `npm run build` clean.
Manual (after deploy, optional): the daemon boot log shows `packs: money`; DM `@cfo spending_summary` privately returns a category breakdown of your real bunq data.

- [ ] **Step 6: Commit**

```bash
git add playbooks/money/pack.yaml src/index.ts test/money-pack.test.ts
git commit -m "feat(money): wire money server builder + money pack manifest (reactive core live)"
```

---

## Stage 3 — Proactive heartbeat signals

### Task 8: `computeMoneySignals` (pure) + dedup-stamp keys

**Files:**
- Create: `src/money/signals.ts`
- Modify: `src/config.ts` (thresholds)
- Test: `test/money-signals.test.ts`

- [ ] **Step 1: Add config thresholds** in `src/config.ts` (add fields to the config interface + the built object):

Interface fields:
```ts
  moneyPollSeconds: number;
  moneyLargeTxCents: number;
  moneyRenewalDays: number;
```
Built values (near the other `process.env` reads):
```ts
    moneyPollSeconds: Number(process.env.AIOS_MONEY_POLL_SECONDS ?? 86400),
    moneyLargeTxCents: Number(process.env.AIOS_MONEY_LARGE_TX_CENTS ?? 50000),
    moneyRenewalDays: Number(process.env.AIOS_MONEY_RENEWAL_DAYS ?? 3),
```

- [ ] **Step 2: Write the failing test**

Create `test/money-signals.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { makeCategorizer } from "../src/money/categorize.js";
import { computeMoneySignals } from "../src/money/signals.js";

const cfg = { moneyLargeTxCents: 50000, moneyRenewalDays: 3 };
function txn(s: Store, over = {}) {
  s.upsertPersonalTransaction({ account_id: "acc1", account_label: "Main", bunq_id: 1, amount_cents: -1000, currency: "EUR", description: "x", counterparty: "Shop", counterparty_iban: null, type: "CARD", bunq_created: "2026-06-17T10:00:00.000Z", ...over });
}

describe("computeMoneySignals", () => {
  it("fires a large-transaction signal once (dedup by stamp)", async () => {
    const s = new Store(":memory:"); txn(s, { bunq_id: 7, amount_cents: -80000 });
    const cat = makeCategorizer(s, async () => "other");
    const now = new Date("2026-06-17T12:00:00.000Z");
    const first = await computeMoneySignals(s, cat, now, cfg);
    expect(first.some((sig) => sig.key.startsWith("money:largetx:") && /large/i.test(sig.text))).toBe(true);
    // stamp the emitted keys, then recompute → no repeat
    for (const sig of first) s.kvSet(sig.key, now.toISOString());
    const second = await computeMoneySignals(s, cat, now, cfg);
    expect(second.find((sig) => sig.key.startsWith("money:largetx:"))).toBeUndefined();
  });

  it("fires a renewal signal for a confirmed sub due within N days", async () => {
    const s = new Store(":memory:");
    s.addSubscription({ name: "Spotify", counterparty: "Spotify AB", amount_cents: 1099, currency: "EUR", cadence: "monthly", next_renewal: "2026-06-18", status: "confirmed", source: "auto" });
    const cat = makeCategorizer(s, async () => "other");
    const sigs = await computeMoneySignals(s, cat, new Date("2026-06-17T12:00:00.000Z"), cfg);
    expect(sigs.some((sig) => /renew/i.test(sig.text) && sig.text.includes("Spotify"))).toBe(true);
  });

  it("fires a budget-overrun signal and a new-recurring candidate", async () => {
    const s = new Store(":memory:");
    s.setBudget("groceries", 1500, "EUR");
    ["2026-06-01", "2026-06-08", "2026-06-15"].forEach((d, i) =>
      s.upsertPersonalTransaction({ account_id: "acc1", account_label: "M", bunq_id: 20 + i, amount_cents: -1099, currency: "EUR", description: "sub", counterparty: "Netflix", counterparty_iban: null, type: "DIRECT_DEBIT", bunq_created: `${d}T10:00:00.000Z` }));
    const cat = makeCategorizer(s, async () => "groceries"); // force grocery spend over the 15.00 budget
    const sigs = await computeMoneySignals(s, cat, new Date("2026-06-17T12:00:00.000Z"), cfg);
    expect(sigs.some((sig) => /budget/i.test(sig.text))).toBe(true);
    // new-recurring detected Netflix → a detected subscription row was created
    expect(s.listSubscriptions("detected").some((x) => x.counterparty === "Netflix")).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails** — module not found.

- [ ] **Step 4: Implement** — create `src/money/signals.ts`:

```ts
import type { Store } from "../store/db.js";
import type { Category, TxLike } from "./categorize.js";
import { budgetStatus, detectRecurring } from "./ops.js";

export interface MoneySignal { key: string; text: string }
export interface MoneySignalConfig { moneyLargeTxCents: number; moneyRenewalDays: number }
const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
const ym = (d: Date) => d.toISOString().slice(0, 7);
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Compute proactive money signals (NOT yet delivered). The caller checks each `key` against kv to
 * fire once, sends `text` to the private chat, then stamps the key. Side effect: newly-detected
 * recurring charges are inserted as `status='detected'` subscriptions (idempotent — skipped if a row
 * for that counterparty+amount already exists).
 */
export async function computeMoneySignals(
  store: Store, categorize: (tx: TxLike) => Promise<Category>, now: Date, cfg: MoneySignalConfig,
): Promise<MoneySignal[]> {
  const out: MoneySignal[] = [];

  // Budget overruns (this month).
  for (const b of await budgetStatus(store, categorize, ym(now))) {
    if (b.over) out.push({ key: `money:budget:${b.category}:${ym(now)}`, text: `💸 Budget alert: ${b.category} ${eur(b.spent_cents)} of ${eur(b.limit_cents)} this month — over.` });
  }

  // Upcoming renewals (confirmed subs within N days).
  const horizon = new Date(now.getTime() + cfg.moneyRenewalDays * 86400_000);
  for (const sub of store.listSubscriptions("confirmed")) {
    if (!sub.next_renewal) continue;
    const r = new Date(`${sub.next_renewal}T00:00:00.000Z`);
    if (r >= now && r <= horizon) out.push({ key: `money:renewal:${sub.id}:${sub.next_renewal}`, text: `🔁 ${sub.name} renews ${sub.next_renewal} (${eur(sub.amount_cents)}).` });
  }

  // New recurring charges → detected subscription + a confirm prompt (skip ones already tracked).
  const known = new Set(store.listSubscriptions().map((s) => `${s.counterparty}\x00${s.amount_cents}`));
  for (const c of detectRecurring(store.listPersonalTransactions())) {
    const sig = `${c.counterparty}\x00${c.amount_cents}`;
    if (known.has(sig)) continue;
    store.addSubscription({ name: c.counterparty, counterparty: c.counterparty, amount_cents: Math.abs(c.amount_cents), currency: c.currency, cadence: "monthly", next_renewal: null, status: "detected", source: "auto" });
    known.add(sig);
    out.push({ key: `money:recurring:${sig}`, text: `🔎 Looks like a subscription: ${c.counterparty} ${eur(Math.abs(c.amount_cents))}/month (seen ${c.count}×). Confirm with @cfo if it is one.` });
  }

  // Unusually large debits this month.
  for (const t of store.listPersonalTransactions()) {
    if (t.bunq_created.slice(0, 7) !== ym(now)) continue;
    if (t.amount_cents < 0 && Math.abs(t.amount_cents) >= cfg.moneyLargeTxCents) {
      out.push({ key: `money:largetx:${t.account_id}:${t.bunq_id}`, text: `⚠️ Large transaction ${day(new Date(t.bunq_created))}: ${eur(Math.abs(t.amount_cents))} to ${t.counterparty ?? t.description}.` });
    }
  }

  return out;
}
```

- [ ] **Step 5: Run + build + commit**

Run: `npx vitest run test/money-signals.test.ts` → pass. `npx vitest run` green. `npm run build` clean.

```bash
git add src/money/signals.ts src/config.ts test/money-signals.test.ts
git commit -m "feat(money): proactive money signals (budget/renewal/recurring/large-tx)"
```

---

### Task 9: Wire the money-signals watcher (private push, dedup) + privacy test

**Files:**
- Modify: `src/index.ts` (a `startWatcher("money", …)` that computes signals, fires-once via kv, pushes via `sendVia` to `config.primaryChat`)
- Test: `test/money-privacy.test.ts`

- [ ] **Step 1: Write the privacy test (load-bearing)**

Create `test/money-privacy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { reconcile } from "../src/memory/indexer.js";
import { recall } from "../src/memory/recall.js";
import { makeCategorizer } from "../src/money/categorize.js";
import { spendingSummary } from "../src/money/ops.js";

describe("money privacy — bank data never reaches recall", () => {
  it("after categorize/summary/signals, recall finds no transaction counterparties/descriptions", async () => {
    const store = new Store(":memory:");
    const vault = new VaultWriter("/tmp/aios-money-privacy-vault");
    store.upsertPersonalTransaction({ account_id: "acc1", account_label: "Main", bunq_id: 1, amount_cents: -4200, currency: "EUR", description: "SecretClinicVisit", counterparty: "PrivateClinicXYZ", counterparty_iban: null, type: "CARD", bunq_created: "2026-06-10T08:00:00.000Z" });
    const cat = makeCategorizer(store, async () => "health");
    await spendingSummary(store, cat, "2026-06"); // exercises categorize → personal_tx_category

    reconcile(store, vault); // the boot indexing pass over vault + decisions + events
    expect(recall(store, "PrivateClinicXYZ")).toEqual([]);
    expect(recall(store, "SecretClinicVisit")).toEqual([]);
  });
});
```

> `recall`/`reconcile` signatures match `test/bunq-recall-exclusion.test.ts` — mirror that test's exact imports/calls (read it first). The assertion (recall returns `[]` for bank strings) is the load-bearing part.

- [ ] **Step 2: Run to verify it passes** (it should — nothing writes money data to the vault). Run: `npx vitest run test/money-privacy.test.ts`. If `recall` returns hits, STOP — something is leaking money data into the index; investigate before proceeding.

- [ ] **Step 3: Wire the watcher in `src/index.ts`**

Where the other watchers are started (`startWatcher(...)`, ~`:407-426`), add a money-signals watcher that computes, fires-once via kv, and pushes to the private chat. `categorize`, `store`, `sendVia`, `config`, `log` are all in scope:

```ts
  if (config.primaryChat) {
    stops.push(startWatcher("money", config.moneyPollSeconds * 1000, async () => {
      const signals = await computeMoneySignals(store, categorize, new Date(), config);
      for (const sig of signals) {
        if (store.kvGet(sig.key)) continue;               // fire once
        await sendVia(config.primaryChat!.channel, config.primaryChat!.chatId, sig.text);
        store.kvSet(sig.key, new Date().toISOString());   // stamp AFTER send
      }
    }, () => {}, () => {}));
  }
```

Add the import: `import { computeMoneySignals } from "./money/signals.js";`

> Confirm the exact `startWatcher(name, intervalMs, pollFn, onFail, onOk)` signature in `src/index.ts:380-405` and match the arg order. The push is plain text (no agent turn, never a vault write) — the privacy invariant.

- [ ] **Step 4: Full verification**

Run: `npm run build` → clean.
Run: `npx vitest run` → full suite green (all new money tests + zero regression).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/money-privacy.test.ts
git commit -m "feat(money): heartbeat money-signals watcher (private push, fire-once) + privacy test"
```

---

## Self-Review

**Spec coverage:**
- §1 Framework extension (toolServer + builder registry + resolvePack merge, fail-soft) → Task 1. ✅
- §2 Data (4 tables, immutable feed) → Task 2. ✅
- §3 Privacy (SQLite-only, no vault, recall-excluded) → Task 9 test + the design keeps all money writes in `personal_*` and pushes plain text only. ✅
- §3 Categorization (hybrid, learning, taxonomy, fail→other) → Task 3. ✅
- §4 Money server (direct-CRUD, analysis-only, inherits recall/vault_read) → Tasks 5, 7. ✅
- §5 Proactive signals (budget/renewal/recurring/large-tx, private push, fire-once) → Tasks 8, 9. ✅
- §6 Surface (cfo role, pack.yaml, group-refusal) → Tasks 6, 7. ✅
- Error handling (LLM fail→other, unknown toolServer fail-soft, signal errors swallowed by startWatcher's onFail, empty data→empty results) → Tasks 1, 3, 9. ✅
- Testing list (framework ext, store CRUD, categorization ordering, subscription detection, budgets, signals fire-once, privacy recall-exclusion, group refusal) → Tasks 1-9. ✅
- Build stages (framework ext → reactive core → proactive) → Stages 1/2/3. ✅

**Placeholder scan:** No TBD/"add error handling"/"similar to Task N". Two explicit "confirm the signature" notes (VaultWriter ctor, startWatcher arg order) are verification instructions, not placeholders — each gives the expected shape. Every code step has real code.

**Type consistency:** `Category`/`CATEGORIES`/`TxLike` (categorize.ts) used identically in ops.ts, server.ts, signals.ts; `makeCategorizer(store, classify)` returns `(tx) => Promise<Category>` consumed everywhere; Store methods (`upsertCategoryRule`/`listCategoryRules`/`setTxCategory`/`getTxCategory`/`addSubscription`/`listSubscriptions`/`setSubscriptionStatus`/`setBudget`/`listBudgets`) named identically across tasks; `MoneySignal{key,text}` consumed by the Task 9 watcher exactly as produced; `toolServers`/`PackToolServerBuilder`/`buildMoneyServer({store,categorize})` consistent across Tasks 1, 5, 7. ✅

**Note (carry into execution):** the Task 9 privacy test must mirror `test/bunq-recall-exclusion.test.ts`'s exact `recall`/`reconcile` imports/calls (the implementer reads that file first). The two "confirm the signature" notes (VaultWriter constructor, `startWatcher` arg order) are deliberate verification steps — the surrounding code shows the expected shape.
