import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeSettlement, renderSettlement, toCents, formatCents } from "./ledger.js";
import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { ActionGate } from "../kernel/gate.js";
import type { FinanceMember } from "../config.js";

const EXPORTS_DIR = resolve("data/downloads/exports");

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function slugify(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "ledger";
}

export function buildLedgerServer(
  deps: { store: Store; vault: VaultWriter; gate: ActionGate; origin: { channel: string; chatId: string } },
  cfg: { company: string; members: FinanceMember[] },
) {
  const { store, vault, gate, origin } = deps;
  const { company } = cfg;
  const members = cfg.members.map((m) => m.name);
  const ledger = `${origin.channel}:${origin.chatId}`;
  const ledgerSlug = slugify(ledger);

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
      const currency = a.currency.toUpperCase();
      const row = await gate.propose({
        type: "ledger.write",
        payload: {
          op: "add", ledger, payer: a.payer.trim(), amount_cents: cents,
          currency, description: a.description, date,
          ...(a.receipt_path ? { receipt_path: a.receipt_path } : {}),
        },
        preview: `Ledger add: ${a.payer.trim()} paid ${formatCents(cents, currency)} — ${a.description} (${ledger})`,
      }, origin);
      return text(row.status === "executed"
        ? row.result ?? "Recorded."
        : `Queued for approval (${row.id}) — approve to record.`);
    },
  );

  const removeExpense = tool(
    "remove_expense",
    "Delete a wrongly recorded expense by id.",
    { id: z.number().int() },
    async (a) => {
      const row = await gate.propose({
        type: "ledger.write",
        payload: { op: "remove", ledger, id: a.id },
        preview: `Ledger remove: expense #${a.id} (${ledger})`,
      }, origin);
      return text(row.status === "executed"
        ? row.result ?? `Removed expense #${a.id}.`
        : `Queued for approval (${row.id}) — approve to remove.`);
    },
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
    "Write the ledger as a CSV file and attach it to the chat (call attach_file with the returned path).",
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
      mkdirSync(EXPORTS_DIR, { recursive: true });
      const filePath = join(EXPORTS_DIR, `${ledgerSlug}-${label}.csv`);
      writeFileSync(filePath, `${csv}\n`);
      return text(`CSV written to ${filePath}. Call attach_file with this exact path to deliver it into the chat.`);
    },
  );

  const sendReceipt = tool(
    "send_receipt",
    "Return the archived receipt's path — call attach_file with it to share the file in this chat.",
    { id: z.number().int().describe("Expense id") },
    async (a) => {
      const row = store.listExpenses(ledger).find((r) => r.id === a.id);
      if (!row) return text(`No expense #${a.id} in this ledger.`);
      if (!row.receipt_path) return text(`Expense #${a.id} has no receipt on file.`);
      return text(`Receipt is at ${row.receipt_path}. Call attach_file with this exact path to deliver it into the chat.`);
    },
  );

  return createSdkMcpServer({
    name: "ledger",
    version: "0.1.0",
    tools: [addExpense, removeExpense, listExpenses, settle, exportCsv, sendReceipt],
  });
}
