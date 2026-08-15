// src/agents/registry/extras.ts
import { join, resolve } from "node:path";
import { EXPORTS_DIR } from "../guards/aws-readonly.js";
import { ledgerReadCheck } from "../guards/read-confined.js";
import { atlasMutatingChecks } from "../guards/atlas-mutating.js";
import type { AgentExtras } from "./loader.js";
import type { FinanceMember } from "../../config.js";

/** Client project dir — env-only since onboarding (spec §7); no personal default.
 *  Read at call time, not module load, so tests can set it late. */
export const clientDir = (): string | undefined => process.env.AIOS_CLIENT_DIR;

/** Which agent the client project belongs to. Env-only for the same reason the dir is: the
 *  agent's NAME is one operator's, so hardcoding it here would put a client back in product
 *  source. Both must be set or the entry is omitted — half-configured is not a client. */
export const clientAgent = (): string | undefined => process.env.AIOS_CLIENT_AGENT;

export interface ExtrasConfig {
  vaultPath: string;
  vaultSubdir: string;
  financeCompany: string;
  financeMembers: FinanceMember[];
}

/** Env-dependent role parts that cannot live in YAML: guards, machine paths, config-derived prompt bits. */
export function buildExtras(cfg: ExtrasConfig): Record<string, AgentExtras> {
  const roster = cfg.financeMembers
    .map((m) => (m.handle ? `${m.name} (@${m.handle})` : m.name)).join(", ");
  const cDir = clientDir();
  const cAgent = clientAgent();
  return {
    // No AIOS_CLIENT_DIR/AIOS_CLIENT_AGENT → no client project to point at, so the entry is
    // omitted entirely rather than pointed at a path that does not exist on this machine.
    ...(cDir && cAgent ? {
      [cAgent]: {
        cwd: cDir,
        contextFiles: [join(cDir, "CLAUDE.md")],
        attachDirs: [EXPORTS_DIR],
        promptSuffix: `\n\n## Exports directory\nYour exports directory (absolute): ${EXPORTS_DIR}. Write deliverable files there (e.g. ${EXPORTS_DIR}/orders.csv), then attach_file with that same absolute path. A bare filename would be refused — always use the full exports path.`,
      },
    } : {}),
    juno: (() => {
      const attachDirs = [join(cfg.vaultPath, cfg.vaultSubdir, "attachments"), "/tmp/aios-"];
      // Read is confined to the finance evidence roots: the vault finance + attachments
      // dirs (as the deleted FinanceAgent guard had), plus invoice staging in
      // data/downloads (= EXPORTS_DIR, where telegram invoices land + exports).
      const readRoots = [
        join(cfg.vaultPath, cfg.vaultSubdir, "finance"),
        ...attachDirs, // vault attachments + /tmp/aios- staging prefix
        resolve("data/downloads"),
      ];
      return {
        promptSuffix: `\n\nCompany: ${cfg.financeCompany}. Team members sharing costs equally (${cfg.financeMembers.length}): ${roster}.`,
        attachDirs,
      };
    })(),
  };
}
