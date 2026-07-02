// src/web/org-view.ts — pure builders behind GET /api/org and GET /api/agents/<name>.
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { TrustRecord } from "../kernel/trust.js";
import { effectiveAllowedTools } from "../agents/permissions.js";
import { MODERATOR_ALLOWED_TOOLS } from "../moderator/session.js";

export type AgentLiveStatus = "idle" | "working" | "waiting";

export interface OrgAgentCard {
  name: string;
  title: string;
  charter: string;
  visibility: "shared" | "private";
  guarded: boolean;
  status: AgentLiveStatus;
  /** Live run context ("chat:telegram:42" | "job:slug/stage") or null when idle. */
  currentTask: string | null;
  costTodayUsd: number;
}

export interface OrgDepartmentView {
  department: string;
  mission: string;
  lead: string | null;
  memoDomain: string;
  sandbox: boolean;
  actions: string[];
  agents: OrgAgentCard[];
}

const HISTORY_WINDOW = 5000; // same window as /api/costs

/** The router emits alias names on mention paths — canonicalize before matching registry entries. */
function canonical(registry: LoadedRegistry, agent: string): string {
  return registry.agentOf.get(agent) ?? agent;
}

export function buildOrgView(
  registry: LoadedRegistry,
  store: Store,
  bus: EventBus,
  today: string = new Date().toISOString().slice(0, 10),
): OrgDepartmentView[] {
  // One history scan: open runs (start without end) + per-agent cost today.
  const liveRuns = new Map<string, string>();
  const costToday = new Map<string, number>();
  for (const e of bus.history(0, HISTORY_WINDOW)) {
    if (e.event.type === "agent.start") {
      liveRuns.set(canonical(registry, e.event.agent), e.event.context);
    } else if (e.event.type === "agent.end") {
      const name = canonical(registry, e.event.agent);
      liveRuns.delete(name);
      if (e.event.costUsd && e.ts.slice(0, 10) === today) {
        costToday.set(name, (costToday.get(name) ?? 0) + e.event.costUsd);
      }
    }
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
          guarded: !!a.role.toolChecks,
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
      actions: dept.actions,
      agents,
    });
  }
  return out;
}

export interface AgentProfileView {
  name: string;
  title: string;
  department: string;
  mission: string;
  charter: string;
  persona: string;
  aliases: string[];
  visibility: "shared" | "private";
  permissionMode: string;
  model: string | null;
  skills: string[];
  guarded: boolean;
  maxTurns: number;
  tools: Array<{ name: string; source: "default" | "granted" }>;
  revoked: Array<{ name: string; source: "revoked" }>;
  /** Trust ledger rows for action types this agent's department can propose. */
  trust: TrustRecord[];
  /** Newest first, capped at 20. */
  recentRuns: Array<{ ts: string; context: string; ok: boolean; costUsd: number | null }>;
  /** hand_off dispatches to this agent (route.decision via=handoff), newest first, capped at 20. */
  handoffs: Array<{ ts: string; reason: string; channel: string; chatId: string }>;
  costByDay: Record<string, number>;
}

export function buildAgentProfile(
  nameOrAlias: string,
  registry: LoadedRegistry,
  store: Store,
  bus: EventBus,
): AgentProfileView | null {
  const name = registry.agentOf.get(nameOrAlias);
  const def = name ? registry.agents.get(name) : undefined;
  if (!def) return null;
  const dept = registry.departments.get(def.department);

  // hermes's real allowlist is the moderator toolset, not its empty manifest tools
  // (same special case as permissionRoleCatalog in permissions-view.ts).
  const base = def.manifest.name === "hermes" ? MODERATOR_ALLOWED_TOOLS : def.role.allowedTools;
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

  const deptActions = new Set(dept?.actions ?? []);
  const trust = store.listTrust().filter((t) => deptActions.has(t.actionType));

  const recentRuns: AgentProfileView["recentRuns"] = [];
  const handoffs: AgentProfileView["handoffs"] = [];
  const costByDay: Record<string, number> = {};
  for (const e of bus.history(0, HISTORY_WINDOW)) {
    if (e.event.type === "agent.end" && canonical(registry, e.event.agent) === def.manifest.name) {
      recentRuns.push({ ts: e.ts, context: e.event.context, ok: e.event.ok, costUsd: e.event.costUsd ?? null });
      if (e.event.costUsd) {
        const day = e.ts.slice(0, 10);
        costByDay[day] = (costByDay[day] ?? 0) + e.event.costUsd;
      }
    } else if (
      e.event.type === "route.decision" && e.event.via === "handoff" &&
      canonical(registry, e.event.to) === def.manifest.name
    ) {
      handoffs.push({ ts: e.ts, reason: e.event.reason, channel: e.event.channel, chatId: e.event.chatId });
    }
  }

  return {
    name: def.manifest.name,
    title: def.manifest.title,
    department: def.department,
    mission: dept?.mission ?? "",
    charter: def.manifest.charter.trim(),
    persona: def.manifest.persona.trim(),
    aliases: def.manifest.aliases,
    visibility: def.manifest.visibility,
    permissionMode: def.role.permissionMode,
    model: def.manifest.model ?? null,
    skills: def.manifest.skills,
    guarded: !!def.role.toolChecks,
    maxTurns: def.manifest.maxTurns,
    tools,
    revoked,
    trust,
    recentRuns: recentRuns.slice(-20).reverse(),
    handoffs: handoffs.slice(-20).reverse(),
    costByDay,
  };
}
