// ui2/src/views/Staff.tsx — org columns + governance + department admin (spec §6 Staff).
// The rich per-agent profile lives in StaffProfile.tsx (persona explorer).
import { useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { useFetch, useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate, type Route } from "../lib/router.js";
import { Button, Dot, Empty, SectionLabel, Tag } from "../components/ui.js";
import { TwoStepButton } from "../components/TwoStepButton.js";
import { ts, usdFloat } from "../lib/format.js";
import { StaffProfile } from "./StaffProfile.js";

export function Staff({ events, route, onOpenChat }: {
  events: StoredEvent[]; route: Route; onOpenChat: (t: string, s?: string) => void;
}) {
  const sub = route.parts[0];
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="flex gap-3 mb-4 items-center">
        <h1 className="text-[17px] font-bold text-bright">Staff</h1>
        <button onClick={() => navigate("staff")}
          className={`label hover:text-fg ${!sub ? "text-strong" : ""}`}>org</button>
        <button onClick={() => navigate("staff/governance")}
          className={`label hover:text-fg ${sub === "governance" ? "text-strong" : ""}`}>governance</button>
      </div>
      {sub === "agents" && route.parts[1]
        ? <StaffProfile name={route.parts[1]} events={events} route={route} onOpenChat={onOpenChat} />
        : sub === "governance"
          ? <Governance events={events} />
          : <OrgColumns events={events} />}
    </div>
  );
}

function OrgColumns({ events }: { events: StoredEvent[] }) {
  const { data: org } = useLiveQuery(() => api.org(), events, T.agentsActions);
  const { data: unread } = useLiveQuery(() => api.mailUnread(), events, T.agentMail);
  if (!org) return <Empty>Loading…</Empty>;
  return (
    <div className="flex gap-6 overflow-x-auto items-start">
      {org.map((d) => (
        <div key={d.department} className="panel min-w-56 p-3">
          <div className="flex items-center mb-2">
            <SectionLabel>{d.department}</SectionLabel>
            <DeptMenu department={d.department} />
          </div>
          <div className="text-[11px] text-dim mb-3">{d.mission}</div>
          {d.agents.map((a) => (
            <button key={a.name} onClick={() => navigate(`staff/agents/${a.name}`)}
              className="card card-hover w-full text-left px-2 py-2 mb-1.5 flex flex-col gap-0.5 min-h-11">
              <span className="flex items-center gap-2">
                <Dot tone={a.status === "working" ? "agent" : a.status === "waiting" ? "accent" : "dim"} breathing={a.status === "working"} />
                <span className="text-strong">{a.name}</span>
                <span className="text-[10px] text-dim">{a.title}</span>
                <span className="ml-auto flex gap-1 text-[10px]">
                  {a.visibility === "private" && <span title="private">🔒</span>}
                  {a.guarded && <span title="guarded">🛡</span>}
                  {(unread?.byAgent[a.name] ?? 0) > 0 && <Tag tone="accent">{unread!.byAgent[a.name]}</Tag>}
                </span>
              </span>
              {a.currentTask && <span className="text-[11px] text-agent truncate">{a.currentTask}</span>}
              {a.costTodayUsd > 0 && <span className="text-[10px] text-dim">{usdFloat(a.costTodayUsd)} today</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** ⋯ department admin: enable/disable, playbook YAML editor, run playbook (spec §6 — a menu, not a section). */
function DeptMenu({ department }: { department: string }) {
  const [open, setOpen] = useState(false);
  const { data: packs, reload } = useFetch(() => api.packs(), []);
  const pack = packs?.find((p) => p.pillar === department);
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
    <span className="ml-auto relative">
      <button onClick={() => setOpen((v) => !v)} className="text-dim hover:text-fg px-1">⋯</button>
      {open && (
        <div className="card absolute right-0 top-6 z-30 w-72 p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[12px]">{pack.enabled ? "enabled" : "disabled"}</span>
            <TwoStepButton label={pack.enabled ? "Disable" : "Enable"} className="ml-auto"
              onConfirm={() => void api.setPackEnabled(pack.pillar, !pack.enabled).then(() => reload())} />
          </div>
          <SectionLabel>Playbooks</SectionLabel>
          {pack.playbooks.map((pb) => (
            <div key={pb.name} className="flex items-center gap-2 text-[12px]">
              <span className="truncate">{pb.name}</span>
              <Button className="ml-auto" onClick={() => void run(pb.name)}>Run</Button>
            </div>
          ))}
          <SectionLabel>Files</SectionLabel>
          <FileList pillar={pack.pillar} onEdit={setEditing} />
          {note && <div className="text-[11px] text-dim">{note}</div>}
        </div>
      )}
      {editing && (
        <YamlEditor pillar={pack.pillar} file={editing.file} initial={editing.yaml} onClose={() => setEditing(null)} />
      )}
    </span>
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
