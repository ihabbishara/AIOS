// ui2/src/views/System.tsx — events tail · costs · config · health (spec §6 System).
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { useFetch, useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate, type Route } from "../lib/router.js";
import { Button, Dot, Empty, PageHeader, SectionLabel } from "../components/ui.js";
import { TwoStepButton } from "../components/TwoStepButton.js";
import { describeEvent } from "../lib/activity.js";
import { tsTime, usdFloat, usd } from "../lib/format.js";

const TABS = ["health", "events", "costs", "config"] as const;

export function System({ events, route }: { events: StoredEvent[]; route: Route }) {
  const tab = (TABS as readonly string[]).includes(route.parts[0]) ? route.parts[0] : "health";
  return (
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
      <div className="page flex-1 min-h-0 flex flex-col">
        <PageHeader title="System">
          <span className="seg">
            {TABS.map((t) => (
              <button key={t} onClick={() => navigate(t === "health" ? "system" : `system/${t}`)}
                className={`seg-item ${tab === t ? "seg-item-active" : ""}`}>{t}</button>
            ))}
          </span>
        </PageHeader>
        {tab === "health" && <Health events={events} />}
        {tab === "events" && <EventsTail live={events} />}
        {tab === "costs" && <Costs events={events} />}
        {tab === "config" && <ConfigEditor />}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "accent" | "err" }) {
  return (
    <div className="card px-3.5 py-3">
      <div className="label mb-1">{label}</div>
      <div className={`text-[15px] font-semibold font-mono ${tone === "err" ? "text-err" : tone === "accent" ? "text-accent" : "text-strong"}`}>{value}</div>
    </div>
  );
}

function Health({ events }: { events: StoredEvent[] }) {
  const { data: h, reload } = useLiveQuery(() => api.health(), events, T.attention);
  if (!h) return <Empty>Loading…</Empty>;
  const hours = Math.floor(h.uptimeMs / 3_600_000);
  const mins = Math.floor((h.uptimeMs % 3_600_000) / 60_000);
  return (
    <div className="max-w-3xl flex flex-col gap-5">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
        <Stat label="Uptime" value={hours ? `${hours}h ${mins}m` : `${mins}m`} />
        <Stat label="Voice" value={h.voice ? "on" : "off"} />
        <Stat label="Live clients" value={String(h.sseClients)} />
        <Stat label="DB" value={`${(h.dbBytes / 1_048_576).toFixed(1)} MB`} />
        <Stat label="Policy" value={h.policyMode} tone={h.policyMode === "audit" && h.policyViolations > 0 ? "accent" : undefined} />
      </div>
      {h.policyViolations > 0 && (
        // Distinct refusals, and the window is named: the raw event count multiplies with every
        // reconcile replay (199 events were 6 refusals live), and "resets on rebuild" was wrong —
        // it is a rolling tail of the newest events, not something a restart clears.
        <div className="text-[11.5px] text-dim">
          {h.policyViolations} distinct info-flow refusal{h.policyViolations === 1 ? "" : "s"}
          {h.policyViolationsSince ? ` since ${h.policyViolationsSince.slice(0, 10)}` : ""}
          {" "}— each one is a wall doing its job, and a repeat of the same refusal is counted once.
        </div>
      )}
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
  policy: ["policy."],
};

const FAMILY_TONE: Array<[string, string]> = [
  ["goal.", "text-agent"], ["node.", "text-agent"], ["mail.", "text-info"], ["chat.", "text-dim"],
  ["action.", "text-ok"], ["agent.", "text-ok"], ["policy.", "text-accent"], ["tool.denied", "text-err"],
  ["trust.", "text-accent"], ["route.", "text-dim"], ["triage.", "text-dim"],
];
const typeClass = (t: string) => FAMILY_TONE.find(([p]) => (p.endsWith(".") ? t.startsWith(p) : t === p))?.[1] ?? "text-fg";

function EventRow({ e }: { e: StoredEvent }) {
  const [open, setOpen] = useState(false);
  const line = describeEvent(e);
  return (
    <div className="border-b border-line-soft last:border-0">
      <button onClick={() => setOpen((v) => !v)}
        className="w-full text-left flex gap-2.5 items-baseline px-2 py-[3px] hover:bg-raised rounded-sm">
        <span className="font-mono text-[10px] text-dim shrink-0">{tsTime(e.ts)}</span>
        <span className={`font-mono text-[10.5px] shrink-0 w-32 truncate ${typeClass(e.event.type)}`}>{e.event.type}</span>
        <span className="text-[11.5px] text-fg truncate min-w-0 flex-1">
          {line?.text ?? JSON.stringify({ ...e.event, type: undefined }).slice(0, 140)}
        </span>
      </button>
      {open && (
        <pre className="font-mono text-[10.5px] text-dim whitespace-pre-wrap px-2 py-2 mx-2 mb-1.5 card overflow-x-auto">
          {JSON.stringify(e.event, null, 2)}
        </pre>
      )}
    </div>
  );
}

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
        <span className="seg">
          {Object.keys(PRESETS).map((p) => (
            <button key={p} onClick={() => setPreset(p)} className={`seg-item ${preset === p ? "seg-item-active" : ""}`}>{p}</button>
          ))}
        </span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search events…"
          className="bg-bg border border-line rounded-md px-2 py-1 text-[12px] outline-none focus:border-dim w-48" />
        <Button className="ml-auto" onClick={() => setPaused((v) => !v)}>{paused ? "Resume" : "Pause"}</Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto panel !rounded-lg p-1.5">
        {shown.map((e) => <EventRow key={e.id} e={e} />)}
        {shown.length === 0 && <Empty>No events match.</Empty>}
        <div ref={bottom} />
      </div>
      <div className="text-[10px] text-dim mt-1.5 shrink-0">Click a row for the raw payload · newest at the bottom · {shown.length} shown</div>
    </div>
  );
}

function Costs({ events }: { events: StoredEvent[] }) {
  const { data: costs } = useLiveQuery(() => api.costs(), events, T.costs);
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);
  const { data: budget } = useLiveQuery(() => api.budget(), events, T.costs);
  if (!costs) return <Empty>Loading…</Empty>;
  const days = Object.entries(costs.byDay ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const today = days[days.length - 1]?.[1] ?? 0;
  const week = days.slice(-7).reduce((s, [, v]) => s + v, 0);
  const window14 = days.reduce((s, [, v]) => s + v, 0); // /api/costs serves a 14-day window
  const agents = Object.entries(costs.byAgent ?? {}).sort(([, a], [, b]) => b - a);
  const maxAgent = Math.max(0.01, ...agents.map(([, v]) => v));
  const maxDay = Math.max(0.01, ...days.map(([, v]) => v));
  const topGoals = (goals ?? [])
    .map((g) => ({ g, cents: g.nodes.reduce((s, n) => s + n.costCents, 0) }))
    .filter((x) => x.cents > 0)
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 5);

  return (
    <div className="max-w-3xl flex flex-col gap-6">
      <div className="grid grid-cols-3 gap-2.5 max-w-md">
        <Stat label="Today" value={usdFloat(today)} />
        <Stat label="7 days" value={usdFloat(week)} />
        <Stat label="14 days" value={usdFloat(window14)} />
      </div>
      {/* Spend without a limit beside it is only half the picture. This daemon has spent $56.71
          in a single day, and an unset AIOS_DAILY_BUDGET_USD means SpendGuard.allow() is always
          true — so the absence of a cap is the louder fact and has to be said, not implied. */}
      {budget && (
        budget.capCents == null ? (
          <div className="text-[11.5px] text-accent">
            No daily cap — background work is never held back for spend.
            Set a limit in Config → Budgets (AIOS_DAILY_BUDGET_USD).
          </div>
        ) : (
          <div className="text-[11.5px] text-dim">
            {usd(budget.spentCents)} of {usd(budget.capCents)} today
            {" · "}
            {budget.spentCents >= budget.capCents
              ? "cap reached — background work is paused until tomorrow"
              : `${usd(budget.capCents - budget.spentCents)} left`}
          </div>
        )
      )}
      <div>
        <SectionLabel>Last 14 days</SectionLabel>
        <div className="flex items-end gap-1 h-24">
          {days.map(([d, v]) => (
            <div key={d} title={`${d} · ${usdFloat(v)}`} className="flex-1 flex flex-col items-center gap-1 group">
              <div className="w-full bg-info/60 group-hover:bg-info rounded-sm transition-colors"
                style={{ height: `${Math.max(3, (v / maxDay) * 88)}px` }} />
              <span className="text-[8.5px] font-mono text-dim">{"SMTWTFS"[new Date(d).getDay()]}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <SectionLabel>Per agent · all time</SectionLabel>
        {agents.map(([name, v]) => (
          <div key={name} className="flex items-center gap-2 py-0.5 text-[12px]">
            <span className="w-28 text-dim truncate">{name}</span>
            <div className="flex-1 h-2">
              <div className="h-full bg-agent/50 rounded-sm min-w-px" style={{ width: `${(v / maxAgent) * 100}%` }} />
            </div>
            <span className="w-16 text-right font-mono">{usdFloat(v)}</span>
          </div>
        ))}
      </div>
      <div>
        <SectionLabel>Top goals by spend</SectionLabel>
        {topGoals.map(({ g, cents }) => (
          <button key={g.id} onClick={() => navigate(`goals/${g.slug}`)}
            className="w-full text-left flex gap-2 py-1 text-[12px] hover:text-strong">
            <span className="truncate">{g.title}</span>
            <span className="text-dim ml-auto shrink-0 font-mono">{usd(cents)}</span>
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
  Budgets: ["AIOS_DAILY_BUDGET_USD", "AIOS_MAX_CONCURRENT_JOBS", "AIOS_TRUST_SEED", "AIOS_ALWAYS_SUPERVISED"],
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
        {restarting
          ? <Button variant="danger" disabled>Restarting…</Button>
          : <TwoStepButton label="Restart daemon" onConfirm={restart} />}
        {note && <span className="text-[12px] text-dim">{note}</span>}
        {!note && !restarting && <span className="text-[11px] text-dim">Saved changes apply after a restart.</span>}
      </div>
    </div>
  );
}
