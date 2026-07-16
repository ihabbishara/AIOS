// src/web/persona-view.ts — persona explorer builders: per-agent activity merge +
// comment-preserving manifest field splicing (spec 2026-07-16-persona-explorer).
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { AgentActivityInfo } from "./dto.js";

const HISTORY_WINDOW = 5000; // same window as org-view
const TIMELINE_CAP = 100;

export function buildAgentActivity(
  nameOrAlias: string,
  registry: LoadedRegistry,
  store: Store,
  bus: EventBus,
): AgentActivityInfo | null {
  const name = registry.agentOf.get(nameOrAlias);
  if (!name || !registry.agents.has(name)) return null;
  const canon = (agent: string) => registry.agentOf.get(agent) ?? agent;

  const timeline: AgentActivityInfo["timeline"] = [];
  for (const e of bus.history(0, HISTORY_WINDOW)) {
    const ev = e.event;
    if (ev.type === "agent.end" && canon(ev.agent) === name) {
      timeline.push({ ts: e.ts, kind: "run", summary: ev.context, ok: ev.ok });
    } else if (ev.type === "route.decision" && canon(ev.to) === name) {
      timeline.push({ ts: e.ts, kind: "route", summary: `${ev.via}: ${ev.reason}` });
    } else if (ev.type === "mail.sent" && (canon(ev.from) === name || canon(ev.to) === name)) {
      timeline.push({ ts: e.ts, kind: "mail", summary: `${ev.from} → ${ev.to} (${ev.kind})` });
    } else if (ev.type === "node.status" && canon(ev.agent) === name) {
      timeline.push({
        ts: e.ts, kind: "goal",
        summary: `${ev.goalId.slice(0, 8)}/${ev.nodeKey}: ${ev.status}`,
        ...(ev.status === "failed" ? { ok: false } : {}),
      });
    }
  }
  timeline.reverse(); // history is oldest-first

  const goals: AgentActivityInfo["goals"] = [];
  for (const g of store.listGoals(50)) {
    const nodes = store.listNodes(g.id).filter((n) => canon(n.agent) === name);
    if (nodes.length === 0) continue;
    goals.push({
      goalId: g.id, title: g.title, status: g.status,
      nodes: nodes.map((n) => ({ key: n.node_key, status: n.status })),
    });
  }

  const mail = store.listMail(name, 30).map((m) => ({
    id: m.id, ts: m.created_at, from: m.from_agent, to: m.to_agent,
    kind: m.kind, snippet: m.body.slice(0, 120), status: m.status,
  }));

  return { timeline: timeline.slice(0, TIMELINE_CAP), goals, mail };
}
