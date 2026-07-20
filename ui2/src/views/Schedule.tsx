// ui2/src/views/Schedule.tsx — Scheduling & Routines: anchors, routines, reminders (spec 2026-07-15).
import { useState } from "react";
import { api } from "../api.js";
import type { Recurrence, RoutineView } from "../api.js";
import { useFetch } from "../hooks.js";
import { SectionLabel, Empty, Button, PageHeader, Tag } from "../components/ui.js";
import { TwoStepButton } from "../components/TwoStepButton.js";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function recurrenceLabel(r: Recurrence): string {
  switch (r.kind) {
    case "daily": return `daily ${r.hhmm}`;
    case "weekdays": return `weekdays ${r.hhmm}`;
    case "weekly": return `${DOW[r.dow]} ${r.hhmm}`;
    case "interval": return `every ${r.everyMinutes}m`;
  }
}

function AnchorRow({ name, hhmm, overridden, firedToday, onSave }: {
  name: string; hhmm: string; overridden: boolean; firedToday: boolean; onSave: (v: string) => void;
}) {
  const [value, setValue] = useState(hhmm);
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-line">
      <span className="w-24 text-bright">{name}</span>
      <input
        className="bg-transparent border border-line rounded px-1.5 py-0.5 w-20 text-bright"
        value={value}
        aria-label={`${name} time`}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => value !== hhmm && onSave(value)}
        onKeyDown={(e) => e.key === "Enter" && value !== hhmm && onSave(value)}
      />
      {overridden && <Tag tone="accent">override</Tag>}
      {firedToday && <Tag tone="ok">fired today</Tag>}
    </div>
  );
}

function RecurrenceInputs({ rec, setRec }: { rec: Recurrence; setRec: (r: Recurrence) => void }) {
  return (
    <div className="flex items-center gap-2">
      <select
        className="bg-surface border border-line rounded px-1.5 py-0.5"
        value={rec.kind}
        aria-label="recurrence kind"
        onChange={(e) => {
          const kind = e.target.value as Recurrence["kind"];
          setRec(
            kind === "interval" ? { kind, everyMinutes: 60 }
            : kind === "weekly" ? { kind, dow: 1, hhmm: "09:00" }
            : { kind, hhmm: "09:00" },
          );
        }}
      >
        <option value="daily">daily</option>
        <option value="weekdays">weekdays</option>
        <option value="weekly">weekly</option>
        <option value="interval">interval</option>
      </select>
      {rec.kind === "weekly" && (
        <select className="bg-surface border border-line rounded px-1.5 py-0.5" value={rec.dow}
          aria-label="day of week" onChange={(e) => setRec({ ...rec, dow: Number(e.target.value) })}>
          {DOW.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
      )}
      {"hhmm" in rec && (
        <input className="bg-transparent border border-line rounded px-1.5 py-0.5 w-20" value={rec.hhmm}
          aria-label="time" onChange={(e) => setRec({ ...rec, hhmm: e.target.value })} />
      )}
      {rec.kind === "interval" && (
        <span className="flex items-center gap-1 text-dim">
          every
          <input className="bg-transparent border border-line rounded px-1.5 py-0.5 w-16" type="number" min={1}
            value={rec.everyMinutes} aria-label="minutes"
            onChange={(e) => setRec({ ...rec, everyMinutes: Number(e.target.value) })} />
          min
        </span>
      )}
    </div>
  );
}

function RoutineRowView({ r, onChanged }: { r: RoutineView; onChanged: () => void }) {
  const [err, setErr] = useState<string>();
  const act = (p: Promise<unknown>) => p.then(onChanged).catch((e) => setErr((e as Error).message));
  return (
    <div className="py-2 border-b border-line">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-bright">{r.name}</span>
        <Tag tone={r.enabled ? "ok" : "dim"}>{r.enabled ? "on" : "off"}</Tag>
        <Tag tone="dim">{recurrenceLabel(r.recurrence)}</Tag>
        {r.nextFire && <span className="text-dim text-xs">{r.nextFire}</span>}
        <span className="flex-1" />
        <Button onClick={() => act(api.runRoutine(r.id))}>Run now</Button>
        <Button onClick={() => act(api.updateRoutine(r.id, { enabled: !r.enabled }))}>
          {r.enabled ? "Disable" : "Enable"}
        </Button>
        <TwoStepButton label="Delete" onConfirm={() => act(api.deleteRoutine(r.id))} />
      </div>
      <div className="text-dim text-xs mt-1 truncate">{r.prompt}</div>
      {err && <div className="text-err text-xs mt-1">{err}</div>}
    </div>
  );
}

function CreateRoutine({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [rec, setRec] = useState<Recurrence>({ kind: "daily", hhmm: "09:00" });
  const [err, setErr] = useState<string>();
  const submit = () => {
    api.addRoutine({ name, prompt, recurrence: rec })
      .then(() => { setName(""); setPrompt(""); setErr(undefined); onCreated(); })
      .catch((e) => setErr((e as Error).message));
  };
  return (
    <div className="flex flex-col gap-2 py-2">
      <input className="bg-transparent border border-line rounded px-2 py-1" placeholder="Routine name"
        value={name} onChange={(e) => setName(e.target.value)} />
      <textarea className="bg-transparent border border-line rounded px-2 py-1 min-h-16"
        placeholder="Prompt — what should run" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="flex items-center gap-3 flex-wrap">
        <RecurrenceInputs rec={rec} setRec={setRec} />
        <Button variant="primary" disabled={!name.trim() || !prompt.trim()} onClick={submit}>Create routine</Button>
      </div>
      {err && <div className="text-err text-xs">{err}</div>}
    </div>
  );
}

export function Schedule() {
  const { data, error, reload } = useFetch(() => api.schedule(), []);
  const [anchorErr, setAnchorErr] = useState<string>();
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Empty>Loading…</Empty>;
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="page">
        <PageHeader title="Schedule" meta={`${data.routines.length} routine${data.routines.length === 1 ? "" : "s"} · ${data.reminders.length} reminder${data.reminders.length === 1 ? "" : "s"}`} />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] items-start">
          <div className="panel p-4">
            <SectionLabel>Routines</SectionLabel>
            <div className="text-[11px] text-dim mb-2">Recurring prompts the org runs on its own — hermes picks them up on schedule.</div>
            {data.routines.length === 0 && <Empty>No routines yet — create one below.</Empty>}
            {data.routines.map((r) => <RoutineRowView key={r.id} r={r} onChanged={reload} />)}
            <div className="mt-3"><SectionLabel>New routine</SectionLabel></div>
            <CreateRoutine onCreated={reload} />
          </div>

          <div className="flex flex-col gap-4">
            <div className="panel p-4">
              <SectionLabel>Anchors</SectionLabel>
              <div className="text-[11px] text-dim mb-2">The daemon's daily heartbeats — briefs, memory distillation, speculation fire at these times.</div>
              {data.anchors.map((a) => (
                // key includes hhmm so the row remounts (re-seeds its input) when the persisted value
                // changes — e.g. the server normalizes 9:00→09:00 — instead of showing stale local text.
                <AnchorRow key={`${a.name}:${a.hhmm}`} {...a}
                  onSave={(hhmm) => api.setAnchor(a.name, hhmm).then(reload).catch((e) => setAnchorErr((e as Error).message))} />
              ))}
              {anchorErr && <div className="text-err text-xs mt-1">{anchorErr}</div>}
            </div>

            <div className="panel p-4">
              <SectionLabel>Reminders</SectionLabel>
              {data.reminders.length === 0 && <Empty>No pending reminders — ask any agent to "remind me…".</Empty>}
              {data.reminders.map((rem) => (
                <div key={rem.id} className="flex items-center gap-3 py-1.5 border-b border-line last:border-0">
                  <span className="text-bright flex-1">{rem.text}</span>
                  <span className="text-dim text-xs font-mono">{rem.dueAt}</span>
                  <span className="text-dim text-xs">{rem.origin}</span>
                  <TwoStepButton label="Cancel" onConfirm={() => api.cancelReminder(rem.id).then(reload).catch(() => {})} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
