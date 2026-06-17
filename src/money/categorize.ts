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

/** Seeded NL merchant patterns → category. Code-level, no LLM. (No pharmacy entries — those exercise the LLM path.) */
const DEFAULTS: Array<[string, Category]> = [
  ["albert heijn", "groceries"], ["jumbo", "groceries"], ["lidl", "groceries"], ["aldi", "groceries"], ["dirk", "groceries"],
  ["ns ", "transport"], ["ns reizigers", "transport"], ["ov-chipkaart", "transport"], ["ov-chip", "transport"], ["uber", "transport"], ["shell", "transport"],
  ["vattenfall", "utilities"], ["eneco", "utilities"], ["greenchoice", "utilities"], ["ziggo", "utilities"], ["kpn", "utilities"], ["vodafone", "utilities"],
  ["netflix", "subscriptions"], ["spotify", "subscriptions"], ["disney", "subscriptions"], ["youtube", "subscriptions"], ["icloud", "subscriptions"], ["apple.com/bill", "subscriptions"],
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
