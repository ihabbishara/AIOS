// ui2/src/views/System.tsx — events tail · costs · config · health (spec §6 System).
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { useFetch, useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate, type Route } from "../lib/router.js";
import { Button, Dot, Empty, SectionLabel } from "../components/ui.js";
import { tsTime, usdFloat, usd } from "../lib/format.js";

const TABS = ["health", "events", "costs", "config"] as const;

export function System({ events, route }: { events: StoredEvent[]; route: Route }) {
  const tab = (TABS as readonly string[]).includes(route.parts[0]) ? route.parts[0] : "health";
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col">
      <div className="flex gap-3 mb-4 items-center shrink-0">
        <h1 className="text-[20px] text-strong">System</h1>
        {TABS.map((t) => (
          <button key={t} onClick={() => navigate(t === "health" ? "system" : `system/${t}`)}
            className={`label hover:text-fg ${tab === t ? "text-strong" : ""}`}>{t}</button>
        ))}
      </div>
      {tab === "health" && <Health events={events} />}
      {tab === "events" && <EventsTail live={events} />}
      {tab === "costs" && <Costs events={events} />}
      {tab === "config" && <ConfigEditor />}
    </div>
  );
}

function Health({ events }: { events: StoredEvent[] }) {
  const { data: h, reload } = useLiveQuery(() => api.health(), events, T.attention);
  if (!h) return <Empty>Loading…</Empty>;
  const hours = Math.floor(h.uptimeMs / 3_600_000);
  const mins = Math.floor((h.uptimeMs % 3_600_000) / 60_000);
  return (
    <div className="max-w-xl flex flex-col gap-4">
      <div className="border border-line rounded-lg bg-surface p-4 grid grid-cols-2 gap-3 text-[12px]">
        <span className="text-dim">Daemon uptime</span><span>{hours ? `${hours}h ${mins}m` : `${mins}m`}</span>
        <span className="text-dim">Voice</span><span>{h.voice ? "available" : "off"}</span>
        <span className="text-dim">SSE clients</span><span>{h.sseClients}</span>
        <span className="text-dim">DB size</span><span>{(h.dbBytes / 1_048_576).toFixed(1)} MB</span>
      </div>
      <div>
        <SectionLabel>Senses</SectionLabel>
        {h.senses.length === 0 && <Empty>No senses configured.</Empty>}
        {h.senses.map((s) => (
          <div key={s.name} className="flex items-center gap-2 py-1 text-[12px]">
            <Dot tone={s.ok ? "ok" : "err"} />
            <span>{s.name}</span>
            {!s.ok && <span className="text-err">{s.reason ?? "degraded"} — re-auth from a terminal</span>}
          </div>
        ))}
      </div>
      <Button onClick={reload} className="w-fit">Refresh</Button>
    </div>
  );
}

const PRESETS: Record<string, string[]> = {
  all: [],
  routing: ["route.", "triage."],
  goals: ["goal.", "node."],
  agents: ["agent."],
  actions: ["action.", "trust.", "permission.", "tool.denied"],
  chat: ["chat."],
  mail: ["mail."],
};

function EventsTail({ live }: { live: StoredEvent[] }) {
  const { data: history } = useFetch(() => api.events(), []);
  const [preset, setPreset] = useState("all");
  const [q, setQ] = useState("");
  const [paused, setPaused] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const frozen = useRef<StoredEvent[]>([]);

  const merged = useMemo(() => {
    const seen = new Set<number>();
    return [...(history ?? []), ...live].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  }, [history, live]);
  if (paused && frozen.current.length === 0) frozen.current = merged;
  if (!paused) frozen.current = [];
  const shown = (paused ? frozen.current : merged).filter((e) => {
    const pats = PRESETS[preset];
    const typeOk = pats.length === 0 || pats.some((p) => (p.endsWith(".") ? e.event.type.startsWith(p) : e.event.type === p));
    const text = JSON.stringify(e.event).toLowerCase();
    return typeOk && (!q || text.includes(q.toLowerCase()));
  }).slice(-500);

  useEffect(() => {
    if (!paused) bottom.current?.scrollIntoView();
  }, [shown.length, paused]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex gap-2 mb-2 items-center shrink-0 flex-wrap">
        {Object.keys(PRESETS).map((p) => (
          <button key={p} onClick={() => setPreset(p)} className={`label hover:text-fg ${preset === p ? "text-strong" : ""}`}>{p}</button>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…"
          className="bg-bg border border-line rounded-md px-2 py-1 text-[12px] outline-none focus:border-dim w-48" />
        <Button className="ml-auto" onClick={() => setPaused((v) => !v)}>{paused ? "Resume" : "Pause"}</Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto font-mono text-[11px] text-dim border border-line rounded-lg bg-bg p-2">
        {shown.map((e) => (
          <div key={e.id} className="whitespace-nowrap">
            <span className="text-line">{tsTime(e.ts)}</span>{" "}
            <span className="text-fg">{e.event.type}</span>{" "}
            {JSON.stringify({ ...e.event, type: undefined }).slice(0, 180)}
          </div>
        ))}
        <div ref={bottom} />
      </div>
    </div>
  );
}

function Costs({ events }: { events: StoredEvent[] }) {
  const { data: costs } = useLiveQuery(() => api.costs(), events, T.costs);
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  if (!costs) return <Empty>Loading…</Empty>;
  const days = Object.entries(costs.byDay).sort(([a], [b]) => (a < b ? -1 : 1));
  const today = days[days.length - 1]?.[1] ?? 0;
  const week = days.slice(-7).reduce((s, [, v]) => s + v, 0);
  const window14 = days.reduce((s, [, v]) => s + v, 0); // /api/costs serves a 14-day window
  const agents = Object.entries(costs.byAgent).sort(([, a], [, b]) => b - a);
  const maxAgent = Math.max(0.01, ...agents.map(([, v]) => v));
  const maxDay = Math.max(0.01, ...days.map(([, v]) => v));
  const topGoals = (goals ?? [])
    .map((g) => ({ g, cents: g.nodes.reduce((s, n) => s + n.costCents, 0) }))
    .filter((x) => x.cents > 0)
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 5);

  return (
    <div className="max-w-3xl flex flex-col gap-6">
      <div className="flex gap-6 text-[13px]">
        <span><span className="text-dim">today </span><span className="text-strong">{usdFloat(today)}</span></span>
        <span><span className="text-dim">7d </span><span className="text-strong">{usdFloat(week)}</span></span>
        <span><span className="text-dim">14d </span><span className="text-strong">{usdFloat(window14)}</span></span>
      </div>
      <div>
        <SectionLabel>Per agent</SectionLabel>
        {agents.map(([name, v]) => (
          <div key={name} className="flex items-center gap-2 py-0.5 text-[12px]">
            <span className="w-24 text-dim truncate">{name}</span>
            <div className="flex-1 h-2 bg-raised rounded-sm"><div className="h-full bg-line rounded-sm" style={{ width: `${(v / maxAgent) * 100}%` }} /></div>
            <span className="w-14 text-right">{usdFloat(v)}</span>
          </div>
        ))}
      </div>
      <div>
        <SectionLabel>Last 14 days</SectionLabel>
        <div className="flex items-end gap-1 h-24">
          {days.map(([d, v]) => (
            <div key={d} title={`${d} · ${usdFloat(v)}`} className="flex-1 bg-line rounded-sm" style={{ height: `${Math.max(3, (v / maxDay) * 100)}%` }} />
          ))}
        </div>
      </div>
      <div>
        <SectionLabel>Top goals by spend</SectionLabel>
        {topGoals.map(({ g, cents }) => (
          <button key={g.id} onClick={() => navigate(`goals/${g.slug}`)}
            className="w-full text-left flex gap-2 py-1 text-[12px] hover:text-strong">
            <span className="truncate">{g.title}</span>
            <span className="text-dim ml-auto shrink-0">{usd(cents)}</span>
          </button>
        ))}
        {topGoals.length === 0 && <Empty>No goal spend yet.</Empty>}
      </div>
    </div>
  );
}

const CONFIG_GROUPS: Record<string, string[]> = {
  Channels: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "AIOS_CHAT_BINDINGS"],
  Models: ["CLAUDE_CODE_OAUTH_TOKEN", "AIOS_MODERATOR_MODEL", "AIOS_SPECIALIST_MODEL"],
  Anchors: ["AIOS_FINANCE_COMPANY", "AIOS_FINANCE_MEMBERS", "AIOS_PROJECTS_ROOT"],
  Budgets: ["AIOS_MAX_CONCURRENT_JOBS", "AIOS_TRUST_SEED", "AIOS_ALWAYS_SUPERVISED"],
  Senses: ["AIOS_GMAIL_POLL_SECONDS", "AIOS_CALENDAR_POLL_SECONDS", "AIOS_MEETING_PING_MINUTES", "AIOS_GMAIL_SKIP_CATEGORIES"],
  Security: ["AIOS_UI_TOKEN"],
};

function ConfigEditor() {
  const { data: cfg, reload } = useFetch(() => api.config(), []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [restarting, setRestarting] = useState(false);
  if (!cfg) return <Empty>Loading…</Empty>;
  const byKey = new Map(cfg.map((c) => [c.key, c]));
  const grouped = new Set(Object.values(CONFIG_GROUPS).flat());

  const save = async (key: string) => {
    setNote("");
    try {
      const { note: n } = await api.saveConfig(key, drafts[key] ?? "");
      setNote(n || `${key} saved — restart to apply`);
      setDrafts((d) => { const { [key]: _, ...rest } = d; return rest; });
      reload();
    } catch (err) { setNote((err as Error).message); }
  };

  const restart = async () => {
    setRestarting(true);
    await api.restart().catch(() => {}); // the daemon exits mid-response
    // Poll /api/state for real readiness — no fake timers (spec §4).
    const poll = async () => {
      try { await api.state(); setRestarting(false); reload(); }
      catch { setTimeout(poll, 2000); }
    };
    setTimeout(poll, 3000);
  };

  const row = (c: { key: string; secret: boolean; set: boolean; value: string }) => (
    <div key={c.key} className="flex items-center gap-2 py-1">
      <span className="w-64 font-mono text-[11px] text-dim truncate">{c.key}</span>
      <input
        type={c.secret ? "password" : "text"}
        value={drafts[c.key] ?? c.value}
        placeholder={c.set ? (c.secret ? "••••••" : "") : "unset"}
        onChange={(e) => setDrafts((d) => ({ ...d, [c.key]: e.target.value }))}
        className="flex-1 bg-bg border border-line rounded-md px-2 py-1 text-[12px] outline-none focus:border-dim"
      />
      {drafts[c.key] !== undefined && <Button variant="primary" onClick={() => void save(c.key)}>Save</Button>}
    </div>
  );

  return (
    <div className="max-w-2xl">
      {Object.entries(CONFIG_GROUPS).map(([group, keys]) => {
        const rows = keys.map((k) => byKey.get(k)).filter((c): c is NonNullable<typeof c> => !!c);
        if (rows.length === 0) return null;
        return (
          <div key={group} className="mb-5">
            <SectionLabel>{group}</SectionLabel>
            {rows.map(row)}
          </div>
        );
      })}
      {/* Any UI-editable key the groups above miss still shows up (server owns the list). */}
      {cfg.filter((c) => !grouped.has(c.key)).map(row)}
      <div className="flex items-center gap-3 mt-4">
        <Button variant="danger" disabled={restarting} onClick={restart}>{restarting ? "Restarting…" : "Restart daemon"}</Button>
        {note && <span className="text-[12px] text-dim">{note}</span>}
      </div>
    </div>
  );
}
