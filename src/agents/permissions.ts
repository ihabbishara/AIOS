import type { RolePermissionRow } from "../store/db.js";

/** Minimal store surface this module needs — keeps the helpers pure and easy to fake in tests. */
export interface PermissionStore {
  listRolePermissions(role?: string): RolePermissionRow[];
}

/**
 * Effective tool allowlist for a role = (base ∪ {allow=1}) \ {allow=0}, read fresh per run.
 * Fail-closed: any error reading overrides returns the code-default `base` — an error can
 * only narrow toward the default, never widen.
 */
export function effectiveAllowedTools(roleName: string, base: string[], store: PermissionStore): string[] {
  let rows: RolePermissionRow[];
  try {
    rows = store.listRolePermissions(roleName);
  } catch {
    return base;
  }
  const set = new Set(base);
  for (const r of rows) {
    if (r.allow === 1) set.add(r.tool);
    else set.delete(r.tool);
  }
  return [...set];
}

/** Returns a shallow copy of `options` with allowedTools replaced by the effective set. */
export function withEffectiveTools<T extends { allowedTools?: string[] }>(
  options: T,
  roleName: string,
  store: PermissionStore,
): T {
  return { ...options, allowedTools: effectiveAllowedTools(roleName, options.allowedTools ?? [], store) };
}

/**
 * Appends a PreToolUse hook that records (and denies) any tool the model reaches for
 * outside `options.allowedTools`. Deduped per run (a looping agent can't flood the log).
 * - mcp__ tools are governed by allowedTools, not surfaced as denials.
 * - bypassPermissions roles are sandboxed write-roles with no concept of denial → no observer.
 * - The emit callback is wrapped in try/catch: a denial-hook failure can never break an agent run.
 * Append-merges so an existing guard PreToolUse hook (e.g. halalo's) is preserved.
 */
export function withDenialObserver<
  T extends { allowedTools?: string[]; permissionMode?: string; hooks?: { PreToolUse?: unknown[] } },
>(options: T, roleName: string, emit: (e: { role: string; tool: string }) => void): T {
  if (options.permissionMode === "bypassPermissions") return options;
  const allowed = new Set(options.allowedTools ?? []);
  const seen = new Set<string>();
  const observer = async (raw: unknown) => {
    const tool = (raw as { tool_name?: string }).tool_name ?? "";
    if (!tool || allowed.has(tool) || tool.startsWith("mcp__")) return { continue: true };
    if (!seen.has(tool)) {
      seen.add(tool);
      try {
        emit({ role: roleName, tool });
      } catch {
        /* a denial-observation failure must never break an agent run */
      }
    }
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: `${tool} is not in ${roleName}'s allowlist`,
      },
    };
  };
  const existing = options.hooks?.PreToolUse ?? [];
  return { ...options, hooks: { ...options.hooks, PreToolUse: [...existing, { hooks: [observer] }] } };
}
