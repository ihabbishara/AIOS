import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ToolCheck } from "./halalo-readonly.js";

export type { ToolCheck, GuardVerdict } from "./halalo-readonly.js";

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
): Partial<Options> {
  const decide = (toolName: string, input: Record<string, unknown>) => {
    const check = checks[toolName];
    if (check) return check(input);
    // StructuredOutput is the SDK's output channel for json_schema results, not a
    // side-effect tool — a fallback-deny guard must never block it (it silently
    // strips verdicts/plans: observed live with the goal planner).
    if (toolName === "StructuredOutput") return { ok: true as const };
    // MCP tools (the role's own SDK tools) are governed by allowedTools.
    if (toolName.startsWith("mcp__")) return { ok: true as const };
    return fallback === "allow"
      ? { ok: true as const }
      : { ok: false as const, reason: `tool ${toolName} is not permitted for this agent` };
  };

  return {
    canUseTool: async (toolName, input) => {
      const v = decide(toolName, input);
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
