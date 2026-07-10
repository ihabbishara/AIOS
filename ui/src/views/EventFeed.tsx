import { useEffect, useRef } from "react";
import type { StoredEvent } from "../api.js";

export const COLOR: Record<string, string> = {
  "goal.created": "text-cyan",
  "goal.status": "text-cyan",
  "node.status": "text-amber",
  "agent.start": "text-amber",
  "agent.end": "text-phosphor",
  "chat.in": "text-violet",
  "chat.out": "text-fg",
};

export function describe(e: StoredEvent): string {
  const v = e.event;
  switch (v.type) {
    case "goal.created": return `goal ▸ ${v.title}`;
    case "goal.status": return `goal ${String(v.status).toUpperCase()}${v.error ? ` — ${v.error}` : ""}`;
    case "node.status": return `node ${v.nodeKey} ${v.status} · ${v.agent}`;
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
