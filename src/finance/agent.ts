import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resumableTurn } from "../agents/resumable.js";
import { computeSettlement, renderSettlement, toCents, formatCents } from "./ledger.js";
import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { FinanceMember } from "../config.js";
import type { InboundMessage } from "../channels/types.js";
import { guardOptions } from "../agents/guards/index.js";

const FINANCE_TOOLS = [
  "mcp__finance__add_expense",
  "mcp__finance__remove_expense",
  "mcp__finance__list_expenses",
  "mcp__finance__settle",
  "mcp__finance__export_csv",
  "mcp__finance__send_receipt",
  "Read",
];

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function financePrompt(company: string, members: FinanceMember[]): string {
  const roster = members
    .map((m) => (m.handle ? `${m.name} (@${m.handle})` : m.name))
    .join(", ");
  return `You are the Finance assistant for ${company}, living inside the team's group chat. \
You handle FINANCIAL MATTERS ONLY: recording invoices and expenses, answering who-paid-what, \
and running the monthly settlement. For anything non-financial, politely decline in one short \
sentence and steer back to finances.

Team members sharing costs equally (${members.length}): ${roster}.

## How you work
- Every user message is prefixed with "[from: Name (@username)]" — the actual sender. \
When someone reports their own expense ("paid 40 for the domain"), match the sender to a team member \
by @username or name and record THEM as the payer. If they name someone else as payer, use that person. \
If the sender matches no member and no payer is named, ask who paid.
- Record expenses with add_expense. Confirm each recorded entry back with its id, amount, payer, and description.
- INVOICES/RECEIPTS AS FILES: when a message carries "[attached file stored at: <path>]", Read that file \
(PDFs and images both work), extract vendor, amount, currency, and date, then record the expense with \
receipt_path set to that stored path. State what you extracted so the team can correct you. If the file \
is unreadable or amounts are ambiguous, ask instead of guessing.
- Amounts default to EUR unless stated otherwise.
- Use list_expenses to answer questions about what was spent; never recall amounts from memory — \
the ledger is the source of truth.
- For month-end (or whenever asked), use settle — it computes totals, the equal ${members.length}-way \
split, balances, and who pays whom. The math is done by the tool; report its output faithfully.
- To correct mistakes: remove_expense with the id, then re-add.
- When someone asks for a report, export, overview, or spreadsheet, use export_csv — it sends a CSV \
file directly into the chat.
- A 📎 in listings means a receipt is archived in the vault — it is NOT attached to your reply. \
To actually share it in the chat, call send_receipt with the expense id. Never say "attached" \
unless you called send_receipt or export_csv in this turn.
- Keep replies short and group-chat friendly. Confirmations one line; settlements as the tool renders them.
- NEVER use markdown tables — they are unreadable on phones. Use the compact one-line-per-entry \
format the tools return, or bullets.

## Boundaries
- Never invent or estimate amounts. No entry in the ledger = it doesn't exist.
- You cannot move money — you record and calculate only.`;
}

export interface FinanceAgentDeps {
  store: Store;
  vault: VaultWriter;
  company: string;
  members: FinanceMember[];
  model?: string;
  /** Sends a file into the originating chat (wired to the channel layer). */
  sendFile?: (channel: string, chatId: string, filePath: string, caption?: string) => Promise<void>;
  log?: (line: string) => void;
}

/** Ledger-backed finance assistant bound to specific group chats. */
export class FinanceAgent {
  private locks = new Map<string, Promise<void>>();

  constructor(private deps: FinanceAgentDeps) {}

  private buildServer(ledger: string, origin: { channel: string; chatId: string }) {
    const { store, vault, company } = this.deps;
    const members = this.deps.members.map((m) => m.name);

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
        receipt_path: z.string().optional()
          .describe("Absolute path of the stored invoice/receipt file, when the expense came from an attachment"),
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
          receiptPath: a.receipt_path,
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
          (r) =>
            `#${r.id} ${r.date} ${r.payer}: ${formatCents(r.amount_cents, r.currency)} — ${r.description}${r.receipt_path ? " 📎" : ""}`,
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

    const exportCsv = tool(
      "export_csv",
      "Generate a CSV report of the expenses (optionally one month) and send it into this chat as a file.",
      { month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM; omit for all time") },
      async (a) => {
        const rows = store.listExpenses(ledger, a.month);
        if (!rows.length) return text(a.month ? `No expenses for ${a.month}.` : "Ledger is empty.");
        const csv = [
          "id,date,payer,amount,currency,description",
          ...rows.map((r) =>
            [r.id, r.date, csvEscape(r.payer), (r.amount_cents / 100).toFixed(2), r.currency, csvEscape(r.description)].join(","),
          ),
        ].join("\n");
        const label = a.month ?? "all-time";
        const path = vault.writeFile(
          `finance/${company.toLowerCase()}/expenses-${label}.csv`,
          `${csv}\n`,
        );
        if (!this.deps.sendFile) return text(`CSV written to ${path} (no file channel available).`);
        const total = rows.reduce((s, r) => s + r.amount_cents, 0);
        await this.deps.sendFile(
          origin.channel, origin.chatId, path,
          `${company} expenses ${label}: ${rows.length} entries, total ${formatCents(total, rows[0].currency)}`,
        );
        return text(`CSV report (${rows.length} entries) sent into the chat and archived at ${path}.`);
      },
    );

    const sendReceipt = tool(
      "send_receipt",
      "Send the archived receipt/invoice file of an expense into this chat.",
      { id: z.number().int().describe("Expense id") },
      async (a) => {
        const row = store.listExpenses(ledger).find((r) => r.id === a.id);
        if (!row) return text(`No expense #${a.id} in this ledger.`);
        if (!row.receipt_path) return text(`Expense #${a.id} has no receipt on file.`);
        if (!this.deps.sendFile) return text(`Receipt is at ${row.receipt_path} (no file channel available).`);
        await this.deps.sendFile(
          origin.channel, origin.chatId, row.receipt_path,
          `Receipt for #${row.id}: ${row.payer} — ${formatCents(row.amount_cents, row.currency)} (${row.description})`,
        );
        return text(`Receipt for #${a.id} sent into the chat.`);
      },
    );

    return createSdkMcpServer({
      name: "finance",
      version: "0.1.0",
      tools: [addExpense, removeExpense, listExpenses, settle, exportCsv, sendReceipt],
    });
  }

  async handle(
    channel: string,
    chatId: string,
    userText: string,
    sender?: InboundMessage["sender"],
    attachments?: InboundMessage["attachments"],
  ): Promise<string> {
    const chatKey = `${channel}:${chatId}`;
    const from = sender?.name || sender?.username
      ? `[from: ${sender.name ?? "?"}${sender.username ? ` (@${sender.username})` : ""}]\n`
      : "";

    // Evidence first: copy attachments into the vault before the agent sees them,
    // so the audit trail exists even if the turn fails.
    const month = new Date().toISOString().slice(0, 7);
    const invoicesDir = `finance/${this.deps.company.toLowerCase()}/invoices/${month}`;
    const storedLines = (attachments ?? []).map((att) => {
      const stored = this.deps.vault.storeFile(invoicesDir, `${Date.now()}-${att.fileName}`, att.path);
      this.deps.log?.(`invoice stored: ${stored}`);
      return `[attached file stored at: ${stored}]`;
    });
    const prompt =
      from + (storedLines.length ? `${storedLines.join("\n")}\n` : "") +
      (userText || (storedLines.length ? "(no caption — analyze the attached file)" : ""));
    const prev = this.locks.get(chatKey) ?? Promise.resolve();
    let release!: () => void;
    this.locks.set(chatKey, new Promise((r) => (release = r)));
    await prev;
    try {
      return await resumableTurn({
        store: this.deps.store,
        sessionKey: `finance-session:${chatKey}`,
        prompt,
        log: this.deps.log,
        options: {
          systemPrompt: financePrompt(this.deps.company, this.deps.members),
          mcpServers: { finance: this.buildServer(chatKey, { channel, chatId }) },
          allowedTools: FINANCE_TOOLS,
          permissionMode: "dontAsk",
          // Read is for invoice analysis only — confined to the finance evidence folder.
          // Enforced via PreToolUse hook: the only layer that fires even for
          // auto-allowed "safe" tools (canUseTool alone is bypassed for those).
          ...guardOptions(
            {
              Read: (input) => {
                const allowedRoot = `${this.deps.vault.root}/finance/`;
                return String(input.file_path ?? "").startsWith(allowedRoot)
                  ? { ok: true }
                  : { ok: false, reason: `Reading outside ${allowedRoot} is not permitted.` };
              },
            },
            "allow",
          ),
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
