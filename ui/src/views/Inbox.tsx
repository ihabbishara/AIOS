// ui/src/views/Inbox.tsx — the answer to "what needs me?": approvals, asks, unread mail, failures.
import { useState } from "react";
import { api, type ActionInfo, type StoredEvent } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate } from "../lib/router.js";
import { ts } from "../lib/format.js";
import { ConfirmButton } from "../components/ConfirmButton.js";

export function Inbox({ events }: { events: StoredEvent[] }) {
  const { data: actions, reload: reloadActions } = useLiveQuery(() => api.actions("proposed"), events, T.actions);
  const { data: mine, reload: reloadMail } = useLiveQuery(() => api.mailMine(), events, T.agentMail);
  const { data: goals } = useLiveQuery(() => api.goals(), events, T.goals);

  const asks = (mine?.threads ?? []).filter((t) => t.pendingAsk > 0);
  const unreadThreads = (mine?.threads ?? []).filter((t) => t.unread > 0 && t.pendingAsk === 0);
  const failed = (goals ?? []).filter((g) => g.status === "failed");
  const empty = !actions?.length && !asks.length && !unreadThreads.length && !failed.length;

  return (
    <div className="flex flex-col gap-5 max-w-3xl">
      {empty && (
        <div className="border border-dashed border-line text-dim text-[12px] p-8 text-center boot">
          Inbox zero — nothing needs you. <span className="text-phosphor">System nominal.</span>
        </div>
      )}

      {!!actions?.length && (
        <section>
          <div className="label mb-2">Approvals — {actions.length} pending</div>
          <div className="flex flex-col gap-2">
            {actions.map((a) => <ApprovalRow key={a.id} a={a} onDone={reloadActions} />)}
          </div>
        </section>
      )}

      {asks.length > 0 && (
        <section>
          <div className="label mb-2">🙋 Agents waiting on your answer</div>
          {asks.map((t) => (
            <button key={t.threadId} onClick={() => navigate(`work/mail/${t.threadId}`)}
              className="hud hud-cyan p-3 mb-2 w-full text-left hover:bg-panel-2 transition-colors">
              <div className="text-[11px]"><span className="text-cyan">{t.lastFrom}</span>
                <span className="text-dim ml-2">{ts(t.lastTs)}</span></div>
              <div className="text-[12px] text-bright truncate">{t.lastBody}</div>
            </button>
          ))}
        </section>
      )}

      {unreadThreads.length > 0 && (
        <section>
          <div className="label mb-2">Unread mail</div>
          {unreadThreads.map((t) => (
            <button key={t.threadId} onClick={() => { navigate(`work/mail/${t.threadId}`); reloadMail(); }}
              className="hud p-3 mb-2 w-full text-left hover:bg-panel-2 transition-colors">
              <div className="text-[11px]"><span className="text-fg">{t.lastFrom}</span>
                <span className="text-void bg-amber px-1 rounded-full text-[9px] ml-2">{t.unread}</span>
                <span className="text-dim ml-2">{ts(t.lastTs)}</span></div>
              <div className="text-[12px] text-dim truncate">{t.lastBody}</div>
            </button>
          ))}
        </section>
      )}

      {failed.length > 0 && (
        <section>
          <div className="label mb-2">Failed goals</div>
          {failed.map((g) => (
            <button key={g.id} onClick={() => navigate(`work/goals/${g.slug}`)}
              className="hud hud-alert p-3 mb-2 w-full text-left hover:bg-panel-2 transition-colors">
              <div className="text-[12px] text-bright">{g.title}</div>
              {g.error && <div className="text-[11px] text-alert truncate">{g.error}</div>}
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

function ApprovalRow({ a, onDone }: { a: ActionInfo; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const decide = async (verdict: "approve" | "reject") => {
    setBusy(true);
    try {
      await api.resolveAction(a.id, verdict, verdict === "reject" ? reason || undefined : undefined);
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="hud p-4 boot">
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-amber">{a.type} · {a.id} · via {a.origin_channel}</div>
          <div className="text-fg">{a.preview}</div>
          <div className="text-[10px] text-dim">expires {ts(a.expires_at)}</div>
        </div>
        <ConfirmButton label="approve" disabled={busy} onConfirm={() => decide("approve")} />
        <button disabled={busy} onClick={() => setRejecting((v) => !v)}
          className="border border-alert text-alert px-3 py-1 font-display uppercase tracking-[0.2em] text-[10px] hover:bg-alert hover:text-void transition-colors disabled:opacity-40">
          reject
        </button>
      </div>
      {rejecting && (
        <div className="flex gap-2 mt-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="reason (optional — trains the ledger)"
            className="flex-1 bg-void border border-alert/40 px-2 py-1 text-[11px] text-fg outline-none focus:border-alert" />
          <ConfirmButton label="confirm reject" alert disabled={busy} onConfirm={() => decide("reject")} />
        </div>
      )}
      {msg && <div className="text-[11px] text-alert mt-1">{msg}</div>}
    </div>
  );
}
