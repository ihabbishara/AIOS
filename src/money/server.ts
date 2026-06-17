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
    { month: z.string().regex(/^\d{4}-\d{2}$/).optional(), category: z.enum(CATEGORIES as unknown as [string, ...string[]]).optional(), account: z.string().optional(), limit: z.number().int().positive().max(100).default(20) },
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
    { category: z.enum(CATEGORIES as unknown as [string, ...string[]]), limit: z.number().positive(), currency: z.string().default("EUR") },
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
    { pattern: z.string(), category: z.enum(CATEGORIES as unknown as [string, ...string[]]) },
    async (a) => { store.upsertCategoryRule(a.pattern.toLowerCase().trim(), a.category, "user"); return text(`Rule saved: "${a.pattern}" → ${a.category}.`); },
  );

  return createSdkMcpServer({
    name: "money", version: "0.1.0",
    tools: [summary, listTx, listSubs, confirmSub, dismissSub, addSub, setBudget, listBudgetsTool, budgetStatusTool, setRule],
  });
}
