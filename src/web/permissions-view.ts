import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import { capabilityTools, type LoadedRegistry } from "../agents/registry/loader.js";
import { effectiveAllowedTools } from "../agents/permissions.js";

/** The Claude Agent SDK's built-in tool names — the universally grantable set (case-sensitive). */
export const BUILTIN_TOOLS = [
  "Bash",
  "Edit",
  "Read",
  "Write",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "Task",
  "NotebookEdit",
  "Skill",
];

/** A grantable tool name must be a non-empty, whitespace-free token. Unknown-but-well-formed
 *  names are allowed (intentionally inert until such a tool exists — forward-compat). */
export function isWellFormedToolName(name: string): boolean {
  return name.length > 0 && !/\s/.test(name);
}

import type { PermissionInfo } from "./dto.js";
export type { PermissionInfo } from "./dto.js";

interface CatalogEntry {
  role: string;
  description: string;
  permissionMode: string;
  toolCheckFallback: string;
  skills: string[];
  base: string[];
}

/** Every controllable role: the live registry agents, uniformly — hermes included (org-model
 *  spec §5: the pseudo-role special case is gone; capabilities are the base truth). */
export function permissionRoleCatalog(registry: LoadedRegistry): CatalogEntry[] {
  return [...registry.agents.values()].map((a) => ({
    role: a.role.name,
    description: a.role.description,
    permissionMode: a.role.permissionMode,
    toolCheckFallback: a.role.toolCheckFallback ?? "allow",
    skills: a.role.skills ?? [],
    base: capabilityTools(registry, a.manifest.name),
  }));
}

export function buildPermissionsView(store: Store, bus: EventBus, registry: LoadedRegistry): PermissionInfo[] {
  // Aggregate denials once.
  const denialMap = new Map<string, { count: number; lastTs: string }>();
  for (const e of bus.history(0, 5000)) {
    if (e.event.type !== "tool.denied") continue;
    const key = `${e.event.role}\x00${e.event.tool}`;
    const prev = denialMap.get(key);
    denialMap.set(key, { count: (prev?.count ?? 0) + 1, lastTs: e.ts });
  }

  return permissionRoleCatalog(registry).map((entry) => {
    const overrides = store.listRolePermissions(entry.role);
    const granted = new Set(overrides.filter((o) => o.allow === 1).map((o) => o.tool));
    const revokedNames = new Set(overrides.filter((o) => o.allow === 0).map((o) => o.tool));
    const effective = effectiveAllowedTools(entry.role, entry.base, store);
    const baseSet = new Set(entry.base);

    const tools: PermissionInfo["tools"] = effective.map((name) => ({
      name,
      source: !baseSet.has(name) && granted.has(name) ? "granted" : "default",
    }));
    const revoked: PermissionInfo["revoked"] = [...revokedNames]
      .filter((name) => baseSet.has(name))
      .map((name) => ({ name, source: "revoked" as const }));

    const denials: PermissionInfo["denials"] = [];
    for (const [key, agg] of denialMap) {
      const nul = key.indexOf("\x00");
      const role = key.slice(0, nul);
      const tool = key.slice(nul + 1);
      if (role === entry.role) denials.push({ tool, count: agg.count, lastTs: agg.lastTs });
    }
    denials.sort((a, b) => b.lastTs.localeCompare(a.lastTs));

    const knownTools = [...new Set([...BUILTIN_TOOLS, ...entry.base, ...effective])];

    return {
      role: entry.role,
      description: entry.description,
      permissionMode: entry.permissionMode,
      toolCheckFallback: entry.toolCheckFallback,
      skills: entry.skills,
      tools,
      revoked,
      denials,
      knownTools,
    };
  });
}
