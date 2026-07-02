// src/web/org-view.ts — pure builders behind GET /api/org and GET /api/agents/<name>.
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";

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
