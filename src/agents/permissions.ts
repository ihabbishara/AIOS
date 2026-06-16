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
