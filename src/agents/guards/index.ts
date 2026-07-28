import { join, resolve } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { halaloToolChecks, type ToolCheck } from "./halalo-readonly.js";
import { ledgerReadCheck } from "./read-confined.js";
import { atlasMutatingChecks } from "./atlas-mutating.js";
import { webFetchPublicChecks } from "./web-fetch-public.js";

export type { ToolCheck, GuardVerdict } from "./halalo-readonly.js";

export interface GuardConfig {
  halaloDir: string;
  vaultPath: string;
  vaultSubdir: string;
}

export interface NamedGuard {
  checks: Record<string, ToolCheck>;
  fallback?: "deny";
}

/** Named deterministic guards referenced by capability `guard:` fields (org-model spec §3).
 *  Unknown names are a boot error (loader validates). Guards AND-compose: every guard must allow. */
export const NAMED_GUARDS: Record<string, (cfg: GuardConfig) => NamedGuard> = {
  "halalo-readonly": (cfg) => ({ checks: halaloToolChecks(cfg.halaloDir), fallback: "deny" }),
  // Mirror of the extras.ts juno readRoots: finance evidence dirs + attachment staging.
  "ledger-read-confine": (cfg) => ({
    checks: ledgerReadCheck([
      join(cfg.vaultPath, cfg.vaultSubdir, "finance"),
      join(cfg.vaultPath, cfg.vaultSubdir, "attachments"),
      "/tmp/aios-",
      resolve("data/downloads"),
    ]),
  }),
  "atlas-mutating": () => ({ checks: atlasMutatingChecks() }),
  // WebFetch SSRF guard for the fetch-only web-fetch capability (minos). Fallback allow: it only
  // constrains WebFetch, every other tool stays bounded by allowedTools + other guards.
  "web-fetch-public": () => ({ checks: webFetchPublicChecks() }),
};

/**
 * Wires per-tool checks into SDK options with defense in depth:
 * - PreToolUse hook: fires for EVERY tool call, including ones auto-allowed as
 *   "safe" (Read/Grep) or pre-approved via allowedTools. Denies on check failure.
 * - canUseTool: the programmatic permission prompt — decides for tools that
 *   reach the permission flow.
 *
 * Empirically verified (2026-06-11, SDK 0.3.173): allowedTools and safe-tool
 * classification BYPASS canUseTool — hooks are the only layer that always fires.
 */
export function guardOptions(
  checks: Record<string, ToolCheck>,
  fallback: "allow" | "deny",
  onDeny?: (tool: string, reason: string) => void,
): Partial<Options> {
  const decide = (toolName: string, input: Record<string, unknown>) => {
    const check = checks[toolName];
    if (check) return check(input);
    // StructuredOutput is the SDK's output channel for json_schema results, not a
    // side-effect tool — a fallback-deny guard must never block it (it silently
    // strips verdicts/plans: observed live with the goal planner).
    if (toolName === "StructuredOutput") return { ok: true as const };
    // ToolSearch only loads deferred tool SCHEMAS — it has no side effect and grants no access
    // (using a loaded tool still goes through allowedTools + these same checks). A fallback-deny
    // guard (halalo) must not veto it, or every deferred tool is unreachable: the agent runs
    // fully offline (observed live — odin's WebFetch deferred, schema-load denied).
    if (toolName === "ToolSearch") return { ok: true as const };
    // MCP tools (the role's own SDK tools) are governed by allowedTools.
    if (toolName.startsWith("mcp__")) return { ok: true as const };
    return fallback === "allow"
      ? { ok: true as const }
      : { ok: false as const, reason: `tool ${toolName} is not permitted for this agent` };
  };

  // Denial collector seam (policy-wall spec §1): report each denied tool once per wiring so
  // the engine can park the node and name the wall. A collector failure must never affect
  // the guard's verdict.
  const reported = new Set<string>();
  const report = (tool: string, reason: string): void => {
    if (!onDeny || reported.has(tool)) return;
    reported.add(tool);
    try { onDeny(tool, reason); } catch { /* never break a guard */ }
  };

  return {
    canUseTool: async (toolName, input) => {
      const v = decide(toolName, input);
      if (!v.ok) report(toolName, v.reason ?? "denied by guard");
      // Runtime zod schema requires updatedInput on the allow branch (despite optional typing).
      return v.ok
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: v.reason ?? "denied by guard" };
    },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (raw) => {
              const input = raw as { tool_name?: string; tool_input?: Record<string, unknown> };
              const v = decide(input.tool_name ?? "", input.tool_input ?? {});
              if (v.ok) return { continue: true }; // no decision — normal flow proceeds
              report(input.tool_name ?? "", v.reason ?? "denied by guard");
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: v.reason ?? "denied by guard",
                },
              };
            },
          ],
        },
      ],
    },
  };
}
