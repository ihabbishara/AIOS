import { useMemo, useState } from "react";
import { api, type JobInfo, type StoredEvent } from "../api.js";
import { usePoll } from "../hooks.js";
import { JobDetail } from "./JobDetail.js";

const COLUMNS: Array<{ key: string; title: string; accent: string }> = [
  { key: "queued", title: "Queued", accent: "text-dim" },
  { key: "running", title: "In Progress", accent: "text-amber glow-amber" },
  { key: "done", title: "Completed", accent: "text-phosphor glow-green" },
  { key: "failed", title: "Failed", accent: "text-alert" },
];

export function Board({ events }: { events: StoredEvent[] }) {
  const lastJobEvent = useMemo(
    () => events.filter((e) => e.event.type.startsWith("job.") || e.event.type.startsWith("stage.")).at(-1)?.id,
    [events],
  );
  const { data: jobs } = usePoll(() => api.jobs(), [lastJobEvent]);
  const [selected, setSelected] = useState<string | null>(null);

  if (selected) return <JobDetail id={selected} onBack={() => setSelected(null)} events={events} />;

  const byStatus = (s: string) => (jobs ?? []).filter((j) => j.status === s);

  return (
    <div className="grid grid-cols-4 gap-4 h-full min-h-0">
      {COLUMNS.map(({ key, title, accent }, i) => (
        <section key={key} className="boot flex flex-col min-h-0" style={{ animationDelay: `${i * 80}ms` }}>
          <div className="flex items-baseline gap-2 mb-3">
            <span className={`font-display uppercase tracking-[0.2em] text-[11px] ${accent}`}>{title}</span>
            <span className="text-dim text-[11px]">{byStatus(key).length}</span>
          </div>
          <div className="flex flex-col gap-3 overflow-auto pr-1">
            {byStatus(key).map((job) => (
              <JobCard key={job.id} job={job} onClick={() => setSelected(job.id)} />
            ))}
            {byStatus(key).length === 0 && (
              <div className="border border-dashed border-line text-dim text-[11px] p-4 text-center">empty</div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function JobCard({ job, onClick }: { job: JobInfo; onClick: () => void }) {
  const doneStages = job.stages.filter((s) => s.status === "done").length;
  const hudClass =
    job.status === "running" ? "hud hud-amber running-sweep" :
    job.status === "failed" ? "hud hud-alert" : "hud";
  return (
    <button onClick={onClick} className={`${hudClass} p-3 text-left hover:bg-panel-2 transition-colors`}>
      <div className="text-bright text-[13px] leading-snug">{job.title}</div>
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[10px] text-cyan">{job.playbook}</span>
        <span className="text-[10px] text-dim ml-auto">{job.created_at.slice(5, 16).replace("T", " ")}</span>
      </div>
      {job.stages.length > 0 && (
        <div className="flex gap-1 mt-2">
          {job.stages.map((s) => (
            <span
              key={s.stage_id}
              title={s.stage_id}
              className={`h-1 flex-1 ${
                s.status === "done" ? "bg-phosphor" : s.status === "running" ? "bg-amber live-dot" : "bg-alert"
              }`}
            />
          ))}
        </div>
      )}
      {job.status === "running" && (
        <div className="text-[10px] text-amber mt-1">{doneStages}/{job.stages.length || "?"} stages</div>
      )}
      {job.error && <div className="text-[10px] text-alert mt-1 line-clamp-2">{job.error}</div>}
      <div className="text-[10px] text-dim mt-1">via {job.channel}</div>
    </button>
  );
}
