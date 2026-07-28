import type { ToolCheck } from "../guards/halalo-readonly.js";

export interface RoleDef {
  name: string;
  description: string;
  systemPrompt: string;
  /** Built-in tools the role may use without prompting. */
  allowedTools: string[];
  /**
   * 'dontAsk' denies anything not pre-allowed; 'bypassPermissions' for sandboxed
   * write roles; 'default' routes undecided tools through the role's toolChecks guard.
   */
  permissionMode: "dontAsk" | "bypassPermissions" | "default";
  /** Working directory override (e.g. a specific project repo). */
  cwd?: string;
  /** Files whose contents are appended to the system prompt at runtime (e.g. a project CLAUDE.md). */
  contextFiles?: string[];
  /** Deterministic per-tool guard (enforced via PreToolUse hook + canUseTool). */
  toolChecks?: Record<string, ToolCheck>;
  /** What happens to tools without a check: default "allow". Use "deny" for locked-down roles. */
  toolCheckFallback?: "allow" | "deny";
  /** JSON schema forced on the final answer (engine branches on structured_output). */
  outputSchema?: Record<string, unknown>;
  /** Skill names from skills-plugin/skills/ this role may load (progressive disclosure). */
  skills?: string[];
  /** When true, this role is refused from any origin other than the configured primary (private) chat. */
  privateOnly?: boolean;
  /** Extra absolute dirs the attachment server may serve from for this role (e.g. vault receipts). */
  attachDirs?: string[];
  /** Per-agent model override (manifest `model:`) — wins over kind-tier defaults (org-model spec §6). */
  model?: string;
  maxTurns: number;
}

export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "revise"] },
    summary: { type: "string" },
    reasons: { type: "array", items: { type: "string" } },
    suggestions: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "summary", "reasons"],
  additionalProperties: false,
} as const;

export const TEST_REPORT_SCHEMA = {
  type: "object",
  properties: {
    passed: { type: "boolean" },
    summary: { type: "string" },
    failures: { type: "array", items: { type: "string" } },
  },
  required: ["passed", "summary", "failures"],
  additionalProperties: false,
} as const;

/** Injected per call by the run-node worker, never declared in a manifest: a work report is a
 *  property of being run as a `run` node, not of any agent. Without it a run node has no way to
 *  tell "I produced the deliverable" from "I explained why I could not" — two agents in goal
 *  c03a3bda reported, articulately, that they had applied no fixes, and both nodes were journaled
 *  outcome:ok and consumed downstream. The `description` fields ARE the instruction; no system
 *  prompt anywhere mentions this. */
export const WORK_REPORT_SCHEMA = {
  type: "object",
  properties: {
    completed: { type: "boolean", description:
      "true only if you actually produced the work this task asked for. false if you refused, were blocked, ran out of information, or produced only a placeholder or a description of what you would have done." },
    summary: { type: "string", description:
      "One or two sentences on what you produced, or on why you could not." },
    blockers: { type: "array", items: { type: "string" }, description:
      "Empty when completed is true. Otherwise one entry per concrete thing that stopped you." },
  },
  required: ["completed", "summary", "blockers"],
  additionalProperties: false,
} as const;
