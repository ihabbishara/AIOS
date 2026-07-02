// src/agents/registry/extras.ts
import { join } from "node:path";
import { halaloToolChecks, HALALO_EXPORTS_DIR } from "../guards/halalo-readonly.js";
import type { AgentExtras } from "./loader.js";
import type { FinanceMember } from "../../config.js";

const HALALO_DIR =
  process.env.AIOS_HALALO_DIR ?? "/Users/ihabbishara/projects/halalo-php-source/halalo";

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
  return {
    halalo: {
      cwd: HALALO_DIR,
      contextFiles: [join(HALALO_DIR, "CLAUDE.md")],
      toolChecks: halaloToolChecks(HALALO_DIR),
      toolCheckFallback: "deny",
      attachDirs: [HALALO_EXPORTS_DIR],
    },
    salim: {
      promptSuffix: `\n\nCompany: ${cfg.financeCompany}. Team members sharing costs equally (${cfg.financeMembers.length}): ${roster}.`,
      attachDirs: [join(cfg.vaultPath, cfg.vaultSubdir, "attachments"), "/tmp/aios-"],
    },
  };
}
