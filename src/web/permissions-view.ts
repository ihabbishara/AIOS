import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import { roles } from "../agents/roles/index.js";
import { effectiveAllowedTools } from "../agents/permissions.js";
import { MODERATOR_ALLOWED_TOOLS } from "../moderator/session.js";
import { FINANCE_TOOLS } from "../finance/agent.js";

export interface PermissionTool {
  name: string;
  source: "default" | "granted" | "revoked";
}
export interface PermissionDenial {
  tool: string;
  count: number;
  lastTs: string;
}
export interface PermissionRoleView {
  role: string;
  description: string;
  permissionMode: string;
  toolCheckFallback: string;
  skills: string[];
  /** Effective allowlist — each tool tagged default/granted. */
  tools: PermissionTool[];
  /** Defaults the human revoked (shown struck-through). */
  revoked: PermissionTool[];
  denials: PermissionDenial[];
}

interface CatalogEntry {
  role: string;
  description: string;
  permissionMode: string;
  toolCheckFallback: string;
  skills: string[];
  base: string[];
}

/** Every controllable role: the code registry + the two standalone pseudo-roles. */
export function permissionRoleCatalog(): CatalogEntry[] {
  const codeRoles = Object.values(roles).map((r) => ({
    role: r.name,
    description: r.description,
    permissionMode: r.permissionMode,
    toolCheckFallback: r.toolCheckFallback ?? "allow",
    skills: r.skills ?? [],
    base: r.allowedTools,
  }));
  return [
    ...codeRoles,
    {
      role: "moderator",
      description: "Top-level orchestrator — routes work and talks to you.",
      permissionMode: "dontAsk",
      toolCheckFallback: "allow",
      skills: [],
      base: MODERATOR_ALLOWED_TOOLS,
    },
    {
      role: "finance",
      description: "Standalone finance agent — expenses, settlements, receipts.",
      permissionMode: "dontAsk",
      toolCheckFallback: "allow",
      skills: [],
      base: FINANCE_TOOLS,
    },
  ];
}

export function buildPermissionsView(store: Store, bus: EventBus): PermissionRoleView[] {
  // Aggregate denials once.
  const denialMap = new Map<string, { count: number; lastTs: string }>();
  for (const e of bus.history(0, 5000)) {
    if (e.event.type !== "tool.denied") continue;
    const key = `${e.event.role}\x00${e.event.tool}`;
    const prev = denialMap.get(key);
    denialMap.set(key, { count: (prev?.count ?? 0) + 1, lastTs: e.ts });
  }

  return permissionRoleCatalog().map((entry) => {
    const overrides = store.listRolePermissions(entry.role);
    const granted = new Set(overrides.filter((o) => o.allow === 1).map((o) => o.tool));
    const revokedNames = new Set(overrides.filter((o) => o.allow === 0).map((o) => o.tool));
    const effective = effectiveAllowedTools(entry.role, entry.base, store);
    const baseSet = new Set(entry.base);

    const tools: PermissionTool[] = effective.map((name) => ({
      name,
      source: !baseSet.has(name) && granted.has(name) ? "granted" : "default",
    }));
    const revoked: PermissionTool[] = [...revokedNames]
      .filter((name) => baseSet.has(name))
      .map((name) => ({ name, source: "revoked" as const }));

    const denials: PermissionDenial[] = [];
    for (const [key, agg] of denialMap) {
      const nul = key.indexOf("\x00");
      const role = key.slice(0, nul);
      const tool = key.slice(nul + 1);
      if (role === entry.role) denials.push({ tool, count: agg.count, lastTs: agg.lastTs });
    }
    denials.sort((a, b) => b.lastTs.localeCompare(a.lastTs));

    return {
      role: entry.role,
      description: entry.description,
      permissionMode: entry.permissionMode,
      toolCheckFallback: entry.toolCheckFallback,
      skills: entry.skills,
      tools,
      revoked,
      denials,
    };
  });
}
