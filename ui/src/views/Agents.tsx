import type { StateInfo, StoredEvent } from "../api.js";

const KIND_ICON: Record<string, string> = { moderator: "🧠", specialist: "▣", finance: "▤" };

export function Agents({ state, events }: { state: StateInfo | undefined; events: StoredEvent[] }) {
  if (!state) return <div className="text-dim">loading…</div>;

  const running = new Set(
    events.reduce<string[]>((acc, e) => {
      if (e.event.type === "agent.start") acc.push(String(e.event.agent));
      if (e.event.type === "agent.end") acc.splice(acc.indexOf(String(e.event.agent)), 1);
      return acc;
    }, []),
  );

  const lastSeen = new Map<string, string>();
  for (const e of events) {
    if (e.event.type === "agent.end") lastSeen.set(String(e.event.agent), e.ts);
  }

  return (
    <div className="grid grid-cols-2 2xl:grid-cols-3 gap-4">
      {state.agents.map((a, i) => (
        <div
          key={a.name}
          className={`hud p-4 boot ${running.has(a.name) ? "hud-amber running-sweep" : ""}`}
          style={{ animationDelay: `${i * 50}ms` }}
        >
          <div className="flex items-center gap-2">
            <span className="text-base">{KIND_ICON[a.kind] ?? "▣"}</span>
            <span className="font-display text-bright tracking-wider">{a.name}</span>
            {a.guarded && (
              <span title="deterministic tool gate" className="text-[10px] border border-cyan text-cyan px-1.5 py-0.5">
                ⛨ GUARDED
              </span>
            )}
            <span className={`ml-auto text-[10px] ${running.has(a.name) ? "text-amber glow-amber" : "text-dim"}`}>
              {running.has(a.name) ? "● ACTIVE" : "○ idle"}
            </span>
          </div>
          <p className="text-[12px] text-fg mt-2 leading-relaxed">{a.description}</p>
          <div className="flex flex-wrap gap-1 mt-3">
            {a.tools.slice(0, 8).map((t) => (
              <span key={t} className="text-[10px] text-dim border border-line px-1.5 py-0.5">{t}</span>
            ))}
          </div>
          {!!a.skills?.length && (
            <div className="mt-2 text-[11px] text-violet">skills: {a.skills.join(", ")}</div>
          )}
          {!!a.members?.length && (
            <div className="mt-2 text-[11px] text-cyan">members: {a.members.join(", ")}</div>
          )}
          {a.permissionMode && (
            <div className="mt-2 text-[10px] text-dim">mode: {a.permissionMode}{a.cwd ? ` · cwd: ${a.cwd}` : ""}</div>
          )}
          {lastSeen.has(a.name) && (
            <div className="mt-1 text-[10px] text-dim">last run: {lastSeen.get(a.name)!.slice(11, 19)}</div>
          )}
        </div>
      ))}
    </div>
  );
}
