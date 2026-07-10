import { useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";

export function Approvals({ events }: { events: StoredEvent[] }) {
  const { data, reload } = useLiveQuery(() => api.actions("proposed"), events, T.actions);
  const [busy, setBusy] = useState<string>();

  const decideAction = async (id: string, verdict: "approve" | "reject") => {
    const reason = verdict === "reject" ? prompt("Reason (optional — trains the ledger)") ?? undefined : undefined;
    setBusy(id);
    try {
      await api.resolveAction(id, verdict, reason);
    } catch (e) {
      alert((e as Error).message);
    }
    setBusy(undefined);
    reload();
  };

  if (!data) return <div className="text-dim">loading…</div>;
  return (
    <div className="flex flex-col gap-3 max-w-3xl">
      <div className="label">Approval inbox — {data.length} pending</div>
      {data.length === 0 && <div className="text-dim text-[11px]">nothing waiting on you</div>}
      {data.map((a) => (
        <div key={a.id} className="hud p-4 boot flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-[11px] text-amber">
              {a.type} · {a.id} · via {a.origin_channel}
            </div>
            <div className="text-fg">{a.preview}</div>
            <div className="text-[10px] text-dim">expires {a.expires_at.slice(0, 16).replace("T", " ")}</div>
          </div>
          <button
            disabled={busy === a.id}
            onClick={() => decideAction(a.id, "approve")}
            className="border border-phosphor text-phosphor px-3 py-1.5 text-[11px] font-display uppercase tracking-widest hover:bg-phosphor hover:text-void transition-colors"
          >
            Approve
          </button>
          <button
            disabled={busy === a.id}
            onClick={() => decideAction(a.id, "reject")}
            className="border border-alert text-alert px-3 py-1.5 text-[11px] font-display uppercase tracking-widest hover:bg-alert hover:text-void transition-colors"
          >
            Reject
          </button>
        </div>
      ))}
    </div>
  );
}
