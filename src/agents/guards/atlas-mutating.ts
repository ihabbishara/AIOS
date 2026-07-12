// src/agents/guards/atlas-mutating.ts — deterministic fence for the DevOps
// agent. Atlas's YAML prompt says "never terraform apply / kubectl apply /
// git push"; this makes those rules code, not advice. Fallback stays "allow"
// (atlas remains a useful generalist) — the denylist is the fence.
import type { ToolCheck, GuardVerdict } from "./halalo-readonly.js";

const MUTATING: Array<{ re: RegExp; why: string }> = [
  { re: /\bterraform\s+(apply|destroy)\b/, why: "terraform apply/destroy changes live infra" },
  { re: /\bkubectl\s+(apply|delete|patch|drain|scale|rollout)\b/, why: "kubectl mutation changes a live cluster" },
  { re: /\bgit\s+push\b/, why: "git push publishes — propose it for approval instead" },
  { re: /\bhelm\s+(install|upgrade|uninstall|rollback)\b/, why: "helm release mutation changes a live cluster" },
  { re: /\baws\s+\S+\s+(?!describe-|get-|list-|ls\b)\S*(rm|delete|create|put|update|terminate|stop|start|modify|attach|detach|run)[a-z-]*\b/, why: "mutating aws call" },
];

function checkCommand(input: Record<string, unknown>): GuardVerdict {
  const cmd = input?.command;
  if (typeof cmd !== "string") return { ok: false, reason: "atlas guard: missing command string" };
  for (const { re, why } of MUTATING) {
    if (re.test(cmd)) {
      return { ok: false, reason: `atlas guard: refused — ${why}. Write the config/plan into the workspace instead.` };
    }
  }
  return { ok: true };
}

/** Applies to raw Bash and the sandboxed shell alike — whole-string scan, so
 *  compound commands (`a && b`) can't smuggle a mutating call past the fence. */
export function atlasMutatingChecks(): Record<string, ToolCheck> {
  return { Bash: checkCommand, mcp__code__sh: checkCommand };
}
