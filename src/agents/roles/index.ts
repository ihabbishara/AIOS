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
