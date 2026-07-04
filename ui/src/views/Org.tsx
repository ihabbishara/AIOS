// ui/src/views/Org.tsx — org-first home: department columns, live agent cards, profile drill-in.
import { useEffect, useMemo, useState } from "react";
import { api, type OrgAgentCard, type StoredEvent } from "../api.js";
import { usePoll } from "../hooks.js";

const DEPT_ORDER = ["operations", "engineering", "research", "finance", "life", "clients"];

const STATUS_DOT: Record<OrgAgentCard["status"], string> = {
  idle: "bg-panel-2 border border-line",
  working: "bg-amber live-dot",
  waiting: "bg-alert live-dot",
};

export function Org({ events, onOpenChat, onOpenGoal, agentTarget, onConsumeAgentTarget }: {
  events: StoredEvent[]; onOpenChat: (name: string) => void; onOpenGoal: (slug: string, nodeKey: string | null) => void;
  agentTarget: string | null; onConsumeAgentTarget: () => void;
}) {
  // Re-fetch when agent or action events arrive — same lastEvt pattern as Packs.
  const lastEvt = useMemo(
    () => events.filter((e) => e.event.type.startsWith("agent.") || e.event.type.startsWith("action.")).at(-1)?.id,
    [events],
  );
  const { data: org } = usePoll(() => api.org(), [lastEvt]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!agentTarget) return;
    setSelected(agentTarget);
    onConsumeAgentTarget();
  }, [agentTarget, onConsumeAgentTarget]);

  if (selected) return <AgentProfile name={selected} events={events} onBack={() => setSelected(null)} onOpenChat={onOpenChat} onOpenGoal={onOpenGoal} />;
  if (!org) return <div className="text-dim">loading…</div>;

  const depts = [...org].sort(
    (a, b) => (DEPT_ORDER.indexOf(a.department) + 99) - (DEPT_ORDER.indexOf(b.department) + 99),
  );

  return (
    <div className="flex gap-4 items-start overflow-x-auto h-full min-h-0 pb-2">
      {depts.map((d, i) => (
        <section key={d.department} className="boot w-64 shrink-0" style={{ animationDelay: `${i * 60}ms` }}>
          <div className="mb-2">
            <div className="font-display uppercase tracking-[0.2em] text-[12px] text-phosphor glow-green">{d.department}</div>
            <div className="text-[10px] text-dim mt-0.5 line-clamp-2">{d.mission}</div>
            {d.lead && <div className="text-[10px] text-cyan mt-0.5">lead: {d.lead}</div>}
          </div>
          <div className="flex flex-col gap-2">
            {d.agents.map((a) => (
              <button key={a.name} onClick={() => setSelected(a.name)}
                className={`hud p-3 text-left hover:border-phosphor transition-colors ${a.status !== "idle" ? "hud-amber running-sweep" : ""}`}>
                <div className="flex items-center gap-2">
                  <span className={`inline-block w-2 h-2 rounded-full ${STATUS_DOT[a.status]}`} />
                  <span className="font-display text-bright tracking-wider text-[13px]">{a.name}</span>
                  {a.visibility === "private" && <span className="text-[9px] text-violet border border-violet px-1">private</span>}
                  {a.guarded && <span title="deterministic tool gate" className="text-[9px] text-cyan border border-cyan px-1">⛨</span>}
                  <span className={`ml-auto text-[9px] ${a.status === "idle" ? "text-dim" : a.status === "waiting" ? "text-alert" : "text-amber"}`}>
                    {a.status}
                  </span>
                </div>
                <div className="text-[10px] text-dim mt-1">{a.title}</div>
                {a.currentTask && a.currentTask.startsWith("goal:") ? (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      const [slug, nodeKey] = a.currentTask!.slice("goal:".length).split("/");
                      onOpenGoal(slug, nodeKey ?? null);
                    }}
                    className="block text-[10px] text-amber mt-1 truncate underline decoration-dotted cursor-pointer hover:text-bright"
                  >
                    ▸ {a.currentTask.slice("goal:".length)}
                  </span>
                ) : a.currentTask && (
                  <div className="text-[10px] text-amber mt-1 truncate">▸ {a.currentTask.replace(/^(job|chat):/, "")}</div>
                )}
                <div className="text-[10px] text-dim mt-1">today: ${a.costTodayUsd.toFixed(2)}</div>
              </button>
            ))}
          </div>
        </section>
      ))}
      {depts.length === 0 && (
        <div className="border border-dashed border-line text-dim text-[11px] p-4">no departments loaded</div>
      )}
    </div>
  );
}

function AgentProfile({ name, events, onBack, onOpenChat, onOpenGoal }: {
  name: string; events: StoredEvent[]; onBack: () => void;
  onOpenChat: (name: string) => void; onOpenGoal: (slug: string, nodeKey: string | null) => void;
}) {
  const { data: p, error } = usePoll(() => api.agent(name), [name]);
  if (error) return <div className="text-alert text-[12px]">error: {error} <button className="text-dim underline" onClick={onBack}>back</button></div>;
  if (!p) return <div className="text-dim">loading…</div>;

  return (
    <div className="max-w-3xl flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-[11px] text-dim border border-line px-2 py-1 hover:text-fg hover:border-fg">← org</button>
        <span className="font-display text-bright tracking-wider text-lg">{p.name}</span>
        <span className="text-[11px] text-dim">{p.title} · {p.department}</span>
        {p.visibility === "private" && <span className="text-[9px] text-violet border border-violet px-1">private</span>}
        {p.guarded && <span className="text-[9px] text-cyan border border-cyan px-1">⛨ guarded</span>}
        <button onClick={() => onOpenChat(p.name)}
          className="ml-auto border border-phosphor text-phosphor px-4 py-1.5 font-display uppercase tracking-[0.2em] text-[11px] hover:bg-phosphor hover:text-void transition-colors">
          Chat
        </button>
      </div>

      <div className="hud p-4">
        <div className="label mb-1">Charter</div>
        <p className="text-[12px] text-fg leading-relaxed whitespace-pre-wrap">{p.charter}</p>
        <div className="label mb-1 mt-3">Persona</div>
        <p className="text-[12px] text-dim leading-relaxed whitespace-pre-wrap">{p.persona}</p>
        <div className="text-[10px] text-dim mt-3">
          mode: {p.permissionMode} · maxTurns: {p.maxTurns}
          {p.model ? ` · model: ${p.model}` : ""}
          {p.aliases.length ? ` · aliases: ${p.aliases.join(", ")}` : ""}
        </div>
        {!!p.skills.length && <div className="text-[11px] text-violet mt-1">skills: {p.skills.join(", ")}</div>}
      </div>

      <div className="hud p-4">
        <div className="label mb-2">Effective tools</div>
        <div className="flex flex-wrap gap-1">
          {p.tools.map((t) => (
            <span key={t.name}
              className={`text-[10px] px-1.5 py-0.5 border ${t.source === "granted" ? "border-phosphor text-phosphor" : "border-line text-dim"}`}>
              {t.name}{t.source === "granted" ? " +" : ""}
            </span>
          ))}
          {p.revoked.map((t) => (
            <span key={t.name} className="text-[10px] px-1.5 py-0.5 border border-alert text-alert line-through">{t.name}</span>
          ))}
        </div>
      </div>

      <MailSection name={p.name} events={events} onOpenGoal={onOpenGoal} />

      {p.trust.length > 0 && (
        <div className="hud p-4">
          <div className="label mb-2">Trust</div>
          {p.trust.map((t) => (
            <div key={t.actionType} className="text-[11px] flex gap-3">
              <span className="text-fg w-40">{t.actionType}</span>
              <span className={t.state === "autonomous" ? "text-phosphor" : t.state === "graduating" ? "text-amber" : "text-dim"}>{t.state}</span>
              <span className="text-dim">✓{t.approvals} ✗{t.rejections} streak {t.streak}</span>
            </div>
          ))}
        </div>
      )}

      <div className="hud p-4">
        <div className="label mb-2">Recent runs</div>
        {p.recentRuns.length === 0 && <div className="text-[11px] text-dim">no runs yet</div>}
        {p.recentRuns.map((r, i) => (
          <div key={i} className="text-[11px] flex gap-2">
            <span className="text-dim">{r.ts.slice(5, 16).replace("T", " ")}</span>
            <span className={r.ok ? "text-phosphor" : "text-alert"}>{r.ok ? "ok" : "FAILED"}</span>
            <span className="text-fg truncate">{r.context.replace(/^(job|chat):/, "")}</span>
            {r.costUsd != null && <span className="text-dim ml-auto">${r.costUsd.toFixed(3)}</span>}
          </div>
        ))}
      </div>

      {p.handoffs.length > 0 && (
        <div className="hud p-4">
          <div className="label mb-2">Handoffs received</div>
          {p.handoffs.map((h, i) => (
            <div key={i} className="text-[11px] flex gap-2">
              <span className="text-dim">{h.ts.slice(5, 16).replace("T", " ")}</span>
              <span className="text-fg">{h.reason}</span>
              <span className="text-dim ml-auto">{h.channel}:{h.chatId}</span>
            </div>
          ))}
        </div>
      )}

      {Object.keys(p.costByDay).length > 0 && (
        <div className="hud p-4">
          <div className="label mb-2">Cost history</div>
          {Object.entries(p.costByDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14).map(([day, usd]) => (
            <div key={day} className="text-[11px] flex gap-3">
              <span className="text-dim">{day}</span>
              <span className="text-fg">${usd.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const MAIL_KIND: Record<string, string> = {
  request: "text-amber", note: "text-dim", report: "text-cyan", standup: "text-violet", refused: "text-alert",
};

function MailSection({ name, events, onOpenGoal }: {
  name: string; events: StoredEvent[]; onOpenGoal: (slug: string, nodeKey: string | null) => void;
}) {
  const lastMailEvt = useMemo(
    () => events.filter((e) => e.event.type.startsWith("mail.")).at(-1)?.id,
    [events],
  );
  const { data: mail } = usePoll(() => api.mail(name), [name, lastMailEvt]);
  if (!mail) return null;

  const received = mail.filter((m) => m.to === name);
  const unread = received.filter((m) => m.readAt === null).length;

  return (
    <div className="hud p-4">
      <div className="label mb-2 flex items-center gap-2">
        Mail
        {unread > 0 && <span className="text-[9px] text-void bg-amber px-1.5 rounded-full">{unread}</span>}
      </div>
      {mail.length === 0 && <div className="text-[11px] text-dim">no mail</div>}
      {mail.map((m) => {
        const sent = m.from === name;
        const isUnread = !sent && m.readAt === null;
        return (
          <div key={m.id} className="text-[11px] flex gap-2 items-baseline py-0.5">
            <span className="text-dim w-24 shrink-0">{m.createdAt.slice(5, 16).replace("T", " ")}</span>
            <span className="text-dim w-4 shrink-0">{sent ? "→" : "←"}</span>
            <span className="text-fg w-16 shrink-0 truncate">{sent ? m.to : m.from}</span>
            <span className={`w-14 shrink-0 ${MAIL_KIND[m.kind] ?? "text-dim"}`}>{m.kind}</span>
            <span className={`truncate ${isUnread ? "text-bright" : "text-dim"}`}>{m.body}</span>
            {m.goalId && (
              <span
                onClick={() => onOpenGoal(m.goalId!, null)}
                className="ml-auto shrink-0 text-amber underline decoration-dotted cursor-pointer hover:text-bright"
              >▸ goal</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
