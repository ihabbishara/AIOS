import { useState } from "react";
import { api, setToken, getToken, type BudgetInfo } from "./api.js";
import { useEvents, useFetch, useLiveQuery } from "./hooks.js";
import { T } from "./lib/topics.js";
import { useRoute, navigate, type Route } from "./lib/router.js";
import { Goals } from "./views/Goals.js";
import { Mail } from "./views/Mail.js";
import { Org } from "./views/Org.js";
import { RoutingTrail } from "./views/RoutingTrail.js";
import { ChatDrawer } from "./components/ChatDrawer.js";
import { Config } from "./views/Config.js";
import { Costs } from "./views/Costs.js";
import { EventFeed } from "./views/EventFeed.js";
import { Inbox } from "./views/Inbox.js";
import { Governance } from "./views/Governance.js";
import { Packs } from "./views/Packs.js";

// zone → ordered sub-views. First entry is the zone default.
const SUBNAV: Record<string, string[]> = {
  inbox: [],
  work: ["goals", "mail"],
  staff: ["org", "governance"],
  system: ["departments", "config", "costs", "routing"],
};

/** Which leaf view a route shows. Every leaf stays mounted; this only picks visibility. */
function leafOf(route: Route): string {
  const sub = route.parts[0];
  if (route.zone === "inbox") return "inbox";
  if (route.zone === "work") return sub === "mail" ? "mail" : "goals";
  if (route.zone === "staff") {
    if (sub === "agents") return "org"; // profile drill-in renders inside Org
    return sub === "governance" ? "governance" : "org";
  }
  return sub === "config" ? "config" : sub === "costs" ? "costs" : sub === "routing" ? "routing" : "departments";
}

export function App() {
  const route = useRoute();
  const leaf = leafOf(route);
  const [chatTarget, setChatTarget] = useState("hermes");
  const [chatOpen, setChatOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem("aios_rail") !== "0");
  const { events, connected } = useEvents();
  const { data: state, error, reload } = useFetch(() => api.state(), []);
  const { data: budget } = useLiveQuery(() => api.budget(), events, T.budget);
  const { data: unread } = useLiveQuery(() => api.mailUnread(), events, T.agentMail);
  const { data: pending } = useLiveQuery(() => api.actions("proposed"), events, T.actions);

  const openChat = (name: string) => { setChatTarget(name); setChatOpen(true); };
  const toggleRail = () => setRailOpen((v) => { localStorage.setItem("aios_rail", v ? "0" : "1"); return !v; });

  if (error === "unauthorized") return <TokenGate onSet={reload} />;

  const activeAgents = new Map<string, string>();
  for (const e of events) {
    if (e.event.type === "agent.start") activeAgents.set(String(e.event.agent), String(e.event.context));
    if (e.event.type === "agent.end") activeAgents.delete(String(e.event.agent));
  }

  const inboxCount = (pending?.length ?? 0) + (unread?.userInbox ?? 0) + (unread?.pendingUser ?? 0);

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
        <button onClick={() => setChatOpen((v) => !v)}
          className={`label hover:text-fg ${chatOpen ? "text-phosphor" : ""}`}>comms</button>
        <button onClick={toggleRail} title="toggle telemetry" className={`label hover:text-fg ${railOpen ? "text-phosphor" : ""}`}>
          ◫
        </button>
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-phosphor live-dot" : "bg-alert"}`} />
          <span className="label">{connected ? "LINK" : "NO LINK"}</span>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Zone rail */}
        <nav className="w-40 shrink-0 border-r border-line bg-panel flex flex-col py-4 gap-1">
          {(["inbox", "work", "staff", "system"] as const).map((z, i) => (
            <div key={z}>
              <button
                onClick={() => navigate(z)}
                className={`boot w-full text-left px-5 py-2.5 font-display uppercase tracking-[0.18em] text-[11px] transition-colors border-l-2 ${
                  route.zone === z
                    ? "border-phosphor text-phosphor glow-green bg-panel-2"
                    : "border-transparent text-dim hover:text-fg hover:border-line"
                }`}
                style={{ animationDelay: `${i * 60}ms` }}
              >
                {z}
                {z === "inbox" && inboxCount > 0 && (
                  <span className="ml-2 text-[9px] text-void bg-amber px-1.5 rounded-full tracking-normal align-middle">{inboxCount}</span>
                )}
                {z === "staff" && unread && unread.total > 0 && (
                  <span className="ml-2 text-[9px] text-void bg-amber px-1.5 rounded-full tracking-normal align-middle">{unread.total}</span>
                )}
              </button>
              {route.zone === z && SUBNAV[z].map((s) => (
                <button
                  key={s}
                  onClick={() => navigate(`${z}/${s}`)}
                  className={`w-full text-left pl-8 pr-2 py-1.5 text-[10px] uppercase tracking-[0.15em] transition-colors ${
                    leaf === leafOf({ zone: z, parts: [s], query: new URLSearchParams() })
                      ? "text-bright"
                      : "text-dim hover:text-fg"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          ))}
          <div className="mt-auto px-5">
            <div className="label mb-1">Uptime</div>
            <div className="text-[11px] text-fg">{state ? fmtUptime(state.uptimeMs) : "—"}</div>
          </div>
        </nav>

        {/* Main view — every leaf stays mounted; route picks visibility. */}
        <main className="flex-1 min-w-0 overflow-auto p-5">
          <div className={leaf === "inbox" ? "h-full" : "hidden"}><Inbox events={events} /></div>
          <div className={leaf === "goals" ? "h-full" : "hidden"}><Goals events={events} route={route} /></div>
          <div className={leaf === "mail" ? "h-full" : "hidden"}><Mail events={events} route={route} /></div>
          <div className={leaf === "org" ? "h-full" : "hidden"}><Org events={events} route={route} onOpenChat={openChat} unreadByAgent={unread?.byAgent ?? {}} /></div>
          <div className={leaf === "governance" ? "" : "hidden"}><Governance events={events} /></div>
          <div className={leaf === "departments" ? "h-full" : "hidden"}><Packs events={events} /></div>
          <div className={leaf === "config" ? "h-full" : "hidden"}><Config /></div>
          <div className={leaf === "costs" ? "" : "hidden"}><Costs events={events} /></div>
          <div className={leaf === "routing" ? "" : "hidden"}><RoutingTrail events={events} /></div>
        </main>

        {/* Telemetry rail — toggleable at every width now. */}
        {railOpen && (
          <aside className="w-72 shrink-0 border-l border-line bg-panel hidden lg:flex flex-col">
            <div className="label px-4 pt-4 pb-2">Telemetry</div>
            <EventFeed events={events} />
          </aside>
        )}
      </div>

      <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)}
        state={state} events={events} target={chatTarget} setTarget={setChatTarget} />
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
