// ui/src/views/Packs.tsx
import { useMemo } from "react";
import { api, type PackView, type StoredEvent } from "../api.js";
import { usePoll } from "../hooks.js";

export function Packs({ events }: { events: StoredEvent[] }) {
  const lastEvt = useMemo(
    () => events.filter((e) => e.event.type.startsWith("job.") || e.event.type.startsWith("stage.")).at(-1)?.id,
    [events],
  );
  const { data: packs } = usePoll(() => api.packs(), [lastEvt]);

  return (
    <div className="flex flex-col gap-4 overflow-auto h-full min-h-0 pr-1">
      {(packs ?? []).map((p, i) => <PackCard key={p.pillar} pack={p} i={i} />)}
      {packs && packs.length === 0 && (
        <div className="border border-dashed border-line text-dim text-[11px] p-4 text-center">no packs bound</div>
      )}
    </div>
  );
}

function PackCard({ pack, i }: { pack: PackView; i: number }) {
  const dim = pack.enabled ? "" : "opacity-50";
  return (
    <section className={`boot hud p-4 ${dim}`} style={{ animationDelay: `${i * 60}ms` }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="font-display uppercase tracking-[0.2em] text-[13px] text-phosphor glow-green">{pack.pillar}</span>
        {pack.sandbox && <span className="text-[9px] text-cyan border border-cyan px-1">sandbox</span>}
        <span className={`text-[10px] ml-auto ${pack.enabled ? "text-phosphor" : "text-dim"}`}>
          {pack.enabled ? "● enabled" : "○ disabled"}
        </span>
      </div>
      <div className="text-[11px] text-dim mb-2 line-clamp-2">{pack.persona}</div>
      <div className="text-[10px] text-dim mb-2">
        memo: {pack.memoDomain} · vault: {pack.vaultSection} · actions: [{pack.actions.join(", ") || "none"}] · memos: {pack.memoCount}
      </div>
      <div className="mb-2">
        <span className="label">Roles</span>
        <div className="flex flex-wrap gap-1 mt-1">
          {pack.roles.map((r) => (
            <span key={r.name} title={`${r.description} · ${r.permissionMode}`}
              className="text-[10px] border border-line px-1 text-fg">
              {r.name}{r.privateOnly ? " (private)" : ""}{r.advisoryInDirect ? " ★" : ""}
            </span>
          ))}
        </div>
      </div>
      {pack.playbooks.length > 0 ? (
        <div className="mb-2">
          <span className="label">Playbooks</span>
          {pack.playbooks.map((pb) => (
            <div key={pb.name} className="text-[10px] text-fg mt-1">
              <span className="text-cyan">{pb.name}</span>{" "}
              <span className="text-dim">{pb.stages.map((s) => s.id).join("→")}{pb.needsProjectDir ? " · needs project_dir" : ""}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[10px] text-dim mb-2">direct-chat pillar — no playbooks/jobs</div>
      )}
      {pack.recentJobs.length > 0 && (
        <div className="mb-2">
          <span className="label">Recent jobs</span>
          {pack.recentJobs.map((j) => (
            <div key={j.id} className="text-[10px] mt-1">
              <span className={j.status === "done" ? "text-phosphor" : j.status === "failed" ? "text-alert" : "text-amber"}>{j.status}</span>{" "}
              <span className="text-fg">{j.title}</span> <span className="text-dim">{j.created_at.slice(5, 16).replace("T", " ")}</span>
            </div>
          ))}
        </div>
      )}
      {pack.workspaces.length > 0 && (
        <div>
          <span className="label">Workspaces</span>
          {pack.workspaces.map((w) => (
            <div key={w.taskDir} className="text-[10px] text-dim mt-1 font-mono">
              {w.taskDir} {w.exists ? "✓" : "✗(removed)"}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
