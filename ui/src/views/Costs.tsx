import { api, type StoredEvent } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";

export function Costs({ events }: { events: StoredEvent[] }) {
  const { data } = useLiveQuery(() => api.costs(), events, T.costs);
  if (!data) return <div className="text-dim">loading…</div>;

  const agents = Object.entries(data.byAgent).sort((a, b) => b[1] - a[1]);
  const days = Object.entries(data.byDay).sort((a, b) => a[0].localeCompare(b[0])).slice(-14);
  const maxAgent = Math.max(...agents.map(([, v]) => v), 0.001);
  const maxDay = Math.max(...days.map(([, v]) => v), 0.001);
  const total = agents.reduce((s, [, v]) => s + v, 0);

  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      <div className="hud p-4 boot">
        <div className="label mb-1">Total recorded usage (USD-equivalent, covered by subscription)</div>
        <div className="text-3xl font-display text-phosphor glow-green">${total.toFixed(2)}</div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="hud p-4 boot" style={{ animationDelay: "80ms" }}>
          <div className="label mb-4">By agent</div>
          {agents.map(([agent, usd]) => (
            <div key={agent} className="mb-3">
              <div className="flex text-[11px] mb-1">
                <span className="text-fg">{agent}</span>
                <span className="text-dim ml-auto">${usd.toFixed(3)}</span>
              </div>
              <div className="h-2 bg-panel-2">
                <div className="h-full bg-phosphor/70" style={{ width: `${(usd / maxAgent) * 100}%` }} />
              </div>
            </div>
          ))}
          {agents.length === 0 && <div className="text-dim text-[11px]">no usage recorded yet</div>}
        </div>

        <div className="hud p-4 boot" style={{ animationDelay: "160ms" }}>
          <div className="label mb-4">Last 14 days</div>
          <div className="flex items-end gap-1 h-40">
            {days.map(([day, usd]) => (
              <div key={day} className="flex-1 flex flex-col items-center gap-1" title={`${day}: $${usd.toFixed(3)}`}>
                <div className="w-full bg-cyan/60 hover:bg-cyan transition-colors" style={{ height: `${(usd / maxDay) * 100}%` }} />
                <span className="text-[9px] text-dim rotate-45 origin-left">{day.slice(5)}</span>
              </div>
            ))}
            {days.length === 0 && <div className="text-dim text-[11px]">no usage recorded yet</div>}
          </div>
        </div>
      </div>

      <p className="text-[11px] text-dim">
        Figures are the SDK's cost-equivalents per agent run — usage draws from your Claude subscription, not API billing.
      </p>
    </div>
  );
}
