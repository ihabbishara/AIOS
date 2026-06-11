import { useEffect, useRef } from "react";
import type { StoredEvent } from "../api.js";

const COLOR: Record<string, string> = {
  "job.created": "text-cyan",
  "job.status": "text-cyan",
  "stage.start": "text-amber",
  "stage.finish": "text-phosphor",
  "agent.start": "text-amber",
  "agent.end": "text-phosphor",
  "chat.in": "text-violet",
  "chat.out": "text-fg",
};

function describe(e: StoredEvent): string {
  const v = e.event;
  switch (v.type) {
    case "job.created": return `job ▸ ${v.title}`;
    case "job.status": return `job ${String(v.status).toUpperCase()}${v.error ? ` — ${v.error}` : ""}`;
    case "stage.start": return `stage ▸ ${v.stageId}`;
    case "stage.finish": return `stage ${v.stageId} ${v.status}`;
    case "agent.start": return `${v.agent} engaged · ${String(v.context).replace(/^(job|chat):/, "")}`;
    case "agent.end": return `${v.agent} ${v.ok ? "done" : "FAILED"}${v.costUsd ? ` · $${Number(v.costUsd).toFixed(3)}` : ""}`;
    case "chat.in": return `← ${v.channel}${v.sender ? ` (${v.sender})` : ""}: ${v.text}`;
    case "chat.out": return `→ ${v.channel}: ${v.text}`;
    default: return v.type;
  }
}

export function EventFeed({ events }: { events: StoredEvent[] }) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView(); }, [events.length]);

  return (
    <div className="flex-1 overflow-auto px-4 pb-4 flex flex-col gap-1.5">
      {events.slice(-120).map((e) => (
        <div key={e.id} className="text-[10px] leading-relaxed">
          <span className="text-dim">{e.ts.slice(11, 19)} </span>
          <span className={COLOR[e.event.type] ?? "text-fg"}>{describe(e)}</span>
        </div>
      ))}
      {events.length === 0 && <div className="text-dim text-[11px]">no telemetry yet</div>}
      <div ref={bottom} />
    </div>
  );
}
