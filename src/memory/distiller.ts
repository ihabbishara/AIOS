import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { ActionGate } from "../kernel/gate.js";
import { DOMAINS, type Domain } from "./recall.js";
import { domainForType } from "./indexer.js";
import { memoRelPath } from "./memos.js";

const ORIGIN = { channel: "system", chatId: "distill" };

export interface CurateInput { domain: string; existing: string; signals: string }
export type CurateFn = (input: CurateInput) => Promise<string>;

export interface DistillDeps {
  store: Store;
  vault: VaultWriter;
  gate: ActionGate;
  curate: CurateFn;
  nowIso?: string;
  log?: (line: string) => void;
}

export async function distill(deps: DistillDeps): Promise<void> {
  const now = deps.nowIso ?? new Date().toISOString();
  for (const domain of DOMAINS) {
    try {
      await distillDomain(deps, domain, now);
    } catch (err) {
      deps.log?.(`distill ${domain} failed: ${(err as Error).message}`);
    }
  }
}

async function distillDomain(deps: DistillDeps, domain: Domain, now: string): Promise<void> {
  const { store, vault, gate, curate } = deps;
  const since = store.kvGet(`distill:last:${domain}`) ?? undefined;

  const decisions = domain === "profile"
    ? []
    : store.listDecisions(since).filter((d) => domainForType(d.type) === domain);

  const teachings = domain === "profile"
    ? store.listUnconsolidatedTeachings(null).filter((t) => t.kind === "fact" || t.kind === "forget")
    : store.listUnconsolidatedTeachings(domain).filter((t) => t.kind === "preference" || t.kind === "forget");

  if (!decisions.length && !teachings.length) return; // no-op, do not bump the cursor

  const existing = vault.readNote(memoRelPath(domain)) ?? "";
  const signals = [
    ...decisions.map((d) => `- decision[${d.verdict}] ${d.preview}${d.reason ? ` — reason: ${d.reason}` : ""}`),
    ...teachings.map((t) => `- ${t.kind}: ${t.text}`),
  ].join("\n");

  const updated = (await curate({ domain, existing, signals })).trim();
  if (!updated) {
    deps.log?.(`distill ${domain}: empty curator output — keeping prior memo`);
    return;
  }

  const row = await gate.propose(
    { type: "vault.write", payload: { path: memoRelPath(domain), content: updated }, preview: `Update ${domain} memo` },
    ORIGIN,
  );
  if (row.status === "executed") {
    store.markTeachingsConsolidated(teachings.map((t) => t.id));
    store.kvSet(`distill:last:${domain}`, now);
  } else {
    deps.log?.(`distill ${domain}: memo write not executed (${row.status})`);
  }
}
