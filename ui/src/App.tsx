import { useCallback, useMemo, useState } from "react";
import { api, setToken, getToken, type BudgetInfo } from "./api.js";
import { useEvents, usePoll } from "./hooks.js";
import { Goals, type GoalTarget } from "./views/Goals.js";
import { Org } from "./views/Org.js";
import { RoutingTrail } from "./views/RoutingTrail.js";
import { Chat } from "./views/Chat.js";
import { Config } from "./views/Config.js";
import { Costs } from "./views/Costs.js";
import { EventFeed } from "./views/EventFeed.js";
import { Approvals } from "./views/Approvals.js";
import { Trust } from "./views/Trust.js";
import { Permissions } from "./views/Permissions.js";
import { Packs } from "./views/Packs.js";

const TABS = ["org", "chat", "routing", "goals", "approvals", "trust", "permissions", "departments", "config", "costs"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [tab, setTab] = useState<Tab>("org");
  const [chatTarget, setChatTarget] = useState("hermes");
  const { events, connected } = useEvents();
  const { data: state, error, reload } = usePoll(() => api.state(), []);
  const openChat = (name: string) => { setChatTarget(name); setTab("chat"); };
  const [goalTarget, setGoalTarget] = useState<GoalTarget | null>(null);
  const openGoal = (slug: string, nodeKey: string | null) => { setGoalTarget({ slug, nodeKey }); setTab("goals"); };
  const consumeGoalTarget = useCallback(() => setGoalTarget(null), []);
  const [agentTarget, setAgentTarget] = useState<string | null>(null);
  const openAgent = (name: string) => { setAgentTarget(name); setTab("org"); };
  const consumeAgentTarget = useCallback(() => setAgentTarget(null), []);
  // Budget refreshes when costs land (agent.end) or goals transition (pause-budget etc.).
  const lastCostEvt = useMemo(
    () => events.filter((e) => e.event.type === "agent.end" || e.event.type.startsWith("goal.")).at(-1)?.id,
    [events],
  );
  const { data: budget } = usePoll(() => api.budget(), [lastCostEvt]);

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
              ▸ {agent} <span className="text-dim">{ctx.replace(/^(job|chat|goal):/, "")}</span>
            </span>
          ))}
          {activeAgents.size === 0 && <span className="text-dim text-[11px]">all agents idle</span>}
        </div>
        <BudgetBar budget={budget} />
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
        {/* All views stay mounted — tab switches hide, not destroy (preserves chat log, drafts, scroll). */}
        <main className="flex-1 min-w-0 overflow-auto p-5">
          <div className={tab === "org" ? "h-full" : "hidden"}><Org events={events} onOpenChat={openChat} onOpenGoal={openGoal} agentTarget={agentTarget} onConsumeAgentTarget={consumeAgentTarget} /></div>
          <div className={tab === "routing" ? "" : "hidden"}><RoutingTrail events={events} /></div>
          <div className={tab === "goals" ? "h-full" : "hidden"}>
            <Goals events={events} target={goalTarget} onConsumeTarget={consumeGoalTarget} onOpenAgent={openAgent} />
          </div>
          <div className={tab === "approvals" ? "" : "hidden"}><Approvals events={events} /></div>
          <div className={tab === "trust" ? "" : "hidden"}><Trust events={events} /></div>
          <div className={tab === "permissions" ? "" : "hidden"}><Permissions events={events} /></div>
          <div className={tab === "departments" ? "" : "hidden"}><Packs events={events} /></div>
          <div className={tab === "chat" ? "h-full" : "hidden"}><Chat state={state} events={events} target={chatTarget} setTarget={setChatTarget} /></div>
          <div className={tab === "config" ? "h-full" : "hidden"}><Config /></div>
          <div className={tab === "costs" ? "" : "hidden"}><Costs events={events} /></div>
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

function BudgetBar({ budget }: { budget: BudgetInfo | undefined }) {
  // Spec §9: hidden entirely when no cap is configured.
  if (!budget || budget.capCents == null) return null;
  const pct = budget.capCents > 0 ? Math.min(100, (budget.spentCents / budget.capCents) * 100) : 100;
  const hot = pct >= 80;
  return (
    <div className="flex items-center gap-2" title={`daily budget · ${budget.date}`}>
      <div className="w-24 h-1.5 bg-panel-2 border border-line">
        <div className={`h-full ${hot ? "bg-alert" : "bg-phosphor"}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-[10px] ${hot ? "text-alert" : "text-dim"}`}>
        ${(budget.spentCents / 100).toFixed(2)} / ${(budget.capCents / 100).toFixed(2)}
      </span>
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
