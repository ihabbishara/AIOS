// src/web/org-view.ts — pure builders behind GET /api/org and GET /api/agents/<name>.
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import { capabilityTools, departmentActions, type LoadedRegistry } from "../agents/registry/loader.js";
import { effectiveAllowedTools } from "../agents/permissions.js";

export type AgentLiveStatus = "idle" | "working" | "waiting";

import type { OrgAgentCard, OrgDepartmentView, AgentProfileInfo } from "./dto.js";
export type { OrgAgentCard, OrgDepartmentView, AgentProfileInfo } from "./dto.js";

const HISTORY_WINDOW = 5000; // same window as /api/costs

/** The router emits alias names on mention paths — canonicalize before matching registry entries. */
function canonical(registry: LoadedRegistry, agent: string): string {
  return registry.agentOf.get(agent) ?? agent;
}

/** An agent is "guarded" when any of its capabilities carries a named deterministic guard. */
function isGuarded(registry: LoadedRegistry, name: string): boolean {
  const def = registry.agents.get(name);
  return !!def?.capabilities.some((c) => registry.capabilities.get(c)?.guard);
}

export function buildOrgView(
  registry: LoadedRegistry,
  store: Store,
  bus: EventBus,
  today: string = new Date().toISOString().slice(0, 10),
): OrgDepartmentView[] {
  // History scan only for live-run status (start without end). Costs come from
  // the cost_daily rollup — canonicalized here because the write path stores
  // whatever name the router emitted (aliases included).
  const liveRuns = new Map<string, string>();
  for (const e of bus.history(0, HISTORY_WINDOW)) {
    if (e.event.type === "agent.start") {
      liveRuns.set(canonical(registry, e.event.agent), e.event.context);
    } else if (e.event.type === "agent.end") {
      liveRuns.delete(canonical(registry, e.event.agent));
    }
  }
  const costToday = new Map<string, number>();
  for (const r of store.costsByAgent(today)) {
    const name = canonical(registry, r.agent);
    costToday.set(name, (costToday.get(name) ?? 0) + r.usd_cents / 100);
  }

  // waiting = live chat run whose origin has a proposed (awaiting-approval) action.
  // Job contexts never match — by design; the Approvals tab covers those.
  const pendingOrigins = new Set(
    store.listActions("proposed").map((a) => `chat:${a.origin_channel}:${a.origin_chat_id}`),
  );

  const out: OrgDepartmentView[] = [];
  for (const [deptName, dept] of registry.departments) {
    const agents: OrgAgentCard[] = [...registry.agents.values()]
      .filter((a) => a.department === deptName)
      .map((a) => {
        const context = liveRuns.get(a.manifest.name) ?? null;
        const status: AgentLiveStatus =
          context && pendingOrigins.has(context) ? "waiting" : context ? "working" : "idle";
        return {
          name: a.manifest.name,
          title: a.manifest.title,
          charter: a.manifest.charter.trim(),
          visibility: a.manifest.visibility,
          guarded: isGuarded(registry, a.manifest.name),
          status,
          currentTask: context,
          costTodayUsd: costToday.get(a.manifest.name) ?? 0,
        };
      });
    out.push({
      department: deptName,
      mission: dept.mission,
      lead: dept.lead ?? null,
      memoDomain: dept.memoDomain,
      sandbox: dept.sandbox,
      actions: departmentActions(registry, deptName),
      agents,
    });
  }
  return out;
}


export function buildAgentProfile(
  nameOrAlias: string,
  registry: LoadedRegistry,
  store: Store,
  bus: EventBus,
): AgentProfileInfo | null {
  const name = registry.agentOf.get(nameOrAlias);
  const def = name ? registry.agents.get(name) : undefined;
  if (!def) return null;
  const dept = registry.departments.get(def.department);

  // Capabilities are the base truth for every agent — neo included (no pseudo-role).
  const base = capabilityTools(registry, def.manifest.name);
  const overrides = store.listRolePermissions(def.manifest.name);
  const granted = new Set(overrides.filter((o) => o.allow === 1).map((o) => o.tool));
  const baseSet = new Set(base);
  const tools = effectiveAllowedTools(def.manifest.name, base, store).map((t) => ({
    name: t,
    source: (!baseSet.has(t) && granted.has(t) ? "granted" : "default") as "granted" | "default",
  }));
  const revoked = overrides
    .filter((o) => o.allow === 0 && baseSet.has(o.tool))
    .map((o) => ({ name: o.tool, source: "revoked" as const }));

  const deptActions = new Set(dept ? departmentActions(registry, dept.department) : []);
  const trust = store.listTrust().filter((t) => deptActions.has(t.actionType));

  const recentRuns: AgentProfileInfo["recentRuns"] = [];
  const handoffs: AgentProfileInfo["handoffs"] = [];
  for (const e of bus.history(0, HISTORY_WINDOW)) {
    if (e.event.type === "agent.end" && canonical(registry, e.event.agent) === def.manifest.name) {
      recentRuns.push({ ts: e.ts, context: e.event.context, ok: e.event.ok, costUsd: e.event.costUsd ?? null });
    } else if (
      e.event.type === "route.decision" && e.event.via === "handoff" &&
      canonical(registry, e.event.to) === def.manifest.name
    ) {
      handoffs.push({ ts: e.ts, reason: e.event.reason, channel: e.event.channel, chatId: e.event.chatId });
    }
  }

  // costByDay from the rollup (last 30 days), canonicalized — see buildOrgView.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const costByDay: Record<string, number> = {};
  for (const r of store.costRows(since)) {
    if (canonical(registry, r.agent) !== def.manifest.name) continue;
    costByDay[r.date] = (costByDay[r.date] ?? 0) + r.usd_cents / 100;
  }

  return {
    name: def.manifest.name,
    title: def.manifest.title,
    department: def.department,
    mission: dept?.mission ?? "",
    charter: def.manifest.charter.trim(),
    persona: def.manifest.persona.trim(),
    prompt: def.manifest.prompt.trim(),
    kind: def.kind,
    capabilities: def.capabilities,
    aliases: def.manifest.aliases,
    visibility: def.manifest.visibility,
    permissionMode: def.role.permissionMode,
    model: def.manifest.model ?? null,
    skills: def.manifest.skills,
    guarded: isGuarded(registry, def.manifest.name),
    maxTurns: def.manifest.maxTurns,
    tools,
    revoked,
    trust,
    recentRuns: recentRuns.slice(-20).reverse(),
    handoffs: handoffs.slice(-20).reverse(),
    costByDay,
  };
}
