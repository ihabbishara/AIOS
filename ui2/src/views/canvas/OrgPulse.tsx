// ui2/src/views/canvas/OrgPulse.tsx — the idle canvas: live department cards + activity strip (Command Deck).
import { api, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { navigate } from "../../lib/router.js";
import { Avatar } from "../../components/ui.js";
import { usdFloat, usd, tsTime } from "../../lib/format.js";

const NOTABLE = new Set(["goal.created", "goal.status", "mail.sent", "brief.sent", "action.executed", "action.resolved"]);
const EVENT_TONE: Record<string, string> = {
  "goal.created": "text-agent", "goal.status": "text-ok", "mail.sent": "text-info",
  "brief.sent": "text-dim", "action.executed": "text-ok", "action.resolved": "text-ok",
};

function eventLine(e: StoredEvent): string {
  const ev = e.event as unknown as Record<string, unknown>;
  const parts = [String(ev.type)];
  for (const k of ["from", "agent", "status", "title", "slug", "to", "kind"]) {
    if (typeof ev[k] === "string" && (ev[k] as string).length < 60) parts.push(`${ev[k]}`);
  }
  return parts.join(" · ");
}

export function OrgPulse({ events }: { events: StoredEvent[] }) {
  const { data: org } = useLiveQuery(() => api.org(), events, T.agentsActions);
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  const { data: budget } = useLiveQuery(() => api.budget(), events, T.budget);
  const failedBy = new Map<string, number>();
  for (const g of goals ?? []) if (g.status === "failed") failedBy.set(g.lead, (failedBy.get(g.lead) ?? 0) + 1);
  const activity = events.filter((e) => NOTABLE.has(e.event.type)).slice(-6).reverse();

  return (
    <div className="panel p-4 flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <span className="label">Organization · live</span>
        <span className="font-mono text-[11px] text-dim">
          {budget ? `${usd(budget.spentCents)} today` : ""}{budget?.capCents != null ? ` of ${usd(budget.capCents)}` : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5">
        {(org ?? []).map((d) => (
          <div key={d.department} className="card p-3">
            <div className="flex justify-between items-baseline mb-2">
              <span className="label !mb-0">{d.department}</span>
              <span className="font-mono text-[10px] text-dim">{d.agents.length}</span>
            </div>
            {d.agents.map((a) => {
              const failed = failedBy.get(a.name) ?? 0;
              const tone = failed > 0 ? "err" : a.status === "working" ? "agent" : a.status === "waiting" ? "accent" : "dim";
              return (
                <button key={a.name} onClick={() => navigate(`staff/agents/${a.name}`)}
                  className="flex items-center gap-2 py-1 w-full text-left group">
                  <Avatar name={a.name} tone={tone} />
                  <span className={`text-[11.5px] group-hover:text-bright ${a.status === "working" ? "text-strong" : "text-fg"}`}>{a.name}</span>
                  <span className={`text-[9.5px] truncate ml-auto text-right ${failed > 0 ? "text-err" : a.status === "working" ? "text-agent" : "text-dim"}`}>
                    {failed > 0 ? `${failed} failed goal${failed > 1 ? "s" : ""}`
                      : a.status === "working" ? (a.currentTask ?? "working")
                      : a.costTodayUsd > 0 ? `done · ${usdFloat(a.costTodayUsd)}` : "idle"}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {activity.length > 0 && (
        <div className="border-t border-line-soft pt-3">
          <div className="label mb-1.5">Activity</div>
          {activity.map((e) => (
            <div key={e.id} className="font-mono text-[10.5px] text-fg leading-relaxed truncate arrive">
              <span className={EVENT_TONE[e.event.type] ?? "text-dim"}>{e.ts ? tsTime(e.ts) : "—"}</span> {eventLine(e)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
