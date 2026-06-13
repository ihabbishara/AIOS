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
  for (const domain of DOMAINS) {
    try {
      await distillDomain(deps, domain);
    } catch (err) {
      deps.log?.(`distill ${domain} failed: ${(err as Error).message}`);
    }
  }
}

async function distillDomain(deps: DistillDeps, domain: Domain): Promise<void> {
  const { store, vault, gate, curate } = deps;
  const since = store.kvGet(`distill:last:${domain}`) ?? undefined;

  const decisions = domain === "profile"
    ? []
    // Exclude vault.write: the distiller's own gate-audited memo writes are recorded as
    // decisions; re-consuming them would create a self-feeding loop (every run re-curates the
    // 'general' domain those writes map to). Memo writes carry no preference signal.
    : store.listDecisions(since).filter((d) => d.type !== "vault.write" && domainForType(d.type) === domain);

  // The two queries are disjoint (domain IS NULL vs domain = 'profile'), so no dedup is needed.
  // Collecting both also rescues any pre-existing rows mis-stamped with the literal "profile" domain.
  const teachings = domain === "profile"
    ? [...store.listUnconsolidatedTeachings(null), ...store.listUnconsolidatedTeachings("profile")].filter((t) => t.kind === "fact" || t.kind === "forget")
    : store.listUnconsolidatedTeachings(domain).filter((t) => t.kind === "preference" || t.kind === "forget");

  // No-op without bumping the cursor: decisions are deliberately re-read every run until a write
  // succeeds, so the cursor stays write-dependent (do not "fix" it into a write-independent one).
  if (!decisions.length && !teachings.length) return;

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
    if (teachings.length) store.markTeachingsConsolidated(teachings.map((t) => t.id));
    if (decisions.length) {
      // Stamp the cursor with the MAX consumed decision ts (not "now") so a decision resolved
      // mid-run is re-read next run (a benign re-curate) instead of being silently skipped.
      const watermark = decisions.reduce((m, d) => (d.ts > m ? d.ts : m), decisions[0].ts);
      store.kvSet(`distill:last:${domain}`, watermark);
    }
  } else {
    deps.log?.(`distill ${domain}: memo write not executed (${row.status})`);
  }
}
