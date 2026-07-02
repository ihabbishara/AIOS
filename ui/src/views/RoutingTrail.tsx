// ui/src/views/RoutingTrail.tsx — filterable feed of route.decision events.
import { useMemo, useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { usePoll } from "../hooks.js";

const VIAS = ["all", "mention", "binding", "handoff", "default", "verdict", "reset"] as const;

const VIA_COLOR: Record<string, string> = {
  mention: "text-cyan", binding: "text-violet", handoff: "text-amber",
  default: "text-dim", verdict: "text-phosphor", reset: "text-alert",
};

interface RouteEvt { to: string; via: string; reason: string; channel: string; chatId: string }

export function RoutingTrail({ events }: { events: StoredEvent[] }) {
  const { data: history } = usePoll(() => api.events(), []);
  const [q, setQ] = useState("");
  const [via, setVia] = useState<(typeof VIAS)[number]>("all");

  // Merge persisted history with the live SSE buffer, dedupe by event id.
  const rows = useMemo(() => {
    const byId = new Map<number, StoredEvent>();
    for (const e of history ?? []) byId.set(e.id, e);
    for (const e of events) byId.set(e.id, e);
    return [...byId.values()]
      .filter((e) => e.event.type === "route.decision")
      .sort((a, b) => b.id - a.id);
  }, [history, events]);

  const filtered = rows.filter((e) => {
    const v = e.event as unknown as RouteEvt;
    if (via !== "all" && v.via !== via) return false;
    if (!q.trim()) return true;
    return `${v.to} ${v.reason} ${v.channel}:${v.chatId}`.toLowerCase().includes(q.toLowerCase());
  });

  return (
    <div className="max-w-4xl flex flex-col gap-3">
      <div className="flex gap-2 items-center flex-wrap">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter by agent, reason, chat…"
          className="bg-panel border border-line px-3 py-1.5 text-[12px] text-fg outline-none focus:border-phosphor w-64"
        />
        {VIAS.map((v) => (
          <button key={v} onClick={() => setVia(v)}
            className={`px-2 py-1 text-[10px] font-display uppercase tracking-wider border transition-colors ${
              via === v ? "border-phosphor text-phosphor" : "border-line text-dim hover:text-fg"}`}>
            {v}
          </button>
        ))}
      </div>
      <div className="hud p-4 flex flex-col gap-1.5">
        {filtered.slice(0, 200).map((e) => {
          const v = e.event as unknown as RouteEvt;
          return (
            <div key={e.id} className="text-[11px] leading-relaxed">
              <span className="text-dim">{e.ts.slice(5, 19).replace("T", " ")} </span>
              <span className={VIA_COLOR[v.via] ?? "text-fg"}>[{v.via}]</span>{" "}
              <span className="text-bright">→ {v.to}</span>{" "}
              <span className="text-fg">{v.reason}</span>{" "}
              <span className="text-dim">({v.channel}:{v.chatId})</span>
            </div>
          );
        })}
        {filtered.length === 0 && <div className="text-dim text-[11px]">no routing decisions yet</div>}
      </div>
    </div>
  );
}
