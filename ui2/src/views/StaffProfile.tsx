// ui2/src/views/StaffProfile.tsx — rich persona explorer: overview / activity / edit
// (spec 2026-07-16-persona-explorer). Extracted from Staff.tsx.
import { useState } from "react";
import { api, type AgentProfileInfo, type StoredEvent } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate, type Route } from "../lib/router.js";
import { Button, Dot, Empty, SectionLabel, Tag, toneOfStatus } from "../components/ui.js";
import { ts, usdFloat } from "../lib/format.js";

export function StaffProfile({ name, events, route, onOpenChat }: {
  name: string; events: StoredEvent[]; route: Route; onOpenChat: (t: string, s?: string) => void;
}) {
  const { data: p, error } = useLiveQuery(() => api.agent(name), events, T.agentsActions, [name]);
  const tab = route.parts[2]; // undefined | "activity" | "edit"
  const [note, setNote] = useState("");
  if (error) return <Empty>{error}</Empty>;
  if (!p) return <Empty>Loading…</Empty>;

  const propose = async (tool: string, action: "grant" | "revoke") => {
    setNote("");
    try { await api.proposePermission(name, tool, action); setNote(`${action} of ${tool} queued for approval`); }
    catch (err) { setNote((err as Error).message); }
  };

  return (
    <div className="max-w-3xl">
      <button onClick={() => navigate("staff")} className="label hover:text-fg mb-3">← staff</button>
      <div className="flex items-center gap-3 flex-wrap mb-1">
        <h2 className="text-[17px] font-bold text-bright">{p.name}</h2>
        <span className="text-dim">{p.title} · {p.department}</span>
        {p.model && <Tag>{p.model}</Tag>}
        <Tag>{p.kind}</Tag>
        {p.visibility === "private" && <Tag>🔒 private</Tag>}
        {p.guarded && <Tag>🛡 guarded</Tag>}
        <Button className="ml-auto" variant="primary" onClick={() => onOpenChat(p.name)}>Chat ⌘J</Button>
      </div>
      {p.aliases.length > 0 && <div className="text-[11px] text-dim mb-2">aka {p.aliases.join(", ")}</div>}
      <div className="flex gap-3 mb-4">
        <button onClick={() => navigate(`staff/agents/${name}`)}
          className={`label hover:text-fg ${!tab ? "text-strong" : ""}`}>overview</button>
        <button onClick={() => navigate(`staff/agents/${name}/activity`)}
          className={`label hover:text-fg ${tab === "activity" ? "text-strong" : ""}`}>activity</button>
        <button onClick={() => navigate(`staff/agents/${name}/edit`)}
          className={`label hover:text-fg ${tab === "edit" ? "text-strong" : ""}`}>edit</button>
      </div>
      {tab === "activity" ? <Activity name={p.name} events={events} />
        : tab === "edit" ? <EditManifest profile={p} />
        : <Overview p={p} note={note} propose={propose} />}
    </div>
  );
}

function Overview({ p, note, propose }: {
  p: AgentProfileInfo; note: string; propose: (tool: string, action: "grant" | "revoke") => void;
}) {
  return (
    <>
      <p className="text-fg leading-relaxed mb-2 whitespace-pre-wrap">{p.charter}</p>
      <p className="text-[13px] text-dim leading-relaxed mb-4 whitespace-pre-wrap">{p.persona}</p>

      {p.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {p.capabilities.map((c) => <Tag key={c}>{c}</Tag>)}
        </div>
      )}

      {p.skills.length > 0 && (
        <>
          <SectionLabel>Skills</SectionLabel>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {p.skills.map((s) => (
              <button key={s} onClick={() => navigate(`skills/${s}`)}><Tag tone="ok">{s}</Tag></button>
            ))}
          </div>
        </>
      )}

      <details className="mb-5">
        <summary className="label cursor-pointer hover:text-fg">system prompt</summary>
        <pre className="font-mono text-[11px] text-dim whitespace-pre-wrap mt-2 p-3 card">{p.prompt}</pre>
      </details>

      <SectionLabel>Access</SectionLabel>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {p.tools.map((t) => (
          <button key={t.name} title={`${t.source} — click to queue revoke`} onClick={() => void propose(t.name, "revoke")}>
            <Tag tone={t.source === "granted" ? "ok" : "dim"}>{t.name}</Tag>
          </button>
        ))}
        {p.revoked.map((t) => (
          <button key={t.name} title="revoked — click to queue grant" onClick={() => void propose(t.name, "grant")}>
            <Tag tone="err">{t.name}</Tag>
          </button>
        ))}
      </div>
      <GrantBox onGrant={(tool) => void propose(tool, "grant")} />
      {note && <div className="text-[11px] text-accent mb-4">{note}</div>}

      <SectionLabel>Trust — {p.department} action types</SectionLabel>
      <div className="flex flex-wrap gap-1.5 mb-5">
        {p.trust.length === 0 && <span className="text-[12px] text-dim">no tracked action types</span>}
        {p.trust.map((t) => (
          <Tag key={t.actionType} tone={t.state === "autonomous" ? "ok" : t.state === "graduating" ? "agent" : "dim"}>
            {t.actionType} · {t.state} · streak {t.streak}
          </Tag>
        ))}
      </div>

      <SectionLabel>Recent runs</SectionLabel>
      <div className="mb-5">
        {p.recentRuns.slice(0, 10).map((r, i) => (
          <div key={i} className="flex gap-3 text-[12px] py-1 items-center">
            <Dot tone={r.ok ? "ok" : "err"} />
            <span className="text-dim">{ts(r.ts)}</span>
            <span className="truncate">{r.context}</span>
            {r.costUsd != null && <span className="text-dim ml-auto">{usdFloat(r.costUsd)}</span>}
          </div>
        ))}
        {p.recentRuns.length === 0 && <span className="text-[12px] text-dim">none yet</span>}
      </div>

      <SectionLabel>Handoffs</SectionLabel>
      <div className="mb-5">
        {p.handoffs.slice(0, 10).map((h, i) => (
          <div key={i} className="flex gap-3 text-[12px] py-1 items-center">
            <span className="text-dim">{ts(h.ts)}</span>
            <span className="truncate">{h.reason}</span>
            <span className="text-dim ml-auto">{h.channel}</span>
          </div>
        ))}
        {p.handoffs.length === 0 && <span className="text-[12px] text-dim">none yet</span>}
      </div>

      <SectionLabel>Cost by day</SectionLabel>
      <Sparkline data={p.costByDay} />
    </>
  );
}

/** Everything that can add a timeline/goals/mail row for an agent. */
const ACTIVITY_TOPICS = [...T.agentsActions, ...T.agentMail, ...T.goals] as const;

const TIMELINE_TONE = { run: "ok", route: "accent", mail: "agent", goal: "dim" } as const;

function Activity({ name, events }: { name: string; events: StoredEvent[] }) {
  const { data: a, error } = useLiveQuery(() => api.agentActivity(name), events, ACTIVITY_TOPICS, [name]);
  if (error) return <Empty>{error}</Empty>;
  if (!a) return <Empty>Loading…</Empty>;
  return (
    <>
      <SectionLabel>Timeline</SectionLabel>
      <div className="mb-5">
        {a.timeline.map((t, i) => (
          <div key={i} className="flex gap-3 text-[12px] py-1 items-center">
            <Dot tone={t.ok === false ? "err" : TIMELINE_TONE[t.kind]} />
            <span className="text-dim">{ts(t.ts)}</span>
            <span className="text-[10px] text-dim w-10">{t.kind}</span>
            <span className="truncate">{t.summary}</span>
          </div>
        ))}
        {a.timeline.length === 0 && <span className="text-[12px] text-dim">no activity yet</span>}
      </div>

      <SectionLabel>Goals</SectionLabel>
      <div className="mb-5">
        {a.goals.map((g) => (
          <div key={g.goalId} className="card px-3 py-2 mb-1.5">
            <div className="flex gap-2 items-center text-[13px]">
              <span className="text-strong truncate">{g.title}</span>
              <Tag tone={toneOfStatus(g.status)}>{g.status}</Tag>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {g.nodes.map((n) => (
                <Tag key={n.key} tone={toneOfStatus(n.status)}>{n.key} · {n.status}</Tag>
              ))}
            </div>
          </div>
        ))}
        {a.goals.length === 0 && <span className="text-[12px] text-dim">no goal work yet</span>}
      </div>

      <SectionLabel>Mail</SectionLabel>
      <div className="mb-5">
        {a.mail.map((m) => (
          <div key={m.id} className="flex gap-3 text-[12px] py-1 items-center">
            <span className="text-dim">{ts(m.ts)}</span>
            <span className="text-strong">{m.from} → {m.to}</span>
            <Tag>{m.kind}</Tag>
            <span className="truncate text-dim">{m.snippet}</span>
          </div>
        ))}
        {a.mail.length === 0 && <span className="text-[12px] text-dim">no mail yet</span>}
      </div>
    </>
  );
}

function EditManifest({ profile: _profile }: { profile: AgentProfileInfo }) {
  return <Empty>soon</Empty>;
}

function GrantBox({ onGrant }: { onGrant: (tool: string) => void }) {
  const [tool, setTool] = useState("");
  return (
    <div className="flex gap-2 mb-2">
      <input value={tool} onChange={(e) => setTool(e.target.value)} placeholder="grant a tool (queues approval)…"
        onKeyDown={(e) => { if (e.key === "Enter" && tool.trim()) { onGrant(tool.trim()); setTool(""); } }}
        className="bg-bg border border-line rounded-md px-2 py-1 text-[12px] outline-none focus:border-dim w-64" />
    </div>
  );
}

function Sparkline({ data }: { data: Record<string, number> }) {
  const days = Object.entries(data).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-14);
  const max = Math.max(0.01, ...days.map(([, v]) => v));
  return (
    <div className="flex items-end gap-1 h-12">
      {days.map(([d, v]) => (
        <div key={d} title={`${d} · ${usdFloat(v)}`} className="w-4 bg-line rounded-sm"
          style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />
      ))}
      {days.length === 0 && <span className="text-[12px] text-dim">no spend</span>}
    </div>
  );
}
