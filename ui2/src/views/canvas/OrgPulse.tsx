// ui2/src/views/canvas/OrgPulse.tsx — the idle canvas: what the org is doing RIGHT NOW.
// Order encodes urgency: work in flight → live activity → the roster. Feed seeds from
// /api/events history so the page is alive on load, not only after the next event.
import { api, type StoredEvent } from "../../api.js";
import { useFetch, useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { navigate } from "../../lib/router.js";
import { activityFeed } from "../../lib/activity.js";
import { Avatar, Dot, Segments } from "../../components/ui.js";
import { usdFloat, tsTime } from "../../lib/format.js";

const LIVE_GOALS = new Set(["planning", "running", "replanning", "awaiting-mail"]);

export function OrgPulse({ events }: { events: StoredEvent[] }) {
  const { data: org } = useLiveQuery(() => api.org(), events, T.agentsActions);
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  const { data: history } = useFetch(() => api.events(), []);

  const working = (org ?? []).flatMap((d) => d.agents.filter((a) => a.status === "working"));
  const running = (goals ?? []).filter((g) => LIVE_GOALS.has(g.status));
  const failedBy = new Map<string, number>();
  for (const g of goals ?? []) if (g.status === "failed") failedBy.set(g.lead, (failedBy.get(g.lead) ?? 0) + 1);

  // History + live share ids; dedupe so the reconnect replay doesn't double lines.
  const seen = new Set<number>();
  const merged = [...(history ?? []), ...events].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  const feed = activityFeed(merged, 12);

  return (
    <div className="flex flex-col gap-4">
      {/* Work in flight — the reason to glance at this screen. */}
      <div className="panel p-4">
        <div className="label mb-2.5">Now</div>
        {working.length === 0 && running.length === 0 && (
          <div className="text-[12px] text-dim">All quiet — every agent idle. Start something with <span className="text-fg">Chat ⌘J</span>.</div>
        )}
        {working.map((a) => (
          <button key={a.name} onClick={() => navigate(`staff/agents/${a.name}`)}
            className="flex items-center gap-2.5 py-1.5 w-full text-left group">
            <Avatar name={a.name} tone="agent" />
            <span className="text-strong group-hover:text-bright">{a.name}</span>
            <span className="text-[11.5px] text-agent truncate">{a.currentTask ?? "working"}</span>
          </button>
        ))}
        {running.map((g) => (
          <button key={g.id} onClick={() => navigate(`goals/${g.slug}`)}
            className="card card-hover w-full text-left px-3 py-2.5 mt-2 block">
            <div className="flex items-center gap-2 mb-1.5 min-w-0">
              <Dot tone="agent" breathing />
              <span className="text-[12.5px] text-strong font-medium truncate min-w-0 flex-1">{g.title}</span>
              <span className="font-mono text-[10px] text-dim ml-auto shrink-0">
                {g.nodes.filter((n) => n.status === "done").length}/{g.nodes.length} · {g.lead}
              </span>
            </div>
            <Segments statuses={g.nodes.map((n) => n.status)} />
          </button>
        ))}
      </div>

      {/* Live activity — human sentences, streaming in over SSE. */}
      <div className="panel p-4">
        <div className="label mb-2">Activity</div>
        {feed.length === 0 && <div className="text-[12px] text-dim">Nothing logged yet today.</div>}
        {feed.map((e) => (
          <div key={e.id} className="flex gap-2.5 items-baseline py-[3px] text-[11.5px] leading-relaxed arrive min-w-0">
            <span className="font-mono text-[10px] text-dim shrink-0">{e.ts ? tsTime(e.ts).slice(0, 5) : "—"}</span>
            <Dot tone={e.line.tone} />
            <span className="text-fg truncate min-w-0 flex-1">{e.line.text}</span>
          </div>
        ))}
      </div>

      {/* The roster — compact; click through for the full profile. */}
      <div className="panel p-4">
        <div className="label mb-2.5">Organization</div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5">
          {(org ?? []).map((d) => (
            <div key={d.department} className="card p-2.5 min-w-0">
              <div className="flex justify-between items-baseline mb-1.5">
                <span className="label !mb-0">{d.department}</span>
                <span className="font-mono text-[10px] text-dim">{d.agents.length}</span>
              </div>
              {d.agents.map((a) => {
                const failed = failedBy.get(a.name) ?? 0;
                const tone = failed > 0 ? "err" : a.status === "working" ? "agent" : a.status === "waiting" ? "accent" : "dim";
                return (
                  <button key={a.name} onClick={() => navigate(`staff/agents/${a.name}`)}
                    className="flex items-center gap-2 py-[3px] w-full text-left group min-w-0">
                    <Avatar name={a.name} tone={tone} />
                    <span className={`text-[11.5px] group-hover:text-bright ${a.status === "working" ? "text-strong" : "text-fg"}`}>{a.name}</span>
                    <span className={`text-[9.5px] truncate min-w-0 ml-auto text-right ${failed > 0 ? "text-err" : a.status === "working" ? "text-agent" : "text-dim"}`}>
                      {failed > 0 ? `${failed} failed goal${failed > 1 ? "s" : ""}`
                        : a.status === "working" ? "working"
                        : a.costTodayUsd > 0 ? usdFloat(a.costTodayUsd) : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
