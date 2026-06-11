/** Pure settlement math — money stays in integer cents, no LLM arithmetic. */

export interface ExpenseEntry {
  id: number;
  payer: string;
  amountCents: number;
  currency: string;
  description: string;
  date: string; // YYYY-MM-DD
}

export interface Settlement {
  month: string;
  currency: string;
  totalCents: number;
  members: string[];
  shareCents: number;
  /** payer -> paid total in cents (0 for members who paid nothing) */
  paidByMember: Record<string, number>;
  /** member -> balance in cents (positive = should receive, negative = owes) */
  balances: Record<string, number>;
  /** minimal transfer plan: debtor pays creditor */
  transfers: Array<{ from: string; to: string; amountCents: number }>;
}

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function formatCents(cents: number, currency = "EUR"): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

export function computeSettlement(
  expenses: ExpenseEntry[],
  members: string[],
  month: string,
): Settlement {
  if (members.length === 0) throw new Error("No members configured for settlement");
  const currencies = new Set(expenses.map((e) => e.currency));
  if (currencies.size > 1) {
    throw new Error(`Mixed currencies in ledger (${[...currencies].join(", ")}) — settle per currency`);
  }
  const currency = expenses[0]?.currency ?? "EUR";

  const canonical = new Map(members.map((m) => [normalize(m), m.trim()]));
  const paidByMember: Record<string, number> = {};
  for (const m of canonical.values()) paidByMember[m] = 0;

  let totalCents = 0;
  for (const e of expenses) {
    const member = canonical.get(normalize(e.payer));
    if (!member) {
      throw new Error(
        `Payer "${e.payer}" (expense #${e.id}) is not in the member list [${members.join(", ")}]`,
      );
    }
    paidByMember[member] += e.amountCents;
    totalCents += e.amountCents;
  }

  // Equal split. Remainder cents are assigned to the first members deterministically
  // so shares always sum exactly to the total.
  const base = Math.floor(totalCents / members.length);
  const remainder = totalCents - base * members.length;
  const names = [...canonical.values()];
  const balances: Record<string, number> = {};
  names.forEach((m, i) => {
    const share = base + (i < remainder ? 1 : 0);
    balances[m] = paidByMember[m] - share;
  });

  // Greedy transfer plan: biggest debtor pays biggest creditor.
  const transfers: Settlement["transfers"] = [];
  const debtors = names.filter((m) => balances[m] < 0).map((m) => ({ m, amt: -balances[m] }));
  const creditors = names.filter((m) => balances[m] > 0).map((m) => ({ m, amt: balances[m] }));
  debtors.sort((a, b) => b.amt - a.amt);
  creditors.sort((a, b) => b.amt - a.amt);
  let di = 0, ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const pay = Math.min(debtors[di].amt, creditors[ci].amt);
    if (pay > 0) transfers.push({ from: debtors[di].m, to: creditors[ci].m, amountCents: pay });
    debtors[di].amt -= pay;
    creditors[ci].amt -= pay;
    if (debtors[di].amt === 0) di++;
    if (creditors[ci].amt === 0) ci++;
  }

  return {
    month,
    currency,
    totalCents,
    members: names,
    shareCents: base,
    paidByMember,
    balances,
    transfers,
  };
}

export function renderSettlement(s: Settlement): string {
  const lines = [
    `# Settlement ${s.month}`,
    "",
    `Total spent: **${formatCents(s.totalCents, s.currency)}** across ${s.members.length} members — fair share ≈ ${formatCents(s.shareCents, s.currency)} each.`,
    "",
    "## Paid",
    ...s.members.map((m) => `- ${m}: ${formatCents(s.paidByMember[m], s.currency)}`),
    "",
    "## Balances",
    ...s.members.map((m) => {
      const b = s.balances[m];
      return `- ${m}: ${b === 0 ? "settled" : b > 0 ? `receives ${formatCents(b, s.currency)}` : `owes ${formatCents(-b, s.currency)}`}`;
    }),
  ];
  if (s.transfers.length) {
    lines.push("", "## Who pays whom");
    for (const t of s.transfers) {
      lines.push(`- ${t.from} → ${t.to}: ${formatCents(t.amountCents, s.currency)}`);
    }
  } else {
    lines.push("", "All settled — no transfers needed.");
  }
  return lines.join("\n");
}
