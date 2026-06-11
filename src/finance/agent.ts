import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resumableTurn } from "../agents/resumable.js";
import { computeSettlement, renderSettlement, toCents, formatCents } from "./ledger.js";
import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";

const FINANCE_TOOLS = [
  "mcp__finance__add_expense",
  "mcp__finance__remove_expense",
  "mcp__finance__list_expenses",
  "mcp__finance__settle",
];

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function financePrompt(company: string, members: string[]): string {
  return `You are the Finance assistant for ${company}, living inside the team's group chat. \
You handle FINANCIAL MATTERS ONLY: recording invoices and expenses, answering who-paid-what, \
and running the monthly settlement. For anything non-financial, politely decline in one short \
sentence and steer back to finances.

Team members sharing costs equally (${members.length}): ${members.join(", ")}.

## How you work
- When someone reports an expense ("paid 40 for the domain", an invoice, a receipt), record it with \
add_expense. Infer the payer from how they introduce themselves or who they say paid — ask if unclear. \
Confirm each recorded entry back with its id, amount, and description.
- Amounts default to EUR unless stated otherwise.
- Use list_expenses to answer questions about what was spent; never recall amounts from memory — \
the ledger is the source of truth.
- For month-end (or whenever asked), use settle — it computes totals, the equal ${members.length}-way \
split, balances, and who pays whom. The math is done by the tool; report its output faithfully.
- To correct mistakes: remove_expense with the id, then re-add.
- Keep replies short and group-chat friendly. Confirmations one line; settlements as the tool renders them.

## Boundaries
- Never invent or estimate amounts. No entry in the ledger = it doesn't exist.
- You cannot move money — you record and calculate only.`;
}

export interface FinanceAgentDeps {
  store: Store;
  vault: VaultWriter;
  company: string;
  members: string[];
  model?: string;
  log?: (line: string) => void;
}

/** Ledger-backed finance assistant bound to specific group chats. */
export class FinanceAgent {
  private locks = new Map<string, Promise<void>>();

  constructor(private deps: FinanceAgentDeps) {}

  private buildServer(ledger: string) {
    const { store, vault, members, company } = this.deps;

    const addExpense = tool(
      "add_expense",
      "Record an expense/invoice in the ledger. Returns the entry id.",
      {
        payer: z.string().describe(`Who paid — one of: ${members.join(", ")}`),
        amount: z.number().positive().describe("Amount in major units, e.g. 42.50"),
        currency: z.string().default("EUR"),
        description: z.string().describe("What it was for"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe("YYYY-MM-DD; omit for today"),
      },
      async (a) => {
        const date = a.date ?? new Date().toISOString().slice(0, 10);
        const cents = toCents(a.amount);
        const id = store.addExpense({
          ledger,
          payer: a.payer.trim(),
          amountCents: cents,
          currency: a.currency.toUpperCase(),
          description: a.description,
          date,
        });
        vault.appendDaily(
          `${company} expense #${id}: ${a.payer} paid ${formatCents(cents, a.currency.toUpperCase())} — ${a.description}`,
        );
        return text(`Recorded #${id}: ${a.payer} paid ${formatCents(cents, a.currency.toUpperCase())} for "${a.description}" on ${date}.`);
      },
    );

    const removeExpense = tool(
      "remove_expense",
      "Delete a wrongly recorded expense by id.",
      { id: z.number().int() },
      async (a) =>
        text(store.deleteExpense(ledger, a.id) ? `Removed expense #${a.id}.` : `No expense #${a.id} in this ledger.`),
    );

    const listExpenses = tool(
      "list_expenses",
      "List recorded expenses, optionally for one month (YYYY-MM). The ledger is the source of truth.",
      { month: z.string().regex(/^\d{4}-\d{2}$/).optional() },
      async (a) => {
        const rows = store.listExpenses(ledger, a.month);
        if (!rows.length) return text(a.month ? `No expenses recorded for ${a.month}.` : "Ledger is empty.");
        const lines = rows.map(
          (r) => `#${r.id} ${r.date} ${r.payer}: ${formatCents(r.amount_cents, r.currency)} — ${r.description}`,
        );
        const total = rows.reduce((s, r) => s + r.amount_cents, 0);
        return text(`${lines.join("\n")}\n\nTotal: ${formatCents(total, rows[0].currency)} (${rows.length} entries)`);
      },
    );

    const settle = tool(
      "settle",
      `Compute the month's settlement: total, equal ${members.length}-way split, balances, and who pays whom. All math is exact (integer cents).`,
      { month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM; omit for current month") },
      async (a) => {
        const month = a.month ?? currentMonth();
        const rows = store.listExpenses(ledger, month);
        if (!rows.length) return text(`No expenses recorded for ${month} — nothing to settle.`);
        const settlement = computeSettlement(
          rows.map((r) => ({
            id: r.id,
            payer: r.payer,
            amountCents: r.amount_cents,
            currency: r.currency,
            description: r.description,
            date: r.date,
          })),
          members,
          month,
        );
        const report = renderSettlement(settlement);
        vault.writeNote(`finance/${company.toLowerCase()}/settlement-${month}.md`, `${report}\n`);
        return text(report);
      },
    );

    return createSdkMcpServer({
      name: "finance",
      version: "0.1.0",
      tools: [addExpense, removeExpense, listExpenses, settle],
    });
  }

  async handle(channel: string, chatId: string, userText: string): Promise<string> {
    const chatKey = `${channel}:${chatId}`;
    const prev = this.locks.get(chatKey) ?? Promise.resolve();
    let release!: () => void;
    this.locks.set(chatKey, new Promise((r) => (release = r)));
    await prev;
    try {
      return await resumableTurn({
        store: this.deps.store,
        sessionKey: `finance-session:${chatKey}`,
        prompt: userText,
        log: this.deps.log,
        options: {
          systemPrompt: financePrompt(this.deps.company, this.deps.members),
          mcpServers: { finance: this.buildServer(chatKey) },
          allowedTools: FINANCE_TOOLS,
          permissionMode: "dontAsk",
          settingSources: [],
          strictMcpConfig: true,
          maxTurns: 20,
          ...(this.deps.model ? { model: this.deps.model } : {}),
        },
      });
    } finally {
      release();
    }
  }
}
