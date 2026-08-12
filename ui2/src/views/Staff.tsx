// ui2/src/views/Staff.tsx — org columns + governance + department admin (spec §6 Staff).
// The rich per-agent profile lives in StaffProfile.tsx (persona explorer).
import { useState } from "react";
import { api, type OrgAgentCard, type OrgGrowthProposal, type PackView, type StoredEvent } from "../api.js";
import { useFetch, useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate, type Route } from "../lib/router.js";
import { Avatar, Button, Empty, PageHeader, SectionLabel, Tag } from "../components/ui.js";
import { TwoStepButton } from "../components/TwoStepButton.js";
import { agentClock, lastActiveText, STAFF_TEXT, STAFF_TOKEN } from "../lib/staff-clock.js";
import { ts, usdFloat } from "../lib/format.js";
import { StaffProfile } from "./StaffProfile.js";

export function Staff({ events, route, onOpenChat }: {
  events: StoredEvent[]; route: Route; onOpenChat: (t: string, s?: string) => void;
}) {
  const sub = route.parts[0];
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="page">
      {sub !== "agents" && (
        <PageHeader title="Staff">
          <span className="seg">
            <button onClick={() => navigate("staff")}
              className={`seg-item ${!sub ? "seg-item-active" : ""}`}>org</button>
            <button onClick={() => navigate("staff/governance")}
              className={`seg-item ${sub === "governance" ? "seg-item-active" : ""}`}>governance</button>
          </span>
        </PageHeader>
      )}
      {sub === "agents" && route.parts[1]
        ? <StaffProfile name={route.parts[1]} events={events} route={route} onOpenChat={onOpenChat} />
        : sub === "governance"
          ? <Governance events={events} />
          : <OrgColumns events={events} />}
      </div>
    </div>
  );
}

/** One agent, led by aliveness (spec 2026-08-04 §2). The dot's colour is the clock;
 *  it breathes only for a run happening RIGHT NOW, never for "was active lately". */
function AgentCard({ a, today, unread }: { a: OrgAgentCard; today: string; unread: number }) {
  const clock = agentClock(a.lastActiveAt, today);
  // goals led first: an agent can lead 26 goals while executing almost no nodes,
  // and that division of labour is the point of the line.
  const work = [
    a.goalsLed > 0 ? `${a.goalsLed} goals led` : null,
    a.nodes > 0 ? `${a.nodes} nodes` : null,
    a.mail > 0 ? `${a.mail} mail` : null,
    a.costUsd > 0 ? usdFloat(a.costUsd) : null,
  ].filter(Boolean).join(" · ");
  return (
    <button onClick={() => navigate(`staff/agents/${a.name}`)}
      className={`card card-hover w-full text-left px-2.5 py-2 mb-1.5 flex flex-col gap-0.5 min-h-11 ${
        clock === "never" ? "opacity-55" : ""}`}>
      <span className="flex items-center gap-2">
        <span data-testid="staff-clock" data-clock={clock}
          className={`size-1.5 rounded-full shrink-0 ${STAFF_TOKEN[clock]} ${a.status === "working" ? "breath" : ""}`} />
        <Avatar name={a.name} tone={a.status === "working" ? "agent" : a.status === "waiting" ? "accent" : "dim"} />
        <span className="text-strong">{a.name}</span>
        <span className="text-[10px] text-dim truncate">{a.title}</span>
        <span className="ml-auto flex gap-1 items-center text-[10px] shrink-0">
          {a.visibility === "private" && <span title="private — only you can reach this agent">🔒</span>}
          {a.guarded && <span title="guarded — extra approval gates">🛡</span>}
          {unread > 0 && <Tag tone="accent">{unread}</Tag>}
          <span className={`font-mono ${STAFF_TEXT[clock]}`}>{lastActiveText(a.lastActiveAt, today)}</span>
        </span>
      </span>
      {a.currentTask && <span className="text-[11px] text-agent truncate">{a.currentTask}</span>}
      {work
        ? <span className="text-[10px] text-dim font-mono">{work}</span>
        : a.runs > 0
          // Ran, but left no goal, node, mail or cost behind — the whole finance
          // department looks like this. Saying nothing here would read as idle.
          ? <span className="text-[10px] text-dim font-mono">{a.runs} runs · no output</span>
          : <span className="text-[10px] text-dim">hired, never run</span>}
    </button>
  );
}

function OrgColumns({ events }: { events: StoredEvent[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: org, reload: reloadOrg } = useLiveQuery(() => api.org(), events, T.agentsActions);
  const { data: unread } = useLiveQuery(() => api.mailUnread(), events, T.agentMail);
  const { data: packs, reload: reloadPacks } = useFetch(() => api.packs(), []);
  const { data: state } = useFetch(() => api.state(), []);
  const [hiring, setHiring] = useState(false);
  const [addingDept, setAddingDept] = useState(false);
  const [growing, setGrowing] = useState(false);
  if (!org) return <Empty>Loading…</Empty>;
  return (
    <>
    <div className="flex justify-end gap-2 mb-3">
      <Button onClick={() => { setGrowing((v) => !v); setAddingDept(false); setHiring(false); }}>
        {growing ? "cancel" : "grow with the architect"}
      </Button>
      <Button onClick={() => { setAddingDept((v) => !v); setHiring(false); setGrowing(false); }}>
        {addingDept ? "cancel" : "+ new department"}
      </Button>
      <Button onClick={() => { setHiring((v) => !v); setAddingDept(false); setGrowing(false); }}>{hiring ? "cancel" : "+ hire"}</Button>
    </div>
    {growing && <GrowOrg onGrown={reloadOrg} />}
    {addingDept && (
      <DepartmentForm capabilities={state?.capabilities ?? []}
        onDone={() => { setAddingDept(false); reloadOrg(); }} />
    )}
    {hiring && (
      <HireForm departments={org.map((d) => d.department)} capabilities={state?.capabilities ?? []}
        onDone={(name) => { setHiring(false); navigate(`staff/agents/${name}`); }} />
    )}
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 items-start">
      {org.map((d) => (
        <div key={d.department} className="panel p-3.5">
          <SectionLabel>{d.department}</SectionLabel>
          <div className="text-[11px] text-dim mb-3 leading-relaxed">{d.mission}</div>
          {d.agents.map((a) => <AgentCard key={a.name} a={a} today={today} unread={unread?.byAgent?.[a.name] ?? 0} />)}
          <DeptManage pack={packs?.find((p) => p.pillar === d.department)} reload={reloadPacks} />
        </div>
      ))}
    </div>
    <RetiredSection />
    </>
  );
}

/** Archived agents (agents/_retired/) with one-click rehire; hidden while the archive is empty. */
function RetiredSection() {
  const { data: retired, reload } = useFetch(() => api.retiredAgents(), []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  if (!retired?.length) return null;
  return (
    <div className="panel p-3.5 mt-4">
      <SectionLabel>Retired</SectionLabel>
      {error && <div className="text-[12px] text-err mb-1.5">{error}</div>}
      {retired.map((r) => (
        <div key={r.name} className="card w-full px-2.5 py-2 mb-1.5 flex items-center gap-2 min-h-11">
          <Avatar name={r.name} tone="dim" />
          <span className="text-strong">{r.name}</span>
          <span className="text-[10px] text-dim truncate">{r.error ? `unreadable: ${r.error}` : r.title ?? ""}</span>
          <span className="ml-auto flex items-center gap-2">
            {r.department && <Tag tone="dim">{r.department}</Tag>}
            <Button disabled={busy === r.name || !!r.error} onClick={() => {
              setBusy(r.name); setError("");
              api.rehireAgent(r.name)
                .then((p) => { void reload(); navigate(`staff/agents/${p.name}`); })
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(""));
            }}>{busy === r.name ? "…" : "Rehire"}</Button>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The architect, after setup. Onboarding's interview becomes unreachable the moment an org exists,
 * so this is the only way back to it — and it only ever ADDS: the server refuses a coordinator, a
 * name the org already uses, or a department that is already there.
 *
 * Two phases in one panel, because they are one thought: talk until the architect has enough, then
 * look at what it wants to add before any of it is written.
 */
function GrowOrg({ onGrown }: { onGrown: () => void }) {
  const [turns, setTurns] = useState<Array<{ role: "user" | "architect"; text: string }>>([]);
  const [question, setQuestion] = useState("");
  const [proposal, setProposal] = useState<OrgGrowthProposal | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState("");

  // One turn: the answer goes on the transcript, and the architect either asks again or is done.
  // The transcript is the whole state — the endpoint is stateless, exactly like the wizard's.
  const send = async (text: string) => {
    const next = [...turns, ...(text ? [{ role: "user" as const, text }] : [])];
    setError(""); setBusy(true); setAnswer("");
    try {
      const r = await api.growOrg(next);
      if (r.done) { setProposal(r.proposal); setQuestion(""); }
      else { setQuestion(r.question); next.push({ role: "architect", text: r.question }); }
      setTurns(next);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    if (!proposal) return;
    setError(""); setBusy(true);
    try {
      const r = await api.applyOrgGrowth(proposal);
      setApplied([...r.departments, ...r.agents].join(", "));
      setProposal(null); setTurns([]);
      onGrown();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const input = "bg-bg border border-line rounded-md px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-dim";
  return (
    <div className="panel p-4 mb-4 flex flex-col gap-2.5">
      <SectionLabel>Grow your org</SectionLabel>
      {applied && <div className="text-[12px] text-fg">Added {applied}. They're on duty now.</div>}

      {!proposal && (
        <>
          <p className="text-[12px] text-dim leading-relaxed">
            Tell the architect what your org can't do yet. It only adds — nothing you already have
            is changed or replaced.
          </p>
          {question && <div className="text-[13px] text-strong leading-relaxed">{question}</div>}
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={busy}
            aria-label="answer the architect" rows={3}
            placeholder={turns.length ? "your answer" : "what work is going unserved?"}
            className={`${input} resize-y disabled:opacity-60`} />
          <div className="flex justify-end">
            <Button variant="primary" disabled={busy || !answer.trim()} onClick={() => void send(answer.trim())}>
              {busy ? "…" : turns.length ? "Answer" : "Start"}
            </Button>
          </div>
        </>
      )}

      {proposal && (
        <>
          <div className="text-[12px] text-dim">Nothing is written until you say so.</div>
          {proposal.departments.map((d) => (
            <div key={d.department} className="text-[12px]">
              <span className="text-strong">new department: {d.department}</span>
              <span className="text-dim"> — {d.mission}</span>
            </div>
          ))}
          {proposal.agents.map((a) => (
            <div key={a.name} className="text-[12px]">
              <span className="text-strong">{a.name}</span>
              <span className="text-dim"> — {a.title} ({a.kind}, {a.department})</span>
              <div className="text-[11px] text-dim leading-relaxed">{a.charter}</div>
            </div>
          ))}
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={() => { setProposal(null); setTurns([]); setQuestion(""); }}>
              Start over
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void apply()}>
              {busy ? "…" : "Add to my org"}
            </Button>
          </div>
        </>
      )}
      {error && <div className="text-[12px] text-err">{error}</div>}
    </div>
  );
}

/** The 7 memory domains (src/memory/recall.ts). A select, not a text field: the server takes any
 *  non-empty string, and a typo here would file the department's memos in a domain nothing ever
 *  recalls from. */
const MEMO_DOMAINS = ["general", "research", "code", "money", "inbox", "lifeops", "profile"];

/** New department. The endpoint has existed since the onboarding spec (POST /api/departments) but
 *  nothing ever called it, so an org could only ever be grown one agent at a time inside the
 *  departments the architect happened to invent during setup — and setup never runs again.
 *  Deliberately no `lead` field: a brand-new department has no agents yet, and the server rejects
 *  a lead that is not already registered. Hire into it, then set the lead on the agent. */
function DepartmentForm({ capabilities, onDone }: {
  capabilities: string[]; onDone: (department: string) => void;
}) {
  const [f, setF] = useState({ department: "", mission: "", memoDomain: "general" });
  const [caps, setCaps] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  const submit = async () => {
    setError(""); setBusy(true);
    try {
      // playbooks: [] on purpose — a department that names one the loader cannot resolve is
      // SILENTLY SKIPPED at load, which would lose the department the user just made.
      await api.createDepartment({ ...f, capabilities: [...caps], playbooks: [] });
      onDone(f.department);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const input = "bg-bg border border-line rounded-md px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-dim";
  return (
    <div className="panel p-4 mb-4 flex flex-col gap-2.5">
      <SectionLabel>New department</SectionLabel>
      <div className="flex gap-2 flex-wrap">
        <input placeholder="name (kebab-case)" value={f.department} onChange={set("department")} className={`${input} w-44`} />
        <select value={f.memoDomain} onChange={set("memoDomain")} className={input} aria-label="memory domain">
          {MEMO_DOMAINS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <textarea placeholder="mission — what this department is responsible for" value={f.mission} onChange={set("mission")} className={`${input} h-16`} />
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {capabilities.map((c) => (
          <label key={c} className="flex items-center gap-1 text-[12px] text-dim hover:text-fg cursor-pointer">
            <input type="checkbox" checked={caps.has(c)}
              onChange={() => setCaps((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; })} />
            {c}
          </label>
        ))}
      </div>
      <div className="text-[12px] text-dim">
        Every agent you hire here inherits these capabilities. You can hire into it straight after.
      </div>
      {error && <div className="text-[12px] text-err">{error}</div>}
      <div className="flex justify-end">
        <Button variant="primary" disabled={busy || !f.department.trim() || !f.mission.trim()}
          onClick={() => void submit()}>{busy ? "…" : "Create"}</Button>
      </div>
    </div>
  );
}

/** Hire form (spec 2026-07-20): minimal fields + capability checkboxes; tools derive from capabilities. */
function HireForm({ departments, capabilities, onDone }: {
  departments: string[]; capabilities: string[]; onDone: (name: string) => void;
}) {
  const [f, setF] = useState({ name: "", title: "", department: departments[0] ?? "", kind: "worker", charter: "", persona: "", prompt: "" });
  const [caps, setCaps] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  const submit = async () => {
    setError(""); setBusy(true);
    try { await api.hireAgent({ ...f, capabilities: [...caps] }); onDone(f.name); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const input = "bg-bg border border-line rounded-md px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-dim";
  return (
    <div className="panel p-4 mb-4 flex flex-col gap-2.5">
      <SectionLabel>Hire an agent</SectionLabel>
      <div className="flex gap-2 flex-wrap">
        <input placeholder="name (kebab-case)" value={f.name} onChange={set("name")} className={`${input} w-44`} />
        <input placeholder="title" value={f.title} onChange={set("title")} className={`${input} w-44`} />
        <select value={f.department} onChange={set("department")} className={input}>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={f.kind} onChange={set("kind")} className={input}>
          {["worker", "lead", "critic"].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>
      <textarea placeholder="charter — what this agent is for, and what it hands off" value={f.charter} onChange={set("charter")} className={`${input} h-16`} />
      <textarea placeholder="persona — voice and working style" value={f.persona} onChange={set("persona")} className={`${input} h-16`} />
      <textarea placeholder="prompt — full system instructions" value={f.prompt} onChange={set("prompt")} className={`${input} h-28`} />
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {capabilities.map((c) => (
          <label key={c} className="flex items-center gap-1 text-[12px] text-dim hover:text-fg cursor-pointer">
            <input type="checkbox" checked={caps.has(c)}
              onChange={() => setCaps((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; })} />
            {c}
          </label>
        ))}
      </div>
      {error && <div className="text-[12px] text-err">{error}</div>}
      <div className="flex justify-end">
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? "…" : "Hire"}</Button>
      </div>
    </div>
  );
}

/** Department operations, in the open: playbooks with Run, config files, enable toggle.
 *  Collapsed by default but visibly present — no more hunting through a ⋯ popover. */
function DeptManage({ pack, reload }: { pack: PackView | undefined; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ file: string; yaml: string } | null>(null);
  const [note, setNote] = useState("");
  if (!pack) return null;

  const run = async (playbook: string) => {
    setNote("");
    try {
      const { id } = await api.runPack(pack.pillar, playbook);
      setNote(`started ${id.slice(0, 8)}`);
    } catch (err) { setNote((err as Error).message); }
  };

  return (
    <div className="border-t border-line-soft mt-2 pt-2">
      <button onClick={() => setOpen((v) => !v)} className="label hover:text-fg flex items-center gap-1.5 w-full">
        <span>{open ? "▾" : "▸"}</span>
        playbooks & settings
        {!pack.enabled && <Tag tone="err">disabled</Tag>}
        <span className="ml-auto font-mono normal-case tracking-normal">{pack.playbooks.length}</span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1.5">
          {pack.playbooks.map((pb) => (
            <div key={pb.name} className="flex items-center gap-2 text-[12px]">
              <span className="truncate text-fg">{pb.name}</span>
              <Button className="ml-auto !py-0.5" onClick={() => void run(pb.name)}>Run</Button>
            </div>
          ))}
          {pack.playbooks.length === 0 && <span className="text-[11px] text-dim">No playbooks in this pack.</span>}
          <SectionLabel>Files</SectionLabel>
          <FileList pillar={pack.pillar} onEdit={setEditing} />
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[11px] text-dim">{pack.enabled ? "Department enabled" : "Department disabled"}</span>
            <TwoStepButton label={pack.enabled ? "Disable" : "Enable"} className="ml-auto !py-0.5"
              onConfirm={() => void api.setPackEnabled(pack.pillar, !pack.enabled).then(() => reload())} />
          </div>
          {note && <div className="text-[11px] text-dim">{note}</div>}
        </div>
      )}
      {editing && (
        <YamlEditor pillar={pack.pillar} file={editing.file} initial={editing.yaml} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function FileList({ pillar, onEdit }: { pillar: string; onEdit: (f: { file: string; yaml: string }) => void }) {
  const { data: files } = useFetch(() => api.packFiles(pillar), [pillar]);
  return (
    <>
      {(files ?? []).map((f) => (
        <button key={f.file} onClick={() => onEdit(f)} className="text-left text-[12px] font-mono text-dim hover:text-fg truncate">
          {f.file}
        </button>
      ))}
    </>
  );
}

function YamlEditor({ pillar, file, initial, onClose }: {
  pillar: string; file: string; initial: string; onClose: () => void;
}) {
  const [yaml, setYaml] = useState(initial);
  const [error, setError] = useState("");
  const save = async () => {
    setError("");
    try { await api.savePackFile(pillar, file, yaml); onClose(); }
    catch (err) { setError((err as Error).message); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={onClose}>
      <div className="panel w-full max-w-3xl p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}>
        <div className="font-mono text-[12px] text-dim">{pillar}/{file}</div>
        <textarea value={yaml} onChange={(e) => setYaml(e.target.value)} spellCheck={false}
          className="font-mono text-[12px] bg-bg border border-line rounded-md p-3 h-96 outline-none focus:border-dim" />
        {error && <div className="text-[12px] text-err">{error}</div>}
        <div className="flex gap-2 justify-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>Save</Button>
        </div>
      </div>
    </div>
  );
}

function Governance({ events }: { events: StoredEvent[] }) {
  const { data: trust } = useLiveQuery(() => api.trust(), events, T.trust);
  const { data: perms } = useLiveQuery(() => api.permissions(), events, T.permissions);
  return (
    <div className="max-w-4xl">
      <SectionLabel>Trust ledger</SectionLabel>
      <table className="w-full text-[12px] mb-6">
        <thead><tr className="label text-left"><th className="py-1">action type</th><th>state</th><th>✓</th><th>✗</th><th>streak</th><th>shadow</th><th>last rejection</th><th /></tr></thead>
        <tbody>
          {(trust ?? []).map((t) => (
            <tr key={t.actionType} className="border-t border-line">
              <td className="py-1.5">{t.actionType}</td>
              <td><Tag tone={t.state === "autonomous" ? "ok" : t.state === "graduating" ? "agent" : "dim"}>{t.state}</Tag></td>
              <td>{t.approvals}</td><td>{t.rejections}</td><td>{t.streak}</td>
              <td>{t.shadowMatches}{(t.matches ?? 0) + (t.mismatches ?? 0) > 0 ? ` · ${t.matches ?? 0}✓/${t.mismatches ?? 0}✗` : ""}</td>
              <td className="text-dim">{t.lastRejection ? ts(t.lastRejection) : "—"}</td>
              <td className="text-right">
                {t.state !== "supervised" && (
                  <TwoStepButton label="Demote" onConfirm={() => void api.demoteTrust(t.actionType)} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <SectionLabel>Permission matrix</SectionLabel>
      {(perms ?? []).map((r) => (
        <div key={r.role} className="mb-4">
          <div className="text-[13px] text-strong mb-1">{r.role} <span className="text-dim text-[11px]">{r.permissionMode}</span></div>
          <div className="flex flex-wrap gap-1.5">
            {r.tools.map((t) => <Tag key={t.name} tone={t.source === "granted" ? "ok" : "dim"}>{t.name}</Tag>)}
            {r.revoked.map((t) => <Tag key={t.name} tone="err">{t.name}</Tag>)}
          </div>
          {r.denials.length > 0 && (
            <div className="text-[11px] text-dim mt-1">
              denials: {r.denials.map((d) => `${d.tool}×${d.count}`).join(" · ")}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
