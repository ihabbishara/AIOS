import { useState } from "react";
import { api, setToken, getToken } from "./api.js";
import { useEvents, usePoll } from "./hooks.js";
import { Board } from "./views/Board.js";
import { Agents } from "./views/Agents.js";
import { Chat } from "./views/Chat.js";
import { Config } from "./views/Config.js";
import { Costs } from "./views/Costs.js";
import { EventFeed } from "./views/EventFeed.js";

const TABS = ["board", "agents", "chat", "config", "costs"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [tab, setTab] = useState<Tab>("board");
  const { events, connected } = useEvents();
  const { data: state, error, reload } = usePoll(() => api.state(), []);

  if (error === "unauthorized") return <TokenGate onSet={reload} />;

  const activeAgents = new Map<string, string>();
  for (const e of events) {
    if (e.event.type === "agent.start") activeAgents.set(String(e.event.agent), String(e.event.context));
    if (e.event.type === "agent.end") activeAgents.delete(String(e.event.agent));
  }

  return (
    <div className="h-full flex flex-col">
      {/* Top status bar */}
      <header className="flex items-center gap-6 px-5 h-12 border-b border-line bg-panel shrink-0">
        <div className="font-display font-bold tracking-[0.3em] text-bright text-sm">
          AI<span className="text-phosphor glow-green">⏣</span>OS
        </div>
        <div className="label">Mission Control</div>
        <div className="flex items-center gap-2 ml-auto">
          {[...activeAgents.entries()].map(([agent, ctx]) => (
            <span key={agent} className="px-2 py-0.5 text-[11px] border border-line bg-panel-2 text-amber glow-amber">
              ▸ {agent} <span className="text-dim">{ctx.replace(/^(job|chat):/, "")}</span>
            </span>
          ))}
          {activeAgents.size === 0 && <span className="text-dim text-[11px]">all agents idle</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-phosphor live-dot" : "bg-alert"}`} />
          <span className="label">{connected ? "LINK" : "NO LINK"}</span>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Nav rail */}
        <nav className="w-40 shrink-0 border-r border-line bg-panel flex flex-col py-4 gap-1">
          {TABS.map((t, i) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`boot text-left px-5 py-2.5 font-display uppercase tracking-[0.18em] text-[11px] transition-colors border-l-2 ${
                tab === t
                  ? "border-phosphor text-phosphor glow-green bg-panel-2"
                  : "border-transparent text-dim hover:text-fg hover:border-line"
              }`}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              {t}
            </button>
          ))}
          <div className="mt-auto px-5">
            <div className="label mb-1">Uptime</div>
            <div className="text-[11px] text-fg">{state ? fmtUptime(state.uptimeMs) : "—"}</div>
          </div>
        </nav>

        {/* Main view */}
        <main className="flex-1 min-w-0 overflow-auto p-5">
          {tab === "board" && <Board events={events} />}
          {tab === "agents" && <Agents state={state} events={events} />}
          {tab === "chat" && <Chat state={state} />}
          {tab === "config" && <Config />}
          {tab === "costs" && <Costs events={events} />}
        </main>

        {/* Event feed rail */}
        <aside className="w-72 shrink-0 border-l border-line bg-panel hidden xl:flex flex-col">
          <div className="label px-4 pt-4 pb-2">Telemetry</div>
          <EventFeed events={events} />
        </aside>
      </div>
    </div>
  );
}

function TokenGate({ onSet }: { onSet: () => void }) {
  const [value, setValue] = useState(getToken());
  return (
    <div className="h-full flex items-center justify-center">
      <div className="hud p-8 w-96 boot">
        <div className="font-display text-bright tracking-[0.3em] mb-1">AI⏣OS</div>
        <div className="label mb-6">Access token required</div>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (setToken(value), onSet())}
          placeholder="AIOS_UI_TOKEN"
          className="w-full bg-void border border-line px-3 py-2 text-fg outline-none focus:border-phosphor"
        />
        <button
          onClick={() => { setToken(value); onSet(); }}
          className="mt-4 w-full border border-phosphor text-phosphor py-2 font-display uppercase tracking-[0.2em] text-[11px] hover:bg-phosphor hover:text-void transition-colors"
        >
          Authenticate
        </button>
      </div>
    </div>
  );
}

function fmtUptime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h ? `${h}h ${m}m` : `${m}m`;
}
