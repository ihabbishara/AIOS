// ui/src/views/EventLog.tsx — full event history (server 500-cap + live SSE merge) with
// filter presets. Absorbs the old RoutingTrail (preset "routing").
// ponytail: no cursor pagination — bus.history caps at 500; add ?before= paging if that ever hurts.
import { useMemo, useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { useFetch } from "../hooks.js";
import { matches } from "../lib/topics.js";
import { describe, COLOR } from "./EventFeed.js";

const PRESETS: Record<string, readonly string[]> = {
  all: [],
  routing: ["route.decision"],
  goals: ["goal.", "node."],
  agents: ["agent."],
  actions: ["action.", "trust.changed", "permission.changed"],
  chat: ["chat."],
  mail: ["mail."],
};

const VIA_COLOR: Record<string, string> = {
  mention: "text-cyan", binding: "text-violet", handoff: "text-amber",
  default: "text-dim", verdict: "text-phosphor", reset: "text-alert",
};

export function EventLog({ events }: { events: StoredEvent[] }) {
  const { data: history } = useFetch(() => api.events(), []);
  const [preset, setPreset] = useState<keyof typeof PRESETS>("all");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const byId = new Map<number, StoredEvent>();
    for (const e of history ?? []) byId.set(e.id, e);
    for (const e of events) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => b.id - a.id);
  }, [history, events]);

  const filtered = rows.filter((e) => {
    const topics = PRESETS[preset];
    if (topics.length && !matches(e.event.type, topics)) return false;
    if (!q.trim()) return true;
    return JSON.stringify(e.event).toLowerCase().includes(q.toLowerCase());
  });

  return (
    <div className="max-w-4xl flex flex-col gap-3">
      <div className="flex gap-2 items-center flex-wrap">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter…"
          className="bg-panel border border-line px-3 py-1.5 text-[12px] text-fg outline-none focus:border-phosphor w-64" />
        {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).map((p) => (
          <button key={p} onClick={() => setPreset(p)}
            className={`px-2 py-1 text-[10px] font-display uppercase tracking-wider border transition-colors ${
              preset === p ? "border-phosphor text-phosphor" : "border-line text-dim hover:text-fg"}`}>
            {p}
          </button>
        ))}
      </div>
      <div className="hud p-4 flex flex-col gap-1.5">
        {filtered.slice(0, 300).map((e) => (
          <div key={e.id} className="text-[11px] leading-relaxed">
            <span className="text-dim">{e.ts.slice(5, 19).replace("T", " ")} </span>
            {e.event.type === "route.decision" ? (
              <RouteRow e={e} />
            ) : (
              <span className={COLOR[e.event.type] ?? "text-fg"}>{describe(e)}</span>
            )}
          </div>
        ))}
        {filtered.length === 0 && <div className="text-dim text-[11px]">nothing matching</div>}
      </div>
    </div>
  );
}

function RouteRow({ e }: { e: StoredEvent }) {
  const v = e.event as unknown as { to: string; via: string; reason: string; channel: string; chatId: string };
  return (
    <>
      <span className={VIA_COLOR[v.via] ?? "text-fg"}>[{v.via}]</span>{" "}
      <span className="text-bright">→ {v.to}</span>{" "}
      <span className="text-fg">{v.reason}</span>{" "}
      <span className="text-dim">({v.channel}:{v.chatId})</span>
    </>
  );
}
