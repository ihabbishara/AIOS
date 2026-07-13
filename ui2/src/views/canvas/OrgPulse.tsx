// ui2/src/views/canvas/OrgPulse.tsx — the idle canvas: live org, running goals, today totals (spec §5 idle).
import { api, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { navigate } from "../../lib/router.js";
import { Dot, SectionLabel } from "../../components/ui.js";
import { usdFloat, usd } from "../../lib/format.js";

export function OrgPulse({ events }: { events: StoredEvent[] }) {
  const { data: org } = useLiveQuery(() => api.org(), events, T.agentsActions);
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  const { data: budget } = useLiveQuery(() => api.budget(), events, T.budget);
  const running = (goals ?? []).filter((g) => ["planning", "running", "replanning", "awaiting-mail"].includes(g.status));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="text-dim mb-4">Nothing needs you.</div>
        <div className="flex gap-6 overflow-x-auto">
          {(org ?? []).map((d) => (
            <div key={d.department} className="min-w-40">
              <SectionLabel>{d.department}</SectionLabel>
              {d.agents.map((a) => (
                <button
                  key={a.name}
                  onClick={() => navigate(`staff/agents/${a.name}`)}
                  className="flex items-center gap-2 py-1 w-full text-left hover:text-strong"
                >
                  <Dot tone={a.status === "working" ? "agent" : a.status === "waiting" ? "accent" : "dim"} breathing={a.status === "working"} />
                  <span className={a.status === "working" ? "text-fg" : "text-dim"}>{a.name}</span>
                  {a.currentTask && <span className="text-[10px] text-dim truncate max-w-32">{a.currentTask}</span>}
                  {a.costTodayUsd > 0 && <span className="text-[10px] text-dim ml-auto">{usdFloat(a.costTodayUsd)}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      {running.length > 0 && (
        <div>
          <SectionLabel>Running now</SectionLabel>
          {running.map((g) => {
            const done = g.nodes.filter((n) => n.status === "done").length;
            return (
              <button key={g.id} onClick={() => navigate(`goals/${g.slug}`)}
                className="w-full text-left py-1.5 group">
                <div className="flex items-baseline gap-2">
                  <span className="group-hover:text-strong">{g.title}</span>
                  <span className="text-[10px] text-dim">{done}/{g.nodes.length} · {g.department}</span>
                </div>
                <div className="shimmer mt-1" />
              </button>
            );
          })}
        </div>
      )}
      {budget && (
        <div className="text-[11px] text-dim">
          {usd(budget.spentCents)} spent today{budget.capCents != null ? ` of ${usd(budget.capCents)}` : ""}
        </div>
      )}
    </div>
  );
}
