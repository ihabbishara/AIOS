import { useMemo, useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { usePoll } from "../hooks.js";

/** Job drill-down: live pipeline flow + stage timeline + artifact reader. */
export function JobDetail({ id, onBack, events }: { id: string; onBack: () => void; events: StoredEvent[] }) {
  const lastEvent = useMemo(
    () => events.filter((e) => (e.event.jobId as string) === id).at(-1)?.id,
    [events, id],
  );
  const { data: job } = usePoll(() => api.job(id), [id, lastEvent]);
  const [artifact, setArtifact] = useState<string | null>(null);

  if (!job) return <div className="text-dim">loading…</div>;

  const open = job.artifacts.find((a) => a.file === artifact);

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <div className="flex items-center gap-4">
        <button onClick={onBack} className="text-dim hover:text-phosphor text-[11px] font-display tracking-[0.2em] uppercase">
          ◂ Board
        </button>
        <h1 className="text-bright font-display text-base">{job.title}</h1>
        <span className={`label ${job.status === "done" ? "text-phosphor" : job.status === "failed" ? "text-alert" : "text-amber"}`}>
          {job.status}
        </span>
        <span className="text-dim text-[11px] ml-auto">vault: {job.vaultDir}</span>
      </div>

      {/* Pipeline flow */}
      <div className="hud p-4">
        <div className="label mb-3">Pipeline</div>
        <div className="flex items-center gap-0 overflow-x-auto pb-1">
          {job.stages.map((s, i) => (
            <div key={s.stage_id} className="flex items-center shrink-0">
              {i > 0 && <span className="text-dim px-2">──▸</span>}
              <div
                className={`px-3 py-2 border text-[11px] font-display uppercase tracking-wider ${
                  s.status === "done"
                    ? "border-phosphor text-phosphor"
                    : s.status === "running"
                      ? "border-amber text-amber running-sweep glow-amber"
                      : "border-alert text-alert"
                }`}
              >
                {s.stage_id}
              </div>
            </div>
          ))}
          {job.stages.length === 0 && <span className="text-dim text-[11px]">not started</span>}
        </div>
      </div>

      <div className="grid grid-cols-[260px_1fr] gap-4 flex-1 min-h-0">
        {/* Artifact list */}
        <div className="hud p-3 overflow-auto">
          <div className="label mb-2">Artifacts</div>
          {job.artifacts.map((a) => (
            <button
              key={a.file}
              onClick={() => setArtifact(a.file)}
              className={`block w-full text-left px-2 py-1.5 text-[12px] truncate transition-colors ${
                artifact === a.file ? "text-phosphor bg-panel-2" : "text-fg hover:text-bright hover:bg-panel-2"
              }`}
            >
              ▸ {a.file}
            </button>
          ))}
          {job.artifacts.length === 0 && <div className="text-dim text-[11px]">none yet</div>}
          <div className="label mt-4 mb-2">Request</div>
          <div className="text-[11px] text-fg whitespace-pre-wrap">{job.request}</div>
          {job.error && (
            <>
              <div className="label mt-4 mb-2 text-alert">Error</div>
              <div className="text-[11px] text-alert whitespace-pre-wrap">{job.error}</div>
            </>
          )}
        </div>

        {/* Artifact reader */}
        <div className="hud hud-cyan p-4 overflow-auto">
          {open ? (
            <pre className="text-[12px] leading-relaxed whitespace-pre-wrap text-fg">{open.content}</pre>
          ) : (
            <div className="text-dim text-[11px]">select an artifact to read it</div>
          )}
        </div>
      </div>
    </div>
  );
}
