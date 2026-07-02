import { resolve, sep } from "node:path";
import type { ToolCheck, GuardVerdict } from "./halalo-readonly.js";

const deny = (reason: string): GuardVerdict => ({ ok: false, reason });
const allow: GuardVerdict = { ok: true };

/**
 * True when the resolved real path sits under `root`.
 * - Roots ending in "/" or "-" are literal string prefixes (e.g. "/tmp/aios-"),
 *   mirroring the attachment server's isSafe dir semantics.
 * - Normal roots are directories: exact match or a slash-delimited child (so
 *   "/vault/finance" does NOT match "/vault/finance-secret").
 */
function under(real: string, root: string): boolean {
  if (root.endsWith("/") || root.endsWith("-")) return real.startsWith(root);
  const r = resolve(root);
  return real === r || real.startsWith(r + sep);
}

/**
 * Deterministic Read confinement for the shared bookkeeper (juno).
 *
 * juno lives in the team's group chat and reads attacker-suppliable invoice files, so a
 * bare Read tool would let a group member coax it into reading e.g. ~/.ssh keys or the AIOS
 * .env. This restores the deleted FinanceAgent's Read guard: reads are allowed ONLY under the
 * finance evidence roots (vault finance + attachments dirs, invoice staging in data/downloads,
 * tmp staging). Everything else denies. toolCheckFallback stays "allow" as the old agent had —
 * juno's remaining tools are its own MCP tools, governed by allowedTools.
 */
export function ledgerReadCheck(roots: string[]): Record<string, ToolCheck> {
  return {
    Read: (input) => {
      const p = input.file_path;
      if (typeof p !== "string" || !p) return deny("Read needs a file_path");
      const real = resolve(p);
      return roots.some((root) => under(real, root))
        ? allow
        : deny(`reads are confined to the finance evidence dirs (${roots.join(", ")})`);
    },
  };
}
